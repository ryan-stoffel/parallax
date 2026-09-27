//! Admission control for `agent/start` (#197).
//!
//! A per-host and a per-project limit gate how many non-thread runs may be `starting` or
//! `running` at once (0017's normal threads are a user's own chat, never limited or queued, since
//! the limit is on "running workers"). A run over the limit is recorded `queued` — an ordinary
//! `runs` row, no worktree, `backend`/`account_id` left at [`super::convert::UNRESOLVED`] — instead
//! of started. [`tick`] promotes queued runs, oldest first, as slots free up: it skips one whose
//! resolved account is currently rate limited rather than giving up for the whole host, since a
//! different queued run may name a different, available account.
//!
//! No store migration: ordering is `list_runs`'s existing `created_at ASC, id ASC`, and the two
//! limits are a [`crate::server::Config`] setting, the same kind every other tunable in `Config`
//! already is, not a store-backed or RPC-settable one.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use jiff::Timestamp;
use tracing::warn;
use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{AccountChoice, ProjectId, RunId};
use wisp_store::{RunState, WorktreeFields};

use super::convert::{QUEUED, STARTING};
use super::{Actor, create_worktree, prepare, store, store_error, worker};
use crate::server::Daemon;

/// Host and project admission counters, and why a queued run is still waiting.
pub(super) struct Scheduler {
    host_limit: AtomicU32,
    project_limit: AtomicU32,
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
    /// The reason `tick` last found for a still-queued run: a rate limit, or a `prepare` failure.
    /// Absent for one only blocked on host/project capacity, whose reason `reason` computes live.
    reasons: Mutex<HashMap<RunId, String>>,
    /// Serializes `tick` passes: harmless to run two at once (each `reserve`/promotion is already
    /// race-safe on its own), but pointless duplicate work when a periodic tick and a just-freed
    /// slot land at the same time.
    ticking: tokio::sync::Mutex<()>,
}

impl Scheduler {
    pub(super) fn new(host_limit: u32, project_limit: u32) -> Self {
        Self {
            host_limit: AtomicU32::new(host_limit.max(1)),
            project_limit: AtomicU32::new(project_limit.max(1)),
            host_active: AtomicU32::new(0),
            project_active: Mutex::new(HashMap::new()),
            rate_limited: Mutex::new(HashMap::new()),
            reasons: Mutex::new(HashMap::new()),
            ticking: tokio::sync::Mutex::new(()),
        }
    }

    fn host_limit(&self) -> u32 {
        self.host_limit.load(Ordering::Relaxed)
    }

    fn project_limit(&self) -> u32 {
        self.project_limit.load(Ordering::Relaxed)
    }

    fn host_has_room(&self) -> bool {
        self.host_active.load(Ordering::Relaxed) < self.host_limit()
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
        if self.host_active.load(Ordering::Relaxed) >= self.host_limit() {
            return false;
        }
        let count = projects.entry(project).or_insert(0);
        if *count >= self.project_limit() {
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
    fn paused_until(&self, account_id: &str) -> Option<Timestamp> {
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

    fn set_reason(&self, run_id: RunId, reason: String) {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run_id, reason);
    }

    fn clear_reason(&self, run_id: RunId) {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&run_id);
    }

    /// Why `run_id` (in `project`) is still queued, for `AgentRun::queued_reason`: `tick`'s cached
    /// reason (a rate limit, or a `prepare` failure) when it has one, otherwise the live host or
    /// project count, computed fresh so it's never stale the way a stored reason would be.
    pub(super) fn reason(&self, run_id: RunId, project: ProjectId) -> String {
        if let Some(cached) = self
            .reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&run_id)
        {
            return cached.clone();
        }
        if !self.host_has_room() {
            return format!(
                "waiting for a host slot ({} of {} running)",
                self.host_active.load(Ordering::Relaxed),
                self.host_limit()
            );
        }
        format!(
            "waiting for a project slot ({} of {} running in this project)",
            self.project_count(project),
            self.project_limit()
        )
    }
}

/// Promotes queued runs, oldest first, as slots free up. Called after `agents::recover`, on a
/// periodic timer (`Config::scheduler_tick_interval`), and whenever a run stops occupying a slot.
///
/// Returns a boxed, type-erased future rather than being a plain `async fn`: `tick` calls
/// `promote`, which calls `Actor::launch`, whose own failure path calls back into
/// `Actor::release_slot`, which calls `tick` again to retry the queue. That is genuine recursion
/// through the same function, which makes a plain `async fn`'s compiler-generated (opaque, but
/// still concrete) future type infinitely self-referential; boxing it here as `dyn Future` erases
/// the type at exactly this one point in the cycle, which is enough to break it.
pub(crate) fn tick(daemon: &Arc<Daemon>) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
    Box::pin(async move {
        // A queued run must never be promoted while wispd is stopping: `Agents::shutdown`
        // cancels every running CLI first, which frees this very run's slot and is exactly what
        // would otherwise trigger this same `tick` through `Actor::release_slot` — starting a
        // fresh worktree and CLI only to kill it a moment later, and leaving the run recorded
        // `starting` (recovered as `interrupted` on the next start) instead of still `queued`.
        if daemon.agents.shutdown.is_cancelled() {
            return;
        }
        let _ticking = daemon.agents.scheduler.ticking.lock().await;
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
                    .set_reason(run_id, format!("waiting: {}", error.message));
            }
        }
    })
}

/// Tries to start `run_id`, whose project [`tick`] already reserved a slot for. Always resolves
/// that reservation before returning, on every path: releases it if the run isn't started here
/// (already resolved by a concurrent caller, or its account is rate limited), or hands it to the
/// run's actor to release once its CLI stops being live.
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
        // A concurrent cancel, or another `tick` pass, already resolved it.
        release();
        return Ok(());
    }

    let prepared = match prepare(daemon, project, run_id, requested).await {
        Ok(prepared) => prepared,
        Err(error) => {
            release();
            agents
                .scheduler
                .set_reason(run_id, format!("waiting: {}", error.message));
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
        );
        return Ok(());
    }

    let (created, worktree_path, git_common_dir) =
        match create_worktree(agents, Path::new(&scope_path), run_id).await {
            Ok(created) => created,
            Err(error) => {
                release();
                return Err(error);
            }
        };
    let worktree_fields = WorktreeFields {
        repo_path: scope_path.clone(),
        path: created.path.to_string_lossy().into_owned(),
        branch: created.branch.clone(),
        base: created.base.clone(),
        git_dir: created.git_dir.to_string_lossy().into_owned(),
    };
    let backend = prepared.resolved.backend().name().to_owned();
    let state = RunState {
        status: STARTING.to_owned(),
        account_id: account_id.clone(),
        ..RunState::default()
    };
    let started = {
        let backend = backend.clone();
        store(daemon, move |db| {
            let worktree = db
                .create_worktree(run_id.into(), &worktree_fields)
                .map_err(|error| store_error(&error))?;
            let row = db
                .start_queued_run(run_id.into(), &backend, &state)
                .map_err(|error| store_error(&error))?;
            Ok((row, worktree))
        })
        .await
    };
    let (row, worktree) = match started {
        Ok((row, worktree)) if row.fields.backend == backend => (row, worktree),
        // The `WHERE status = 'queued'` guard didn't match: cancelled between the check above and
        // here despite holding `start_guard` (defensive; `agents::cancel`'s own queued path takes
        // the same guard, so this should not happen in practice). Or a database error: either
        // way, the worktree just created is now orphaned, so it is removed again.
        other => {
            release();
            if let Err(cleanup) = agents
                .worktrees
                .remove(Path::new(&scope_path), &created.path, &created.branch)
                .await
            {
                warn!(run = %run_id, %cleanup, "could not remove a worktree for a run that was not promoted");
            }
            return match other {
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };
        }
    };
    agents.scheduler.clear_reason(run_id);
    let mut actor = Actor::new(Arc::clone(daemon), row, Some(worktree), HashMap::new());
    actor.mark_slot_reserved();
    let task = worker::worker_prompt(&prompt, &worktree_path, &prepared.context);
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
