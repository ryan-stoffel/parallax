//! Admission control for `agent/start` (#197), and the one task that promotes queued runs.
//!
//! A per-host and a per-project limit gate how many non-thread runs may be `starting` or
//! `running` at once (0017's normal threads are a user's own chat, never limited or queued, since
//! the limit is on "running workers"). A run over the limit is recorded `queued` — an ordinary
//! `runs` row, no worktree, `backend`/`account_id` left at [`super::convert::UNRESOLVED`] — instead
//! of started. [`run`] is wispd's one scheduler task: it wakes on a [`tokio::sync::Notify`], a
//! periodic timer, or shutdown, and each wake runs one [`pass`], which promotes queued runs oldest
//! first as slots free up, skipping one whose resolved account is currently rate limited rather
//! than giving up for the whole host, since a different queued run may name a different, available
//! account.
//!
//! No store migration: ordering is `list_runs`'s existing `created_at ASC, id ASC`, and the two
//! limits are a [`crate::server::Config`] setting, the same kind every other tunable in `Config`
//! already is, not a store-backed or RPC-settable one.
//!
//! # Why one task, not a recursive `tick`
//!
//! An earlier version had `Actor::release_slot` call back into `tick` directly, awaited, guarded
//! by a `tokio::sync::Mutex` so only one pass ran at a time. That deadlocks: `pass` can promote a
//! run whose `Actor::launch` fails immediately, and `failed_to_start` calls `release_slot`, which
//! tried to take the same mutex `pass` was still holding. Every later `release_slot` then hung
//! forever too, since tokio's `Mutex` isn't reentrant, wedging every run's `agent/send`,
//! `agent/cancel`, and `agent/accept` along with it. Running that recursive `tick` inline in the
//! server's accept loop (as the periodic retry did) meant the same hang stopped wispd from
//! accepting connections at all. A single dedicated task removes the recursion entirely:
//! `release_slot` only ever calls [`Scheduler::wake`], a non-blocking `notify_one`, never `pass`
//! itself.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use tokio::sync::Notify;
use tokio::time::MissedTickBehavior;
use tracing::warn;
use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{AccountChoice, AgentFailureKind, AgentOutcome, ProjectId, RunId, WispEvent};
use wisp_store::{RunState, WorktreeFields};

use super::convert::{self, FAILED, QUEUED, STARTING};
use super::{Actor, create_worktree, prepare, store, store_error};
use crate::server::Daemon;

/// A cached reason for `Scheduler::reason`. `expires` is set only for a rate-limit reason, so a
/// pass that reads a stale one (the pause already expired) falls back to computing one live
/// instead of repeating wrong information until the next pass corrects it.
struct Reason {
    text: String,
    expires: Option<Timestamp>,
}

/// Host and project admission counters, and why a queued run is still waiting.
pub(super) struct Scheduler {
    host_limit: u32,
    project_limit: u32,
    host_active: AtomicU32,
    project_active: Mutex<HashMap<ProjectId, u32>>,
    /// An account known rate limited until this time, from a proactive `RateLimit` event or a
    /// `RateLimited` failure with no snapshot to go on (`actor::finish`).
    ///
    /// One cooldown per account, not per limit window (`ponytail`: a vendor with several windows,
    /// such as a five-hour and a weekly one, is treated as paused until the later of the two
    /// resets, which is safe — never starts early — if slightly conservative; per-window tracking
    /// is the upgrade if that proves too conservative in practice).
    rate_limited: Mutex<HashMap<String, Timestamp>>,
    /// The reason `pass` last found for a still-queued run. Absent for one only blocked on host
    /// or project capacity, whose reason `reason` computes live instead of caching.
    reasons: Mutex<HashMap<RunId, Reason>>,
    /// Wakes the scheduler task in [`run`]. `notify_one` is fire-and-forget and never blocks, so
    /// `Actor::release_slot` and `create`'s failure paths can call it from anywhere.
    notify: Notify,
}

impl Scheduler {
    pub(super) fn new(host_limit: u32, project_limit: u32) -> Self {
        Self {
            host_limit: host_limit.max(1),
            project_limit: project_limit.max(1),
            host_active: AtomicU32::new(0),
            project_active: Mutex::new(HashMap::new()),
            rate_limited: Mutex::new(HashMap::new()),
            reasons: Mutex::new(HashMap::new()),
            notify: Notify::new(),
        }
    }

    fn host_has_room(&self) -> bool {
        self.host_active.load(Ordering::Relaxed) < self.host_limit
    }

    fn project_count(&self, project: ProjectId) -> u32 {
        *self
            .project_active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&project)
            .unwrap_or(&0)
    }

    /// Reserves a host and a project slot for `project`, if both have room. The caller must
    /// [`Self::release`] this exact reservation once the run it started stops occupying it: its
    /// CLI stops being live, or never became live at all.
    ///
    /// One lock covers the read-then-increment of both counters together: `host_active` and one
    /// project's count must be checked and bumped atomically, or two concurrent admission
    /// decisions for two different runs could each see room and both proceed. #190's per-run-id
    /// locks don't help here, since admission spans every run id, not one.
    pub(super) fn reserve(&self, project: ProjectId) -> bool {
        let mut projects = self
            .project_active
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.host_active.load(Ordering::Relaxed) >= self.host_limit {
            return false;
        }
        let count = projects.entry(project).or_insert(0);
        if *count >= self.project_limit {
            return false;
        }
        *count += 1;
        self.host_active.fetch_add(1, Ordering::Relaxed);
        true
    }

    pub(super) fn release(&self, project: ProjectId) {
        let mut projects = self
            .project_active
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = projects.get_mut(&project) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                projects.remove(&project);
            }
        }
        self.host_active.fetch_sub(1, Ordering::Relaxed);
    }

    /// Wakes the scheduler task to run a pass now, instead of waiting for the periodic timer.
    pub(super) fn wake(&self) {
        self.notify.notify_one();
    }

    /// Records that `account_id` is rate limited until `until`. A later call with an earlier
    /// `until` for the same account is ignored, the same "never move a deadline earlier" rule
    /// `record_limit_snapshot` applies, for the same reason: an event that arrived out of order.
    pub(super) fn pause_account(&self, account_id: &str, until: Timestamp) {
        if account_id.is_empty() {
            return;
        }
        let mut paused = self
            .rate_limited
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let later = paused
            .get(account_id)
            .is_none_or(|&existing| until > existing);
        if later {
            paused.insert(account_id.to_owned(), until);
        }
    }

    /// `account_id`'s pause, if it hasn't passed yet. Sweeps it away once it has, so the map
    /// never grows with accounts that recovered.
    pub(super) fn paused_until(&self, account_id: &str) -> Option<Timestamp> {
        let mut paused = self
            .rate_limited
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match paused.get(account_id).copied() {
            Some(until) if until > Timestamp::now() => Some(until),
            Some(_) => {
                paused.remove(account_id);
                None
            }
            None => None,
        }
    }

    pub(super) fn set_reason(&self, run_id: RunId, text: String, expires: Option<Timestamp>) {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run_id, Reason { text, expires });
    }

    pub(super) fn clear_reason(&self, run_id: RunId) {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&run_id);
    }

    /// Why `run_id` (in `project`) is still queued, for `AgentRun::queued_reason`: `pass`'s cached
    /// reason (a rate limit, or a `prepare` failure) when it has one and it hasn't gone stale,
    /// otherwise the live host or project count — never a project count when neither limit is
    /// actually binding, which would misname why a run queued only for its turn (#197 review).
    pub(super) fn reason(&self, run_id: RunId, project: ProjectId) -> String {
        {
            let mut cached = self.reasons.lock().unwrap_or_else(PoisonError::into_inner);
            match cached.get(&run_id) {
                Some(reason) if reason.expires.is_none_or(|until| until > Timestamp::now()) => {
                    return reason.text.clone();
                }
                Some(_) => {
                    cached.remove(&run_id);
                }
                None => {}
            }
        }
        if !self.host_has_room() {
            return format!(
                "waiting for a host slot ({} of {} running)",
                self.host_active.load(Ordering::Relaxed),
                self.host_limit
            );
        }
        if self.project_count(project) >= self.project_limit {
            return format!(
                "waiting for a project slot ({} of {} running in this project)",
                self.project_count(project),
                self.project_limit
            );
        }
        "waiting for its turn".to_owned()
    }
}

/// The scheduler task: wispd's only promoter of queued runs. Runs one [`pass`] on startup (right
/// after `agents::recover`, so a run left `queued` across a restart is reconsidered immediately,
/// not only after the first periodic tick), then again on every wake — `Scheduler::wake` (a slot
/// freed, or a run was just queued) or the periodic timer (so a run waiting only on an account's
/// rate limit resumes once it resets, with no other run finishing to trigger a retry) — until
/// `shutdown` fires. Spawned once on `Agents`'s own tracker, so a stopping wispd waits for its
/// current pass, if any, the same way it waits for every run's actor.
pub(crate) async fn run(daemon: Arc<Daemon>, tick_interval: Duration) {
    let shutdown = daemon.agents.shutdown.clone();
    pass(&daemon).await;
    let mut interval = tokio::time::interval(tick_interval);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => return,
            () = daemon.agents.scheduler.notify.notified() => {},
            _ = interval.tick() => {},
        }
        pass(&daemon).await;
    }
}

/// One scan of the queue, oldest run first: promotes as many as the host and project limits
/// allow, skipping a run whose account is currently rate limited or that no longer exists to
/// promote (already resolved by a concurrent cancel), and failing outright — not leaving queued —
/// a run whose account or repository has become invalid since it was queued.
async fn pass(daemon: &Arc<Daemon>) {
    // A queued run must never be promoted while wispd is stopping: shutdown cancels every running
    // CLI, which frees that run's own slot and is exactly what would otherwise wake this same
    // pass through `Actor::release_slot` — starting a fresh worktree and CLI only to have the
    // freshly spawned actor notice `shutdown` and kill it again a moment later, leaving the run
    // recorded `starting` (recovered as `interrupted` on the next start) instead of still
    // `queued`. A pass already under way when shutdown begins can still finish what it started
    // (see the module's decision record); this only stops a fresh one from beginning.
    if daemon.agents.shutdown.is_cancelled() {
        return;
    }
    let queued = match store(daemon, |db| {
        db.list_runs(None).map_err(|error| store_error(&error))
    })
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error.message, "could not list agent runs to promote from the queue");
            return;
        }
    };
    for row in queued.into_iter().filter(|row| row.state.status == QUEUED) {
        if daemon.agents.shutdown.is_cancelled() || !daemon.agents.scheduler.host_has_room() {
            return;
        }
        let (Ok(run_id), Ok(project)) = (
            RunId::try_from(row.id),
            ProjectId::try_from(row.fields.project_id),
        ) else {
            warn!(run = %row.id, "a queued run's id or project id is not a UUIDv7; skipping it");
            continue;
        };
        if !daemon.agents.scheduler.reserve(project) {
            // This project is full; a different queued run may be for one that isn't.
            continue;
        }
        let requested = row
            .fields
            .requested_account
            .as_deref()
            .and_then(|text| serde_json::from_str::<AccountChoice>(text).ok());
        if let Err(error) = promote(
            daemon,
            run_id,
            project,
            row.fields.prompt.clone(),
            requested,
        )
        .await
        {
            warn!(run = %run_id, error = %error.message, "could not promote a queued agent run");
            daemon
                .agents
                .scheduler
                .set_reason(run_id, format!("waiting: {}", error.message), None);
        }
    }
}

/// Records `created`'s worktree and moves `run_id` out of `queued`, in one store job, or `None` if
/// it wasn't `queued` any more by the time this ran. Split out of `promote` only to keep that
/// function under clippy's line count.
async fn record_promotion(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    scope_path: &str,
    created: &crate::worktree::CreatedWorktree,
    backend: &str,
    account_id: &str,
) -> Result<Option<(wisp_store::Run, wisp_store::Worktree)>, ErrorObject> {
    let worktree_fields = WorktreeFields {
        repo_path: scope_path.to_owned(),
        path: created.path.to_string_lossy().into_owned(),
        branch: created.branch.clone(),
        base: created.base.clone(),
        git_dir: created.git_dir.to_string_lossy().into_owned(),
    };
    let state = RunState {
        status: STARTING.to_owned(),
        account_id: account_id.to_owned(),
        ..RunState::default()
    };
    let backend = backend.to_owned();
    store(daemon, move |db| {
        let worktree = db
            .create_worktree(run_id.into(), &worktree_fields)
            .map_err(|error| store_error(&error))?;
        match db
            .start_queued_run(run_id.into(), &backend, &state)
            .map_err(|error| store_error(&error))?
        {
            Some(row) => Ok(Some((row, worktree))),
            None => Ok(None),
        }
    })
    .await
}

/// Tries to start `run_id`, whose project [`pass`] already reserved a slot for. Always resolves
/// that reservation before returning, on every path: releases it if the run isn't started here
/// (already resolved by a concurrent caller, or its account is rate limited — the one case that
/// leaves it queued rather than starting or failing it), or hands it to the run's actor to
/// release once its CLI stops being live.
async fn promote(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    project: ProjectId,
    prompt: String,
    requested: Option<AccountChoice>,
) -> Result<(), ErrorObject> {
    let agents = &daemon.agents;
    let _starting = agents.start_guard(run_id).await;
    let release = || agents.scheduler.release(project);

    let current = store(daemon, move |db| {
        db.get_run(run_id.into())
            .map_err(|error| store_error(&error))
    })
    .await?;
    if !matches!(&current, Some(row) if row.state.status == QUEUED) {
        // A concurrent cancel already resolved it.
        release();
        return Ok(());
    }

    // Re-validates the same way `create` did when this run was first queued (0197 review): the
    // account or repository this run needs may have stopped existing since then, and a run that
    // can never start must fail, not sit `queued` forever retrying a dead end every pass.
    let prepared = match prepare(daemon, project, run_id, requested).await {
        Ok(prepared) => prepared,
        Err(error) => {
            release();
            fail_queued_run(daemon, run_id, project, error.message).await;
            return Ok(());
        }
    };
    let (prepared, scope_path) = prepared;
    let account_id = prepared.resolved.account_id();
    if let Some(until) = agents.scheduler.paused_until(&account_id) {
        release();
        agents.scheduler.set_reason(
            run_id,
            format!("waiting: the account is rate limited until {until}"),
            Some(until),
        );
        return Ok(());
    }

    let (created, worktree_path, git_common_dir) =
        match create_worktree(agents, Path::new(&scope_path), run_id).await {
            Ok(created) => created,
            Err(error) => {
                release();
                fail_queued_run(daemon, run_id, project, error.to_string()).await;
                return Ok(());
            }
        };
    let backend = prepared.resolved.backend().name().to_owned();
    let recorded =
        record_promotion(daemon, run_id, &scope_path, &created, &backend, &account_id).await;
    let (row, worktree) = match recorded {
        Ok(Some(recorded)) => recorded,
        // The `WHERE status = 'queued'` guard didn't match: cancelled between the check above and
        // here despite holding `start_guard` (defensive; `agents::cancel`'s own queued path takes
        // the same guard, so this should not happen in practice).
        Ok(None) => {
            release();
            remove_orphaned_worktree(daemon, run_id, &scope_path, &created).await;
            return Ok(());
        }
        Err(error) => {
            release();
            remove_orphaned_worktree(daemon, run_id, &scope_path, &created).await;
            return Err(error);
        }
    };
    agents.scheduler.clear_reason(run_id);
    let mut actor = Actor::new(
        Arc::clone(daemon),
        row,
        Some(worktree),
        HashMap::new(),
        false,
    );
    actor.mark_slot_reserved();
    let task = super::worker::worker_prompt(&prompt, &worktree_path, &prepared.context);
    actor
        .launch(
            prepared,
            task,
            None,
            None,
            Some((worktree_path, git_common_dir)),
        )
        .await;
    agents.spawn(actor);
    Ok(())
}

async fn remove_orphaned_worktree(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    repo_path: &str,
    created: &crate::worktree::CreatedWorktree,
) {
    if let Err(cleanup) = daemon
        .agents
        .worktrees
        .remove(Path::new(repo_path), &created.path, &created.branch)
        .await
    {
        warn!(run = %run_id, %cleanup, "could not remove a worktree for a run that was not promoted");
    }
}

/// Fails a still-queued run outright, as `Actor::failed_to_start` does for one that already had a
/// worktree: `agent.finished {failed}` then `agent.updated`, so the coordinator (#196) hears that
/// it ended instead of waiting on a run that would only ever retry into the same error.
async fn fail_queued_run(daemon: &Arc<Daemon>, run_id: RunId, project: ProjectId, message: String) {
    let state = RunState {
        status: FAILED.to_owned(),
        error: Some(message.clone()),
        ..RunState::default()
    };
    let updated = store(daemon, move |db| {
        db.update_run(run_id.into(), &state)
            .map_err(|error| store_error(&error))
    })
    .await;
    let updated = match updated {
        Ok(row) => row,
        Err(error) => {
            warn!(run = %run_id, error = %error.message, "could not record a queued run as failed");
            return;
        }
    };
    let now = jiff::Timestamp::now();
    daemon
        .log
        .append(
            now,
            Some(project),
            WispEvent::AgentFinished {
                run_id,
                outcome: AgentOutcome::Failed {
                    failure: AgentFailureKind::Internal,
                    message,
                },
            },
        )
        .await;
    daemon
        .log
        .append(
            now,
            Some(project),
            WispEvent::AgentUpdated {
                run_id,
                state: convert::run_state(&updated),
            },
        )
        .await;
}
