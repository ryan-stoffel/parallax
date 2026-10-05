//! Removes a settled thread's worktree once its pull request merges (PLX-555), behind the
//! `worktreeCleanup` capability and the host's `cleanWorktrees` setting.
//!
//! A sweep runs at start and every [`SWEEP_PERIOD`]. A thread's worktree and local branch go when
//! the thread is settled, its run isn't running or waiting, and its linked pull requests are all
//! merged or closed with at least one merged. The worktree must hold nothing the merge didn't
//! keep: no uncommitted changes, and a `HEAD` that is on `origin` or is one of a merged pull
//! request's commits. The thread, its transcript, and its worktree row stay, so a later message
//! fails to find the folder rather than running anywhere else.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::PrState;
use parallax_store::{Run, Worktree};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{convert, store, store_error};
use crate::server::Daemon;
use crate::worktree::RunFolder;

/// How often a sweep looks for merged worktrees.
const SWEEP_PERIOD: Duration = Duration::from_mins(15);

/// Sweeps once, then every [`SWEEP_PERIOD`] until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut interval = time::interval(SWEEP_PERIOD);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = interval.tick() => sweep(&daemon, &stop).await,
        }
    }
}

/// Removes every merged worktree, when the host's setting is on, stopping early for `stop`.
async fn sweep(daemon: &Daemon, stop: &CancellationToken) {
    let candidates = store(daemon, |db| {
        if !db.clean_worktrees().map_err(|e| store_error(&e))? {
            return Ok(Vec::new());
        }
        let mut candidates = Vec::new();
        for thread in db.list_threads().map_err(|e| store_error(&e))? {
            if !thread.settled {
                continue;
            }
            let Some(run) = db.get_run(thread.id).map_err(|e| store_error(&e))? else {
                continue;
            };
            if let Some(worktree) = db.get_worktree(thread.id).map_err(|e| store_error(&e))?
                && idle(&run)
                && !run.state.pull_requests.is_empty()
            {
                candidates.push((run, worktree));
            }
        }
        Ok(candidates)
    })
    .await;
    let candidates = candidates.unwrap_or_else(|error| {
        warn!(error = %error.message, "could not list worktrees to clean up");
        Vec::new()
    });
    for (run, worktree) in candidates {
        if stop.is_cancelled() {
            return;
        }
        // A worktree already removed, or never pinned (#166), has nothing to clean.
        if worktree.git_dir.is_empty() || !Path::new(&worktree.path).is_dir() {
            continue;
        }
        clean(daemon, &run, &worktree).await;
    }
}

/// Removes `run`'s `worktree` if its pull requests merged and it holds nothing else.
async fn clean(daemon: &Daemon, run: &Run, worktree: &Worktree) {
    let worktrees = &daemon.agents.worktrees;
    let mut pulls = Vec::new();
    for url in &run.state.pull_requests {
        match worktrees.view_pr(url).await {
            Ok(pull) => pulls.push((pull.state, commits(pull.commits))),
            Err(error) => {
                warn!(run = %run.id, %url, %error, "could not read a pull request to clean up");
                return;
            }
        }
    }
    if !merged(&pulls) {
        return;
    }
    let folder = RunFolder::Worktree {
        path: Path::new(&worktree.path),
        git_dir: Path::new(&worktree.git_dir),
    };
    let (status, head) = match (worktrees.status(folder).await, worktrees.head(folder).await) {
        (Ok(status), Ok(head)) => (status, head),
        (Err(error), _) | (_, Err(error)) => {
            warn!(run = %run.id, %error, "could not read a merged worktree's git state");
            return;
        }
    };
    if status.changes > 0 || (status.ahead > 0 && !in_merged(&pulls, &head)) {
        info!(run = %run.id, "kept a merged worktree that has work its pull request doesn't");
        return;
    }
    // ponytail: rechecks the run is idle right before removing, which narrows but doesn't close
    // the window for a message sent mid-sweep; route through the run's actor if that ever bites.
    let id = run.id;
    let still_idle = store(daemon, move |db| {
        Ok(db
            .get_run(id)
            .map_err(|e| store_error(&e))?
            .is_some_and(|run| idle(&run)))
    })
    .await;
    if !still_idle.unwrap_or(false) {
        return;
    }
    match worktrees
        .remove(
            Path::new(&worktree.repo_path),
            Path::new(&worktree.path),
            &worktree.branch,
        )
        .await
    {
        Ok(()) => info!(run = %run.id, path = %worktree.path, "removed a merged thread's worktree"),
        Err(error) => warn!(run = %run.id, %error, "could not remove a merged thread's worktree"),
    }
}

/// A pull request's state and its commits' hashes.
type Pull = (PrState, Vec<String>);

fn commits(commits: Vec<parallax_protocol::PrCommit>) -> Vec<String> {
    commits.into_iter().map(|commit| commit.oid).collect()
}

/// Whether `run` is neither working nor waiting to resume.
fn idle(run: &Run) -> bool {
    ![convert::STARTING, convert::RUNNING, convert::WAITING].contains(&run.state.status.as_str())
}

/// Whether every pull request is merged or closed, and at least one merged.
fn merged(pulls: &[Pull]) -> bool {
    pulls.iter().any(|(state, _)| *state == PrState::Merged)
        && pulls
            .iter()
            .all(|(state, _)| matches!(state, PrState::Merged | PrState::Closed))
}

/// Whether `head` is one of a merged pull request's commits.
fn in_merged(pulls: &[Pull], head: &str) -> bool {
    pulls
        .iter()
        .any(|(state, commits)| *state == PrState::Merged && commits.iter().any(|oid| oid == head))
}

#[cfg(test)]
mod tests {
    use parallax_protocol::PrState;

    use super::{Pull, in_merged, merged};

    fn pull(state: PrState, commits: &[&str]) -> Pull {
        (state, commits.iter().map(|oid| (*oid).to_owned()).collect())
    }

    #[test]
    fn only_merged_or_closed_pull_requests_with_one_merged_count_as_merged() {
        assert!(merged(&[pull(PrState::Merged, &[])]));
        assert!(merged(&[
            pull(PrState::Merged, &[]),
            pull(PrState::Closed, &[])
        ]));
        assert!(!merged(&[pull(PrState::Closed, &[])]));
        assert!(!merged(&[
            pull(PrState::Merged, &[]),
            pull(PrState::Open, &[])
        ]));
        assert!(!merged(&[]));
    }

    #[test]
    fn head_must_be_a_merged_pull_requests_commit() {
        let pulls = [
            pull(PrState::Merged, &["a", "b"]),
            pull(PrState::Closed, &["c"]),
        ];
        assert!(in_merged(&pulls, "b"));
        assert!(!in_merged(&pulls, "c"));
        assert!(!in_merged(&pulls, "d"));
    }
}
