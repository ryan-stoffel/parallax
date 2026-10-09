//! Per-turn checkpoints, their diffs, and revert (0062, after T3 Code's `checkpointing/` and
//! `orchestration-v2/Checkpoint*`).
//!
//! A run's checkpoint is the git ref [`reference`], `refs/parallax/checkpoints/<thread>/<ordinal>`,
//! holding the thread's folder (its worktree, or a Current checkout thread's checkout) as the
//! run's turn left it; ordinal 0 is the thread's start. `Tx::stage`'s graph fold enqueues the
//! `checkpoint.capture` effect in the transaction that ends a run `completed`, `interrupted`, or
//! `cancelled`, and [`capture`] runs it and stores the outcome as a `thread.checkpoint` event,
//! which the fold writes onto the run. A coordinator writes nothing (0024) and gets none.
//!
//! Before the actor hands a thread's CLI a new turn, [`before_turn`] waits for the thread's
//! captures and captures the previous ordinal if it has no ref: the thread's start, or the first
//! turn after a revert, as T3 captures a run's baseline when it starts. A worktree's start is its
//! base commit, which needs no scan.
//!
//! [`turn_diff`] diffs two checkpoints, [`full_thread_diff`] one against the thread's start, both
//! cut at [`MAX_DIFF_BYTES`] and with whitespace ignored unless asked, as T3's are. A revert
//! (`checkpoint.rollback`) is checked by [`plan_revert`], carried out by the thread's actor, which
//! rewinds the provider, and finished by [`finish_revert`]: the files, the refs above the target,
//! and `thread.reverted`, which marks the runs it undid `rolledBack`.
//!
//! Refs aren't capped by count, as T3's aren't: a revert deletes those above its target, and a
//! thread's deletion or Accept deletes the rest ([`forget`]).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    CheckpointFile, CheckpointStatus, ErrorKind, FullThreadDiffParams, ParallaxEvent, ProjectId,
    RunId, ThreadRun, ThreadRunStatus, ThreadRunsParams, ThreadRunsResult, TurnCheckpoint,
    TurnDiffParams, TurnDiffResult, TurnId,
};
use parallax_store::Store;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::server::Daemon;
use crate::store::store_error;
use crate::worktree::{DiffFormat, RunFolder, parse_numstat_z};

/// The largest diff a query returns, as T3 Code's; a longer one is cut.
pub(crate) const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;

/// How long a turn waits for its thread's captures before it starts anyway.
const CAPTURE_WAIT: Duration = Duration::from_secs(30);

/// What T3 Code says when a folder others share can't have its files restored.
const SHARED: &str = "File restore requires an isolated worktree. This workspace may contain \
                      changes from another thread. Rewind the conversation without restoring \
                      files instead.";

/// The ref holding thread `thread`'s checkpoint after run `ordinal`, or its start for 0.
pub(crate) fn reference(thread: Uuid, ordinal: u32) -> String {
    format!("{}{ordinal}", prefix(thread))
}

fn prefix(thread: Uuid) -> String {
    format!("refs/parallax/checkpoints/{thread}/")
}

/// A thread's folder, owned: its worktree with the pinned git folder and base commit, or its
/// checkout.
pub(crate) struct Folder {
    path: PathBuf,
    git_dir: Option<PathBuf>,
    base: Option<String>,
    project: ProjectId,
}

impl Folder {
    fn run_folder(&self) -> RunFolder<'_> {
        match &self.git_dir {
            Some(git_dir) => RunFolder::Worktree {
                path: &self.path,
                git_dir,
            },
            None => RunFolder::Checkout(&self.path),
        }
    }
}

/// Thread `thread`'s folder, or `None` for one with no checkpoints: a coordinator, an accepted
/// thread, whose worktree is gone, or no thread at all.
fn folder(db: &Store, thread: Uuid) -> Result<Option<Folder>, ErrorObject> {
    let error = |error| store_error(&error);
    let Some(run) = db.get_run(thread).map_err(error)? else {
        return Ok(None);
    };
    let Ok(project) = ProjectId::try_from(run.fields.project_id) else {
        return Ok(None);
    };
    if run.fields.policy == crate::agents::NO_WRITE {
        return Ok(None);
    }
    if run.fields.checkout {
        let path = crate::threads::scope_path(db, project)?;
        return Ok(Some(Folder {
            path: path.into(),
            git_dir: None,
            base: None,
            project,
        }));
    }
    Ok(db
        .get_worktree(thread)
        .map_err(error)?
        .filter(|worktree| !worktree.git_dir.is_empty())
        .map(|worktree| Folder {
            path: worktree.path.into(),
            git_dir: Some(worktree.git_dir.into()),
            base: Some(worktree.base),
            project,
        }))
}

/// The `checkpoint.capture` effect: captures run `turn`, ordinal `ordinal`, of thread `thread`,
/// unless it has its checkpoint or was undone, and stores the outcome. Replay-safe.
pub(crate) async fn capture(
    daemon: &Daemon,
    thread: Uuid,
    turn: TurnId,
    ordinal: u32,
) -> Result<(), ErrorObject> {
    let (folder, run) = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let run = db
                .graph_run(thread, turn.into())
                .map_err(|error| store_error(&error))?
                .and_then(|row| serde_json::from_str::<ThreadRun>(&row.payload).ok());
            Ok((folder(db, thread)?, run))
        })
        .await?;
    let (Some(folder), Some(run)) = (folder, run) else {
        return Ok(());
    };
    if run.checkpoint.is_some() || run.status == ThreadRunStatus::RolledBack {
        return Ok(());
    }
    let worktrees = daemon.agents.worktrees();
    let started = std::time::Instant::now();
    let reference = reference(thread, ordinal);
    let checkpoint = match worktrees
        .capture_checkpoint(folder.run_folder(), &reference)
        .await
    {
        Ok(()) => {
            let millis = started.elapsed().as_millis();
            info!(%thread, ordinal, millis, "captured a turn's checkpoint");
            TurnCheckpoint {
                status: CheckpointStatus::Ready,
                files: files(daemon, &folder, thread, ordinal).await,
            }
        }
        Err(error) => {
            warn!(%thread, ordinal, %error, "could not capture a turn's checkpoint");
            TurnCheckpoint {
                status: CheckpointStatus::Error,
                files: Vec::new(),
            }
        }
    };
    let run_id = RunId::try_from(thread).map_err(|_| ErrorObject::internal_error("bad id"))?;
    let event = ParallaxEvent::ThreadCheckpoint {
        run_id,
        turn_id: turn,
        ordinal,
        checkpoint,
    };
    stage(daemon, thread, folder.project, event).await
}

/// The files run `ordinal` changed, from the checkpoint before it, or none when that is gone.
async fn files(
    daemon: &Daemon,
    folder: &Folder,
    thread: Uuid,
    ordinal: u32,
) -> Vec<CheckpointFile> {
    let Some(previous) = ordinal.checked_sub(1) else {
        return Vec::new();
    };
    let diffed = daemon
        .agents
        .worktrees()
        .diff_checkpoints(
            folder.run_folder(),
            &reference(thread, previous),
            &reference(thread, ordinal),
            DiffFormat::Numstat,
            MAX_DIFF_BYTES,
        )
        .await;
    match diffed {
        Ok((numstat, _)) => parse_numstat_z(&numstat)
            .into_iter()
            .map(|(path, additions, deletions)| CheckpointFile {
                path,
                additions,
                deletions,
            })
            .collect(),
        // A turn whose baseline is missing, such as the first after an update, lists none.
        Err(_) => Vec::new(),
    }
}

async fn stage(
    daemon: &Daemon,
    thread: Uuid,
    project: ProjectId,
    event: ParallaxEvent,
) -> Result<(), ErrorObject> {
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            // A thread deleted while its checkpoint was captured keeps no event of it.
            if db
                .get_run(thread)
                .map_err(|error| store_error(&error))?
                .is_some()
            {
                db.stage(Timestamp::now(), Some(project), event);
            }
            Ok(())
        })
        .await
}

/// Before a new turn in thread `thread`: waits for its captures, then captures the checkpoint
/// the turn starts from if its ref is missing. A failure is logged, and the turn starts anyway.
pub(crate) async fn before_turn(daemon: &Daemon, thread: RunId) {
    let thread = Uuid::from(thread);
    wait_captures(daemon, thread).await;
    // On the writer, so a thread from before the graph is imported first and its ordinals count.
    let read = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.import_thread(thread)?;
            let last = db
                .next_run_ordinal(thread)
                .map_err(|error| store_error(&error))?
                - 1;
            Ok((folder(db, thread)?, last))
        })
        .await;
    let (folder, ordinal) = match read {
        Ok((Some(folder), ordinal)) => (folder, ordinal),
        Ok(_) => return,
        Err(error) => {
            warn!(%thread, error = %error.message, "could not read a thread's checkpoints");
            return;
        }
    };
    let worktrees = daemon.agents.worktrees();
    let reference = reference(thread, ordinal);
    if worktrees
        .has_checkpoint(folder.run_folder(), &reference)
        .await
        .unwrap_or(true)
    {
        return;
    }
    // A worktree's start is its base, which it was made from: no scan of its files, which a
    // checkout that just wrote them makes slow.
    let started = match (&folder.base, ordinal) {
        (Some(base), 0) => {
            worktrees
                .point_checkpoint(folder.run_folder(), &reference, base)
                .await
        }
        _ => {
            worktrees
                .capture_checkpoint(folder.run_folder(), &reference)
                .await
        }
    };
    if let Err(error) = started {
        warn!(%thread, ordinal, %error, "could not capture the checkpoint a turn starts from");
    }
}

/// Waits until thread `thread` has no `checkpoint.capture` effect left, or [`CAPTURE_WAIT`]
/// passes.
async fn wait_captures(daemon: &Daemon, thread: Uuid) {
    let deadline = tokio::time::Instant::now() + CAPTURE_WAIT;
    loop {
        let finished = daemon.orchestrator.effect_finished();
        tokio::pin!(finished);
        finished.as_mut().enable();
        let open = daemon
            .reader
            .run(&CancellationToken::new(), move |db| {
                db.has_open_effect(thread, crate::orchestrator::CHECKPOINT_CAPTURE)
                    .map_err(|error| store_error(&error))
            })
            .await;
        if !open.unwrap_or(false) {
            return;
        }
        tokio::select! {
            () = finished => {}
            () = tokio::time::sleep_until(deadline) => {
                warn!(%thread, "a turn starts while its thread's checkpoint is still being captured");
                return;
            }
        }
    }
}

/// `orchestration/threadRuns`.
pub(crate) async fn thread_runs(
    daemon: &Daemon,
    params: ThreadRunsParams,
) -> Result<ThreadRunsResult, ErrorObject> {
    let thread = params.thread_id.into();
    let runs = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            if db.get_run(thread).map_err(|e| store_error(&e))?.is_none() {
                return Err(crate::agents::run_not_found(params.thread_id));
            }
            crate::graph::runs(db, thread)
        })
        .await?;
    Ok(ThreadRunsResult { runs })
}

/// `orchestration/getTurnDiff`.
pub(crate) async fn turn_diff(
    daemon: &Daemon,
    params: TurnDiffParams,
) -> Result<TurnDiffResult, ErrorObject> {
    let TurnDiffParams {
        thread_id,
        from,
        to,
        ignore_whitespace,
    } = params;
    if from > to {
        return Err(ErrorObject::invalid_params("from must not be after to"));
    }
    if from == to {
        return Ok(TurnDiffResult {
            diff: String::new(),
            truncated: false,
        });
    }
    let thread = Uuid::from(thread_id);
    let (folder, runs) = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            Ok((folder(db, thread)?, crate::graph::runs(db, thread)?))
        })
        .await?;
    let ready = runs.iter().any(|run| {
        run.ordinal == Some(to)
            && run.status != ThreadRunStatus::RolledBack
            && run
                .checkpoint
                .as_ref()
                .is_some_and(|checkpoint| checkpoint.status == CheckpointStatus::Ready)
    });
    let Some(folder) = folder.filter(|_| ready) else {
        return Err(ErrorObject::invalid_params(format!(
            "thread {thread_id} has no ready checkpoint for run {to}"
        )));
    };
    let (diff, truncated) = daemon
        .agents
        .worktrees()
        .diff_checkpoints(
            folder.run_folder(),
            &reference(thread, from),
            &reference(thread, to),
            DiffFormat::Patch {
                ignore_whitespace: ignore_whitespace != Some(false),
            },
            MAX_DIFF_BYTES,
        )
        .await
        .map_err(|error| {
            ErrorObject::invalid_params(format!(
                "thread {thread_id}'s checkpoints for runs {from} to {to} can't be diffed: {error}"
            ))
        })?;
    Ok(TurnDiffResult { diff, truncated })
}

/// `orchestration/getFullThreadDiff`: [`turn_diff`] from the thread's start.
pub(crate) async fn full_thread_diff(
    daemon: &Daemon,
    params: FullThreadDiffParams,
) -> Result<TurnDiffResult, ErrorObject> {
    let FullThreadDiffParams {
        thread_id,
        to,
        ignore_whitespace,
    } = params;
    turn_diff(
        daemon,
        TurnDiffParams {
            thread_id,
            from: 0,
            to,
            ignore_whitespace,
        },
    )
    .await
}

/// Deletes thread `thread`'s checkpoint refs from the repository at `repo`, once the thread is
/// deleted or accepted. A failure is logged: the refs only keep objects alive.
pub(crate) async fn forget(daemon: &Daemon, repo: &Path, thread: Uuid) {
    let worktrees = daemon.agents.worktrees();
    let folder = RunFolder::Checkout(repo);
    let refs = match worktrees.list_refs(folder, &prefix(thread)).await {
        Ok(refs) => refs,
        Err(error) => {
            warn!(%thread, %error, "could not list a thread's checkpoints to delete them");
            return;
        }
    };
    // ponytail: one `update-ref -d` per ref; `update-ref --stdin` if threads get thousands.
    for reference in refs {
        if let Err(error) = worktrees.delete_ref(folder, &reference).await {
            warn!(%thread, %error, "could not delete a thread's checkpoint");
        }
    }
}

/// A revert that passed its checks: what [`finish_revert`] and the actor's rewind do.
pub(crate) struct Revert {
    thread: Uuid,
    pub ordinal: u32,
    pub restore_files: bool,
    /// The provider's turns to drop.
    pub turns: u32,
    /// The runs it undoes, oldest first.
    undone: Vec<TurnId>,
    folder: Folder,
}

impl Revert {
    /// The folder the thread works in.
    pub(crate) fn cwd(&self) -> &Path {
        &self.folder.path
    }
}

/// Checks `checkpoint.rollback` to run `ordinal` of thread `thread`, whose backend `backend`
/// can rewind when `can_rewind`, before anything changes. Waits for the thread's captures first.
///
/// # Errors
///
/// `revertRefused` with the reason, or a store or git failure.
pub(crate) async fn plan_revert(
    daemon: &Daemon,
    thread: RunId,
    ordinal: u32,
    restore_files: bool,
    backend: &str,
    can_rewind: bool,
) -> Result<Revert, ErrorObject> {
    let id = Uuid::from(thread);
    wait_captures(daemon, id).await;
    let (folder, runs, shared) = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let folder = folder(db, id)?;
            let shared = match &folder {
                Some(Folder {
                    path,
                    git_dir: Some(_),
                    ..
                }) => db
                    .worktree_shared(id, &path.to_string_lossy())
                    .map_err(|error| store_error(&error))?,
                _ => true,
            };
            Ok((folder, crate::graph::runs(db, id)?, shared))
        })
        .await?;
    let Some(folder) = folder else {
        return Err(refused(format!("thread {thread} has no folder to revert")));
    };
    let check = Check {
        ordinal,
        restore_files,
        can_rewind,
        isolated: !shared,
    };
    let (turns, undone) = check.run(&runs, backend).map_err(refused)?;
    let worktrees = daemon.agents.worktrees();
    if !worktrees
        .has_checkpoint(folder.run_folder(), &reference(id, ordinal))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
    {
        return Err(refused(format!(
            "thread {thread} has no checkpoint for run {ordinal}"
        )));
    }
    Ok(Revert {
        thread: id,
        ordinal,
        restore_files,
        turns,
        undone,
        folder,
    })
}

fn refused(why: String) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::RevertRefused, why)
}

/// What a revert's checks read besides the thread's runs.
struct Check {
    ordinal: u32,
    restore_files: bool,
    can_rewind: bool,
    /// Whether the folder is the thread's own worktree, which no other thread shares.
    isolated: bool,
}

impl Check {
    /// The provider turns a revert drops, and the runs it undoes, or why it is refused.
    fn run(&self, runs: &[ThreadRun], backend: &str) -> Result<(u32, Vec<TurnId>), String> {
        let ordinal = self.ordinal;
        if !self.can_rewind {
            return Err(format!("{backend} can't rewind a conversation"));
        }
        if self.restore_files && !self.isolated {
            return Err(SHARED.to_owned());
        }
        let started: Vec<&ThreadRun> = runs.iter().filter(|run| run.ordinal.is_some()).collect();
        if started.iter().any(|run| {
            matches!(
                run.status,
                ThreadRunStatus::Starting | ThreadRunStatus::Running | ThreadRunStatus::Waiting
            )
        }) {
            return Err("a turn is still running; revert once it ends".to_owned());
        }
        if ordinal > 0
            && !started.iter().any(|run| {
                run.ordinal == Some(ordinal)
                    && run.status != ThreadRunStatus::RolledBack
                    && run
                        .checkpoint
                        .as_ref()
                        .is_some_and(|checkpoint| checkpoint.status == CheckpointStatus::Ready)
            })
        {
            return Err(format!("run {ordinal} has no ready checkpoint"));
        }
        let mut turns = 0;
        let mut undone = Vec::new();
        let mut previous: Option<&ThreadRun> = None;
        for run in started {
            let after = run.ordinal > Some(ordinal) && run.status != ThreadRunStatus::RolledBack;
            if after {
                undone.push(run.id);
                // A message steered into the turn before it ran in that turn: one provider turn.
                let steered = previous
                    .and_then(|previous| previous.completed_at)
                    .zip(run.started_at)
                    .is_some_and(|(ended, started)| ended > started);
                if !steered {
                    turns += 1;
                }
            }
            if run.status != ThreadRunStatus::RolledBack {
                previous = Some(run);
            }
        }
        Ok((turns, undone))
    }
}

/// Finishes `revert` once the provider has rewound: the files when it restores them, the refs
/// above its target, and `thread.reverted`.
///
/// # Errors
///
/// A git or store failure.
pub(crate) async fn finish_revert(daemon: &Arc<Daemon>, revert: Revert) -> Result<(), ErrorObject> {
    let Revert {
        thread,
        ordinal,
        restore_files,
        undone,
        folder,
        ..
    } = revert;
    let worktrees = daemon.agents.worktrees();
    let failed = |what: &str, error: crate::worktree::WorktreeError| {
        ErrorObject::internal_error(format!("could not {what}: {error}"))
    };
    if restore_files {
        worktrees
            .restore_checkpoint(folder.run_folder(), &reference(thread, ordinal))
            .await
            .map_err(|error| failed("restore the checkpoint's files", error))?;
    }
    let refs = worktrees
        .list_refs(folder.run_folder(), &prefix(thread))
        .await
        .map_err(|error| failed("list the thread's checkpoints", error))?;
    for stale in refs.iter().filter(|reference| {
        reference
            .rsplit('/')
            .next()
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| n > ordinal)
    }) {
        worktrees
            .delete_ref(folder.run_folder(), stale)
            .await
            .map_err(|error| failed("delete a stale checkpoint", error))?;
    }
    let run_id = RunId::try_from(thread).map_err(|_| ErrorObject::internal_error("bad id"))?;
    info!(%thread, ordinal, restore_files, undone = undone.len(), "reverted a thread");
    let event = ParallaxEvent::ThreadReverted {
        run_id,
        ordinal,
        turns: undone,
        restore_files,
    };
    stage(daemon, thread, folder.project, event).await
}

#[cfg(test)]
mod tests;
