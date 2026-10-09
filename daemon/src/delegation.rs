//! Delegation (0063, PLX-648), as T3 Code's `delegate_task`, `create_threads`, and
//! `t3_thread_merge_back`.
//!
//! `task/delegate` starts a thread in its owner's workspace. It runs as a checkout thread whose
//! folder is the owner's worktree ([`workdir`]), so plxd never commits it or removes that
//! worktree for it. With a `completionWake` it is a task the owner delegated: its child, lineage
//! `subagent`, whose end wakes the owner by [`wakes`]' rule. Without one it is a top-level thread
//! beside it (`create_threads`). Its mode can't need less approval than the owner's, a no-write
//! thread (a Project's coordinator) can't share its workspace, and the owner must be running a
//! turn, as T3's must. Only threads in a repo entry share theirs: a Project's runs
//! start children through their coordinator.
//!
//! `task/status` reads a task and records what its parent did with it: read its result, which
//! acknowledges it, cancelled it, which disposes of it, or stopped waiting on it, which turns
//! `settled_only` into `always`.
//!
//! `thread/mergeBack` records a pending `merge_back` context transfer. The target's next message
//! carries the source's conversation since the fork, or all of it for a child, through the
//! attached-thread path (0047), and recording what that message read consumes the transfer.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AgentEffort, AgentPermission, AgentStatus, CompletionWake, DelegatedTask,
    ErrorKind, ParallaxEvent, ProjectId, RunId, TaskDelegateParams, TaskDelivery, TaskStatusParams,
    ThreadMergeBackParams, ThreadMergeBackResult, ThreadStartResult,
};
use parallax_store::{Lineage, Store, ThreadFields};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agents::{self, NewRun, NewThread, RunOptions};
use crate::server::Daemon;
use crate::store::store_error;

/// A delegated task's relationship to its parent, as T3's lineage names it.
const SUBAGENT: &str = "subagent";

/// The type of the context transfer `thread/mergeBack` records.
const MERGE_BACK: &str = "merge_back";

/// The longest chain of threads sharing one workspace that [`workdir`] follows.
const MAX_SHARED_DEPTH: usize = 64;

/// A delegated task's payload in its lineage row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    completion_wake: CompletionWake,
    #[serde(default)]
    delivery: TaskDelivery,
}

async fn store<T: Send + 'static>(
    daemon: &Daemon,
    job: impl FnOnce(&mut crate::store::Tx) -> Result<T, ErrorObject> + Send + 'static,
) -> Result<T, ErrorObject> {
    daemon.store.run(&CancellationToken::new(), job).await
}

/// `task/delegate`: see the module documentation. Idempotent on the run id.
pub(crate) async fn delegate(
    daemon: Arc<Daemon>,
    params: TaskDelegateParams,
) -> Result<ThreadStartResult, ErrorObject> {
    let TaskDelegateParams {
        run_id,
        owner,
        prompt,
        title,
        account,
        model,
        effort,
        permission,
        completion_wake,
    } = params;
    crate::methods::check_message("prompt", &prompt, &[])?;
    if completion_wake == Some(CompletionWake::Unknown) {
        return Err(ErrorObject::invalid_params("unknown completionWake"));
    }
    let title = title
        .as_deref()
        .map(crate::threads::check_title)
        .transpose()?
        .flatten();
    let task = completion_wake.map(|completion_wake| Task {
        completion_wake,
        delivery: TaskDelivery::Pending,
    });
    let lineage = Lineage {
        relationship: task.map(|_| SUBAGENT.to_owned()),
        workspace_of: Some(owner.into()),
        payload: serde_json::to_string(&task).map_err(ErrorObject::internal_error)?,
    };
    let (row, scope, inserted) =
        store(&daemon, move |db| claim(db, run_id, owner, &lineage)).await?;
    let options = match inherit(&row, account.as_ref(), model, effort, permission) {
        Ok(options) => options,
        Err(error) => {
            forget(&daemon, run_id, inserted).await;
            return Err(ErrorObject::invalid_params(error));
        }
    };
    let new = NewRun {
        run_id,
        scope,
        prompt,
        images: Vec::new(),
        threads: Vec::new(),
        account: Some(account.unwrap_or_else(|| agents::session_account(&row.state.account_id))),
        coordinator_thread: None,
        notify: task.is_some(),
        options,
        // As a thread the user starts: it asks the app (0034).
        approvals: true,
        explore: false,
        thread: Some(NewThread {
            scratch: None,
            branch_slug: None,
            checkout: true,
            git_ref: None,
            parent: task.map(|_| owner),
            fields: ThreadFields {
                forked_from: None,
                title,
            },
            fork: None,
        }),
    };
    let created = match agents::create(Arc::clone(&daemon), new).await {
        Ok(created) => created,
        Err(error) => {
            forget(&daemon, run_id, inserted).await;
            return Err(error);
        }
    };
    let thread = created
        .thread
        .as_ref()
        .ok_or_else(|| ErrorObject::internal_error("a new thread has no thread row"))?;
    Ok(ThreadStartResult {
        thread: crate::threads::thread_entry(thread)?,
        run: created.run,
    })
}

/// A new thread's options: those asked for, else the owner `row`'s on its own backend, which maps
/// them. Refuses a mode that needs less approval than the owner's.
fn inherit(
    row: &parallax_store::Run,
    account: Option<&AccountChoice>,
    model: Option<String>,
    effort: Option<AgentEffort>,
    permission: Option<AgentPermission>,
) -> Result<RunOptions, String> {
    let fields = &row.fields;
    let same_backend = match account {
        None => true,
        Some(AccountChoice::Subscription { backend }) => *backend == fields.backend,
        Some(_) => false,
    };
    let theirs = fields
        .permission
        .as_deref()
        .and_then(agents::convert::option_value);
    let inherited = |value: Option<&str>| {
        value
            .and_then(agents::convert::option_value)
            .filter(|_| same_backend)
    };
    let permission = permission.or(theirs.filter(|_| same_backend));
    check_mode(theirs, permission)?;
    Ok(RunOptions {
        model: model.or_else(|| fields.model.clone().filter(|_| same_backend)),
        effort: effort.or_else(|| inherited(fields.effort.as_deref())),
        permission,
        context_window: None,
        fast: None,
    })
}

/// Checks that `owner` can share its workspace with new thread `run_id`, and records `lineage`
/// for it unless a retry did: the owner's row, its repo entry, and whether this inserted it.
fn claim(
    db: &Store,
    run_id: RunId,
    owner: RunId,
    lineage: &Lineage,
) -> Result<(parallax_store::Run, ProjectId, bool), ErrorObject> {
    let error = |error| store_error(&error);
    let row = db
        .get_run(owner.into())
        .map_err(error)?
        .ok_or_else(|| agents::run_not_found(owner))?;
    let thread = db.get_thread(owner.into()).map_err(error)?;
    let in_repo = match &thread {
        Some(thread) => db.get_repo(thread.repo_id).map_err(error)?.is_some(),
        None => false,
    };
    if !in_repo {
        return Err(ErrorObject::invalid_params(format!(
            "thread {owner} is a Project's run: it starts children through its coordinator"
        )));
    }
    if row.fields.policy == agents::NO_WRITE {
        return Err(ErrorObject::invalid_params(format!(
            "thread {owner} can't write, so no thread can work in its workspace"
        )));
    }
    // A retry may come after the owner's turn ended.
    let retry = db.get_run(run_id.into()).map_err(error)?.is_some();
    let status = agents::snapshot(&row, None)?.status;
    if !retry && !matches!(status, AgentStatus::Starting | AgentStatus::Running) {
        return Err(ErrorObject::invalid_params(format!(
            "thread {owner} isn't running a turn: threads start in its workspace from inside \
             one"
        )));
    }
    // A retry finds the lineage it made; another owner's is a different thread.
    let inserted = match db.lineage(run_id.into()).map_err(error)? {
        Some(existing) if existing.workspace_of == lineage.workspace_of => false,
        Some(_) => {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!("run {run_id} exists in another thread's workspace"),
            ));
        }
        None => {
            db.put_lineage(run_id.into(), lineage).map_err(error)?;
            true
        }
    };
    let scope = ProjectId::try_from(row.fields.project_id)
        .map_err(|_| ErrorObject::internal_error("a stored repo entry id is invalid"))?;
    Ok((row, scope, inserted))
}

/// Drops the lineage `delegate` `inserted` for `run_id` when no run was made for it.
async fn forget(daemon: &Daemon, run_id: RunId, inserted: bool) {
    if !inserted {
        return;
    }
    let _ = store(daemon, move |db| {
        if db
            .get_run(run_id.into())
            .map_err(|e| store_error(&e))?
            .is_none()
        {
            db.delete_lineage(run_id.into())
                .map_err(|e| store_error(&e))?;
        }
        Ok(())
    })
    .await;
}

/// `task/status`: see the module documentation. A task another thread delegated, or a thread that
/// isn't a task, is `runNotFound`, as T3's `task_not_found`.
pub(crate) async fn status(
    daemon: &Daemon,
    params: TaskStatusParams,
) -> Result<DelegatedTask, ErrorObject> {
    let TaskStatusParams {
        parent,
        task_id,
        acknowledge,
        completion_wake,
        dispose,
    } = params;
    if completion_wake == Some(CompletionWake::Unknown) {
        return Err(ErrorObject::invalid_params("unknown completionWake"));
    }
    store(daemon, move |db| {
        let error = |error| store_error(&error);
        let not_found = || {
            ErrorObject::parallax(
                ErrorKind::RunNotFound,
                format!("thread {parent} delegated no task {task_id}"),
            )
        };
        let row = db.get_run(task_id.into()).map_err(error)?;
        let lineage = db.lineage(task_id.into()).map_err(error)?;
        let (Some(row), Some(mut lineage)) = (row, lineage) else {
            return Err(not_found());
        };
        let mut task = match serde_json::from_str::<Option<Task>>(&lineage.payload) {
            Ok(Some(task)) if row.fields.parent == Some(parent.into()) => task,
            _ => return Err(not_found()),
        };
        let worktree = db.get_worktree(task_id.into()).map_err(error)?;
        let run = agents::snapshot(&row, worktree.as_ref())?;
        let before = task;
        if let Some(wake) = completion_wake {
            task.completion_wake = wake;
        }
        if task.delivery == TaskDelivery::Pending {
            if dispose {
                task.delivery = TaskDelivery::Disposed;
            } else if acknowledge && ended(run.status) {
                task.delivery = TaskDelivery::Acknowledged;
            }
        }
        if task != before {
            lineage.payload =
                serde_json::to_string(&Some(task)).map_err(ErrorObject::internal_error)?;
            db.put_lineage(task_id.into(), &lineage).map_err(error)?;
        }
        Ok(DelegatedTask {
            task_id,
            parent,
            completion_wake: task.completion_wake,
            delivery: task.delivery,
            run,
        })
    })
    .await
}

/// Whether a run in `status` has ended a turn and waits for nothing.
fn ended(status: AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::Starting | AgentStatus::Running | AgentStatus::Waiting
    )
}

/// How a delegated task's end reaches its parent (T3's rule): `None` when nothing should wake
/// it, because the parent read or cancelled the task, or the task is `settled_only` and the
/// parent's turn is running, which waits on it. `Some(true)` for a task, `Some(false)` for any
/// other child, which always wakes it.
pub(crate) fn wakes(db: &Store, child: Uuid, parent: Uuid) -> Result<Option<bool>, ErrorObject> {
    let error = |error| store_error(&error);
    let Some(lineage) = db.lineage(child).map_err(error)? else {
        return Ok(Some(false));
    };
    let Ok(Some(task)) = serde_json::from_str::<Option<Task>>(&lineage.payload) else {
        return Ok(Some(false));
    };
    if task.delivery != TaskDelivery::Pending {
        return Ok(None);
    }
    if task.completion_wake == CompletionWake::SettledOnly
        && let Some(parent) = db.get_run(parent).map_err(error)?
        && matches!(
            agents::snapshot(&parent, None)?.status,
            AgentStatus::Starting | AgentStatus::Running
        )
    {
        return Ok(None);
    }
    Ok(Some(true))
}

/// Of `tasks`, the ones whose end no longer wakes their parent: read or cancelled since.
pub(crate) fn quiet(db: &Store, tasks: &[Uuid]) -> Result<Vec<Uuid>, ErrorObject> {
    let mut quiet = Vec::new();
    for &task in tasks {
        let pending = db
            .lineage(task)
            .map_err(|e| store_error(&e))?
            .and_then(|lineage| serde_json::from_str::<Option<Task>>(&lineage.payload).ok())
            .flatten()
            .is_none_or(|task| task.delivery == TaskDelivery::Pending);
        if !pending {
            quiet.push(task);
        }
    }
    Ok(quiet)
}

/// The folder a checkout thread works in (0063): the worktree of the thread whose workspace it
/// shares, following a chain of them, or else `scope`'s checkout.
pub(crate) fn workdir(db: &Store, scope: ProjectId, run: Uuid) -> Result<String, ErrorObject> {
    let error = |error| store_error(&error);
    let mut thread = run;
    for _ in 0..MAX_SHARED_DEPTH {
        let Some(owner) = db
            .lineage(thread)
            .map_err(error)?
            .and_then(|lineage| lineage.workspace_of)
        else {
            return crate::threads::scope_path(db, scope);
        };
        if let Some(worktree) = db.get_worktree(owner).map_err(error)? {
            return Ok(worktree.path);
        }
        let shares = db
            .get_run(owner)
            .map_err(error)?
            .is_some_and(|row| row.fields.checkout);
        if !shares {
            return Err(ErrorObject::parallax(
                ErrorKind::WorktreeFailed,
                format!(
                    "thread {run} works in thread {owner}'s worktree, which is gone; start a new \
                     thread instead"
                ),
            ));
        }
        thread = owner;
    }
    Err(ErrorObject::internal_error(format!(
        "thread {run} shares a workspace through more than {MAX_SHARED_DEPTH} threads"
    )))
}

/// `thread/mergeBack`: see the module documentation. `source` must be a fork of `target`, or its
/// child, and have run a turn of its own since.
pub(crate) async fn merge_back(
    daemon: &Daemon,
    params: ThreadMergeBackParams,
) -> Result<ThreadMergeBackResult, ErrorObject> {
    let ThreadMergeBackParams { source, target } = params;
    let (base, forked) = store(daemon, move |db| {
        let error = |error| store_error(&error);
        let thread = db.get_thread(source.into()).map_err(error)?;
        let row = db.get_run(source.into()).map_err(error)?;
        let (Some(thread), Some(row)) = (thread, row) else {
            return Err(ErrorObject::parallax(
                ErrorKind::ThreadNotFound,
                format!("no thread has run id {source}"),
            ));
        };
        let forked = thread
            .fields
            .forked_from
            .is_some_and(|from| from.run == Uuid::from(target));
        if !forked && row.fields.parent != Some(target.into()) {
            return Err(ErrorObject::invalid_params(format!(
                "thread {source} is neither a fork nor a child of thread {target}"
            )));
        }
        if db.get_run(target.into()).map_err(error)?.is_none() {
            return Err(agents::run_not_found(target));
        }
        let base = db
            .attached_seen(target.into(), source.into())
            .map_err(error)?;
        Ok((base, forked))
    })
    .await?;
    let events = agents::logged_events(daemon, source).await?;
    let Some(last) = events.last().map(|event| event.seq) else {
        return Err(nothing_new(source));
    };
    // A fork's log starts with the conversation it copied: the delta starts at its own first turn.
    let start = if forked && base.is_none() {
        let turns = own_turns(daemon, source).await?;
        let first = events.iter().position(|event| {
            matches!(&event.event, ParallaxEvent::AgentOutput { items, .. }
                if items.iter().any(|item| matches!(item,
                    parallax_protocol::AgentOutputItem::TurnStarted { turn_id: Some(turn), .. }
                        if turns.contains(&Uuid::from(*turn)))))
        });
        match first {
            Some(0) => Some(0),
            Some(index) => Some(events[index - 1].seq),
            None => return Err(nothing_new(source)),
        }
    } else {
        None
    };
    if base.is_some_and(|seen| seen >= last) {
        return Err(nothing_new(source));
    }
    let id = Uuid::now_v7();
    store(daemon, move |db| {
        let error = |error| store_error(&error);
        if let Some(start) = start {
            db.record_attached_seen(target.into(), &[(source.into(), start)])
                .map_err(error)?;
        }
        db.add_context_transfer(
            id,
            MERGE_BACK,
            source.into(),
            target.into(),
            last,
            Timestamp::now(),
        )
        .map_err(error)
    })
    .await?;
    Ok(ThreadMergeBackResult {
        transfer_id: id.hyphenated().to_string(),
    })
}

fn nothing_new(source: RunId) -> ErrorObject {
    ErrorObject::invalid_params(format!(
        "thread {source} has no turn of its own to merge back yet"
    ))
}

/// The ids of the turns `run` recorded itself, which a fork's copied ones aren't.
async fn own_turns(daemon: &Daemon, run: RunId) -> Result<Vec<Uuid>, ErrorObject> {
    store(daemon, move |db| {
        Ok(db
            .run_turns(run.into())
            .map_err(|e| store_error(&e))?
            .into_iter()
            .map(|(turn, _)| turn)
            .collect())
    })
    .await
}

/// Refuses a child `mode` that needs less approval than `theirs`, its parent's or owner's (0041):
/// the message the agent sees. No mode means Edit.
pub(crate) fn check_mode(
    theirs: Option<AgentPermission>,
    mode: Option<AgentPermission>,
) -> Result<(), String> {
    let theirs = theirs.unwrap_or(AgentPermission::Edit);
    let child = mode.unwrap_or(AgentPermission::Edit);
    if reach(child).is_some_and(|child| reach(theirs) >= Some(child)) {
        return Ok(());
    }
    let name = |mode| agents::convert::option_name(mode).unwrap_or_default();
    Err(format!(
        "you run in {} mode, so a thread you launch, fork, or delegate to can't run in {}, which \
         needs less approval",
        name(theirs),
        name(child)
    ))
}

/// How much `mode` lets a run do without asking, least first, or `None` for a mode this plxd
/// doesn't know.
fn reach(mode: AgentPermission) -> Option<u8> {
    match mode {
        AgentPermission::Plan => Some(0),
        AgentPermission::Manual => Some(1),
        AgentPermission::Edit => Some(2),
        AgentPermission::Auto => Some(3),
        AgentPermission::Bypass => Some(4),
        AgentPermission::Unknown => None,
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::AgentPermission::{Auto, Bypass, Edit, Manual, Plan, Unknown};

    use super::check_mode;

    #[test]
    fn a_child_never_needs_less_approval_than_its_parent() {
        assert!(check_mode(Some(Auto), Some(Edit)).is_ok());
        assert!(check_mode(Some(Auto), Some(Auto)).is_ok());
        assert!(check_mode(None, None).is_ok(), "both default to Edit");
        assert!(check_mode(Some(Manual), Some(Plan)).is_ok());
        assert!(check_mode(Some(Edit), Some(Bypass)).is_err());
        assert!(check_mode(Some(Plan), None).is_err(), "Edit is above Plan");
        assert!(check_mode(Some(Bypass), Some(Unknown)).is_err());
    }
}
