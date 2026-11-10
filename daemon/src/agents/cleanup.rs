//! Archives a thread once its linked pull requests merge (PLX-795), and removes a settled or
//! archived thread's worktree once they do (PLX-555, PLX-781), behind the `worktreeCleanup`
//! capability and the host's `cleanWorktrees` setting.
//!
//! A sweep runs at start, every [`SWEEP_PERIOD`], and right after `pr/act` merges a pull request
//! (PLX-839). It looks at each thread whose run isn't running or waiting and whose linked pull
//! requests are all merged or closed, with at least one merged. An unarchived thread is archived
//! when the newest merge came after the user's last message or unarchive, so a thread brought
//! back stays out. A settled or archived thread's worktree and local branch go too, when the
//! setting is on. The worktree must be on its stored branch or a merged pull request's head branch,
//! which agents often rename it to, and hold nothing the merge didn't keep: no local changes,
//! and a `HEAD` that is on `origin` or is one of a merged pull request's commits. A worktree kept
//! from an earlier sweep's merge is checked again only every [`RECHECK_EVERY`] sweeps. The thread,
//! its transcript, and its worktree row stay, and a later message makes the worktree again at the
//! same path before it resumes (PLX-856). A merged pull request never changes, so each is read
//! from GitHub once per plxd run, and a closed one is read again only every [`RECHECK_EVERY`]
//! sweeps.
//!
//! Every [`RECHECK_EVERY`] sweeps also apply the host's worktree rules, each off by default,
//! behind the `worktreeRules` capability (PLX-1524), whatever a thread's pull requests. They are
//! T3 Code's. A worktree goes when its thread has had no activity for `inactiveWorktreeDays`, has
//! been archived for `archivedWorktreeDays`, or, with `unchangedWorktrees`, has been idle for
//! [`UNCHANGED_AFTER`] with no commits beyond the default branch. A thread's activity is its
//! run's `updated_at`, which plxd writes each time it saves the run's state: a turn starting or
//! ending, a stop, a linked pull request, changed options. Archived time counts from the later of
//! that and when the thread was archived, and a thread brought back isn't archived. Archiving
//! isn't deleting: the thread, its transcript, and its worktree row stay. Under every rule the
//! run isn't running or waiting and isn't in its repository's own checkout, no other thread works
//! in the worktree (0063), its thread has no terminal open, and the worktree is on its stored
//! branch. Its local branch
//! stays, since its commits may exist nowhere else, and a later message checks it out again at
//! the same path. A worktree git can't read stays.
//!
//! The host's `worktreeKeep` says what a worktree must hold for these rules, and the merged
//! sweep, to keep it: any local file, ignored ones outside `node_modules` included; uncommitted
//! changes, the default, which lets ignored files go; or edits to tracked files alone, which
//! lets untracked files go too. The rules never force a removal, so git itself refuses a
//! worktree that changed after its check.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{GitStatus, PrState, RunId, ThreadArchiveParams, WorktreeKeep};
use parallax_store::{Run, Store, Thread, Worktree};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use super::{convert, store, store_error};
use crate::server::Daemon;
use crate::worktree::{PrError, RunFolder, WorktreeError, WorktreeManager};

/// How often a sweep looks for merged pull requests. Each reads only the state of idle threads'
/// linked pull requests not yet known merged or closed.
const SWEEP_PERIOD: Duration = Duration::from_mins(1);

/// Sweeps per recheck, which runs `git status` again on a worktree kept from an earlier sweep's
/// merge and on each worktree a rule is due for, and reads closed pull requests again, since one
/// can reopen: every 15 minutes rather than every sweep.
const RECHECK_EVERY: u32 = 15;

/// How long a thread is idle before the unchanged rule takes its worktree, so one whose first
/// commit is still ahead of it isn't removed and made again between messages. T3 Code gets the
/// same from sweeping once an hour.
const UNCHANGED_AFTER: SignedDuration = SignedDuration::from_hours(1);

/// Sweeps once, then every [`SWEEP_PERIOD`] and on `daemon.merged` until `stop`. Every
/// [`RECHECK_EVERY`] sweeps also removes abandoned chunked uploads (0074) and applies the host's
/// worktree rules (PLX-1524).
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut interval = time::interval(SWEEP_PERIOD);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut known: HashMap<String, Pull> = HashMap::new();
    let mut count: u32 = 0;
    loop {
        let woken = tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = interval.tick() => false,
            () = daemon.merged.notified() => {
                interval.reset();
                true
            }
        };
        let recheck = count.is_multiple_of(RECHECK_EVERY);
        if recheck {
            crate::methods::host::sweep_uploads(&daemon).await;
            daemon.bundles.sweep();
        }
        // The merge that woke this sweep may be of a pull request known closed, since reopened.
        if recheck || woken {
            known.retain(|_, pull| pull.state == PrState::Merged);
        }
        sweep(&daemon, &stop, &mut known, recheck).await;
        if recheck {
            sweep_rules(&daemon, &daemon.agents.worktrees, &stop, Timestamp::now()).await;
        }
        count = count.wrapping_add(1);
    }
}

/// The worktree rule a thread is due under.
#[derive(Clone, Copy, Debug)]
enum Rule {
    /// `inactiveWorktreeDays`.
    Inactive,
    /// `archivedWorktreeDays`.
    Archived,
    /// `unchangedWorktrees`, which also needs git to find no commits beyond the default branch.
    Unchanged,
}

/// A run a rule is due for, with its worktree and the rule.
type Due = (Run, Worktree, Rule);

/// Removes, through `worktrees`, the worktree of every thread the host's inactive, archived, and
/// unchanged rules are due for at `now` (PLX-1524), and keeps its branch, stopping early for
/// `stop`. A worktree that fails a check, or that a check can't read, stays.
async fn sweep_rules(
    daemon: &Daemon,
    worktrees: &WorktreeManager,
    stop: &CancellationToken,
    now: Timestamp,
) {
    let (keep, candidates) = match store(daemon, move |db| due(db, now)).await {
        Ok(found) => found,
        Err(error) => {
            warn!(error = %error.message, "could not list the worktrees a rule is due for");
            return;
        }
    };
    for (run, worktree, rule) in candidates {
        if stop.is_cancelled() {
            return;
        }
        // A worktree already removed, or never pinned (#166), has nothing to clean. One whose
        // thread has a terminal open may have something running in it.
        if worktree.git_dir.is_empty()
            || !Path::new(&worktree.path).is_dir()
            || !daemon.terminals.list(Some(&run.id.to_string())).is_empty()
        {
            continue;
        }
        let folder = RunFolder::Worktree {
            path: Path::new(&worktree.path),
            git_dir: Path::new(&worktree.git_dir),
        };
        let repo = Path::new(&worktree.repo_path);
        let goes = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            goes = may_go(worktrees, repo, folder, &worktree.branch, rule, keep) => goes,
        };
        match goes {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                warn!(run = %run.id, %error, "could not read a worktree's git state for its rule");
                continue;
            }
        }
        if !still_as_read(daemon, &run).await {
            continue;
        }
        // Only when the host keeps edited tracked files alone do untracked files go.
        let untracked_go = keep == WorktreeKeep::TrackedChanges;
        match worktrees
            .remove_keeping_branch(repo, folder, untracked_go)
            .await
        {
            Ok(()) => {
                info!(run = %run.id, path = %worktree.path, ?rule, "removed a thread's worktree");
            }
            Err(error) => {
                warn!(run = %run.id, %error, ?rule, "could not remove a thread's worktree");
            }
        }
    }
}

/// What the host's rules keep a worktree for, and the runs a rule is due for at `now`, each with
/// its worktree and the rule: a thread's run that is idle, outside its repository's own checkout,
/// and in a worktree no other thread works in (0063). None when every rule is off.
fn due(db: &Store, now: Timestamp) -> Result<(WorktreeKeep, Vec<Due>), ErrorObject> {
    let error = |error| store_error(&error);
    let keep = crate::methods::host::worktree_keep(db)?;
    let inactive = db.inactive_worktree_days().map_err(error)?;
    let archived = db.archived_worktree_days().map_err(error)?;
    let unchanged = db.unchanged_worktrees().map_err(error)?;
    let mut found = Vec::new();
    if inactive.is_none() && archived.is_none() && !unchanged {
        return Ok((keep, found));
    }
    for thread in db.list_threads().map_err(error)? {
        let Some(run) = db.get_run(thread.id).map_err(error)? else {
            continue;
        };
        if !idle(&run) || run.fields.checkout {
            continue;
        }
        let quiet = |wait| quiet_for(run.updated_at, wait, now);
        let rule = if inactive.is_some_and(|days| quiet(day(days))) {
            Rule::Inactive
        } else if archived.is_some_and(|days| archived_for(&thread, &run, days, now)) {
            Rule::Archived
        } else if unchanged && quiet(UNCHANGED_AFTER) {
            Rule::Unchanged
        } else {
            continue;
        };
        let Some(worktree) = db.get_worktree(thread.id).map_err(error)? else {
            continue;
        };
        if db.shared_users(thread.id).map_err(error)?.is_empty()
            && !db
                .worktree_shared(thread.id, &worktree.path)
                .map_err(error)?
        {
            found.push((run, worktree, rule));
        }
    }
    Ok((keep, found))
}

/// `days` days.
fn day(days: u32) -> SignedDuration {
    SignedDuration::from_hours(24 * i64::from(days))
}

/// Whether `since` is at least `wait` before `now`.
fn quiet_for(since: Timestamp, wait: SignedDuration, now: Timestamp) -> bool {
    now.checked_sub(wait).is_ok_and(|limit| since <= limit)
}

/// Whether `thread` has been archived for `days` days at `now`, counted from the later of when it
/// was archived and its `run`'s last change.
fn archived_for(thread: &Thread, run: &Run, days: u32, now: Timestamp) -> bool {
    thread
        .archived_at
        .filter(|_| thread.archived)
        .is_some_and(|at| quiet_for(at.max(run.updated_at), day(days), now))
}

/// Whether the worktree `folder` of repository `repo` may go under `rule`: it is on `branch`, its
/// stored branch, which making it again checks out, holds nothing `keep` keeps, and for the
/// unchanged rule has no commits beyond the default branch.
async fn may_go(
    worktrees: &WorktreeManager,
    repo: &Path,
    folder: RunFolder<'_>,
    branch: &str,
    rule: Rule,
    keep: WorktreeKeep,
) -> Result<bool, WorktreeError> {
    let status = worktrees.status(folder).await?;
    if status.branch.as_deref() != Some(branch) || kept(worktrees, folder, &status, keep).await? {
        return Ok(false);
    }
    match rule {
        Rule::Unchanged => worktrees.in_default_branch(repo, folder).await,
        Rule::Inactive | Rule::Archived => Ok(true),
    }
}

/// Whether the host's `keep` keeps the worktree `folder`, whose git state is `status`.
async fn kept(
    worktrees: &WorktreeManager,
    folder: RunFolder<'_>,
    status: &GitStatus,
    keep: WorktreeKeep,
) -> Result<bool, WorktreeError> {
    match keep {
        WorktreeKeep::UncommittedChanges => Ok(status.changes > 0),
        WorktreeKeep::TrackedChanges => worktrees.tracked_changes(folder).await,
        // A value this plxd doesn't know keeps the most.
        WorktreeKeep::AnyLocalFiles | WorktreeKeep::Unknown => {
            Ok(status.changes > 0 || worktrees.ignored_files(folder).await?)
        }
    }
}

/// Whether `run` is idle and unchanged since the sweep read it, read again from the store so a
/// message sent mid-sweep keeps its worktree.
async fn still_as_read(daemon: &Daemon, run: &Run) -> bool {
    let (id, at) = (run.id, run.updated_at);
    store(daemon, move |db| {
        Ok(db
            .get_run(id)
            .map_err(|e| store_error(&e))?
            .is_some_and(|run| idle(&run) && run.updated_at == at))
    })
    .await
    .unwrap_or(false)
}

/// Archives every thread whose pull requests merged since the user's last message, and removes
/// every merged worktree when the host's setting is on, stopping early for `stop`. `known` holds
/// the merged and closed pull requests read so far, by URL. Without `recheck`, a worktree whose
/// pull requests were all known merged before this sweep stays unless its thread archives now.
async fn sweep(
    daemon: &Arc<Daemon>,
    stop: &CancellationToken,
    known: &mut HashMap<String, Pull>,
    recheck: bool,
) {
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
            pulls = read(daemon, &thread, &run, known) => pulls,
        };
        let Some((pulls, fresh)) = pulls.filter(|(pulls, _)| merged(pulls)) else {
            continue;
        };
        let archived_now = !thread.archived && archive(daemon, thread.id, &pulls).await;
        let Some(worktree) = worktree
            .filter(|_| thread.archived || archived_now || thread.settled)
            .filter(|_| recheck || fresh || archived_now)
        else {
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

/// `run`'s linked pull requests, reading only those not in `known` and adding the merged and
/// closed ones, and whether this read a merge for the first time. A closed one in `known` is read
/// again when the others' merge would archive `thread` or remove its worktree now, since it may
/// have reopened. None when one can't be read.
async fn read(
    daemon: &Daemon,
    thread: &Thread,
    run: &Run,
    known: &mut HashMap<String, Pull>,
) -> Option<(Vec<Pull>, bool)> {
    let urls = &run.state.pull_requests;
    let mut pulls = Vec::new();
    let mut fresh = false;
    let mut stale = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        let pull = match known.get(url) {
            Some(pull) => {
                if pull.state == PrState::Closed {
                    stale.push(index);
                }
                pull.clone()
            }
            None => live(daemon, run, url, known, &mut fresh).await?,
        };
        pulls.push(pull);
    }
    let acts = fresh || (!thread.archived && merged_since(&pulls, last_activity(thread)));
    if merged(&pulls) && acts {
        for index in stale {
            known.remove(&urls[index]);
            pulls[index] = live(daemon, run, &urls[index], known, &mut fresh).await?;
        }
    }
    Some((pulls, fresh))
}

/// Pull request `url` read from GitHub, added to `known` when merged or closed, with `fresh` set
/// when merged. None when it can't be read.
async fn live(
    daemon: &Daemon,
    run: &Run,
    url: &str,
    known: &mut HashMap<String, Pull>,
    fresh: &mut bool,
) -> Option<Pull> {
    match read_one(daemon, url).await {
        Ok(pull) => {
            if matches!(pull.state, PrState::Merged | PrState::Closed) {
                *fresh |= pull.state == PrState::Merged;
                known.insert(url.to_owned(), pull.clone());
            }
            Some(pull)
        }
        Err(error) => {
            warn!(run = %run.id, %url, %error, "could not read a linked pull request");
            None
        }
    }
}

/// Pull request `url`: its state alone, as every sweep reads it, and the rest only once merged.
async fn read_one(daemon: &Daemon, url: &str) -> Result<Pull, PrError> {
    let worktrees = &daemon.agents.worktrees;
    let state = worktrees.pr_state(url).await?;
    if state != PrState::Merged {
        return Ok(Pull {
            state,
            merged_at: None,
            commits: Vec::new(),
            head: String::new(),
        });
    }
    let pull = worktrees.view_pr(url).await?;
    Ok(Pull {
        state: pull.state,
        merged_at: pull.merged_at,
        commits: commits(pull.commits),
        head: pull.head_branch,
    })
}

/// Archives thread `id` the way the app's Archive does, when the newest of its merged `pulls`
/// came after the user's last message or unarchive and its run is idle, read again here so a
/// message sent mid-sweep counts. Whether it did.
async fn archive(daemon: &Arc<Daemon>, id: Uuid, pulls: &[Pull]) -> bool {
    let thread = store(daemon, move |db| {
        let run = db.get_run(id).map_err(|e| store_error(&e))?;
        let thread = db.get_thread(id).map_err(|e| store_error(&e))?;
        Ok(thread.filter(|thread| !thread.archived && run.is_some_and(|run| idle(&run))))
    })
    .await;
    let Ok(Some(thread)) = thread else {
        return false;
    };
    if !merged_since(pulls, last_activity(&thread)) {
        return false;
    }
    let Ok(run_id) = RunId::try_from(id) else {
        return false;
    };
    let params = ThreadArchiveParams {
        run_id,
        archived: true,
    };
    match crate::threads::archive(daemon, params, None).await {
        Ok(_) => {
            info!(run = %id, "archived a thread whose pull request merged");
            true
        }
        Err(error) => {
            warn!(run = %id, error = %error.message, "could not archive a merged thread");
            false
        }
    }
}

/// When the user last sent `thread` a message or unarchived it. Wake-ups don't count, since the
/// one `merge_when_ready` sends lands after the merge it reports.
fn last_activity(thread: &Thread) -> Timestamp {
    thread
        .unarchived_at
        .map_or(thread.last_user_prompt_at, |at| {
            at.max(thread.last_user_prompt_at)
        })
}

/// The branch to delete with `run`'s `worktree`, when the worktree can go: it is on its own branch
/// and holds nothing the merged `pulls` don't, nor anything the host's `worktreeKeep` keeps.
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
    let keep = store(daemon, |db| crate::methods::host::worktree_keep(db))
        .await
        .ok()?;
    let (status, head) = match (worktrees.status(folder).await, worktrees.head(folder).await) {
        (Ok(status), Ok(head)) => (status, head),
        (Err(error), _) | (_, Err(error)) => {
            warn!(run = %run.id, %error, "could not read a merged worktree's git state");
            return None;
        }
    };
    let kept = match kept(worktrees, folder, &status, keep).await {
        Ok(kept) => kept,
        Err(error) => {
            warn!(run = %run.id, %error, "could not read a merged worktree's local files");
            return None;
        }
    };
    let Some(branch) = branch_to_delete(pulls, &worktree.branch, status.branch.as_deref())
        .filter(|_| !kept && (status.ahead == 0 || in_merged(pulls, &head)))
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

/// Whether the newest merge came after `last_activity`, so the thread wasn't used since.
fn merged_since(pulls: &[Pull], last_activity: Timestamp) -> bool {
    pulls
        .iter()
        .filter_map(|pull| pull.merged_at)
        .max()
        .is_some_and(|at| at > last_activity)
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
    use parallax_store::{Thread, ThreadFields};
    use uuid::Uuid;

    use super::{Pull, branch_to_delete, last_activity, merged_since};

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

    /// PR #960: the user said "rebase and then merge", `merge_when_ready` merged it, and its wake
    /// turn landed after the merge. The thread still counts as unused since the merge.
    #[test]
    fn a_wake_after_the_merge_is_not_activity() {
        let at = |s: &str| s.parse::<Timestamp>().unwrap();
        let mut thread = Thread {
            id: Uuid::now_v7(),
            repo_id: Uuid::now_v7(),
            archived: false,
            created_at: at("2026-10-27T17:00:00Z"),
            seen_at: None,
            snoozed_until: None,
            last_prompt_at: at("2026-10-27T20:56:37Z"),
            last_user_prompt_at: at("2026-10-27T20:47:48Z"),
            parent: None,
            fields: ThreadFields::default(),
            settled: false,
            unarchived_at: None,
            pinned: false,
            project_id: None,
            orchestrator_id: None,
            wake_reason: None,
            archived_at: None,
        };
        let pulls = [Pull {
            merged_at: Some(at("2026-10-27T20:56:36Z")),
            ..pull(PrState::Merged, &[])
        }];
        assert!(merged_since(&pulls, last_activity(&thread)));

        // Unarchiving after the merge still keeps it out.
        thread.unarchived_at = Some(at("2026-10-27T21:00:00Z"));
        assert!(!merged_since(&pulls, last_activity(&thread)));
    }

    /// The rules sweep against real worktrees of a real repository, with a real `git`, as
    /// `worktree`'s tests run it.
    #[cfg(unix)]
    mod rules {
        use std::path::{Path, PathBuf};
        use std::process::Command;
        use std::sync::Arc;
        use std::time::Duration;

        use jiff::{SignedDuration, Timestamp};
        use parallax_protocol::RunId;
        use parallax_store::{Lineage, RunState, Store, StoreError, ThreadFields, WorktreeFields};
        use tokio_util::sync::CancellationToken;
        use uuid::Uuid;

        use super::super::sweep_rules;
        use crate::agents::tests::run_fields;
        use crate::agents::{convert, store, store_error};
        use crate::backend::process::{Environment, Launcher};
        use crate::paths::DataDir;
        use crate::server::Daemon;
        use crate::worktree::{RunFolder, WorktreeManager};

        fn git(dir: &Path, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .expect("git should run");
            assert!(output.status.success(), "git {args:?}: {output:?}");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }

        /// A repository that ignores `*.log` and `node_modules`, a daemon whose store the sweep
        /// reads, and a worktree manager that finds git, which the test daemon's own can't.
        struct Fixture {
            _dir: tempfile::TempDir,
            repo: PathBuf,
            daemon: Arc<Daemon>,
            worktrees: WorktreeManager,
        }

        /// A thread's worktree, its git folder, and its branch.
        struct Made {
            id: Uuid,
            path: PathBuf,
            git_dir: PathBuf,
            branch: String,
        }

        impl Fixture {
            fn new() -> Self {
                let dir = tempfile::tempdir().unwrap();
                let repo = dir.path().join("repo");
                std::fs::create_dir_all(&repo).unwrap();
                git(&repo, &["init", "-q", "--initial-branch=main"]);
                git(&repo, &["config", "user.name", "Test User"]);
                git(&repo, &["config", "user.email", "test@example.com"]);
                std::fs::write(repo.join(".gitignore"), "*.log\nnode_modules\n").unwrap();
                std::fs::write(repo.join("README.md"), "hello\n").unwrap();
                git(&repo, &["add", "-A"]);
                git(&repo, &["commit", "-q", "-m", "init"]);
                let repo = repo.canonicalize().unwrap();
                let data = dir.path().join("data");
                std::fs::create_dir_all(&data).unwrap();
                let daemon = Daemon::for_tests(&data, 10, Duration::from_secs(90));
                let launcher =
                    Launcher::new(DataDir::new(&data).unwrap(), Environment::inherited());
                Self {
                    worktrees: WorktreeManager::new(launcher, &data),
                    _dir: dir,
                    repo,
                    daemon,
                }
            }

            /// A thread whose run has `status`, in a new worktree, with a commit of its own when
            /// `commits`.
            async fn thread(&self, status: &str, commits: bool) -> Made {
                let id = RunId::generate();
                let created = self
                    .worktrees
                    .create_named(&self.repo, id, None, None)
                    .await
                    .unwrap();
                if commits {
                    std::fs::write(created.path.join("work.txt"), "work\n").unwrap();
                    git(&created.path, &["add", "work.txt"]);
                    git(&created.path, &["commit", "-q", "-m", "Work"]);
                }
                let fields = WorktreeFields {
                    repo_path: self.repo.to_string_lossy().into_owned(),
                    path: created.path.to_string_lossy().into_owned(),
                    branch: created.branch.clone(),
                    base: created.base,
                    git_dir: created.git_dir.to_string_lossy().into_owned(),
                    base_dirty: false,
                };
                let state = RunState {
                    status: status.to_owned(),
                    ..RunState::default()
                };
                store(&self.daemon, move |db| {
                    let repo = Uuid::now_v7();
                    db.create_thread_run(
                        id.into(),
                        repo,
                        &run_fields(repo),
                        &state,
                        Some(&fields),
                        &ThreadFields::default(),
                    )
                    .map_err(|e| store_error(&e))
                })
                .await
                .unwrap();
                Made {
                    id: id.into(),
                    path: created.path,
                    git_dir: created.git_dir,
                    branch: created.branch,
                }
            }

            /// An idle thread with a commit of its own.
            async fn idle(&self) -> Made {
                self.thread("completed", true).await
            }

            /// Changes the store, as `host/settings/set` and the app's actions do.
            async fn set(
                &self,
                change: impl FnOnce(&Store) -> Result<(), StoreError> + Send + 'static,
            ) {
                store(&self.daemon, move |db| {
                    change(db).map_err(|e| store_error(&e))
                })
                .await
                .unwrap();
            }

            /// Sweeps as if `after` had passed.
            async fn sweep(&self, after: SignedDuration) {
                let stop = CancellationToken::new();
                sweep_rules(
                    &self.daemon,
                    &self.worktrees,
                    &stop,
                    Timestamp::now() + after,
                )
                .await;
            }

            /// The commit `made`'s branch is at, which is there whether or not its worktree is.
            fn branch(&self, made: &Made) -> String {
                git(&self.repo, &["rev-parse", &made.branch])
            }
        }

        fn days(days: i64) -> SignedDuration {
            SignedDuration::from_hours(24 * days)
        }

        #[tokio::test]
        async fn removes_only_an_idle_unshared_clean_worktree_and_keeps_its_branch() {
            let f = Fixture::new();
            let old = f.idle().await;
            std::fs::write(old.path.join("ignored.log"), "noise\n").unwrap();
            let dirty = f.idle().await;
            std::fs::write(dirty.path.join("untracked.txt"), "mine\n").unwrap();
            let running = f.thread(convert::RUNNING, true).await;
            let shared = f.idle().await;
            // Another thread works in `shared` (0063).
            let owner = shared.id;
            f.set(move |db| {
                let user = Uuid::now_v7();
                db.create_run(user, &run_fields(Uuid::now_v7()), &RunState::default())?;
                let lineage = Lineage {
                    relationship: None,
                    workspace_of: Some(owner),
                    payload: "{}".to_owned(),
                };
                db.put_lineage(user, &lineage)
            })
            .await;
            let all = [&old, &dirty, &running, &shared];

            // Off, as a fresh host is: nothing goes, however old.
            f.sweep(days(400)).await;
            assert!(all.iter().all(|made| made.path.is_dir()));

            // Too recent: 29 days of a 30-day setting.
            f.set(|db| db.set_inactive_worktree_days(Some(30))).await;
            f.sweep(days(29)).await;
            assert!(all.iter().all(|made| made.path.is_dir()));

            // After 31 days only the idle, unshared, clean one goes. The ignored file didn't keep
            // it, and its branch still has its commit.
            let commit = git(&old.path, &["rev-parse", "HEAD"]);
            f.sweep(days(31)).await;
            assert!(!old.path.exists());
            assert!(dirty.path.join("untracked.txt").is_file());
            assert!(running.path.is_dir());
            assert!(shared.path.is_dir());
            assert_eq!(f.branch(&old), commit);

            // Git itself refuses a worktree that gained a file after the sweep's own check.
            let folder = RunFolder::Worktree {
                path: &dirty.path,
                git_dir: &dirty.git_dir,
            };
            let refused = f
                .worktrees
                .remove_keeping_branch(&f.repo, folder, false)
                .await;
            assert!(refused.is_err());
            assert!(dirty.path.join("untracked.txt").is_file());

            // Only a folder under plxd's worktrees folder goes, never the repository's checkout.
            let checkout = RunFolder::Worktree {
                path: &f.repo,
                git_dir: &f.repo.join(".git"),
            };
            let refused = f
                .worktrees
                .remove_keeping_branch(&f.repo, checkout, true)
                .await;
            assert!(refused.is_err());
            assert!(f.repo.join("README.md").is_file());

            // What a later message does (PLX-856): the branch is checked out at the same path.
            f.worktrees
                .restore(&f.repo, &old.path, &old.branch)
                .await
                .unwrap();
            assert_eq!(git(&old.path, &["rev-parse", "HEAD"]), commit);
            assert!(old.path.join("work.txt").is_file());
        }

        #[tokio::test]
        async fn the_archived_rule_counts_days_from_when_a_thread_was_archived() {
            let f = Fixture::new();
            let archive = |made: &Made, archived| {
                let id = made.id;
                f.set(move |db| db.set_thread_archived(id, archived).map(drop))
            };
            let (archived, open, back) = (f.idle().await, f.idle().await, f.idle().await);
            archive(&archived, true).await;
            // Brought back, it isn't archived, whenever it was.
            archive(&back, true).await;
            archive(&back, false).await;
            let commit = f.branch(&archived);

            f.set(|db| db.set_archived_worktree_days(Some(3))).await;
            f.sweep(days(2)).await;
            assert!(archived.path.is_dir());
            f.sweep(days(4)).await;
            assert!(!archived.path.exists());
            assert!(open.path.is_dir(), "a thread that isn't archived stays");
            assert!(back.path.is_dir(), "an unarchived thread stays");
            assert_eq!(f.branch(&archived), commit);

            // 0 days is the next sweep. The thread stays, still archived.
            f.set(|db| db.set_archived_worktree_days(Some(0))).await;
            archive(&open, true).await;
            f.sweep(SignedDuration::ZERO).await;
            assert!(!open.path.exists());
            assert!(back.path.is_dir());
            let id = open.id;
            let thread = store(&f.daemon, move |db| {
                db.get_thread(id).map_err(|e| store_error(&e))
            })
            .await
            .unwrap();
            assert!(thread.is_some_and(|thread| thread.archived));
        }

        #[tokio::test]
        async fn the_unchanged_rule_takes_a_worktree_with_no_commits_after_an_idle_hour() {
            let f = Fixture::new();
            let (unchanged, committed) = (
                f.thread("completed", false).await,
                f.thread("completed", true).await,
            );
            let commit = f.branch(&unchanged);

            f.set(|db| db.set_unchanged_worktrees(true)).await;
            f.sweep(SignedDuration::from_mins(30)).await;
            assert!(unchanged.path.is_dir(), "idle for less than an hour");
            f.sweep(SignedDuration::from_hours(2)).await;
            assert!(!unchanged.path.exists());
            assert!(committed.path.is_dir(), "it has a commit of its own");
            assert_eq!(f.branch(&unchanged), commit);
        }

        /// What each `worktreeKeep` keeps, under the inactive rule: of a worktree with only an
        /// ignored file, one with only `node_modules`, one with an untracked file, and one with
        /// an edited tracked file.
        #[tokio::test]
        async fn worktree_keep_decides_which_local_files_keep_a_worktree() {
            let f = Fixture::new();
            f.set(|db| db.set_inactive_worktree_days(Some(30))).await;
            // Whether the ignored, `node_modules`, untracked, and edited worktrees stay.
            for (keep, stays) in [
                ("anyLocalFiles", [true, false, true, true]),
                ("uncommittedChanges", [false, false, true, true]),
                ("trackedChanges", [false, false, false, true]),
            ] {
                f.set(move |db| db.set_worktree_keep(keep)).await;
                let [ignored, modules, untracked, edited] = [
                    f.idle().await,
                    f.idle().await,
                    f.idle().await,
                    f.idle().await,
                ];
                std::fs::write(ignored.path.join("secrets.log"), "noise\n").unwrap();
                std::fs::create_dir(modules.path.join("node_modules")).unwrap();
                std::fs::write(modules.path.join("node_modules/dep.js"), "dep\n").unwrap();
                std::fs::write(untracked.path.join("untracked.txt"), "mine\n").unwrap();
                std::fs::write(edited.path.join("README.md"), "edited\n").unwrap();
                let made = [&ignored, &modules, &untracked, &edited];
                let commits = made.map(|made| f.branch(made));

                f.sweep(days(31)).await;
                assert_eq!(made.map(|made| made.path.is_dir()), stays, "{keep}");
                assert_eq!(made.map(|made| f.branch(made)), commits, "{keep}");
                // What a kept worktree was kept for is still there.
                assert!(edited.path.join("README.md").is_file());
                assert_eq!(untracked.path.join("untracked.txt").is_file(), stays[2]);
            }
        }
    }
}
