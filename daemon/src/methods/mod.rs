//! The methods plxd answers, one module per group, routed through `parallax_protocol`'s method
//! table so every params and result type is the protocol's own.
//!
//! Each capability gets a module here (M3 `agents`: `agent.rs` and `context.rs`; M4
//! `coordinator`: `project/start` in `project.rs`; #110 `threads`: `thread.rs`; PLX-227
//! `projectEdit`: `project/update` in `project.rs`; PLX-338 `projectDelete`: `project/delete` in
//! `project.rs`; 0042 `projectFromThreads`: `project/fromThreads` in `project.rs`; PLX-318 `pullRequests`, PLX-328 `prDiff`, and PLX-373 `threadTools` (`pr/link`
//! and `pr/unlink`): `pr.rs`; PLX-359 `composerMenus`: `composer.rs`; PLX-336 `githubStatus`:
//! `github/status` in `accounts.rs`; PLX-423 `githubSetup`: `github/install`, `github/signIn`, and
//! `github/signInCancel` there too; PLX-401 `inbox`: `inbox.rs`; PLX-370 `queue`: `queue.rs`; PLX-402 `questions`: `question.rs`; PLX-405 `memory`: `memory.rs`; PLX-410 `landing`: `land.rs`; PLX-574 `connect`: `connect/devices` in `connect.rs`; PLX-637 `terminals`: `terminal/*` in
//! `crate::terminals`; PLX-641 `remote`: `remote/*` in `remote.rs`), and `host.rs` advertises the
//! capability in `initialize`.

mod accounts;
mod agent;
mod composer;
mod connect;
pub(crate) mod context;
mod cursor;
mod defaults;
mod events;
mod host;
pub(crate) mod inbox;
pub(crate) mod land;
mod memory;
mod pr;
pub(crate) mod project;
pub(crate) mod question;
mod queue;
mod remote;
mod thread;
mod usage;

use std::future::{Future, ready};
use std::sync::Arc;

use parallax_protocol::jsonrpc::{
    ErrorObject, INVALID_REQUEST, Notification, Request, RequestId, Response,
};
use parallax_protocol::methods::{
    self, EventsSubscribe, EventsUnsubscribe, Initialize, RequestMethod,
};
use parallax_protocol::{
    EventsSubscribeResult, EventsUnsubscribeResult, ProvidersListResult, SubscriptionId,
    TerminalListResult, TerminalResult,
};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub(crate) use defaults::read_defaults;
pub(crate) use events::{Cursor, Cursors, Delivery};
pub(crate) use host::{Session, initialize, os_version};

use crate::agents::{self, GitAction};
use crate::server::Daemon;
use crate::threads;

/// What a request handler has to work with.
pub(crate) struct Context {
    pub daemon: Arc<Daemon>,
    /// Cancelled by `$/cancelRequest`, or when the connection closes at once. When the client
    /// closes its side or plxd shuts down, the connection answers what it read first instead.
    /// A listed command method uses a token the connection never cancels (0052).
    pub cancel: CancellationToken,
    /// Cancelled when the connection stops reading: the client closed its side or plxd is
    /// shutting down. A request that waits for something else, like `agent/wait`, ends then.
    pub stopped_reading: CancellationToken,
    /// `commandId` taken out of the params before the method parses them (0052).
    pub command_id: Option<uuid::Uuid>,
    /// The connection's writer, for notifications that aren't events, such as a terminal's
    /// output.
    pub replies: tokio::sync::mpsc::Sender<Reply>,
}

/// What the connection's writer sends for a request.
#[derive(Debug)]
pub(crate) enum Reply {
    Response(Response),
    /// `initialize`'s answer, and whether a lagging subscription gets `events/resync`.
    Initialized {
        response: Response,
        resync_notice: bool,
    },
    /// Send the response, then start delivering the subscription's events.
    Subscribe {
        response: Response,
        cursor: Cursor,
    },
    /// Stop delivering the subscription's events, then send the response.
    Unsubscribe {
        response: Response,
        subscription: SubscriptionId,
    },
    /// A notification that isn't an event, such as a terminal's output (PLX-637).
    Notification(Notification),
}

/// Answers a request on an initialized connection.
pub(crate) async fn dispatch(mut context: Context, mut request: Request) -> Reply {
    if let Some(reply) = command_prelude(&mut context, &mut request) {
        return reply;
    }
    let id = request.id.clone();
    let result = match request.method.as_str() {
        EventsSubscribe::NAME => {
            let subscribed = match request.params() {
                Ok(params) => events::subscribe(&context, params).await,
                Err(error) => Err(error),
            };
            return match subscribed {
                Ok(cursor) => Reply::Subscribe {
                    response: success(
                        id,
                        &EventsSubscribeResult {
                            subscription: cursor.subscription,
                        },
                    ),
                    cursor,
                },
                Err(error) => Reply::Response(Response::error(Some(id), error)),
            };
        }
        EventsUnsubscribe::NAME => {
            return match request.params::<<EventsUnsubscribe as RequestMethod>::Params>() {
                Ok(params) => Reply::Unsubscribe {
                    response: success(id, &EventsUnsubscribeResult {}),
                    subscription: params.subscription,
                },
                Err(error) => Reply::Response(Response::error(Some(id), error)),
            };
        }
        Initialize::NAME => Err(ErrorObject::new(
            INVALID_REQUEST,
            "Invalid request: the connection is already initialized",
        )),
        _ => route(&context, &request).await,
    };
    Reply::Response(Response {
        id: Some(id),
        result,
    })
}

/// A `match` on the request's method with one arm per `Method => handler` pair, `Method` named in
/// `parallax_protocol::methods`, each answered through [`handle`], and `method_not_found` for any
/// other name.
macro_rules! routes {
    ($context:expr, $request:expr, { $($method:ident => $handler:expr,)* }) => {
        match $request.method.as_str() {
            $(methods::$method::NAME => {
                handle::<methods::$method, _, _>($context, $request, $handler).await
            })*
            other => Err(ErrorObject::method_not_found(other)),
        }
    };
}

/// Answers every method but `initialize` and `events/*`, one line per method.
#[expect(clippy::too_many_lines, reason = "one line per method")]
async fn route(context: &Context, request: &Request) -> Result<Value, ErrorObject> {
    let daemon = &context.daemon;
    routes!(context, request, {
        HostHealth => |p| ready(Ok(host::health(context, p))),
        HostVersion => |p| ready(Ok(host::version(context, p))),
        HostSettingsGet => |p| host::settings(context, p),
        HostSettingsSet => |p| host::set_settings(context, p),
        ConnectDevices => |p| connect::devices(context, p),
        RemotePair => |p| remote::pair(context, p),
        RemoteSessions => |p| remote::sessions(context, p),
        RemoteRevoke => |p| remote::revoke(context, p),
        AccountsList => |p| accounts::list(context, p),
        AccountsRefresh => |p| accounts::refresh(context, p),
        AccountsKeysAdd => |p| accounts::keys::add(context, p),
        AccountsKeysList => |p| accounts::keys::list(context, p),
        AccountsKeysRemove => |p| accounts::keys::remove(context, p),
        AccountsDefaultsGet => |p| defaults::get(context, p),
        AccountsDefaultsSet => |p| defaults::set(context, p),
        // Each `providers/*` answers with every instance after it (0040).
        ProvidersList => |p| async move { Ok(providers(daemon, p.refresh).await) },
        ProvidersSave => |p| async move {
            daemon.providers.save(p.instance).await?;
            // A lower reserve, or an instance turned on, may start a waiting child (0046).
            daemon.agents.placement.notify_one();
            Ok(providers(daemon, false).await)
        },
        ProvidersRemove => |p| async move {
            daemon.providers.remove(&p.id).await?;
            Ok(providers(daemon, false).await)
        },
        UsageGet => |p| usage::get(context, p),
        UsageHistory => |p| usage::history(context, p),
        UsageDaily => |p| usage::daily(context, p),
        UsageLimits => |p| usage::limits(context, p),
        CursorSignIn => |p| cursor::sign_in(context, p),
        CursorSignInCancel => |p| ready(Ok(cursor::sign_in_cancel(context, p))),
        CursorSignOut => |p| cursor::sign_out(context, p),
        CursorInstall => |p| ready(cursor::install(context, p)),
        GithubStatusGet => |p| accounts::github(context, p),
        GithubInstall => |p| accounts::github_install(context, p),
        GithubSignInStart => |p| accounts::github_sign_in(context, p),
        GithubSignInCancel => |p| ready(Ok(accounts::github_sign_in_cancel(context, p))),
        ContextList => |p| context::list(context, p),
        ContextRead => |p| context::read(context, p),
        ContextWrite => |p| context::write(context, p),
        ProjectList => |p| project::list(context, p),
        ProjectCreate => |p| project::create(context, p),
        ProjectStart => |p| project::start(context, p),
        ProjectUpdate => |p| project::update(context, p),
        ProjectDelete => |p| project::delete(context, p),
        ProjectFromThreads => |p| project::from_threads(context, p),
        InboxList => |p| inbox::list(context, p),
        InboxSeen => |p| inbox::seen(context, p),
        ThreadList => |_| threads::list(daemon),
        ThreadStart => |p| thread::start(context, p),
        ThreadFork => |p| thread::fork(context, p),
        ThreadArchive => |p| threads::archive(daemon, p, context.command_id),
        ThreadUpdate => |p| threads::update(daemon, p, context.command_id),
        ThreadDelete => |p| thread::delete(context, p),
        ThreadSearch => |p| threads::search(daemon, p),
        RepoAdd => |p| threads::add_repo(daemon, p),
        RepoUpdate => |p| threads::update_repo(daemon, p),
        RepoRefs => |p| threads::refs(daemon, p),
        RepoFiles => |p| composer::files(context, p),
        AgentStart => |p| agent::start(context, p),
        AgentSend => |p| agent::send(context, p),
        AgentCancel => |p| agent::cancel(context, p),
        AgentList => |p| agent::list(context, p),
        AgentEvents => |p| agent::events(context, p),
        AgentWait => |p| agents::wait::wait(context, p),
        AgentImage => |p| agents::image(daemon, p),
        AgentAttach => |p| agents::attach(daemon, p),
        AgentDiff => |p| agents::review::diff(daemon, p.run_id),
        AgentFile => |p| agents::review::file(daemon, p),
        AgentFiles => |p| agents::review::files(daemon, p),
        AgentFileCreate => |p| agents::review::create_entry(daemon, p),
        AgentFileRename => |p| agents::review::rename_entry(daemon, p),
        AgentFileDelete => |p| agents::review::delete_entry(daemon, p),
        AgentAccept => |p| agent::accept(context, p),
        AgentRequestChanges => |p| agent::request_changes(context, p),
        AgentOpenPr => |p| agent::open_pr(context, p),
        AgentApprove => |p| agent::approve(context, p),
        AgentGitStatus => |p| agent::git(context, p.run_id, GitAction::Status),
        AgentCommit => |p| agent::commit(context, p),
        AgentPush => |p| agent::git(context, p.run_id, GitAction::Push),
        AgentCommands => |p| composer::list_commands(context, p),
        AgentResumeNow => |p| agent::resume_now(context, p),
        AgentAutoResume => |p| agent::auto_resume(context, p),
        PrView => |p| agents::view_pr(Arc::clone(daemon), p),
        PrAct => |p| pr::act(context, p),
        PrDiff => |p| agents::diff_pr(Arc::clone(daemon), p),
        PrLink => |p| pr::link(context, p, true),
        PrUnlink => |p| pr::link(context, p, false),
        QueueList => |p| queue::list(context, p),
        QueueEdit => |p| queue::edit(context, p),
        QueueReorder => |p| queue::reorder(context, p),
        QueueCancel => |p| queue::cancel(context, p),
        QueueSteer => |p| queue::steer(context, p),
        QuestionAsk => |p| question::ask(context, p),
        QuestionAnswer => |p| question::answer(context, p),
        QuestionEscalate => |p| question::escalate(context, p),
        QuestionList => |p| question::list(context, p),
        MemoryList => |p| memory::list(context, p),
        MemoryRead => |p| memory::read(context, p),
        MemoryWrite => |p| memory::write(context, p),
        MemoryDelete => |p| memory::delete(context, p),
        MemoryPropose => |p| memory::propose(context, p),
        LandQueue => |p| land::queue(context, p),
        LandApprove => |p| land::approve(context, p),
        LandSendBack => |p| land::send_back(context, p),
        TerminalOpen => |p| ready(
            daemon
                .terminals
                .open(p, &context.replies, &context.stopped_reading)
                .map(|()| TerminalResult {})
        ),
        TerminalClose => |p| {
            daemon.terminals.close(p.thread_id, p.terminal_id);
            ready(Ok(TerminalResult {}))
        },
        TerminalList => |p| ready(Ok(TerminalListResult {
            terminals: daemon.terminals.list(p.thread_id.as_deref()),
        })),
    })
}

/// The provider instances, with each Cursor one's sign-in failure.
async fn providers(daemon: &Daemon, refresh: bool) -> ProvidersListResult {
    let mut listed = daemon.providers.list(&daemon.cli_detector, refresh).await;
    for info in &mut listed.providers {
        if info.instance.kind == parallax_protocol::ProviderKind::Cursor {
            info.sign_in_error = daemon.cursor.failure(&info.instance.id);
        }
    }
    listed
}

/// Cancels a non-listed method, and takes `commandId` off the params.
fn command_prelude(context: &mut Context, request: &mut Request) -> Option<Reply> {
    let id = request.id.clone();
    if context.cancel.is_cancelled() && !crate::commands::keeps_receipt(&request.method) {
        return Some(Reply::Response(Response::error(
            Some(id),
            ErrorObject::request_cancelled(),
        )));
    }
    match crate::commands::take_command_id(request) {
        Ok(command_id) => context.command_id = command_id,
        Err(error) => return Some(Reply::Response(Response::error(Some(id), error))),
    }
    None
}

async fn handle<M, F, Fut>(
    context: &Context,
    request: &Request,
    handler: F,
) -> Result<Value, ErrorObject>
where
    M: RequestMethod,
    F: FnOnce(M::Params) -> Fut,
    Fut: Future<Output = Result<M::Result, ErrorObject>>,
{
    let params = request.params::<M::Params>()?;
    if let Some(command_id) = context
        .command_id
        .filter(|_| crate::commands::RECEIPTED_METHODS.contains(&M::NAME))
    {
        return crate::commands::run_receipted::<M, _, _>(
            &context.daemon,
            command_id,
            params,
            handler,
        )
        .await;
    }
    let result = handler(params).await?;
    serde_json::to_value(result).map_err(ErrorObject::internal_error)
}

/// A successful response with `result`.
pub(crate) fn success(id: RequestId, result: &impl Serialize) -> Response {
    match serde_json::to_value(result) {
        Ok(value) => Response::success(id, value),
        Err(error) => Response::error(Some(id), ErrorObject::internal_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use parallax_protocol::jsonrpc::Request;
    use parallax_protocol::methods::{HostSettingsSet, RequestMethod, ThreadSearch};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::{Context, Reply, dispatch};
    use crate::server::Daemon;

    /// Answers `M` with `params` through the dispatcher, as a connection would.
    async fn call<M: RequestMethod>(daemon: Arc<Daemon>, params: serde_json::Value) -> M::Result {
        let context = Context {
            daemon,
            cancel: CancellationToken::new(),
            stopped_reading: CancellationToken::new(),
            command_id: None,
            replies: tokio::sync::mpsc::channel(1).0,
        };
        let request = Request {
            id: 1.into(),
            method: M::NAME.to_owned(),
            params: Some(params),
        };
        let Reply::Response(response) = dispatch(context, request).await else {
            panic!("expected a response");
        };
        response.into_result().unwrap()
    }

    /// `thread/search` runs on the reader, so while the reader is busy the search waits and a
    /// write doesn't (PLX-457). The blocked job stands in for a slow search.
    #[tokio::test]
    async fn a_busy_reader_holds_up_search_but_not_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let reader = Arc::clone(&daemon);
        let blocked = tokio::spawn(async move {
            reader
                .reader
                .run(&CancellationToken::new(), move |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
        });
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();

        let search = tokio::spawn(call::<ThreadSearch>(
            Arc::clone(&daemon),
            json!({ "query": "notes" }),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!search.is_finished(), "the search waits for the reader");

        let settings = tokio::time::timeout(
            Duration::from_secs(10),
            call::<HostSettingsSet>(Arc::clone(&daemon), json!({ "autoResume": false })),
        )
        .await
        .expect("the write doesn't wait for the reader");
        assert!(!settings.auto_resume);
        assert!(!search.is_finished(), "the reader is still busy");

        release_tx.send(()).unwrap();
        blocked.await.unwrap().unwrap();
        let found = tokio::time::timeout(Duration::from_secs(10), search)
            .await
            .expect("the search answers once the reader is free")
            .unwrap();
        assert!(found.threads.is_empty());
    }
}
