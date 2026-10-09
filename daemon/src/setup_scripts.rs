//! Setup and settle scripts (PLX-650), as T3 Code's project scripts (`ProjectSetupScriptRunner`).
//!
//! A repository's scripts are stored by its path in `host_settings`, so a Project's children,
//! cut from the same repository, run them too. Its first `runOnWorktreeCreate` script is its
//! setup script and its first `runOnSettle` one its settle script, as in T3.
//!
//! - A new thread's worktree runs the setup script in the thread's terminal `setup-<id>`.
//!   Async by default, the agent starts alongside it. With `async: false`, [`worktree_created`]
//!   returns what the first turn waits for, and an error exit fails the run.
//! - Settling a thread runs the settle script in its worktree, in `settle-<id>-<8 hex>`, through
//!   the orchestrator's `settle-script.run` effect. A thread with no worktree of its own skips it.
//!
//! A script runs in the user's shell ([`crate::terminals::Terminals::run_script`]). A clean exit
//! closes its terminal; any other leaves the shell open with its output. Each start and end is a
//! `thread.script` event in the thread's own events, which the app shows in the thread.
//!
//! Trust: like T3 Code with `t3.json`, plxd never runs the scripts in a repository's
//! `parallax.json`. `repo/scripts` lists them, and they run only once the user imports and saves
//! them with `repo/saveScripts`.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, ParallaxEvent, ProjectId, RepoId, RepoSaveScriptsParams, RepoScript,
    RepoScriptsParams, RepoScriptsResult, RunId, ScriptStatus, ScriptTrigger,
};
use serde::Deserialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;

use crate::server::Daemon;
use crate::store::store_error;

/// The checked-in file at a repository's root that declares scripts, in `t3.json`'s shape.
const FILE_NAME: &str = "parallax.json";

/// The largest `parallax.json` plxd reads.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// The most scripts a repository has, as `t3.json` allows.
const MAX_SCRIPTS: usize = 50;

/// `parallax.json`. Like `t3.json`, it may hold `$schema`, `iconPath`, and other settings, and
/// each script an `icon` and a preview URL, which plxd ignores.
#[derive(Deserialize)]
struct ProjectFile {
    #[serde(default)]
    scripts: Vec<RepoScript>,
}

/// `repo/scripts`.
pub(crate) async fn scripts(
    daemon: &Daemon,
    params: RepoScriptsParams,
) -> Result<RepoScriptsResult, ErrorObject> {
    let path = repo_path(daemon, params.repo).await?;
    let scripts = stored(daemon, &path).await;
    let file = Path::new(&path).join(FILE_NAME);
    let (file_scripts, file_error) = match tokio::task::spawn_blocking(move || read_file(&file))
        .await
        .map_err(ErrorObject::internal_error)?
    {
        Ok(scripts) => (scripts, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    Ok(RepoScriptsResult {
        scripts,
        file_scripts,
        file_error,
    })
}

/// `repo/saveScripts`.
pub(crate) async fn save(
    daemon: &Daemon,
    params: RepoSaveScriptsParams,
) -> Result<RepoScriptsResult, ErrorObject> {
    let path = repo_path(daemon, params.repo).await?;
    let saved = checked(params.scripts).map_err(ErrorObject::invalid_params)?;
    let json = serde_json::to_string(&saved).map_err(ErrorObject::internal_error)?;
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let json = (!saved.is_empty()).then_some(json);
            db.set_repo_scripts(&path, json.as_deref())
                .map_err(|e| store_error(&e))
        })
        .await?;
    scripts(daemon, RepoScriptsParams { repo: params.repo }).await
}

/// Starts the setup script of the repository at `repo_path`, if it has one, in run `run_id`'s
/// new worktree `worktree`. For a script that isn't async, returns what the run's first turn
/// waits for: `Ok` once it exits cleanly, else why the run fails.
pub(crate) async fn worktree_created(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    scope: ProjectId,
    repo_path: &str,
    worktree: &Path,
) -> Option<impl Future<Output = Result<(), String>> + Send + 'static> {
    let script = stored(daemon, repo_path)
        .await
        .into_iter()
        .find(|script| script.run_on_worktree_create)?;
    let blocking = script.run_async == Some(false);
    let script = ThreadScript {
        run_id,
        scope,
        trigger: ScriptTrigger::Setup,
        terminal_id: format!("setup-{}", script.id),
        blocking,
        script,
    };
    let ended = script.start(daemon, repo_path, worktree).await;
    blocking.then_some(async move {
        ended
            .await
            .unwrap_or_else(|_| Err("plxd stopped before the setup script finished.".to_owned()))
    })
}

/// The `settle-script.run` effect: runs thread `thread`'s repository's settle script in its
/// worktree, if it still is settled and has one. Doesn't wait for it.
pub(crate) async fn settled(daemon: &Arc<Daemon>, thread: Uuid) {
    let rows = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let error = |e| store_error(&e);
            Ok((
                db.get_thread(thread).map_err(error)?,
                db.get_run(thread).map_err(error)?,
                db.get_worktree(thread).map_err(error)?,
            ))
        })
        .await;
    let (Some(row), Some(run), Some(worktree)) = (match rows {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error.message, "could not read a settled thread");
            return;
        }
    }) else {
        return;
    };
    // A thread re-engaged since keeps working there.
    if !row.settled || !Path::new(&worktree.path).is_dir() {
        return;
    }
    let (Ok(run_id), Ok(scope)) = (
        RunId::try_from(thread),
        ProjectId::try_from(run.fields.project_id),
    ) else {
        return;
    };
    let Some(script) = stored(daemon, &worktree.repo_path)
        .await
        .into_iter()
        .find(|script| script.run_on_settle)
    else {
        return;
    };
    // A thread settles again after it's resumed, and an earlier settle shell may still be busy.
    let suffix = Uuid::now_v7().simple().to_string();
    let script = ThreadScript {
        run_id,
        scope,
        trigger: ScriptTrigger::Settle,
        terminal_id: format!("settle-{}-{}", script.id, &suffix[suffix.len() - 8..]),
        blocking: false,
        script,
    };
    drop(
        script
            .start(daemon, &worktree.repo_path, Path::new(&worktree.path))
            .await,
    );
}

/// A script to run for a thread.
struct ThreadScript {
    run_id: RunId,
    scope: ProjectId,
    trigger: ScriptTrigger,
    terminal_id: String,
    blocking: bool,
    script: RepoScript,
}

impl ThreadScript {
    /// Starts it in `cwd` and reports it, then reports how it ended and closes its terminal if
    /// it exited cleanly. The receiver gets `Ok` for a clean exit, else why it failed.
    async fn start(
        self,
        daemon: &Arc<Daemon>,
        repo_path: &str,
        cwd: &Path,
    ) -> oneshot::Receiver<Result<(), String>> {
        let (done, ended) = oneshot::channel();
        let thread = self.run_id.to_string();
        let cwd = cwd.to_string_lossy();
        // Nobody may be attached yet to answer a color probe, so none is advertised (T3).
        let env = [
            ("PARALLAX_PROJECT_ROOT", repo_path),
            ("PARALLAX_WORKTREE_PATH", &*cwd),
            ("NO_COLOR", "1"),
            ("FORCE_COLOR", "0"),
            ("COLORTERM", ""),
        ];
        let started = daemon.terminals.run_script(
            &thread,
            &self.terminal_id,
            &cwd,
            &self.script.command,
            &env,
        );
        let code = match started {
            Ok(code) => code,
            Err(error) => {
                let message = format!(
                    "The {} script {} couldn't start: {}",
                    self.kind(),
                    self.script.name,
                    error.message
                );
                self.report(daemon, ScriptStatus::Failed, None, Some(error.message))
                    .await;
                let _ = done.send(Err(message));
                return ended;
            }
        };
        self.report(daemon, ScriptStatus::Running, None, None).await;
        let daemon = Arc::clone(daemon);
        tokio::spawn(async move {
            let code = code.await.ok().flatten();
            if code == Some(0) {
                daemon.terminals.close(thread, self.terminal_id.clone());
            }
            let status = if code == Some(0) {
                ScriptStatus::Done
            } else {
                ScriptStatus::Failed
            };
            self.report(&daemon, status, code, None).await;
            let name = &self.script.name;
            let kind = self.kind();
            let _ = done.send(match code {
                Some(0) => Ok(()),
                Some(code) => Err(format!(
                    "The {kind} script {name} exited with code {code}. Its terminal {} stays open.",
                    self.terminal_id
                )),
                None => Err(format!(
                    "The {kind} script {name}'s terminal closed before it finished."
                )),
            });
        });
        ended
    }

    fn kind(&self) -> &'static str {
        match self.trigger {
            ScriptTrigger::Setup => "setup",
            ScriptTrigger::Settle => "settle",
        }
    }

    /// Stages its `thread.script` event.
    async fn report(
        &self,
        daemon: &Daemon,
        status: ScriptStatus,
        exit_code: Option<i32>,
        error: Option<String>,
    ) {
        let scope = self.scope;
        let event = ParallaxEvent::ThreadScript {
            run_id: self.run_id,
            trigger: self.trigger,
            name: self.script.name.clone(),
            terminal_id: self.terminal_id.clone(),
            blocking: self.blocking,
            status,
            exit_code,
            error,
        };
        let staged = daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                db.stage(Timestamp::now(), Some(scope), event);
                Ok(())
            })
            .await;
        if let Err(error) = staged {
            warn!(error = %error.message, "could not record a thread's script");
        }
    }
}

/// The path of repo entry `repo`.
async fn repo_path(daemon: &Daemon, repo: RepoId) -> Result<String, ErrorObject> {
    daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.get_repo(repo.into())
                .map_err(|e| store_error(&e))?
                .map(|row| row.fields.path)
                .ok_or_else(|| {
                    ErrorObject::parallax(
                        ErrorKind::RepoNotFound,
                        format!("no repo entry has id {repo}"),
                    )
                })
        })
        .await
}

/// The saved scripts of the repository at `path`, or none when they can't be read.
async fn stored(daemon: &Daemon, path: &str) -> Vec<RepoScript> {
    let path = path.to_owned();
    let read = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.repo_scripts(&path).map_err(|e| store_error(&e))
        })
        .await;
    match read.map(|json| json.map(|json| serde_json::from_str(&json))) {
        Ok(None) => Vec::new(),
        Ok(Some(Ok(scripts))) => scripts,
        Ok(Some(Err(error))) => {
            warn!(%error, "a repository's stored scripts are unreadable");
            Vec::new()
        }
        Err(error) => {
            warn!(error = %error.message, "could not read a repository's scripts");
            Vec::new()
        }
    }
}

/// The scripts in `parallax.json` at `file`, none when there is no file, or why it's invalid.
fn read_file(file: &Path) -> Result<Vec<RepoScript>, String> {
    let Ok(metadata) = std::fs::metadata(file) else {
        return Ok(Vec::new());
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("{FILE_NAME} is larger than 1 MiB."));
    }
    let text = std::fs::read_to_string(file).map_err(|error| format!("{FILE_NAME}: {error}"))?;
    let parsed: ProjectFile =
        serde_json::from_str(&text).map_err(|error| format!("{FILE_NAME}: {error}"))?;
    checked(parsed.scripts).map_err(|error| format!("{FILE_NAME}: {error}"))
}

/// `scripts` trimmed, checked, and given ids from their names, unique among them.
fn checked(scripts: Vec<RepoScript>) -> Result<Vec<RepoScript>, String> {
    if scripts.len() > MAX_SCRIPTS {
        return Err(format!("a repository has at most {MAX_SCRIPTS} scripts"));
    }
    let mut ids: Vec<String> = Vec::new();
    scripts
        .into_iter()
        .map(|script| {
            let name = script.name.trim().to_owned();
            let command = script.command.trim().to_owned();
            if name.is_empty() || command.is_empty() {
                return Err("each script needs a name and a command".to_owned());
            }
            let base = slug(&name);
            let id = (1..=MAX_SCRIPTS + 1)
                .map(|n| match n {
                    1 => base.clone(),
                    n => format!("{base}-{n}"),
                })
                .find(|id| !ids.contains(id))
                .unwrap_or_default();
            ids.push(id.clone());
            Ok(RepoScript {
                id,
                name,
                command,
                ..script
            })
        })
        .collect()
}

/// A script's id from its name, for its terminal's: lowercase letters, digits, and hyphens.
fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 32 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "script".to_owned()
    } else {
        slug.to_owned()
    }
}

#[cfg(test)]
mod tests;
