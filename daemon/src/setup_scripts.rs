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
//! closes its terminal unless something it started still runs there; any other leaves the shell
//! open with its output. Stopping or deleting a run a script holds closes the script's terminal
//! ([`release`]), and the run ends cancelled. Each start and end is a `thread.script` event in the
//! thread's own events, which the app shows in the thread. The scripts still running are kept in
//! `host_settings`, so the next start ends each as interrupted ([`recover`]).
//!
//! Trust: like T3 Code with `t3.json`, plxd never runs the scripts in a repository's
//! `parallax.json`. `repo/scripts` lists them, and they run only once the user imports and saves
//! them with `repo/saveScripts`.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, ParallaxEvent, ProjectId, RepoId, RepoSaveScriptsParams, RepoScript,
    RepoScriptsParams, RepoScriptsResult, RunId, ScriptStatus, ScriptTrigger,
};
use serde::{Deserialize, Serialize};
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

/// The runs whose first turn a blocking setup script holds, with its terminal, for
/// [`release`].
pub(crate) type Holds = Mutex<HashMap<RunId, String>>;

/// How a script that holds a run's first turn ended: `Ok` after a clean exit, `Err(None)` when
/// [`release`] stopped it, else why the run fails.
pub(crate) type Held = Result<(), Option<String>>;

/// Starts the setup script of the repository at `repo_path`, if it has one, in run `run_id`'s
/// new worktree `worktree`. For a script that isn't async, returns what the run's first turn
/// waits for.
pub(crate) async fn worktree_created(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    scope: ProjectId,
    repo_path: &str,
    worktree: &Path,
) -> Option<impl Future<Output = Held> + Send + 'static> {
    let script = stored(daemon, repo_path)
        .await
        .into_iter()
        .find(|script| script.run_on_worktree_create)?;
    let blocking = script.run_async == Some(false);
    let script = ThreadScript {
        started: Started {
            run_id,
            scope,
            trigger: ScriptTrigger::Setup,
            name: script.name,
            terminal_id: format!("setup-{}", script.id),
            blocking,
        },
        command: script.command,
    };
    let ended = script.start(daemon, repo_path, worktree).await;
    blocking.then_some(async move {
        ended.await.unwrap_or_else(|_| {
            Err(Some(
                "plxd stopped before the setup script finished.".to_owned(),
            ))
        })
    })
}

/// Stops the blocking setup script that holds run `run_id`'s first turn, if one does, by closing
/// its terminal, so a Stop or delete reaches the run at once and it ends cancelled, as T3's
/// `worktreeSetupCancel` does.
pub(crate) fn release(daemon: &Daemon, run_id: RunId) {
    let held = lock(&daemon.setup_holds).remove(&run_id);
    if let Some(terminal_id) = held {
        daemon.terminals.close(run_id.to_string(), terminal_id);
    }
}

/// At start, before anything runs: every script the last plxd started and never saw end died
/// with it, so each gets its `interrupted` event. One store job, with no process or wait; a
/// failure is logged and leaves the list for the next start.
pub(crate) async fn recover(daemon: &Daemon) {
    let recovered = daemon
        .store
        .run(&CancellationToken::new(), |db| {
            let Some(json) = db.running_scripts().map_err(|e| store_error(&e))? else {
                return Ok(());
            };
            let running: Vec<Started> = serde_json::from_str(&json).unwrap_or_default();
            for script in running {
                let scope = script.scope;
                db.stage(
                    Timestamp::now(),
                    Some(scope),
                    script.event(ScriptStatus::Interrupted, None, None),
                );
            }
            db.set_running_scripts(None).map_err(|e| store_error(&e))
        })
        .await;
    if let Err(error) = recovered {
        warn!(error = %error.message, "could not end the scripts a restart interrupted");
    }
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
        started: Started {
            run_id,
            scope,
            trigger: ScriptTrigger::Settle,
            name: script.name,
            terminal_id: format!("settle-{}-{}", script.id, &suffix[suffix.len() - 8..]),
            blocking: false,
        },
        command: script.command,
    };
    drop(
        script
            .start(daemon, &worktree.repo_path, Path::new(&worktree.path))
            .await,
    );
}

/// A thread's script as its events name it, and as `running_scripts` keeps it until it ends.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Started {
    run_id: RunId,
    scope: ProjectId,
    trigger: ScriptTrigger,
    name: String,
    terminal_id: String,
    blocking: bool,
}

impl Started {
    fn event(
        &self,
        status: ScriptStatus,
        exit_code: Option<i32>,
        error: Option<String>,
    ) -> ParallaxEvent {
        ParallaxEvent::ThreadScript {
            run_id: self.run_id,
            trigger: self.trigger,
            name: self.name.clone(),
            terminal_id: self.terminal_id.clone(),
            blocking: self.blocking,
            status,
            exit_code,
            error,
        }
    }
}

/// A script to run for a thread.
struct ThreadScript {
    started: Started,
    command: String,
}

impl ThreadScript {
    /// Starts it in `cwd` and reports it, then reports how it ended and closes its terminal if
    /// it exited cleanly with nothing left running there. The receiver gets how it ended.
    async fn start(
        self,
        daemon: &Arc<Daemon>,
        repo_path: &str,
        cwd: &Path,
    ) -> oneshot::Receiver<Held> {
        let (done, ended) = oneshot::channel();
        let script = self.started;
        let thread = script.run_id.to_string();
        let cwd = cwd.to_string_lossy();
        // Nobody may be attached yet to answer a color probe, so none is advertised (T3).
        let env = [
            ("PARALLAX_PROJECT_ROOT", repo_path),
            ("PARALLAX_WORKTREE_PATH", &*cwd),
            ("NO_COLOR", "1"),
            ("FORCE_COLOR", "0"),
            ("COLORTERM", ""),
        ];
        let kind = match script.trigger {
            ScriptTrigger::Setup => "setup",
            ScriptTrigger::Settle => "settle",
        };
        let code = match daemon.terminals.run_script(
            &thread,
            &script.terminal_id,
            &cwd,
            &self.command,
            &env,
        ) {
            Ok(code) => code,
            Err(error) => {
                let message = format!(
                    "The {kind} script {} couldn't start: {}",
                    script.name, error.message
                );
                report(
                    daemon,
                    &script,
                    ScriptStatus::Failed,
                    None,
                    Some(error.message),
                )
                .await;
                let _ = done.send(Err(Some(message)));
                return ended;
            }
        };
        if script.blocking {
            lock(&daemon.setup_holds).insert(script.run_id, script.terminal_id.clone());
        }
        report(daemon, &script, ScriptStatus::Running, None, None).await;
        let daemon = Arc::clone(daemon);
        tokio::spawn(async move {
            let code = code.await;
            // `release` took the hold first: the user stopped the run.
            let released =
                script.blocking && lock(&daemon.setup_holds).remove(&script.run_id).is_none();
            let (status, held) = match code {
                _ if released => (ScriptStatus::Cancelled, Err(None)),
                Some(0) => (ScriptStatus::Done, Ok(())),
                Some(code) => (
                    ScriptStatus::Failed,
                    Err(Some(format!(
                        "The {kind} script {} exited with code {code}. Its terminal {} stays open.",
                        script.name, script.terminal_id
                    ))),
                ),
                None => (
                    ScriptStatus::Failed,
                    Err(Some(format!(
                        "The {kind} script {}'s terminal closed before it finished.",
                        script.name
                    ))),
                ),
            };
            if status == ScriptStatus::Done {
                let closing = Arc::clone(&daemon);
                let terminal_id = script.terminal_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    closing.terminals.close_idle(&thread, &terminal_id);
                })
                .await;
            }
            report(&daemon, &script, status, code, None).await;
            let _ = done.send(held);
        });
        ended
    }
}

/// Stages `script`'s `thread.script` event, and keeps `running_scripts` in step with it, in one
/// job on the writer.
async fn report(
    daemon: &Daemon,
    script: &Started,
    status: ScriptStatus,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    let script = script.clone();
    let staged = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let mut running: Vec<Started> = db
                .running_scripts()
                .map_err(|e| store_error(&e))?
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default();
            running.retain(|other| other != &script);
            if status == ScriptStatus::Running {
                running.push(script.clone());
            }
            let json = serde_json::to_string(&running).map_err(ErrorObject::internal_error)?;
            db.set_running_scripts((!running.is_empty()).then_some(json.as_str()))
                .map_err(|e| store_error(&e))?;
            db.stage(
                Timestamp::now(),
                Some(script.scope),
                script.event(status, exit_code, error),
            );
            Ok(())
        })
        .await;
    if let Err(error) = staged {
        warn!(error = %error.message, "could not record a thread's script");
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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
