//! `context/list`, `context/read`, and `context/write` (0005, #155), and behind
//! `projectArtifacts`, `context/readBytes` and `context/saveArtifact` (PLX-941).
//!
//! File I/O runs on tokio's blocking pool (`spawn_blocking`), not the request's own task, since
//! reading, writing, and listing a project's shared context folder are ordinary blocking
//! filesystem calls, just like `parallax_store`'s calls are blocking SQLite ones.

use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ContextListParams, ContextListResult, ContextReadBytesParams, ContextReadBytesResult,
    ContextReadParams, ContextReadResult, ContextSaveArtifactParams, ContextWriteParams,
    ContextWriteResult, ErrorKind, InboxKind, ParallaxEvent, ProjectId, RunId,
};
use parallax_store::StoreError;
use tracing::info;

use super::Context;
use crate::context::{self, Existing};
use crate::store::store_error;

pub(crate) async fn list(
    context: &Context,
    params: ContextListParams,
) -> Result<ContextListResult, ErrorObject> {
    let project = params.project;
    ensure_project_exists(context, project).await?;
    let daemon = Arc::clone(&context.daemon);
    run_blocking(move || {
        let dir = context::ensure_dir(&daemon.data_dir, project).map_err(io_error(""))?;
        let files = context::list_files(&dir)
            .map_err(io_error(""))?
            .into_iter()
            .map(|(name, metadata)| {
                let writer = daemon.context.writer_of(project, &name);
                context::context_file(&name, &metadata, writer)
            })
            .collect();
        Ok(ContextListResult { files })
    })
    .await
}

pub(crate) async fn read(
    context: &Context,
    params: ContextReadParams,
) -> Result<ContextReadResult, ErrorObject> {
    let name = context::validate_relative_path(&params.path)?.to_owned();
    let project = params.project;
    ensure_project_exists(context, project).await?;
    let daemon = Arc::clone(&context.daemon);
    run_blocking(move || {
        let dir = context::ensure_dir(&daemon.data_dir, project).map_err(io_error(&name))?;
        let (bytes, metadata) = context::read_file(&dir, &name).map_err(io_error(&name))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| ErrorObject::internal_error(format!("{name} is not valid UTF-8 text")))?;
        let writer = daemon.context.writer_of(project, &name);
        let file = context::context_file(&name, &metadata, writer);
        Ok(ContextReadResult {
            file,
            content: text,
        })
    })
    .await
}

/// `context/readBytes`: one slice of a file of any type, as `agent/file`'s working side reads one.
pub(crate) async fn read_bytes(
    context: &Context,
    params: ContextReadBytesParams,
) -> Result<ContextReadBytesResult, ErrorObject> {
    let name = context::validate_relative_path(&params.path)?.to_owned();
    let (offset, length) =
        super::host::slice(params.offset, params.length)?.unwrap_or((0, super::host::CHUNK_BYTES));
    let project = params.project;
    ensure_project_exists(context, project).await?;
    let daemon = Arc::clone(&context.daemon);
    run_blocking(move || {
        let dir = context::ensure_dir(&daemon.data_dir, project).map_err(io_error(&name))?;
        let (bytes, metadata) =
            context::read_slice(&dir, &name, offset, length).map_err(io_error(&name))?;
        let writer = daemon.context.writer_of(project, &name);
        Ok(ContextReadBytesResult {
            file: context::context_file(&name, &metadata, writer),
            content: crate::images::encode(&bytes),
        })
    })
    .await
}

/// The largest artifact `context/saveArtifact` copies: `present_files`' own cap.
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// `context/saveArtifact`: copies `path` from a Project child's working folder into the Project's
/// `artifacts/<run id>/`, deleting the oldest artifacts first when the bulk folders would pass
/// their cap, with a `needsYou` inbox item saying so.
pub(crate) async fn save_artifact(
    context: &Context,
    params: ContextSaveArtifactParams,
) -> Result<ContextWriteResult, ErrorObject> {
    let ContextSaveArtifactParams { run_id, path } = params;
    crate::worktree::validate_repo_path(&path).map_err(ErrorObject::invalid_params)?;
    let file_name = path.rsplit('/').next().unwrap_or(&path);
    let name = format!("artifacts/{run_id}/{file_name}");
    context::validate_relative_path(&name)?;
    let project = project_of(context, run_id).await?;
    let daemon = Arc::clone(&context.daemon);
    let (root, _) = crate::agents::review::run_folder(&daemon, run_id).await?;
    let (file, pruned) = run_blocking(move || {
        let (mut source, metadata) = context::open_file(&root, &path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ErrorObject::invalid_params(format!("{path} isn't a file in run {run_id}'s folder"))
            } else {
                context::io_error(&path, &error)
            }
        })?;
        let too_large = || {
            ErrorObject::parallax(
                ErrorKind::ContextTooLarge,
                format!("{path} would be over the artifacts size cap"),
            )
        };
        if metadata.len() > MAX_ARTIFACT_BYTES {
            return Err(too_large());
        }
        let dir = context::ensure_dir(&daemon.data_dir, project).map_err(io_error(&name))?;
        let pruned = context::make_room(&dir, &name, metadata.len())
            .map_err(io_error(&name))?
            .ok_or_else(too_large)?;
        let metadata = context::copy_file(&dir, &name, &mut source).map_err(io_error(&name))?;
        let file = context::context_file(&name, &metadata, None);
        let seq = daemon.store.append_blocking(
            jiff::Timestamp::now(),
            Some(project),
            ParallaxEvent::ContextChanged { file: file.clone() },
        );
        info!(project = %project, path = name, seq, "saved an artifact");
        Ok((file, pruned))
    })
    .await?;
    pruned_item(&context.daemon, project, run_id, &pruned).await;
    Ok(ContextWriteResult { file })
}

/// The Project `run` is a child of, or `invalidParams` for a run in a repo entry.
async fn project_of(context: &Context, run: RunId) -> Result<ProjectId, ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |store| {
            let row = store
                .get_run(run.into())
                .map_err(|error| store_error(&error))?
                .ok_or_else(|| store_error(&StoreError::NotFound { id: run.into() }))?;
            let in_project = store
                .get_project(row.fields.project_id)
                .map_err(|error| store_error(&error))?
                .is_some();
            match ProjectId::try_from(row.fields.project_id) {
                Ok(project) if in_project => Ok(project),
                _ => Err(ErrorObject::invalid_params(format!(
                    "run {run} isn't in a Project, so it has no artifacts"
                ))),
            }
        })
        .await
}

/// Adds a `needsYou` item to `project`'s inbox about `run` when [`context::make_room`] deleted
/// artifacts.
pub(crate) async fn pruned_item(
    daemon: &Arc<crate::server::Daemon>,
    project: ProjectId,
    run: RunId,
    pruned: &[String],
) {
    if pruned.is_empty() {
        return;
    }
    let text = format!(
        "Deleted the {} oldest artifacts to keep this Project's history and artifacts under 2 GiB",
        pruned.len()
    );
    super::inbox::add(daemon, project, run, InboxKind::NeedsYou, text).await;
}

/// The logic behind `context/write`, apart from plxd's blocking pool, so a test can call it
/// directly.
///
/// Idempotent on `id`: a retry with the same `project`, `path`, `content`, and `writer` returns
/// the file unchanged, without writing again or emitting a second `context.changed` event; a
/// retry with different params fails with `idConflict`. The last write to a path wins when two
/// race, since each runs independently and the later one's atomic rename is simply the one that
/// lands last (0005).
///
/// A path in `history/` skips [`context::MAX_PROJECT_BYTES`]: its caller makes room under
/// [`context::MAX_BULK_BYTES`] with [`context::make_room`] first.
pub(crate) fn write_context_file(
    daemon: &crate::server::Daemon,
    project: ProjectId,
    name: &str,
    content: &str,
    writer: Option<String>,
    write_id: parallax_protocol::ContextWriteId,
) -> Result<ContextWriteResult, ErrorObject> {
    if content.len() as u64 > context::MAX_FILE_BYTES {
        return Err(ErrorObject::parallax(
            ErrorKind::ContextTooLarge,
            format!("{name} would be over the per-file shared context size cap"),
        ));
    }
    let dir = context::ensure_dir(&daemon.data_dir, project).map_err(io_error(name))?;
    match daemon.context.check(
        project,
        name,
        write_id,
        content.as_bytes(),
        writer.as_deref(),
    ) {
        Existing::SameRetry => {
            let (_, metadata) = context::read_file(&dir, name).map_err(io_error(name))?;
            let file = context::context_file(name, &metadata, writer);
            return Ok(ContextWriteResult { file });
        }
        Existing::Conflict => {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!("context write {write_id} exists with different content or writer"),
            ));
        }
        Existing::New => {}
    }
    let other_total = context::other_files_total(&dir, name).map_err(io_error(name))?;
    let exempt = context::is_bulk(name) || crate::board::LEGACY.contains(&name);
    if !exempt && other_total + content.len() as u64 > context::MAX_PROJECT_BYTES {
        return Err(ErrorObject::parallax(
            ErrorKind::ContextTooLarge,
            format!("{name} would be over the shared context size cap"),
        ));
    }
    let metadata = daemon
        .context
        .write_protocol(
            project,
            name,
            write_id,
            writer.clone(),
            content.as_bytes(),
            || context::write_file(&dir, name, content.as_bytes()),
        )
        .map_err(io_error(name))?;
    let file = context::context_file(name, &metadata, writer);
    let seq = daemon.store.append_blocking(
        jiff::Timestamp::now(),
        Some(project),
        ParallaxEvent::ContextChanged { file: file.clone() },
    );
    info!(project = %project, path = name, seq, "wrote a shared context file");
    Ok(ContextWriteResult { file })
}

pub(crate) async fn write(
    context: &Context,
    params: ContextWriteParams,
) -> Result<ContextWriteResult, ErrorObject> {
    let ContextWriteParams {
        id,
        project,
        path,
        content,
        writer,
    } = params;
    let name = context::validate_relative_path(&path)?.to_owned();
    // 0044's folders hold memory, which only `memory/*` and the memory tools write, so a child
    // can't skip `memory_propose` and a coordinator's write always adds its `learned` item. The
    // brief is the user's, written or approved by them, so it goes through `memory/*` too.
    if name.contains('/') || name.eq_ignore_ascii_case("brief.md") {
        return Err(ErrorObject::invalid_params(
            "context/write takes one file name other than brief.md; the brief, memory, \
             knowledge, history, and proposals are written through memory/*",
        ));
    }
    // plxd renders the board from its items (0081), so a write here would be lost at the next
    // render, and rewriting it whole is what dropped items before. Its legacy copies are plxd's
    // and skip the size cap. Ignoring case, since macOS's and Windows' file systems do.
    if [crate::board::NOTES, crate::board::ARCHIVED]
        .iter()
        .chain(&crate::board::LEGACY)
        .any(|board| name.eq_ignore_ascii_case(board))
    {
        return Err(ErrorObject::invalid_params(format!(
            "Parallax keeps {name} for the status board, from its items; change the board with \
             board_add, board_update, and board_remove instead"
        )));
    }
    // A fast, redundant check: `write_context_file` enforces this cap too, but failing here skips
    // a project lookup and a trip to the blocking pool for a request that is invalid regardless.
    if content.len() as u64 > context::MAX_FILE_BYTES {
        return Err(ErrorObject::parallax(
            ErrorKind::ContextTooLarge,
            format!("{name} would be over the per-file shared context size cap"),
        ));
    }
    ensure_project_exists(context, project).await?;
    let daemon = Arc::clone(&context.daemon);
    run_blocking(move || write_context_file(&daemon, project, &name, &content, writer, id)).await
}

async fn ensure_project_exists(context: &Context, project: ProjectId) -> Result<(), ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |store| {
            let found = store
                .get_project(project.into())
                .map_err(|error| store_error(&error))?
                .is_some();
            if found {
                Ok(())
            } else {
                Err(store_error(&StoreError::NotFound { id: project.into() }))
            }
        })
        .await
}

/// Runs `job` on tokio's blocking pool, for `context/*` and `memory/*`, turning a panic or a
/// dropped task into an internal error rather than losing it silently.
pub(super) async fn run_blocking<T, F>(job: F) -> Result<T, ErrorObject>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ErrorObject> + Send + 'static,
{
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result,
        Err(error) => Err(ErrorObject::internal_error(format!(
            "shared context task failed: {error}"
        ))),
    }
}

pub(super) fn io_error(path: &str) -> impl Fn(std::io::Error) -> ErrorObject {
    let path = path.to_owned();
    move |error| context::io_error(&path, &error)
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{ContextWriteId, ErrorKind, ProjectId};

    use super::write_context_file;
    use crate::server::Daemon;

    fn daemon() -> (tempfile::TempDir, std::sync::Arc<Daemon>) {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, std::time::Duration::from_secs(90));
        (dir, daemon)
    }

    #[test]
    fn a_retry_with_the_same_params_is_idempotent_and_a_different_one_conflicts() {
        let (_dir, daemon) = daemon();
        let project = ProjectId::generate();
        let id = ContextWriteId::generate();

        let first = write_context_file(
            &daemon,
            project,
            "notes.md",
            "hello",
            Some("editor".to_owned()),
            id,
        )
        .unwrap();
        let retry = write_context_file(
            &daemon,
            project,
            "notes.md",
            "hello",
            Some("editor".to_owned()),
            id,
        )
        .unwrap();
        assert_eq!(first.file, retry.file);

        let conflict =
            write_context_file(&daemon, project, "notes.md", "different", None, id).unwrap_err();
        assert_eq!(
            conflict.parallax_data().unwrap().kind,
            ErrorKind::IdConflict
        );
    }

    #[test]
    fn a_fresh_id_overwrites_the_previous_content() {
        let (_dir, daemon) = daemon();
        let project = ProjectId::generate();

        write_context_file(
            &daemon,
            project,
            "notes.md",
            "first",
            None,
            ContextWriteId::generate(),
        )
        .unwrap();
        let second = write_context_file(
            &daemon,
            project,
            "notes.md",
            "second, and longer",
            None,
            ContextWriteId::generate(),
        )
        .unwrap();
        assert_eq!(second.file.size, "second, and longer".len() as u64);
    }

    #[test]
    fn a_file_over_the_per_file_cap_is_rejected() {
        let (_dir, daemon) = daemon();
        let project = ProjectId::generate();
        let too_big = "a".repeat(usize::try_from(super::context::MAX_FILE_BYTES).unwrap() + 1);
        let error = write_context_file(
            &daemon,
            project,
            "a.md",
            &too_big,
            None,
            ContextWriteId::generate(),
        )
        .unwrap_err();
        assert_eq!(
            error.parallax_data().unwrap().kind,
            ErrorKind::ContextTooLarge
        );
    }

    /// History counts toward the bulk cap, not the 20 MiB one (PLX-941).
    #[test]
    fn a_history_write_is_not_held_to_the_per_project_cap() {
        let (_dir, daemon) = daemon();
        let project = ProjectId::generate();
        let full = "a".repeat(usize::try_from(super::context::MAX_FILE_BYTES).unwrap());
        let write = |path: &str, content: &str| {
            write_context_file(
                &daemon,
                project,
                path,
                content,
                None,
                ContextWriteId::generate(),
            )
        };
        for n in 0..20 {
            write(&format!("{n}.md"), &full).unwrap();
        }
        assert!(write("20.md", "x").is_err());
        write("history/run.md", "Run: x").unwrap();
    }

    #[test]
    fn a_write_that_would_cross_the_per_project_cap_is_rejected() {
        let (_dir, daemon) = daemon();
        let project = ProjectId::generate();
        let one_file = "a".repeat(usize::try_from(super::context::MAX_FILE_BYTES).unwrap());
        write_context_file(
            &daemon,
            project,
            "a.md",
            &one_file,
            None,
            ContextWriteId::generate(),
        )
        .unwrap();

        // "a.md" already uses one file's worth of the cap; a second file that alone would use the
        // rest of it, plus one more byte, must push the project over the top.
        let remaining_plus_one = "b".repeat(
            usize::try_from(super::context::MAX_PROJECT_BYTES - super::context::MAX_FILE_BYTES + 1)
                .unwrap(),
        );
        let error = write_context_file(
            &daemon,
            project,
            "b.md",
            &remaining_plus_one,
            None,
            ContextWriteId::generate(),
        )
        .unwrap_err();
        assert_eq!(
            error.parallax_data().unwrap().kind,
            ErrorKind::ContextTooLarge
        );
    }
}
