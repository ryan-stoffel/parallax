//! `repo/clone`, `repo/cloneProgress`, and `repo/remote` (PLX-905): cloning a repository onto
//! this host, for New Thread on a computer that lacks the repository it picked, and for Clone from
//! GitHub. git never waits on a prompt here: one it would show fails the clone instead. And
//! `repo/match` (0057): the repo entry that is this host's copy of another plxd's repository.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, RepoAddParams, RepoAddResult, RepoCloneParams, RepoCloneProgressParams,
    RepoCloneProgressResult, RepoId, RepoMatchParams, RepoMatchResult, RepoRemoteParams,
    RepoRemoteResult,
};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::backend::process::{Output, ProcessSpec};
use crate::server::Daemon;
use crate::threads;
use crate::worktree::{GIT_SCRUBBED, NO_HOOKS};

/// How long git may go without writing to stderr before the clone stops. `--progress` has it
/// write several times a second while it receives or checks out.
const STALL: Duration = Duration::from_mins(5);

/// The longest URL `repo/clone` takes.
const MAX_URL_BYTES: usize = 4096;

/// git's latest progress line for each clone under way, by the id it was given.
static PROGRESS: LazyLock<Mutex<HashMap<RepoId, String>>> = LazyLock::new(Mutex::default);

fn progress_lines() -> MutexGuard<'static, HashMap<RepoId, String>> {
    PROGRESS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `repo/clone`: clones `url` into `path`, an SSH URL falling back to HTTPS, then registers it.
pub(crate) async fn clone(
    daemon: Arc<Daemon>,
    params: RepoCloneParams,
) -> Result<RepoAddResult, ErrorObject> {
    let RepoCloneParams { id, url, path } = params;
    check_url(&url)?;
    let home = std::env::home_dir().filter(|home| home.is_absolute());
    let dest = crate::methods::host::expand_home(&path, home.as_deref())?;
    let Some(dest_text) = dest.to_str().map(str::to_owned) else {
        return Err(ErrorObject::invalid_params(format!(
            "{path} is not valid UTF-8"
        )));
    };
    threads::check_path(&dest_text)?;
    let register = |daemon: Arc<Daemon>| async move {
        threads::add_repo(
            &daemon,
            RepoAddParams {
                id,
                path: dest_text,
            },
        )
        .await
    };
    // What is already at the path is registered only when it is a clone of `url`.
    let check_existing = async |daemon: &Daemon| {
        if same_repo(daemon, &dest, &url).await {
            Ok(())
        } else {
            Err(ErrorObject::invalid_params(format!(
                "{path} already exists"
            )))
        }
    };
    // A retry after the answer was lost finds its own clone there.
    if dest.symlink_metadata().is_ok() {
        check_existing(&daemon).await?;
        return register(daemon).await;
    }
    let (Some(parent), Some(name)) = (dest.parent(), dest.file_name()) else {
        return Err(ErrorObject::invalid_params(format!(
            "{path} has no folder to go in"
        )));
    };
    std::fs::create_dir_all(parent).map_err(|error| {
        ErrorObject::invalid_params(format!("Can't create {}: {error}", parent.display()))
    })?;
    let Some(_progress) = Progress::start(id) else {
        return Err(ErrorObject::invalid_params(format!(
            "{path} is being cloned already"
        )));
    };
    // git writes HEAD and the origin before it fetches anything, so it clones into a folder of
    // this clone's own beside the path, and only a finished clone is renamed into the path. Only
    // that folder is ever removed.
    // ponytail: plxd stopped mid-clone leaves the hidden folder behind; sweep `.*.cloning-*` if
    // they pile up.
    let staging = parent.join(format!(".{}.cloning-{id}", name.to_string_lossy()));
    let mut reason = String::new();
    for candidate in std::iter::once(url.clone()).chain(https_fallback(&url)) {
        let cloned = run(&daemon, id, &candidate, &staging).await;
        if let Err(error) = cloned {
            reason = error;
            let _ = std::fs::remove_dir_all(&staging);
            continue;
        }
        info!(repo = %id, path = %dest.display(), "cloned a repository");
        // Another clone of the same path, such as one started by picking the computer again,
        // may have finished first.
        if dest.symlink_metadata().is_ok() {
            let _ = std::fs::remove_dir_all(&staging);
            check_existing(&daemon).await?;
            return register(daemon).await;
        }
        if let Err(error) = std::fs::rename(&staging, &dest) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(ErrorObject::parallax(
                ErrorKind::CloneFailed,
                format!("Can't move the clone into {path}: {error}"),
            ));
        }
        return register(daemon).await;
    }
    Err(ErrorObject::parallax(ErrorKind::CloneFailed, reason))
}

/// Whether `dest` is a clone of the repository `url` names.
async fn same_repo(daemon: &Daemon, dest: &Path, url: &str) -> bool {
    origin(daemon, dest)
        .await
        .is_some_and(|origin| repo_key(&origin) == repo_key(url))
}

/// `repo/cloneProgress`: git's latest progress line for clone `id`, while it runs.
pub(crate) async fn progress(
    params: RepoCloneProgressParams,
) -> Result<RepoCloneProgressResult, ErrorObject> {
    let progress = progress_lines()
        .get(&params.id)
        .filter(|line| !line.is_empty())
        .cloned();
    Ok(RepoCloneProgressResult { progress })
}

/// `repo/remote`: a repo entry's `origin` URL, with any user name and password taken out.
pub(crate) async fn remote(
    daemon: &Arc<Daemon>,
    params: RepoRemoteParams,
) -> Result<RepoRemoteResult, ErrorObject> {
    let entry = threads::start_entry(daemon, Some(params.repo)).await?;
    let url = origin(daemon, Path::new(&entry.fields.path))
        .await
        .map(|url| without_userinfo(&url));
    Ok(RepoRemoteResult { url })
}

/// `repo/match` (0057): the oldest repo entry whose `origin` names the same repository as
/// `params.origin`, as [`repo_key`] compares them. Spaces and the scratch entry have none.
pub(crate) async fn matching(
    daemon: &Arc<Daemon>,
    params: RepoMatchParams,
) -> Result<RepoMatchResult, ErrorObject> {
    check_url(&params.origin)?;
    let wanted = repo_key(&params.origin);
    let entries = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.list_repos()
                .map_err(|error| threads::store_error(&error))
        })
        .await?;
    // ponytail: one `git config` per entry, one at a time; fine for a host's handful of repos.
    for entry in entries
        .into_iter()
        .filter(|entry| !entry.fields.scratch && !entry.fields.space)
    {
        if origin(daemon, Path::new(&entry.fields.path))
            .await
            .is_some_and(|url| repo_key(&url) == wanted)
        {
            let repo = threads::repo_entry(entry)?;
            return Ok(RepoMatchResult { repo: Some(repo) });
        }
    }
    Ok(RepoMatchResult { repo: None })
}

/// Clone `id`'s entry in [`PROGRESS`], removed when it drops.
struct Progress(RepoId);

impl Progress {
    /// Adds clone `id`, or `None` when one with that id is under way.
    fn start(id: RepoId) -> Option<Self> {
        let mut all = progress_lines();
        if all.contains_key(&id) {
            return None;
        }
        all.insert(id, String::new());
        Some(Self(id))
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        progress_lines().remove(&self.0);
    }
}

/// `git args` as agents' CLIs start, never prompting: no terminal or credential manager prompt,
/// and SSH in batch mode, accepting a host key it hasn't seen.
fn git_spec(daemon: &Daemon, args: Vec<OsString>) -> ProcessSpec {
    let mut spec = ProcessSpec::new("git", daemon.data_dir.root());
    spec.args = ["-c", NO_HOOKS, "-c", "protocol.ext.allow=never"]
        .into_iter()
        .map(OsString::from)
        .chain(args)
        .collect();
    spec.scrub = GIT_SCRUBBED.iter().map(OsString::from).collect();
    spec.inject
        .set("GIT_TERMINAL_PROMPT", "0")
        .set("GCM_INTERACTIVE", "never")
        .set(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
        );
    spec
}

/// Runs `git clone` of `url` into `dest`, blobless, keeping its progress lines in [`PROGRESS`].
/// Resolves to git's reason when it fails, for people.
async fn run(daemon: &Daemon, id: RepoId, url: &str, dest: &Path) -> Result<(), String> {
    let mut spec = git_spec(
        daemon,
        ["clone", "--filter=blob:none", "--progress", "--", url]
            .into_iter()
            .map(OsString::from)
            .chain([dest.as_os_str().to_owned()])
            .collect(),
    );
    spec.stderr_lines = true;
    spec.stderr_progress = true;
    let mut process = daemon
        .cli_detector
        .launcher()
        .spawn(&spec)
        .map_err(|error| format!("git couldn't start: {error}"))?;
    let mut fatal = None;
    loop {
        // Dropping the process kills git and its helpers.
        let Ok(next) = tokio::time::timeout(STALL, process.next()).await else {
            return Err("git made no progress for 5 minutes".to_owned());
        };
        match next {
            Some(Output::Line(line)) => {
                let line = String::from_utf8_lossy(&line).trim().to_owned();
                // The first says why: a later one is git's generic "Could not read from remote".
                if fatal.is_none() {
                    fatal = failure(&line).map(str::to_owned);
                }
                if let Some(entry) = progress_lines().get_mut(&id) {
                    *entry = line;
                }
            }
            Some(Output::Oversized { .. }) => {}
            Some(Output::Exited(exit)) if exit.info.success() => return Ok(()),
            Some(Output::Exited(exit)) => {
                return Err(fatal
                    .or_else(|| exit.stderr_tail.lines().last().map(str::to_owned))
                    .unwrap_or_else(|| "git clone failed".to_owned()));
            }
            None => return Err("git stopped without an exit status".to_owned()),
        }
    }
}

/// The reason in one of git's `fatal:` or `error:` lines, or an SSH server's `ERROR:`.
fn failure(line: &str) -> Option<&str> {
    ["fatal:", "error:", "ERROR:"]
        .iter()
        .find_map(|prefix| line.strip_prefix(prefix))
        .map(str::trim)
}

/// The URL of `repo`'s `origin` remote, if it has one.
pub(crate) async fn origin(daemon: &Daemon, repo: &Path) -> Option<String> {
    let spec = git_spec(
        daemon,
        vec![
            "-C".into(),
            repo.as_os_str().to_owned(),
            "config".into(),
            "--get".into(),
            "remote.origin.url".into(),
        ],
    );
    let mut process = daemon.cli_detector.launcher().spawn(&spec).ok()?;
    let mut url = None;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), process.next()).await {
            Ok(Some(Output::Line(line))) => {
                url = Some(String::from_utf8_lossy(&line).trim().to_owned());
            }
            Ok(Some(Output::Oversized { .. })) => {}
            Ok(Some(Output::Exited(exit))) if exit.info.success() => {
                return url.filter(|url| !url.is_empty());
            }
            _ => return None,
        }
    }
}

fn check_url(url: &str) -> Result<(), ErrorObject> {
    if url.trim().is_empty() || url.len() > MAX_URL_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "url must be 1 to {MAX_URL_BYTES} bytes"
        )));
    }
    if url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(ErrorObject::invalid_params(
            "url must not start with - or contain control characters",
        ));
    }
    Ok(())
}

/// The HTTPS URL of an SSH one, `git@host:owner/name` or `ssh://git@host[:port]/owner/name`, or
/// `None` for any other.
fn https_fallback(url: &str) -> Option<String> {
    let rest = match url.strip_prefix("ssh://") {
        Some(rest) => rest.to_owned(),
        None if !url.contains("://") && url.contains('@') => url.replacen(':', "/", 1),
        None => return None,
    };
    let (authority, path) = rest.split_once('/')?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = host.split(':').next().filter(|host| !host.is_empty())?;
    Some(format!("https://{host}/{}", path.trim_start_matches('/')))
}

/// What names a repository whatever the URL's form: its host and path, lowercased, without a
/// user, port, or `.git`, so `git@github.com:o/r.git` and `https://github.com/O/r` match.
fn repo_key(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_owned(),
        None => url.replacen(':', "/", 1),
    };
    let (authority, path) = rest.split_once('/').unwrap_or((&rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = host.split(':').next().unwrap_or(host);
    format!("{host}/{path}").to_lowercase()
}

/// `url` without the user name and password an HTTP(S) URL can carry.
fn without_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    if !scheme.starts_with("http") {
        return url.to_owned();
    }
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    format!("{scheme}://{host}/{path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ssh_url_falls_back_to_https() {
        assert_eq!(
            https_fallback("git@github.com:ryan-stoffel/parallax.git").as_deref(),
            Some("https://github.com/ryan-stoffel/parallax.git")
        );
        assert_eq!(
            https_fallback("ssh://git@github.com:22/o/r").as_deref(),
            Some("https://github.com/o/r")
        );
        assert_eq!(https_fallback("https://github.com/o/r.git"), None);
        assert_eq!(https_fallback("/Users/me/src/r"), None);
    }

    #[test]
    fn ssh_and_https_urls_of_one_repository_match() {
        let key = repo_key("git@github.com:Ryan-Stoffel/parallax.git");
        assert_eq!(key, "github.com/ryan-stoffel/parallax");
        assert_eq!(repo_key("https://github.com/ryan-stoffel/parallax/"), key);
        assert_eq!(
            repo_key("ssh://git@github.com:22/ryan-stoffel/parallax"),
            key
        );
        assert_eq!(
            repo_key("https://me:token@GitHub.com/ryan-stoffel/parallax.git"),
            key
        );
        assert_eq!(
            repo_key("http://github.com/ryan-stoffel/parallax.git/"),
            key
        );
        assert_ne!(repo_key("https://github.com/ryan-stoffel/photon"), key);
    }

    #[test]
    fn a_shared_url_keeps_no_password() {
        assert_eq!(
            without_userinfo("https://me:token@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            without_userinfo("git@github.com:o/r.git"),
            "git@github.com:o/r.git"
        );
    }
}
