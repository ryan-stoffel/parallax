//! Agents working across the user's computers (0101): the `peer/*` methods `plxd mcp` calls on the
//! local socket, and the followers that wake a parent when a task or thread on another computer
//! ends.
//!
//! - `peer/computers` lists the account's computers from the relay and asks each online one for
//!   `host/health`, which is what shows whether it takes this computer's agents.
//! - `peer/call` forwards one request to a computer, for the thread tools, and only the methods
//!   they use ([`FORWARDED`]). Nothing falls back to this computer: a computer that is offline,
//!   unknown, unapproved, or that refuses is the tool's error.
//! - `peer/start` records a row for a task or a notifying thread, then starts the thread on the
//!   computer, in the repository `repo/match` finds there, at the parent's mode or stricter. A
//!   refusal removes the row. A crash leaves it, so a thread that started is followed, and one that
//!   never did ends its row after [`START_GRACE`] and wakes the parent to say so.
//! - [`run`] keeps one follower per open row, from the rows in the store, so they outlive restarts.
//!   A follower waits with `agent/wait`, and tries again while the computer can't be reached. When
//!   the run ends, or the computer refuses for good, it records that and wakes the parent as a local
//!   child's end does.
//!
//! `plxd` keeps no account token: the client it uses is [`crate::peer::Plxd::relay`].

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use jiff::{SignedDuration, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::methods::{
    AgentCancel, AgentEvents, AgentList, AgentSend, AgentWait, HostHealth, OrchestrationDispatch,
    RepoFetchBase, RepoMatch, RepoRefs, RequestMethod, ThreadList, ThreadStart,
};
use parallax_protocol::{
    AccountChoice, AgentRun, AgentStatus, AgentWaitParams, AgentWaitUntil, CompletionWake,
    ErrorKind, HostHealthParams, LinkedComputer, PeerCallParams, PeerCallResult,
    PeerComputersResult, PeerStartParams, PeerStartResult, PeerTaskParams, PeerTaskResult,
    PeerWorkspace, RelayHost, RemoteTask, RepoFetchBaseParams, RepoId, RepoMatchParams,
    RepoRefsParams, RunId, TaskDelivery, ThreadStartParams,
};
use parallax_store::RemoteRun;
use serde_json::Value;
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agents::convert::{option_name, option_value};
use crate::agents::wake;
use crate::methods::Context;
use crate::peer::Plxd;
use crate::remote;
use crate::server::Daemon;
use crate::store::store_error;
use crate::threads::store;

/// The methods `peer/call` forwards: what the thread tools use.
const FORWARDED: &[&str] = &[
    AgentCancel::NAME,
    AgentEvents::NAME,
    AgentList::NAME,
    AgentSend::NAME,
    AgentWait::NAME,
    OrchestrationDispatch::NAME,
    ThreadList::NAME,
];

/// How long a forwarded request may take: over the 60 s an `agent/wait` takes.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(75);

/// How long one `agent/wait` of a follower's waits.
const FOLLOW_WAIT: Duration = Duration::from_mins(1);

/// How long a follower first waits to try again, doubling up to [`MAX_RETRY`].
const FIRST_RETRY: Duration = Duration::from_secs(2);
const MAX_RETRY: Duration = Duration::from_mins(1);

/// How often a follower looks at a run that waits to resume past a usage limit, which `agent/wait`
/// answers at once.
const WAITING_PAUSE: Duration = Duration::from_secs(30);

/// How long after its row was recorded a run may be unknown to its computer, as its start may still
/// be on its way: a new worktree and its setup come first.
const START_GRACE: SignedDuration = SignedDuration::from_mins(5);

/// How often a follower asks again for a run that may still be starting.
const STARTING_PAUSE: Duration = Duration::from_secs(5);

/// How much of a remote run's last output its row keeps.
const SUMMARY_BYTES: usize = 8 * 1024;

fn refused(why: impl Into<String>) -> ErrorObject {
    ErrorObject::invalid_params(why.into())
}

/// Refuses a `peer/*` call from anywhere but this computer's own socket, so a session from another
/// computer can't go on to a third that doesn't trust it.
fn local_only(context: &Context) -> Result<(), ErrorObject> {
    if context.over_connect || context.over_remote {
        return Err(refused(
            "peer methods are only for this computer's own tools",
        ));
    }
    Ok(())
}

/// A computer a tool named.
struct Computer {
    id: String,
    name: String,
}

/// The computer `named`, by relay id, or by a name one computer on the account has. Never this
/// computer: that's a tool call without `computer`.
async fn resolve(daemon: &Daemon, named: &str) -> Result<Computer, ErrorObject> {
    let hosts = daemon.relay_peers.hosts(daemon).await;
    let computer = if remote::is_host_id(named) {
        let name = hosts.as_ref().ok().and_then(|hosts| {
            let host = hosts.iter().find(|host| host.host_id == named)?;
            Some(host.name.clone())
        });
        Computer {
            id: named.to_owned(),
            name: name.unwrap_or_else(|| named.to_owned()),
        }
    } else {
        let hosts = hosts
            .map_err(|error| refused(format!("can't look up the computer {named:?}: {error}")))?;
        let mut matching: Vec<RelayHost> = hosts
            .into_iter()
            .filter(|host| host.name.eq_ignore_ascii_case(named))
            .collect();
        match matching.len() {
            0 => {
                return Err(refused(format!(
                    "no computer on this account is named {named:?}; linked_computers lists them"
                )));
            }
            1 => {}
            many => {
                return Err(refused(format!(
                    "{many} computers are named {named:?}; use its id from linked_computers"
                )));
            }
        }
        let host = matching.remove(0);
        Computer {
            id: host.host_id,
            name: host.name,
        }
    };
    let own = crate::relay::signer(daemon)
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
        .thumbprint();
    if computer.id == own {
        return Err(refused(format!(
            "{} is this computer; leave computer out to work here",
            computer.name
        )));
    }
    Ok(computer)
}

/// `peer/computers`: see the module documentation.
pub(crate) async fn computers(context: &Context) -> Result<PeerComputersResult, ErrorObject> {
    local_only(context)?;
    let daemon = &context.daemon;
    let hosts = daemon
        .relay_peers
        .hosts(daemon)
        .await
        .map_err(|error| refused(format!("can't list this account's computers: {error}")))?;
    Ok(PeerComputersResult {
        computers: join_all(hosts.into_iter().map(|host| probed(daemon, host))).await,
    })
}

/// `host` as `linked_computers` shows it, asked directly when it's online.
async fn probed(daemon: &Arc<Daemon>, host: RelayHost) -> LinkedComputer {
    let RelayHost {
        host_id,
        name,
        online,
        this_computer,
        ..
    } = host;
    let mut computer = LinkedComputer {
        id: host_id,
        name,
        online,
        this_computer,
        takes_agent_work: false,
        why_not: None,
        running_agents: None,
        load: None,
    };
    if this_computer {
        computer.why_not = Some("it's the computer you run on".to_owned());
        computer.running_agents = Some(daemon.agents.running());
        computer.load = daemon.load.read();
    } else if !online {
        computer.why_not = Some("it's offline".to_owned());
    } else {
        let (client, _) = daemon.relay_peers.client(daemon, &computer.id);
        let asked = client.call::<HostHealth>(HostHealthParams {});
        let answered = timeout(FORWARD_TIMEOUT, asked)
            .await
            .unwrap_or_else(|_| Err("it didn't answer".to_owned()));
        match answered {
            Ok(health) => {
                computer.takes_agent_work = true;
                computer.running_agents = Some(health.running_agents);
                computer.load = health.load;
            }
            Err(error) => computer.why_not = Some(error),
        }
    }
    computer
}

/// `peer/call`: see the module documentation. A message names where it came from, since `from`
/// means a run on the host it goes to.
pub(crate) async fn call(
    context: &Context,
    params: PeerCallParams,
) -> Result<PeerCallResult, ErrorObject> {
    local_only(context)?;
    let PeerCallParams {
        computer,
        method,
        mut params,
    } = params;
    if !FORWARDED.contains(&method.as_str()) {
        return Err(refused(format!(
            "{method} isn't forwarded to other computers"
        )));
    }
    let daemon = &context.daemon;
    let computer = resolve(daemon, &computer).await?;
    let (client, _) = daemon.relay_peers.client(daemon, &computer.id);
    may_message(daemon, &client, &method, &params).await?;
    name_the_sender(daemon, &method, &mut params).await;
    let run = params["runId"].as_str().map(str::to_owned);
    let forwarded = client.forward(&method, params);
    let answered = tokio::select! {
        answered = timeout(FORWARD_TIMEOUT, forwarded) => answered,
        () = context.cancel.cancelled() => return Err(ErrorObject::request_cancelled()),
    };
    let result = match answered {
        Ok(Ok(result)) => result?,
        Ok(Err(lost)) => return Err(refused(lost)),
        Err(_) => {
            client.reset().await;
            return Err(refused(format!(
                "{} didn't answer within {FORWARD_TIMEOUT:?}",
                computer.name
            )));
        }
    };
    if method == AgentSend::NAME
        && let Some(run) = run.and_then(|run| Uuid::parse_str(&run).ok())
    {
        follow_again(daemon, run).await;
    }
    Ok(PeerCallResult(result))
}

/// Takes `from`, a run on this computer, out of `params`, and for a message opens its text by
/// naming this computer and that run.
async fn name_the_sender(daemon: &Daemon, method: &str, params: &mut Value) {
    let from = params
        .as_object_mut()
        .and_then(|params| params.remove("from"));
    let (Some(from), true) = (
        from.as_ref().and_then(Value::as_str),
        method == AgentSend::NAME,
    ) else {
        return;
    };
    let here = crate::server::remote::host_name(daemon).await;
    if let Some(text) = params["text"].as_str() {
        params["text"] = format!("From an agent on {here}, in its thread {from}:\n\n{text}").into();
    }
}

/// A message runs its turn in the target's mode, so it meets the rule for a thread the caller
/// starts: the target can't need less approval than the caller (0101). `from` is the caller's run.
async fn may_message(
    daemon: &Daemon,
    client: &Plxd,
    method: &str,
    params: &Value,
) -> Result<(), ErrorObject> {
    if method != AgentSend::NAME {
        return Ok(());
    }
    let run_in = |name: &str| {
        params[name]
            .as_str()
            .and_then(|id| id.parse::<RunId>().ok())
            .ok_or_else(|| refused(format!("a message to another computer needs {name}")))
    };
    let (caller, target) = (run_in("from")?, run_in("runId")?);
    let (row, _) = parent_and_repo(daemon, caller).await?;
    let theirs = row.fields.permission.as_deref().and_then(option_value);
    let there = crate::mcp::thread::find_run(client, target)
        .await
        .map_err(refused)?;
    crate::delegation::check_mode(theirs, there.permission)
        .map_err(|why| refused(format!("can't message thread {target}: {why}")))
}

/// Follows run `run` again, if a thread's row ended, as a message resumes it.
async fn follow_again(daemon: &Daemon, run: Uuid) {
    let running = option_name(AgentStatus::Running).unwrap_or_default();
    let reopened = store(daemon, move |db| {
        db.reopen_remote_run(run, &running)
            .map_err(|e| store_error(&e))
    })
    .await;
    if matches!(reopened, Ok(true)) {
        daemon.relay_peers.followers.notify_one();
    }
}

/// `peer/start`: see the module documentation.
pub(crate) async fn start(
    context: &Context,
    params: PeerStartParams,
) -> Result<PeerStartResult, ErrorObject> {
    local_only(context)?;
    context
        .detached(|daemon| start_thread(daemon, params))
        .await
}

#[expect(clippy::too_many_lines, reason = "its steps, in order")]
async fn start_thread(
    daemon: Arc<Daemon>,
    params: PeerStartParams,
) -> Result<PeerStartResult, ErrorObject> {
    crate::methods::check_message("prompt", &params.prompt, &[])?;
    if params.completion_wake == Some(CompletionWake::Unknown) {
        return Err(refused("unknown completionWake"));
    }
    let (parent_row, parent_path) = parent_and_repo(&daemon, params.parent).await?;
    let fields = &parent_row.fields;
    let theirs = fields.permission.as_deref().and_then(option_value);
    // The caller's plxd enforces this: the other computer trusts its session (0101).
    let permission = params.permission.or(theirs);
    crate::delegation::check_mode(theirs, permission).map_err(refused)?;
    let computer = resolve(&daemon, &params.computer).await?;
    let (client, _) = daemon.relay_peers.client(&daemon, &computer.id);
    let (repo, base) =
        workspace_there(&daemon, &client, &computer, parent_path.as_deref(), &params).await?;

    // A task runs on the parent's backend and model, as a local one does.
    let task = params.completion_wake.is_some();
    let inherits = task && params.account.is_none();
    let account = params.account.clone().or_else(|| {
        inherits.then(|| AccountChoice::Subscription {
            backend: fields.backend.clone(),
        })
    });
    let model = params
        .model
        .clone()
        .or_else(|| fields.model.clone().filter(|_| inherits));
    let effort = params.effort.or_else(|| {
        fields
            .effort
            .as_deref()
            .and_then(option_value)
            .filter(|_| inherits)
    });

    let here = crate::server::remote::host_name(&daemon).await;
    let parent = params.parent;
    let opened = format!(
        "This thread was started by an agent on {here}, in its thread {parent}.\n\n{}",
        params.prompt
    );
    let row = RemoteRun {
        id: params.run_id.into(),
        host_id: computer.id.clone(),
        host_name: computer.name.clone(),
        parent: parent.into(),
        title: params
            .title
            .clone()
            .unwrap_or_else(|| wake::task(&params.prompt)),
        task,
        completion_wake: option_name(params.completion_wake.unwrap_or(CompletionWake::Always))
            .unwrap_or_default(),
        delivery: option_name(TaskDelivery::Pending).unwrap_or_default(),
        status: option_name(AgentStatus::Running).unwrap_or_default(),
        summary: None,
        reason: None,
        ended_at: None,
        created_at: Timestamp::now(),
    };
    // Reachable now, so a computer that's away is an error with no row left to follow.
    client.agent_wait().await.map_err(refused)?;
    // Stored before the start, so a crash anywhere after it still follows the thread, or reports
    // that it never started. A retry finds its own row.
    let id = row.id;
    let followed = task || params.notify;
    let added = store(&daemon, move |db| {
        Ok(followed && db.add_remote_run(&row).map_err(|e| store_error(&e))?)
    })
    .await?;
    daemon.relay_peers.followers.notify_one();
    let started = client
        .request::<ThreadStart>(ThreadStartParams {
            run_id: params.run_id,
            repo,
            orchestrator: None,
            parent: None,
            notify: None,
            title: params.title,
            prompt: opened,
            account,
            model,
            effort,
            permission,
            context_window: None,
            fast: None,
            branch_slug: None,
            images: Vec::new(),
            threads: params.threads,
            computers: Vec::new(),
            remote_threads: Vec::new(),
            // As a thread the user starts there: full Claude Code, asking that computer's app.
            approvals: true,
            checkout: params.workspace == PeerWorkspace::Checkout,
            base,
            checkout_ref: params.checkout_ref,
            naming: None,
        })
        .await;
    let started = match started {
        Ok(Ok(started)) => started,
        // It said no, so nothing runs there.
        Ok(Err(error)) => {
            if added {
                store(&daemon, move |db| {
                    db.delete_remote_run(id).map_err(|e| store_error(&e))
                })
                .await?;
            }
            return Err(error);
        }
        Err(lost) => {
            return Err(refused(format!(
                "the answer from {} was lost, so the thread may be running there: {lost}. Don't \
                 start it again before checking with thread_list on that computer. Its end, or \
                 that it never started, wakes you if it was to",
                computer.name
            )));
        }
    };
    info!(run = %params.run_id, computer = %computer.id, "started a thread on another computer");
    Ok(PeerStartResult {
        computer: computer.id,
        computer_name: computer.name,
        thread: started.thread,
        run: started.run,
    })
}

/// The repo entry on `computer` a new thread works in, and the ref a new worktree starts from,
/// fetched there. Pushed commits are what the tools promise are there, so its last fetch won't do.
async fn workspace_there(
    daemon: &Daemon,
    client: &Plxd,
    computer: &Computer,
    parent_path: Option<&str>,
    params: &PeerStartParams,
) -> Result<(Option<RepoId>, Option<String>), ErrorObject> {
    let repo = match (params.workspace, params.repo) {
        (PeerWorkspace::None, _) => None,
        (_, Some(repo)) => Some(repo),
        (_, None) => Some(matching_repo(daemon, client, computer, parent_path).await?),
    };
    let base = match (params.workspace, &params.base, repo) {
        (PeerWorkspace::Worktree, None, Some(repo)) => {
            default_base(client, repo).await.map_err(refused)?
        }
        (_, base, _) => base.clone(),
    };
    if let (Some(repo), Some(base)) = (repo, base.clone()) {
        client
            .call::<RepoFetchBase>(RepoFetchBaseParams { repo, base })
            .await
            .map_err(refused)?;
    }
    Ok((repo, base))
}

/// Run `parent`'s row, and the folder of its thread's repository, unless it has none.
async fn parent_and_repo(
    daemon: &Daemon,
    parent: RunId,
) -> Result<(parallax_store::Run, Option<String>), ErrorObject> {
    store(daemon, move |db| {
        let error = |error| store_error(&error);
        let row = db
            .get_run(parent.into())
            .map_err(error)?
            .ok_or_else(|| crate::agents::run_not_found(parent))?;
        let path = match db.get_thread(parent.into()).map_err(error)? {
            Some(thread) => db
                .get_repo(thread.repo_id)
                .map_err(error)?
                .filter(|repo| !repo.fields.scratch)
                .map(|repo| repo.fields.path),
            None => None,
        };
        Ok((row, path))
    })
    .await
}

/// The repo entry on `computer` that is a copy of the repository at `path` here, by `origin`. Its
/// absence is an error that names what's missing: an agent shouldn't choose what lands on another
/// computer's disk (0101).
async fn matching_repo(
    daemon: &Daemon,
    client: &Plxd,
    computer: &Computer,
    path: Option<&str>,
) -> Result<RepoId, ErrorObject> {
    let Some(path) = path else {
        return Err(refused(
            "your thread has no repository to find on the other computer; use workspace none, or \
             name a repo id from thread_list on that computer",
        ));
    };
    let Some(origin) = crate::repo_clone::origin(daemon, std::path::Path::new(path)).await else {
        return Err(refused(format!(
            "{path} has no origin, so {} can't have a copy of it",
            computer.name
        )));
    };
    let matched = client
        .call::<RepoMatch>(RepoMatchParams {
            origin: origin.clone(),
        })
        .await
        .map_err(refused)?;
    matched.repo.map(|repo| repo.id).ok_or_else(|| {
        refused(format!(
            "{} has no copy of {}; clone or add it there first, then try again",
            computer.name,
            crate::repo_clone::without_userinfo(&origin)
        ))
    })
}

/// The ref a new worktree of `repo` starts from: `origin`'s default branch, when it has one.
async fn default_base(client: &Plxd, repo: RepoId) -> Result<Option<String>, String> {
    let refs = client.call::<RepoRefs>(RepoRefsParams { repo }).await?.refs;
    let Some(default) = refs.iter().find(|branch| branch.default) else {
        return Ok(None);
    };
    if default.remote {
        return Ok(Some(default.name.clone()));
    }
    let tracking = format!("origin/{}", default.name);
    let tracked = refs
        .iter()
        .any(|branch| branch.remote && branch.name == tracking);
    Ok(Some(if tracked {
        tracking
    } else {
        default.name.clone()
    }))
}

/// `peer/task`: see the module documentation of [`PeerTaskParams`].
pub(crate) async fn task(
    context: &Context,
    params: PeerTaskParams,
) -> Result<PeerTaskResult, ErrorObject> {
    local_only(context)?;
    let PeerTaskParams {
        parent,
        task_id,
        acknowledge,
        completion_wake,
        dispose,
    } = params;
    if completion_wake == Some(CompletionWake::Unknown) {
        return Err(refused("unknown completionWake"));
    }
    store(&context.daemon, move |db| {
        let error = |error| store_error(&error);
        let found = db.remote_run(task_id.into()).map_err(error)?;
        let Some(mut row) = found.filter(|row| row.task && row.parent == Uuid::from(parent)) else {
            return Ok(PeerTaskResult { task: None });
        };
        let before = (row.delivery.clone(), row.completion_wake.clone());
        if row.delivery == option_name(TaskDelivery::Pending).unwrap_or_default() {
            if dispose {
                row.delivery = option_name(TaskDelivery::Disposed).unwrap_or_default();
            } else if acknowledge {
                row.delivery = option_name(TaskDelivery::Acknowledged).unwrap_or_default();
            }
        }
        if let Some(wake) = completion_wake {
            row.completion_wake = option_name(wake).unwrap_or_default();
        }
        if before != (row.delivery.clone(), row.completion_wake.clone()) {
            db.set_remote_run_delivery(row.id, &row.delivery, &row.completion_wake)
                .map_err(error)?;
        }
        let task = remote_task(row, task_id);
        Ok(PeerTaskResult { task: Some(task) })
    })
    .await
}

fn remote_task(row: RemoteRun, task_id: RunId) -> RemoteTask {
    RemoteTask {
        task_id,
        computer: row.host_id,
        computer_name: row.host_name,
        title: row.title,
        status: option_value(&row.status).unwrap_or(AgentStatus::Unknown),
        summary: row.summary,
        reason: row.reason,
        completion_wake: option_value(&row.completion_wake).unwrap_or(CompletionWake::Always),
        delivery: option_value(&row.delivery).unwrap_or(TaskDelivery::Pending),
    }
}

/// Keeps one follower per open row, until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut followers = JoinSet::new();
    let mut followed = HashSet::new();
    loop {
        match store(&daemon, |db| {
            db.open_remote_runs().map_err(|e| store_error(&e))
        })
        .await
        {
            Ok(rows) => {
                for row in rows {
                    if followed.insert(row.id) {
                        followers.spawn(follow(Arc::clone(&daemon), row));
                    }
                }
            }
            Err(error) => warn!(error = %error.message, "could not read the remote runs"),
        }
        tokio::select! {
            () = stop.cancelled() => return,
            () = daemon.relay_peers.followers.notified() => {}
            Some(done) = followers.join_next() => {
                if let Ok(id) = done {
                    followed.remove(&id);
                }
            }
        }
    }
}

/// How one wait of a follower's went.
enum Followed {
    /// The run ended.
    Ended(Box<AgentRun>),
    /// It hasn't: wait again, after this long.
    Again(Duration),
    /// The computer can't be reached now.
    Unreachable,
    /// Plxd ends it for this reason: the computer refused for good, or the thread is gone.
    Over(String),
}

/// Waits for `row`'s run on its computer, and answers with its id once it recorded the end.
async fn follow(daemon: Arc<Daemon>, row: RemoteRun) -> Uuid {
    let id = row.id;
    let Ok(run_id) = RunId::try_from(id) else {
        return id;
    };
    let (client, link) = daemon.relay_peers.client(&daemon, &row.host_id);
    let mut retry = FIRST_RETRY;
    loop {
        let answered = timeout(
            FOLLOW_WAIT + FIRST_RETRY * 8,
            wait_once(&client, run_id, row.created_at),
        )
        .await;
        let followed = match answered {
            Ok(Some(followed)) => followed,
            Ok(None) => link.refused().map_or(Followed::Unreachable, Followed::Over),
            Err(_) => {
                // Answers stopped without the connection closing.
                client.reset().await;
                Followed::Unreachable
            }
        };
        match followed {
            Followed::Ended(run) => {
                if let Ok(output) = crate::mcp::last_output(&client, run_id).await {
                    let summary = output.map(|text| crate::mcp::tail(&text, SUMMARY_BYTES));
                    ended(&daemon, run_id, run.status, summary, run.error.clone()).await;
                    return id;
                }
                sleep(retry).await;
                retry = (retry * 2).min(MAX_RETRY);
            }
            Followed::Again(pause) => {
                retry = FIRST_RETRY;
                sleep(pause).await;
            }
            Followed::Unreachable => {
                sleep(retry).await;
                retry = (retry * 2).min(MAX_RETRY);
            }
            Followed::Over(reason) => {
                ended(&daemon, run_id, AgentStatus::Failed, None, Some(reason)).await;
                return id;
            }
        }
    }
}

/// One `agent/wait` for `run`, whose row was recorded at `recorded`: `None` when the connection
/// failed.
async fn wait_once(client: &Plxd, run: RunId, recorded: Timestamp) -> Option<Followed> {
    let waited = client
        .request::<AgentWait>(AgentWaitParams {
            run_ids: vec![run],
            until: AgentWaitUntil::Any,
            timeout_ms: u32::try_from(FOLLOW_WAIT.as_millis()).unwrap_or(u32::MAX),
        })
        .await
        .ok()?;
    Some(match waited {
        Ok(waited) => match waited.runs.into_iter().next() {
            Some(run) if run_ended(run.status) => Followed::Ended(Box::new(run)),
            Some(run) if run.status == AgentStatus::Waiting => Followed::Again(WAITING_PAUSE),
            Some(_) => Followed::Again(Duration::ZERO),
            None => unknown(recorded),
        },
        Err(error)
            if error
                .parallax_data()
                .is_some_and(|data| data.kind == ErrorKind::RunNotFound) =>
        {
            unknown(recorded)
        }
        Err(_) => Followed::Again(FIRST_RETRY),
    })
}

/// What a run its computer doesn't know means, by when its row was recorded at `recorded`.
fn unknown(recorded: Timestamp) -> Followed {
    if Timestamp::now().duration_since(recorded) < START_GRACE {
        return Followed::Again(STARTING_PAUSE);
    }
    Followed::Over("the thread never started on that computer, or is gone from it".to_owned())
}

/// Whether a run in `status` has ended: a turn a restart there interrupted counts (0101).
fn run_ended(status: AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::Starting | AgentStatus::Running | AgentStatus::Waiting
    )
}

/// Records that `run` ended, and wakes its parent unless it read the result, cancelled the task,
/// or waits on it in a running turn.
async fn ended(
    daemon: &Arc<Daemon>,
    run: RunId,
    status: AgentStatus,
    summary: Option<String>,
    reason: Option<String>,
) {
    let name = option_name(status).unwrap_or_default();
    let recorded = store(daemon, move |db| {
        let error = |error| store_error(&error);
        let Some(row) = db
            .end_remote_run(run.into(), &name, summary.as_deref(), reason.as_deref())
            .map_err(error)?
        else {
            return Ok(None);
        };
        let wakes = crate::delegation::remote_wakes(db, &row)?;
        Ok(Some((row, wakes)))
    })
    .await;
    match recorded {
        Ok(Some((row, wakes))) => {
            info!(run = %run, computer = %row.host_id, status = %row.status, "a run on another computer ended");
            if wakes {
                wake::remote_ended(daemon, &row);
            }
        }
        Ok(None) => {}
        Err(error) => {
            warn!(run = %run, error = %error.message, "could not record a remote run's end");
        }
    }
}
