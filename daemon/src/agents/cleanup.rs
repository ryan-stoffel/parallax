//! Archives a thread once its linked pull requests merge (PLX-795), and removes a settled or
//! archived thread's worktree once they do (PLX-555, PLX-781), behind the `worktreeCleanup`
//! capability and the host's `cleanWorktrees` setting.
//!
//! A sweep runs at start and every [`SWEEP_PERIOD`]. It looks at each thread whose run isn't
//! running or waiting and whose linked pull requests are all merged or closed, with at least one
//! merged. An unarchived thread is archived when the newest merge came after its last message, so
//! a thread unarchived and messaged again stays out. A settled or archived thread's worktree and
//! local branch go too, when the setting is on. The worktree must be on its stored branch or a
//! merged pull request's head branch, which agents often rename it to, and hold nothing the merge
//! didn't keep: no uncommitted changes, and a `HEAD` that is on `origin` or is one of a merged
//! pull request's commits. The thread, its transcript, and its worktree row stay, so a later
//! message fails to find the folder rather than running anywhere else. A merged pull request
//! never changes, so each is read from GitHub once per plxd run.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::{PrState, RunId, ThreadArchiveParams};
use parallax_store::{Run, Thread, Worktree};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::{convert, store, store_error};
use crate::server::Daemon;
use crate::worktree::RunFolder;

/// How often a sweep looks for merged pull requests.
const SWEEP_PERIOD: Duration = Duration::from_mins(15);

/// Sweeps once, then every [`SWEEP_PERIOD`] until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut interval = time::interval(SWEEP_PERIOD);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut known = HashMap::new();
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = interval.tick() => sweep(&daemon, &stop, &mut known).await,
        }
    }
}

/// Archives every thread whose pull requests merged since its last message, and removes every
/// merged worktree when the host's setting is on, stopping early for `stop`. `known` holds the
/// merged pull requests read so far, by URL.
async fn sweep(daemon: &Arc<Daemon>, stop: &CancellationToken, known: &mut HashMap<String, Pull>) {
    let candidates = store(daemon, |db| {
        let clean = db.clean_worktrees().map_err(|e| store_error(&e))?;
        let mut candidates = Vec::new();
        for thread in db.list_threads().map_err(|e| store_error(&e))? {
            if thread.archived && !clean {
                continue;
            }
            let Some(run) = db.get_run(thread.id).map_err(|e| store_error(&e))? else {
                continue;
            };
            if !idle(&run) || run.state.pull_requests.is_empty() {
                continue;
            }
            // A worktree other threads work in stays (0063).
            let worktree = match db.get_worktree(thread.id).map_err(|e| store_error(&e))? {
                Some(worktree)
                    if clean
                        && db
                            .shared_users(thread.id)
                            .map_err(|e| store_error(&e))?
                            .is_empty() =>
                {
                    Some(worktree)
                }
                _ => None,
            };
            candidates.push((thread, run, worktree));
        }
        Ok(candidates)
    })
    .await;
    let candidates = candidates.unwrap_or_else(|error| {
        warn!(error = %error.message, "could not list threads with merged pull requests");
        Vec::new()
    });
    for (thread, run, worktree) in candidates {
        if stop.is_cancelled() {
            return;
        }
        // A worktree already removed, or never pinned (#166), has nothing to clean.
        let worktree = worktree
            .filter(|worktree| !worktree.git_dir.is_empty() && Path::new(&worktree.path).is_dir());
        if thread.archived && worktree.is_none() {
            continue;
        }
        // Stopping cancels the reads, which can wait minutes on `gh`, but never a removal.
        let pulls = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            pulls = read(daemon, &run, known) => pulls,
        };
        let Some(pulls) = pulls.filter(|pulls| merged(pulls)) else {
            continue;
        };
        let archived = thread.archived
            || (merged_since(&pulls, thread.last_prompt_at) && archive(daemon, &thread).await);
        let Some(worktree) = worktree.filter(|_| archived || thread.settled) else {
            continue;
        };
        let branch = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            branch = removable(daemon, &run, &worktree, &pulls) => branch,
        };
        let Some(branch) = branch else {
            continue;
        };
        match daemon
            .agents
            .worktrees
            .remove(
                Path::new(&worktree.repo_path),
                Path::new(&worktree.path),
                &branch,
            )
            .await
        {
            Ok(()) => {
                info!(run = %run.id, path = %worktree.path, "removed a merged thread's worktree");
            }
            Err(error) => {
                warn!(run = %run.id, %error, "could not remove a merged thread's worktree");
            }
        }
    }
}

/// `run`'s linked pull requests, reading only those not in `known` and adding the merged ones.
/// None when one can't be read.
async fn read(daemon: &Daemon, run: &Run, known: &mut HashMap<String, Pull>) -> Option<Vec<Pull>> {
    let mut pulls = Vec::new();
    for url in &run.state.pull_requests {
        if let Some(pull) = known.get(url) {
            pulls.push(pull.clone());
            continue;
        }
        match daemon.agents.worktrees.view_pr(url).await {
            Ok(pull) => {
                let pull = Pull {
                    state: pull.state,
                    merged_at: pull.merged_at,
                    commits: commits(pull.commits),
                    head: pull.head_branch,
                };
                if pull.state == PrState::Merged {
                    known.insert(url.clone(), pull.clone());
                }
                pulls.push(pull);
            }
            Err(error) => {
                warn!(run = %run.id, %url, %error, "could not read a linked pull request");
                return None;
            }
        }
    }
    Some(pulls)
}

/// Archives `thread` the way the app's Archive does, if its run is still idle. Whether it did.
async fn archive(daemon: &Arc<Daemon>, thread: &Thread) -> bool {
    if !still_idle(daemon, thread.id).await {
        return false;
    }
    let Ok(run_id) = RunId::try_from(thread.id) else {
        return false;
    };
    let params = ThreadArchiveParams {
        run_id,
        archived: true,
    };
    match crate::threads::archive(daemon, params, None).await {
        Ok(_) => {
            info!(run = %thread.id, "archived a thread whose pull request merged");
            true
        }
        Err(error) => {
            warn!(run = %thread.id, error = %error.message, "could not archive a merged thread");
            false
        }
    }
}

/// The branch to delete with `run`'s `worktree`, when the worktree can go: it is on its own branch
/// and holds nothing the merged `pulls` don't.
async fn removable(
    daemon: &Daemon,
    run: &Run,
    worktree: &Worktree,
    pulls: &[Pull],
) -> Option<String> {
    let worktrees = &daemon.agents.worktrees;
    let folder = RunFolder::Worktree {
        path: Path::new(&worktree.path),
        git_dir: Path::new(&worktree.git_dir),
    };
    let (status, head) = match (worktrees.status(folder).await, worktrees.head(folder).await) {
        (Ok(status), Ok(head)) => (status, head),
        (Err(error), _) | (_, Err(error)) => {
            warn!(run = %run.id, %error, "could not read a merged worktree's git state");
            return None;
        }
    };
    let Some(branch) = branch_to_delete(pulls, &worktree.branch, status.branch.as_deref())
        .filter(|_| status.changes == 0 && (status.ahead == 0 || in_merged(pulls, &head)))
    else {
        info!(run = %run.id, "kept a merged worktree that has work its pull request doesn't");
        return None;
    };
    // ponytail: rechecks the run is idle right before removing, which narrows but doesn't close
    // the window for a message sent mid-sweep; route through the run's actor if that ever bites.
    still_idle(daemon, run.id).await.then_some(branch)
}

/// Whether run `id` is idle now, read again from the store.
async fn still_idle(daemon: &Daemon, id: Uuid) -> bool {
    store(daemon, move |db| {
        Ok(db
            .get_run(id)
            .map_err(|e| store_error(&e))?
            .is_some_and(|run| idle(&run)))
    })
    .await
    .unwrap_or(false)
}

/// A linked pull request, as the sweep reads it.
#[derive(Clone)]
struct Pull {
    state: PrState,
    /// When it merged.
    merged_at: Option<Timestamp>,
    /// Its commits' hashes.
    commits: Vec<String>,
    /// The branch it merges from.
    head: String,
}

fn commits(commits: Vec<parallax_protocol::PrCommit>) -> Vec<String> {
    commits.into_iter().map(|commit| commit.oid).collect()
}

/// Whether `run` is neither working nor waiting to resume.
fn idle(run: &Run) -> bool {
    ![convert::STARTING, convert::RUNNING, convert::WAITING].contains(&run.state.status.as_str())
}

/// Whether every pull request is merged or closed, and at least one merged.
fn merged(pulls: &[Pull]) -> bool {
    pulls.iter().any(|pull| pull.state == PrState::Merged)
        && pulls
            .iter()
            .all(|pull| matches!(pull.state, PrState::Merged | PrState::Closed))
}

/// Whether the newest merge came after `last_message`, so the thread wasn't messaged since.
fn merged_since(pulls: &[Pull], last_message: Timestamp) -> bool {
    pulls
        .iter()
        .filter_map(|pull| pull.merged_at)
        .max()
        .is_some_and(|at| at > last_message)
}

/// Whether `head` is one of a merged pull request's commits.
fn in_merged(pulls: &[Pull], head: &str) -> bool {
    pulls
        .iter()
        .any(|pull| pull.state == PrState::Merged && pull.commits.iter().any(|oid| oid == head))
}

/// The branch `HEAD` is on, `current`, when removing may delete it: the `stored` branch, or a
/// merged pull request's head branch. None for a detached `HEAD` or any other branch.
fn branch_to_delete(pulls: &[Pull], stored: &str, current: Option<&str>) -> Option<String> {
    let current = current?;
    (current == stored
        || pulls
            .iter()
            .any(|pull| pull.state == PrState::Merged && pull.head == current))
    .then(|| current.to_owned())
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use parallax_protocol::PrState;

    use super::{Pull, branch_to_delete, in_merged, merged, merged_since};

    fn pull(state: PrState, commits: &[&str]) -> Pull {
        Pull {
            state,
            merged_at: None,
            commits: commits.iter().map(|oid| (*oid).to_owned()).collect(),
            head: String::new(),
        }
    }

    fn headed(state: PrState, head: &str) -> Pull {
        Pull {
            head: head.to_owned(),
            ..pull(state, &[])
        }
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
    fn archives_only_when_the_newest_merge_follows_the_last_message() {
        let at = |time: &str| time.parse::<Timestamp>().unwrap();
        let merged_at = |time: &str| Pull {
            merged_at: Some(at(time)),
            ..pull(PrState::Merged, &[])
        };
        let pulls = [
            merged_at("2026-10-01T10:00:00Z"),
            merged_at("2026-10-03T10:00:00Z"),
        ];
        assert!(merged_since(&pulls, at("2026-10-02T10:00:00Z")));
        assert!(!merged_since(&pulls, at("2026-10-04T10:00:00Z")));
        assert!(!merged_since(
            &[pull(PrState::Closed, &[])],
            at("2026-10-02T10:00:00Z")
        ));
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

    #[test]
    fn deletes_the_stored_branch_or_a_merged_pull_requests_head_branch() {
        let pulls = [
            headed(PrState::Merged, "feature/PLX-1-renamed"),
            headed(PrState::Closed, "feature/PLX-1-closed"),
        ];
        let stored = "parallax/slug";
        assert_eq!(
            branch_to_delete(&pulls, stored, Some(stored)).as_deref(),
            Some(stored)
        );
        assert_eq!(
            branch_to_delete(&pulls, stored, Some("feature/PLX-1-renamed")).as_deref(),
            Some("feature/PLX-1-renamed")
        );
        assert_eq!(
            branch_to_delete(&pulls, stored, Some("feature/PLX-1-closed")),
            None
        );
        assert_eq!(branch_to_delete(&pulls, stored, Some("main")), None);
        assert_eq!(branch_to_delete(&pulls, stored, None), None);
    }
}
