//! Turns an agent's own writes to shared context, made directly on disk outside any plxd call,
//! into `context.changed` events (0005, #155).
//!
//! plxd watches with the `notify` crate (`FSEvents` on macOS, inotify on Linux) rather than
//! rescanning the folder on a timer. Nothing else would ever see an agent's write: it never goes
//! through plxd at all, so there is no request to hang the check off. A poll loop would then
//! have to choose between missing a quick write between ticks and burning cycles ticking often
//! enough not to, while the OS already tells the kernel's own record of every write to the tree,
//! for free. One watcher covers the whole `context/` folder, recursively, from before any project
//! exists, so a project created later needs no watch of its own: both backends report changes
//! anywhere under the root they were given, including in a subfolder created after the watch
//! started. inotify watches each folder separately, and `notify` adds a watch for each new one.

use std::path::{Component, Path};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parallax_protocol::ProjectId;
use tracing::warn;

use super::{MAX_PROJECT_BYTES, context_file, validate_relative_path};
use crate::server::Daemon;

/// Starts watching `daemon`'s shared context folder. The returned watcher must be kept alive for
/// as long as plxd should keep reporting changes; dropping it stops the watch.
///
/// # Errors
///
/// If the platform's watcher backend could not be started or could not watch the folder.
pub(crate) fn start(daemon: std::sync::Arc<Daemon>) -> notify::Result<RecommendedWatcher> {
    let root = daemon.data_dir.context_root();
    // FSEvents reports its own canonical form of a path, which on macOS can differ from plxd's
    // own spelling (`/tmp/...` versus the real `/private/tmp/...`, for example), while inotify
    // reports paths under the one it was given. Watching the canonical path, and comparing
    // against it, keeps `relative_file` matching every event on both instead of silently
    // matching none of them. `context_root` is created just before this is called
    // (`Server::start`), so canonicalizing it should not fail; if it somehow does, falling back
    // to `root` at least keeps the watch itself running.
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let context_root = root.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<Event>| match event {
            Ok(event) => handle(&daemon, &context_root, &event),
            Err(error) => warn!(%error, "the shared context watcher failed"),
        })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn handle(daemon: &Daemon, context_root: &Path, event: &Event) {
    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return;
    }
    for path in &event.paths {
        observe(daemon, context_root, path);
    }
}

/// The project and path, joined with `/`, that a changed path names inside one project's context
/// folder. Anything else (the project folder itself, or a folder name that isn't a project id,
/// such as `you`) is ignored here; [`observe`] then checks the path as plxd's own calls do.
fn relative_file(context_root: &Path, path: &Path) -> Option<(ProjectId, String)> {
    let relative = path.strip_prefix(context_root).ok()?;
    let mut components = relative.components();
    let Component::Normal(project_name) = components.next()? else {
        return None;
    };
    let project: ProjectId = project_name.to_str()?.parse().ok()?;
    let mut parts = Vec::new();
    for component in components {
        let Component::Normal(part) = component else {
            return None;
        };
        parts.push(part.to_str()?);
    }
    (!parts.is_empty()).then(|| (project, parts.join("/")))
}

fn observe(daemon: &Daemon, context_root: &Path, path: &Path) {
    let Some((project, name)) = relative_file(context_root, path) else {
        return;
    };
    if validate_relative_path(&name).is_err() {
        return;
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return, // gone already, a directory, or a symlink: nothing to report
    };
    if metadata.len() > MAX_PROJECT_BYTES {
        warn!(project = %project, path = %name, "ignoring an oversized shared context file on disk");
        return;
    }
    // A failed read raced a delete or another write, whose event settles it. Content that matches
    // is no new information: plxd's own write, or the same content seen again.
    if !daemon
        .context
        .record_disk_write(project, &name, || std::fs::read(path).ok())
    {
        return;
    }
    // An agent's write has no writer.
    let file = context_file(&name, &metadata, None);
    let seq = daemon.log.append_blocking(
        jiff::Timestamp::now(),
        Some(project),
        parallax_protocol::ParallaxEvent::ContextChanged { file },
    );
    tracing::info!(project = %project, path = %name, seq, "a shared context file changed on disk");
}
