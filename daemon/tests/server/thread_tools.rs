//! `plxd mcp --thread`, a thread's host-wide Parallax tools (0041, PLX-373): the built binary,
//! speaking MCP on stdio, against an in-process plxd whose threads run on the fake backend in a
//! real git repository.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{
    AgentAccept, AgentEvents, AgentList, AgentSend, AgentWait, OrchestrationDispatch, RepoAdd,
    TaskDelegate, ThreadDelete, ThreadList, ThreadStart,
};
use parallax_protocol::{
    AcceptId, AccountChoice, AgentAcceptParams, AgentDelivery, AgentEventsParams, AgentListParams,
    AgentOutputItem, AgentPermission, AgentSendParams, AgentStatus, AgentWaitParams,
    AgentWaitUntil, ErrorKind, OrchestrationCommand, ParallaxEvent, RepoAddParams, RepoId, RunId,
    TaskDelegateParams, Thread, ThreadDeleteParams, ThreadListParams, ThreadStartParams, TurnId,
};
use plxd::backend::fake::Step;
use plxd::mcp::MAX_CALLS;
use plxd::mcp::thread::TOOLS;
use plxd::mcp::{delegation, device, html, preview, triggers};
use plxd::paths::DataDir;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::{Instant, sleep};

use crate::agents::{Conn, Host, end_turn, fake, init, real_repo, text};
use crate::mcp::{Mcp, mcp_command};
use crate::support::{PATIENCE, temp_dir};

/// Echoes each message, takes a moment, and finishes its turn.
fn echo() -> Vec<Step> {
    vec![
        init("echo-1"),
        Step::EchoPrompt,
        Step::SleepMs(300),
        end_turn("Done."),
    ]
}

/// Echoes its prompt, then runs until it is stopped.
fn hang() -> Vec<Step> {
    vec![init("hang-1"), Step::EchoPrompt, Step::Hang]
}

/// A thread the user started in a new repo entry under `repos`, which the tools are bound to.
async fn caller(client: &mut Conn, repos: &TempDir) -> (RunId, RepoId) {
    let repo = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: real_repo(repos.path()).to_str().unwrap().to_owned(),
        })
        .await
        .unwrap()
        .repo;
    let started = client
        .call::<ThreadStart>(ThreadStartParams {
            run_id: RunId::generate(),
            repo: Some(repo.id),
            project: None,
            parent: None,
            notify: None,
            title: None,
            prompt: "Plan the work.".to_owned(),
            account: Some(AccountChoice::Subscription {
                backend: "fake".to_owned(),
            }),
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            branch_slug: None,
            images: Vec::new(),
            threads: Vec::new(),
            approvals: false,
            checkout: false,
            base: None,
            checkout_ref: None,
            naming: None,
        })
        .await
        .unwrap();
    (started.run.id, repo.id)
}

async fn tools(host: &Host, run: RunId) -> Mcp {
    let run = run.to_string();
    Mcp::spawn(mcp_command(host.dir.path(), &["--thread", &run])).await
}

/// Every transcript item of `run` in plxd's log.
async fn transcript(client: &mut Conn, run: RunId) -> Vec<AgentOutputItem> {
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
            run_id: run,
            after: 0,
            limit: Some(1000),
        })
        .await
        .unwrap();
    events
        .events
        .into_iter()
        .filter_map(|logged| match logged.event {
            ParallaxEvent::AgentOutput { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .collect()
}

/// `run`'s first follow-up: its text and sender, and its turn id.
async fn follow_up(client: &mut Conn, run: RunId) -> ((String, Option<RunId>), TurnId) {
    transcript(client, run)
        .await
        .into_iter()
        .find_map(|item| match item {
            AgentOutputItem::TurnStarted {
                turn_id: Some(turn),
                text: Some(text),
                from,
                ..
            } => Some(((text, from), turn)),
            _ => None,
        })
        .expect("a follow-up")
}

/// Thread `run` as plxd lists it.
async fn thread(client: &mut Conn, run: RunId) -> Thread {
    let listed = client
        .call::<ThreadList>(ThreadListParams {})
        .await
        .unwrap();
    listed.threads.into_iter().find(|t| t.id == run).unwrap()
}

fn id(value: &Value) -> RunId {
    value["runId"].as_str().unwrap().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_launches_waits_on_reads_searches_and_messages_a_child() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, repo) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;

    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    let memory: &[&str] = &["memory_read", "memory_propose"];
    assert_eq!(
        names,
        [
            TOOLS,
            memory,
            html::TOOLS,
            preview::TOOLS,
            device::TOOLS,
            triggers::TOOLS,
            delegation::TOOLS
        ]
        .concat()
    );

    let child = mcp
        .ok(
            "thread_launch",
            json!({"prompt": "Write the notes.", "title": "Notes", "backend": "fake"}),
        )
        .await;
    assert_eq!(child["parent"], me.to_string(), "{child}");
    assert_eq!(child["title"], "Notes");
    assert_eq!(child["you"], false);
    assert_eq!(
        child["repo"]["id"],
        repo.to_string(),
        "the caller's repo by default"
    );
    assert!(child["branch"].is_string(), "a new worktree: {child}");
    let child = id(&child);
    let stored = client
        .call::<ThreadList>(ThreadListParams {})
        .await
        .unwrap();
    let thread = stored.threads.iter().find(|t| t.id == child).unwrap();
    assert_eq!(
        thread.parent,
        Some(me),
        "plxd records the caller as the parent"
    );

    let waited = mcp.ok("thread_wait", json!({"runId": child})).await;
    assert_eq!(waited["idle"], true, "{waited}");
    assert_eq!(waited["thread"]["status"], "completed");
    assert_eq!(waited["lastOutput"], "Done.");
    let (read, is_error) = mcp.tool("thread_read", json!({"runId": child})).await;
    assert!(!is_error, "{read}");
    assert!(
        read.starts_with("First message:\nWrite the notes.\n"),
        "{read}"
    );
    assert!(read.contains("Agent:\nWrite the notes.\n"), "{read}");
    assert!(read.contains("[run completed]"), "{read}");

    mcp.ok(
        "thread_send",
        json!({"runId": child, "text": "Add a summary."}),
    )
    .await;
    let waited = mcp.ok("thread_wait", json!({"runId": child})).await;
    assert_eq!(waited["idle"], true, "{waited}");
    let (sent, turn) = follow_up(&mut client, child).await;
    assert_eq!(
        sent,
        ("Add a summary.".to_owned(), Some(me)),
        "the message is marked with the thread that sent it"
    );
    let (read, _) = mcp.tool("thread_read", json!({"runId": child})).await;
    assert!(
        read.contains(&format!("Thread {me}, turn {turn}:\nAdd a summary.\n")),
        "the turn id thread_fork takes: {read}"
    );

    let list = mcp.ok("thread_list", json!({})).await;
    let threads = list["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 2);
    assert_eq!(threads[0]["runId"], child.to_string(), "newest first");
    assert_eq!(threads[1]["you"], true);
    let found = mcp
        .ok("thread_search", json!({"query": "add a SUMMARY"}))
        .await;
    let found: Vec<&Value> = found["threads"].as_array().unwrap().iter().collect();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["runId"], child.to_string());
    host.server.stop().await;
}

/// The caller is bound by `--thread`: it can't name itself as a sender, and can't wait on,
/// message, or stop its own turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_cant_act_on_itself_or_name_a_sender() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let child = RunId::generate();
    for (tool, arguments) in [
        ("thread_send", json!({"runId": me, "text": "Hi."})),
        ("thread_wait", json!({"runId": me})),
        ("thread_interrupt", json!({"runId": me})),
    ] {
        let refused = mcp.refused(tool, arguments).await;
        assert!(refused.contains("itself"), "{tool}: {refused}");
    }
    let refused = mcp
        .refused(
            "thread_send",
            json!({"runId": child, "text": "Hi.", "from": me}),
        )
        .await;
    assert!(refused.contains("unknown field"), "{refused}");
    let missing = mcp
        .refused("thread_read", json!({"runId": RunId::generate()}))
        .await;
    assert!(missing.contains("no thread has run id"), "{missing}");
    host.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_interrupts_renames_settles_archives_and_links_a_pr_to_another() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;

    let child = mcp
        .ok(
            "thread_launch",
            json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"}),
        )
        .await;
    assert_eq!(child["repo"], Value::Null, "{child}");
    let child = id(&child);
    let waited = mcp
        .ok("thread_wait", json!({"runId": child, "timeoutSeconds": 1}))
        .await;
    assert_eq!(waited["idle"], false, "{waited}");
    assert_eq!(waited["timedOut"], true);
    assert_eq!(waited["thread"]["status"], "running");

    mcp.ok("thread_interrupt", json!({"runId": child})).await;
    let waited = mcp.ok("thread_wait", json!({"runId": child})).await;
    assert_eq!(waited["thread"]["status"], "cancelled", "{waited}");
    assert!(
        transcript(&mut client, child)
            .await
            .contains(&AgentOutputItem::Interrupted { from: me }),
        "the interrupt is marked with the thread that sent it"
    );
    let (read, _) = mcp.tool("thread_read", json!({"runId": child})).await;
    assert!(
        read.contains(&format!("[stopped by thread {me}]")),
        "{read}"
    );
    assert!(read.contains("[run stopped]"), "{read}");

    let updated = mcp
        .ok(
            "thread_update",
            json!({"runId": child, "title": "Waiter", "settled": true, "archived": true}),
        )
        .await;
    assert_eq!(updated["title"], "Waiter");
    assert_eq!(updated["settled"], true);
    assert_eq!(updated["archived"], true);
    let renamed = mcp.ok("thread_update", json!({"title": "Planner"})).await;
    assert_eq!(renamed["id"], me.to_string(), "no runId means the caller");
    assert!(
        mcp.refused("thread_update", json!({}))
            .await
            .contains("give")
    );
    let list = mcp.ok("thread_list", json!({})).await;
    assert_eq!(list["threads"].as_array().unwrap().len(), 1, "{list}");
    let list = mcp
        .ok("thread_list", json!({"includeArchived": true}))
        .await;
    assert_eq!(list["threads"].as_array().unwrap().len(), 2, "{list}");

    let url = "https://github.com/owner/repo/pull/7";
    let linked = mcp.ok("pr_link", json!({"url": url, "runId": child})).await;
    assert_eq!(linked["pullRequests"], json!([url]));
    let mine = mcp.ok("pr_link", json!({"url": url})).await;
    assert_eq!(mine["runId"], me.to_string());
    let refused = mcp
        .refused("pr_link", json!({"url": "https://example.com/pull/7"}))
        .await;
    assert!(
        refused.contains("not a GitHub pull request URL"),
        "{refused}"
    );
    let unlinked = mcp
        .ok("pr_unlink", json!({"url": url, "runId": child}))
        .await;
    assert_eq!(unlinked["pullRequests"], json!([]));

    host.server.stop().await;
}

/// `thread_launch` refuses a workspace's mismatched options, and a child with more permission than
/// its caller (0041).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_launch_refuses_bad_options_and_more_permission() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let refused = mcp
        .refused(
            "thread_launch",
            json!({"prompt": "Go.", "workspace": "checkout", "base": "main"}),
        )
        .await;
    assert!(
        refused.contains("base goes with workspace worktree"),
        "{refused}"
    );
    let refused = mcp
        .refused(
            "thread_launch",
            json!({"prompt": "Go.", "backend": "fake", "mode": "bypass"}),
        )
        .await;
    assert!(
        refused.contains("you run in edit mode") && refused.contains("can't run in bypass"),
        "a child gets no more permission than its caller: {refused}"
    );
    let refused = mcp
        .refused(
            "thread_launch",
            json!({"prompt": "Go.", "backend": "fake", "mode": "auto"}),
        )
        .await;
    assert!(
        refused.contains("can't run in auto"),
        "auto never asks, where edit asks before each command: {refused}"
    );
    host.server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_refuses_a_thread_plxd_doesnt_know() {
    let host = Host::start(temp_dir(), fake(echo()));
    let run = RunId::generate().to_string();
    let output = mcp_command(host.dir.path(), &["--thread", &run])
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no thread has run id"), "{stderr}");
    host.server.stop().await;
}

/// PLX-380 (0025): a normal thread wakes, with no client connected, when a child it launched with
/// `thread_launch` finishes, in one turn from Parallax that names the child. A child launched with
/// `notify: false` wakes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_wakes_when_a_child_it_launched_finishes_unless_it_opted_out() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = |prompt: &str, notify: bool| json!({"prompt": prompt, "backend": "fake", "workspace": "none", "notify": notify});
    let told = id(&mcp.ok("thread_launch", launch("Tell me.", true)).await);
    let quiet = id(&mcp.ok("thread_launch", launch("Stay quiet.", false)).await);
    for child in [told, quiet] {
        mcp.ok("thread_wait", json!({"runId": child.to_string()}))
            .await;
    }
    drop(client);

    let mut client = host.client().await;
    let deadline = Instant::now() + PATIENCE;
    let wakes = loop {
        let wakes: Vec<String> = transcript(&mut client, me)
            .await
            .into_iter()
            .filter_map(|item| match item {
                AgentOutputItem::TurnStarted {
                    text: Some(text),
                    wake: true,
                    ..
                } => Some(text),
                _ => None,
            })
            .collect();
        if !wakes.is_empty() {
            break wakes;
        }
        assert!(Instant::now() < deadline, "the parent was never woken");
        sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(wakes.len(), 1, "{wakes:?}");
    assert!(
        wakes[0].starts_with("Parallax, not the user"),
        "{}",
        wakes[0]
    );
    assert!(
        wakes[0].contains(&format!("- Run {told} (Tell me.): completed")),
        "{}",
        wakes[0]
    );
    assert!(!wakes[0].contains(&quiet.to_string()), "{}", wakes[0]);
    host.server.stop().await;
}

/// PLX-465: `thread_send` with `steer` goes into the target's running turn, and is refused for a
/// target with no turn running.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_steers_another_only_while_it_runs() {
    // Each turn waits for a message from inside it, so only a steer lets it end.
    let host = Host::start(
        temp_dir(),
        fake(vec![
            init("steer-1"),
            text("Working"),
            Step::AwaitFollowUp,
            end_turn("Started."),
            end_turn("Steered."),
        ]),
    );
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch =
        json!({"prompt": "Work.", "backend": "fake", "workspace": "none", "notify": false});
    let target = id(&mcp.ok("thread_launch", launch).await);
    let deadline = Instant::now() + PATIENCE;
    while !transcript(&mut client, target)
        .await
        .iter()
        .any(|item| matches!(item, AgentOutputItem::Text { text, .. } if text == "Working"))
    {
        assert!(
            Instant::now() < deadline,
            "the target never started working"
        );
        sleep(Duration::from_millis(50)).await;
    }

    mcp.ok(
        "thread_send",
        json!({"runId": target, "text": "Change course.", "steer": true}),
    )
    .await;
    let waited = mcp
        .ok(
            "thread_wait",
            json!({"runId": target, "timeoutSeconds": 30}),
        )
        .await;
    assert_eq!(
        waited["idle"], true,
        "a queued message would wait forever: {waited}"
    );
    assert_eq!(waited["thread"]["status"], "completed");
    let (sent, _) = follow_up(&mut client, target).await;
    assert_eq!(sent, ("Change course.".to_owned(), Some(me)));

    let refused = mcp
        .refused(
            "thread_send",
            json!({"runId": target, "text": "Again.", "steer": true}),
        )
        .await;
    assert!(refused.contains("isn't running a turn"), "{refused}");
    host.server.stop().await;
}

/// PLX-465: `thread_fork` forks a thread at its latest turn or a given one, as the caller's child,
/// and passes on plxd's refusal of a turn a fork copied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_forks_another_at_its_latest_or_a_given_turn() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = json!({"prompt": "Write the notes.", "backend": "fake", "workspace": "none", "notify": false});
    let original = id(&mcp.ok("thread_launch", launch).await);
    mcp.ok("thread_wait", json!({"runId": original})).await;
    mcp.ok(
        "thread_send",
        json!({"runId": original, "text": "Add a summary."}),
    )
    .await;
    mcp.ok("thread_wait", json!({"runId": original})).await;
    let (_, turn) = follow_up(&mut client, original).await;

    let latest = mcp.ok("thread_fork", json!({"runId": original})).await;
    assert_eq!(latest["parent"], me.to_string(), "{latest}");
    assert_eq!(latest["status"], "completed", "no CLI until a message");
    let latest = id(&latest);
    let first = id(&mcp
        .ok(
            "thread_fork",
            json!({"runId": original, "turnId": original}),
        )
        .await);
    for (fork, at) in [(latest, turn.to_string()), (first, original.to_string())] {
        let thread = thread(&mut client, fork).await;
        assert_eq!(thread.parent, Some(me), "the caller is the fork's parent");
        let from = thread.forked_from.unwrap();
        assert_eq!((from.run, from.turn.to_string()), (original, at));
    }

    let refused = mcp
        .refused("thread_fork", json!({"runId": latest, "turnId": turn}))
        .await;
    assert!(refused.contains("of its own"), "a copied turn: {refused}");
    host.server.stop().await;
}

/// PLX-465: `thread_fork` refuses a turn still running, and a thread in a mode that needs less
/// approval than the caller's, since the fork runs in it (0041).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_fork_refuses_a_running_turn_and_more_permission() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch =
        json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none", "notify": false});
    let running = id(&mcp.ok("thread_launch", launch).await);
    let refused = mcp.refused("thread_fork", json!({"runId": running})).await;
    assert!(refused.contains("still running"), "{refused}");

    let bypass = client
        .call::<ThreadStart>(ThreadStartParams {
            run_id: RunId::generate(),
            repo: None,
            project: None,
            parent: None,
            notify: None,
            title: None,
            prompt: "Do anything.".to_owned(),
            account: Some(AccountChoice::Subscription {
                backend: "fake".to_owned(),
            }),
            model: None,
            effort: None,
            permission: Some(AgentPermission::Bypass),
            context_window: None,
            fast: None,
            branch_slug: None,
            images: Vec::new(),
            threads: Vec::new(),
            approvals: false,
            checkout: false,
            base: None,
            checkout_ref: None,
            naming: None,
        })
        .await
        .unwrap()
        .run
        .id;
    let refused = mcp.refused("thread_fork", json!({"runId": bypass})).await;
    assert!(
        refused.contains("you run in edit mode") && refused.contains("can't run in bypass"),
        "{refused}"
    );
    host.server.stop().await;
}

/// PLX-465: a fork wakes the thread that forked it once its CLI ends, as a launched child does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_wakes_when_a_fork_it_made_finishes() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = json!({"prompt": "Write the notes.", "backend": "fake", "workspace": "none", "notify": false});
    let original = id(&mcp.ok("thread_launch", launch).await);
    mcp.ok("thread_wait", json!({"runId": original})).await;
    let fork = id(&mcp.ok("thread_fork", json!({"runId": original})).await);
    mcp.ok("thread_send", json!({"runId": fork, "text": "Go on."}))
        .await;
    mcp.ok("thread_wait", json!({"runId": fork})).await;

    let deadline = Instant::now() + PATIENCE;
    loop {
        let woken = wakes(&mut client, me).await;
        if !woken.is_empty() {
            assert_eq!(woken.len(), 1, "{woken:?}");
            assert!(woken[0].contains(&format!("- Run {fork} ")), "{}", woken[0]);
            break;
        }
        assert!(Instant::now() < deadline, "the caller was never woken");
        sleep(Duration::from_millis(100)).await;
    }
    host.server.stop().await;
}

/// PLX-465: a fork that never ran reads `completed`, but a restart doesn't wake the thread that
/// forked it, since no CLI of the fork's ever ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_doesnt_wake_a_thread_for_a_fork_that_never_ran() {
    let host = Host::start(temp_dir(), fake(echo()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = json!({"prompt": "Write the notes.", "backend": "fake", "workspace": "none", "notify": false});
    let original = id(&mcp.ok("thread_launch", launch).await);
    mcp.ok("thread_wait", json!({"runId": original})).await;
    mcp.ok("thread_fork", json!({"runId": original})).await;
    drop(mcp);
    drop(client);

    let host = host.restart(fake(echo())).await;
    let mut client = host.client().await;
    // Past wake-ups' batching.
    sleep(Duration::from_secs(3)).await;
    assert_eq!(wakes(&mut client, me).await, Vec::<String>::new());
    host.server.stop().await;
}

/// The wake-up turns in `run`'s transcript, oldest first.
async fn wakes(client: &mut Conn, run: RunId) -> Vec<String> {
    transcript(client, run)
        .await
        .into_iter()
        .filter_map(|item| match item {
            AgentOutputItem::TurnStarted {
                text: Some(text),
                wake: true,
                ..
            } => Some(text),
            _ => None,
        })
        .collect()
}

/// PLX-456: `thread_wait` waits in one `agent/wait` rather than polling plxd's every run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_wait_waits_in_agent_wait_without_listing_every_run() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let proxy = temp_dir();
    let methods = record_requests(proxy.path(), host.server.socket.clone());
    let me = me.to_string();
    let mut mcp = Mcp::spawn(mcp_command(proxy.path(), &["--thread", &me])).await;
    let launch = json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"});
    let child = id(&mcp.ok("thread_launch", launch).await);

    methods.lock().unwrap().clear();
    let waited = mcp
        .ok("thread_wait", json!({"runId": child, "timeoutSeconds": 2}))
        .await;
    assert_eq!(waited["timedOut"], true, "{waited}");
    assert_eq!(waited["thread"]["status"], "running");
    assert_eq!(*methods.lock().unwrap(), ["agent/wait", "agent/events"]);
    host.server.stop().await;
}

/// PLX-488: every tool call shares one connection to plxd, and a long `thread_wait` on it doesn't
/// hold up the calls sent after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_calls_share_one_connection_while_a_wait_runs() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let proxy = temp_dir();
    let methods = record_requests(proxy.path(), host.server.socket.clone());
    let me = me.to_string();
    let mut mcp = Mcp::spawn(mcp_command(proxy.path(), &["--thread", &me])).await;
    let launch = json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"});
    let child = id(&mcp.ok("thread_launch", launch).await);

    let wait = json!({"name": "thread_wait", "arguments": {"runId": child, "timeoutSeconds": 5}});
    mcp.send(&json!({"jsonrpc": "2.0", "id": "wait", "method": "tools/call", "params": wait}))
        .await;
    for _ in 0..10 {
        mcp.ok("thread_list", json!({})).await;
    }
    let waited = mcp.read().await.expect("thread_wait's answer");
    assert_eq!(waited["id"], "wait", "{waited}");
    let initialized = methods
        .lock()
        .unwrap()
        .iter()
        .filter(|method| *method == "initialize")
        .count();
    assert_eq!(initialized, 1);
    host.server.stop().await;
}

/// PLX-488: the server runs at most `MAX_CALLS` tool calls at once, and starts the next one only
/// once one of them finishes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_runs_at_most_max_calls_at_once() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"});
    let child = id(&mcp.ok("thread_launch", launch).await);

    let wait = json!({"name": "thread_wait", "arguments": {"runId": child, "timeoutSeconds": 2}});
    for n in 0..MAX_CALLS {
        let id = format!("wait-{n}");
        mcp.send(&json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": wait}))
            .await;
    }
    let list = json!({"name": "thread_list", "arguments": {}});
    mcp.send(&json!({"jsonrpc": "2.0", "id": "list", "method": "tools/call", "params": list}))
        .await;
    let first = mcp.read().await.expect("an answer");
    assert!(
        first["id"].as_str().unwrap().starts_with("wait-"),
        "{first}"
    );
    host.server.stop().await;
}

/// PLX-524: with every slot taken by a `thread_wait`, `notifications/cancelled` for one frees its
/// slot at once, gets it no answer, and cancels its `agent/wait` on plxd. A cancel naming an
/// unknown or finished request changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_thread_wait_frees_its_slot_and_cancels_its_agent_wait() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let proxy = temp_dir();
    let methods = record_requests(proxy.path(), host.server.socket.clone());
    let me = me.to_string();
    let mut mcp = Mcp::spawn(mcp_command(proxy.path(), &["--thread", &me])).await;
    let launch = json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"});
    let child = id(&mcp.ok("thread_launch", launch).await);
    let count = |method: &str| {
        methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == method)
            .count()
    };
    let cancel = |id: Value| json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id}});

    let wait = json!({"name": "thread_wait", "arguments": {"runId": child, "timeoutSeconds": 30}});
    for n in 0..MAX_CALLS {
        let id = format!("wait-{n}");
        mcp.send(&json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": wait}))
            .await;
    }
    let deadline = Instant::now() + PATIENCE;
    while count("agent/wait") < MAX_CALLS {
        assert!(Instant::now() < deadline, "the waits never reached plxd");
        sleep(Duration::from_millis(20)).await;
    }
    mcp.send(&cancel(json!("unknown"))).await;
    mcp.send(&cancel(json!(1))).await;
    mcp.send(&cancel(json!("wait-0"))).await;
    let started = Instant::now();
    let listed = mcp.ok("thread_list", json!({})).await;
    assert!(listed["threads"].is_array(), "{listed}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the slot wasn't freed"
    );
    while count("$/cancelRequest") < 1 {
        assert!(Instant::now() < deadline, "plxd never saw $/cancelRequest");
        sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(count("$/cancelRequest"), 1);
    host.server.stop().await;
}

/// PLX-488: the call after a plxd restart opens a new connection and succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_call_after_a_plxd_restart_reconnects() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    mcp.ok("thread_list", json!({})).await;
    drop(client);
    let host = host.restart(fake(hang())).await;
    let listed = mcp.ok("thread_list", json!({})).await;
    assert!(listed["threads"].is_array(), "{listed}");
    host.server.stop().await;
}

/// PLX-456: a plxd restart in the middle of `thread_wait`'s `agent/wait` doesn't end the wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_wait_outlasts_a_plxd_restart() {
    let host = Host::start(temp_dir(), fake(hang()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    let mut mcp = tools(&host, me).await;
    let launch = json!({"prompt": "Wait here.", "backend": "fake", "workspace": "none"});
    let child = id(&mcp.ok("thread_launch", launch).await);
    let waiting = tokio::spawn(async move {
        mcp.ok("thread_wait", json!({"runId": child, "timeoutSeconds": 8}))
            .await
    });
    sleep(Duration::from_secs(1)).await;
    drop(client);
    let host = host.restart(fake(hang())).await;
    let waited = waiting.await.unwrap();
    assert_eq!(waited["idle"], true, "{waited}");
    host.server.stop().await;
}

/// Serves a socket for the data folder `dir` that forwards each connection to `socket`, and
/// returns the method of every request sent through it, in order.
fn record_requests(dir: &Path, socket: PathBuf) -> Arc<Mutex<Vec<String>>> {
    let methods = Arc::new(Mutex::new(Vec::new()));
    let path = DataDir::new(dir).unwrap().socket_path().unwrap().path;
    let listener = UnixListener::bind(path).unwrap();
    let recorded = Arc::clone(&methods);
    tokio::spawn(async move {
        while let Ok((inbound, _)) = listener.accept().await {
            let outbound = UnixStream::connect(&socket).await.unwrap();
            let (from_client, mut to_client) = inbound.into_split();
            let (mut from_plxd, mut to_plxd) = outbound.into_split();
            tokio::spawn(async move { tokio::io::copy(&mut from_plxd, &mut to_client).await });
            let recorded = Arc::clone(&recorded);
            tokio::spawn(async move {
                let mut lines = BufReader::new(from_client).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let request: Value = serde_json::from_str(&line).unwrap();
                    if let Some(method) = request["method"].as_str() {
                        recorded.lock().unwrap().push(method.to_owned());
                    }
                    let line = format!("{line}\n");
                    if to_plxd.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    methods
}

/// Each turn prints its folder and prompt, then works until a message from inside it, which only a
/// steer delivers, lets it end.
fn steered() -> Vec<Step> {
    vec![
        init("work-1"),
        Step::EchoCwd,
        Step::EchoPrompt,
        text("Working"),
        Step::AwaitFollowUp,
        end_turn("Started."),
        end_turn("Steered."),
    ]
}

/// The agent's messages in `run`'s transcript, oldest first.
async fn texts(client: &mut Conn, run: RunId) -> Vec<String> {
    transcript(client, run)
        .await
        .into_iter()
        .filter_map(|item| match item {
            AgentOutputItem::Text { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

/// Waits until `run` is in the middle of a turn of [`steered`].
async fn working(client: &mut Conn, run: RunId) {
    let deadline = Instant::now() + PATIENCE;
    while !texts(client, run)
        .await
        .iter()
        .any(|text| text == "Working")
    {
        assert!(Instant::now() < deadline, "{run} never started working");
        sleep(Duration::from_millis(50)).await;
    }
}

/// Sends `text` into `run`'s running turn, which lets a turn of [`steered`] end.
async fn steer(client: &mut Conn, run: RunId, text: &str) {
    client
        .call::<AgentSend>(AgentSendParams {
            run_id: run,
            turn_id: TurnId::generate(),
            text: text.to_owned(),
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            account: None,
            images: Vec::new(),
            threads: Vec::new(),
            from: None,
            delivery: Some(AgentDelivery::Steer),
        })
        .await
        .unwrap();
}

/// `run`'s worktree, canonical.
async fn worktree(client: &mut Conn, run: RunId) -> PathBuf {
    let runs = client
        .call::<AgentList>(AgentListParams { project: None })
        .await
        .unwrap()
        .runs;
    let path = runs
        .iter()
        .find(|r| r.id == run)
        .unwrap()
        .worktree_path
        .clone();
    std::fs::canonicalize(path.expect("a worktree")).unwrap()
}

fn task(value: &Value) -> RunId {
    value["taskId"].as_str().unwrap().parse().unwrap()
}

/// Waits until `run` has woken `count` times, and returns its wake-up turns.
async fn woken(client: &mut Conn, run: RunId, count: usize) -> Vec<String> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let found = wakes(client, run).await;
        if found.len() >= count {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "{run} woke {} times",
            found.len()
        );
        sleep(Duration::from_millis(100)).await;
    }
}

/// The wake batch (2 s) and then some, to see that a wake-up didn't come.
const QUIET: Duration = Duration::from_secs(3);

/// PLX-648 (0063): `delegate_task` starts the caller's child in its worktree, on any backend, in a
/// mode no broader than its own. An async task's end wakes the caller once its turn is over,
/// unless it read the result with `task_status` first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_delegates_tasks_in_its_worktree_and_is_woken_for_the_ones_it_didnt_read() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;

    let refused = mcp
        .refused(
            "delegate_task",
            json!({"task": "Ship it.", "runtimeMode": "bypass"}),
        )
        .await;
    assert!(refused.contains("needs less approval"), "{refused}");

    let read = mcp
        .ok(
            "delegate_task",
            json!({"task": "Read the docs.", "target": {"providerInstanceId": "fake"}, "title": "Docs"}),
        )
        .await;
    assert_eq!(read["workState"], "working", "{read}");
    assert_eq!(read["waitTimedOut"], false);
    let read = task(&read);
    let told = task(
        &mcp.ok(
            "delegate_task",
            json!({"task": "Run the tests.", "role": "test"}),
        )
        .await,
    );
    let mine = worktree(&mut client, me).await;
    for child in [read, told] {
        working(&mut client, child).await;
        assert_eq!(thread(&mut client, child).await.parent, Some(me));
        let cwd = texts(&mut client, child).await.remove(0);
        assert_eq!(
            std::fs::canonicalize(&cwd).unwrap(),
            mine,
            "a task works in its parent's worktree"
        );
    }
    assert!(
        texts(&mut client, told)
            .await
            .contains(&"Act as the test sub-agent for this task.\n\nRun the tests.".to_owned())
    );

    for child in [read, told] {
        steer(&mut client, child, "Finish.").await;
        mcp.ok("thread_wait", json!({"runId": child})).await;
    }
    let status = mcp.ok("task_status", json!({"taskId": read})).await;
    assert_eq!(status["status"], "completed", "{status}");
    assert_eq!(status["workState"], "result_available");
    assert_eq!(status["summary"], "Steered.");
    let missing = mcp.refused("task_status", json!({"taskId": me})).await;
    assert!(missing.contains("delegated no task"), "{missing}");

    steer(&mut client, me, "Wrap up.").await;
    let wakes = woken(&mut client, me, 1).await;
    assert!(
        wakes[0].contains(&format!(
            "- Delegated task {told} (Act as the test sub-agent for this task.) reached a terminal \
             state: completed. Use task_status with taskId {told} to read the result."
        )),
        "{}",
        wakes[0]
    );
    assert!(
        !wakes[0].contains(&read.to_string()),
        "it read that one: {}",
        wakes[0]
    );
    host.server.stop().await;
}

/// The thread with parent `parent` whose prompt is `prompt`, once plxd has it.
async fn child_of(client: &mut Conn, parent: RunId, prompt: &str) -> RunId {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let runs = client
            .call::<AgentList>(AgentListParams { project: None })
            .await
            .unwrap()
            .runs;
        let threads = client
            .call::<ThreadList>(ThreadListParams {})
            .await
            .unwrap()
            .threads;
        if let Some(run) = runs.iter().find(|run| {
            run.prompt == prompt
                && threads
                    .iter()
                    .any(|thread| thread.id == run.id && thread.parent == Some(parent))
        }) {
            return run.id;
        }
        assert!(Instant::now() < deadline, "no child {prompt:?}");
        sleep(Duration::from_millis(50)).await;
    }
}

/// `delegate_task` with `wait` returns the task's result, and its end doesn't wake the caller,
/// whose turn was waiting on it (`settled_only`). A wait that times out hands the end back to a
/// wake-up (`always`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waited_task_returns_its_result_and_wakes_only_after_its_wait_times_out() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;

    let mut other = host.client().await;
    let (waited, quick) = tokio::join!(
        mcp.ok(
            "delegate_task",
            json!({"task": "Quick check.", "mode": "wait", "timeoutMs": 60_000}),
        ),
        async {
            let child = child_of(&mut other, me, "Quick check.").await;
            working(&mut other, child).await;
            steer(&mut other, child, "Finish.").await;
            child
        },
    );
    assert_eq!(task(&waited), quick);
    assert_eq!(waited["status"], "completed", "{waited}");
    assert_eq!(waited["summary"], "Steered.");
    assert_eq!(waited["waitTimedOut"], false);

    let slow = mcp
        .ok(
            "delegate_task",
            json!({"task": "Slow check.", "mode": "wait", "timeoutMs": 500}),
        )
        .await;
    assert_eq!(slow["waitTimedOut"], true, "{slow}");
    assert_eq!(slow["status"], "running");
    let slow = task(&slow);
    working(&mut client, slow).await;
    steer(&mut client, slow, "Finish.").await;
    mcp.ok("thread_wait", json!({"runId": slow})).await;

    steer(&mut client, me, "Wrap up.").await;
    let wakes = woken(&mut client, me, 1).await;
    assert!(
        wakes[0].contains(&format!("Delegated task {slow}")),
        "{}",
        wakes[0]
    );
    assert!(!wakes[0].contains(&quick.to_string()), "{}", wakes[0]);
    host.server.stop().await;
}

/// `task_cancel` stops a task as Stop does, and its end wakes no one. Stop on the caller stops the
/// tasks it delegated (0063).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_task_is_cancelled_or_stopped_with_its_parent() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;

    let cancelled = task(&mcp.ok("delegate_task", json!({"task": "Cancel me."})).await);
    working(&mut client, cancelled).await;
    let answer = mcp.ok("task_cancel", json!({"taskId": cancelled})).await;
    assert_eq!(answer["status"], "cancel_requested", "{answer}");
    let waited = mcp.ok("thread_wait", json!({"runId": cancelled})).await;
    assert_eq!(waited["thread"]["status"], "cancelled", "{waited}");
    let status = mcp.ok("task_status", json!({"taskId": cancelled})).await;
    assert_eq!(status["status"], "cancelled");
    let again = mcp.ok("task_cancel", json!({"taskId": cancelled})).await;
    assert_eq!(
        again["status"], "cancelled",
        "an ended task keeps its status"
    );

    let stopped = task(
        &mcp.ok("delegate_task", json!({"task": "Stop with me."}))
            .await,
    );
    working(&mut client, stopped).await;
    client
        .call::<OrchestrationDispatch>(OrchestrationCommand::RunInterrupt {
            thread_id: me,
            hold_queue: true,
        })
        .await
        .unwrap();
    let waited = mcp.ok("thread_wait", json!({"runId": stopped})).await;
    assert_eq!(waited["thread"]["status"], "cancelled", "{waited}");

    // The user's next message lets wake-ups through again, and its turn's end would send what
    // waits: the Stop dropped the stopped task's.
    client
        .call::<AgentSend>(AgentSendParams {
            run_id: me,
            turn_id: TurnId::generate(),
            text: "Carry on.".to_owned(),
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            account: None,
            images: Vec::new(),
            threads: Vec::new(),
            from: None,
            delivery: None,
        })
        .await
        .unwrap();
    let _ = client
        .call::<OrchestrationDispatch>(OrchestrationCommand::QueueResume { thread_id: me })
        .await;
    working_again(&mut client, me).await;
    steer(&mut client, me, "Wrap up.").await;
    idle(&mut client, me).await;
    sleep(QUIET).await;
    assert!(
        wakes(&mut client, me).await.is_empty(),
        "a cancelled or stopped task never wakes its parent"
    );
    host.server.stop().await;
}

/// Waits until `run` is idle, as the caller can't `thread_wait` on itself.
async fn idle(client: &mut Conn, run: RunId) {
    let waited = client
        .call::<AgentWait>(AgentWaitParams {
            run_ids: vec![run],
            until: AgentWaitUntil::Any,
            timeout_ms: 10_000,
        })
        .await
        .unwrap();
    assert!(
        !matches!(
            waited.runs[0].status,
            AgentStatus::Starting | AgentStatus::Running
        ),
        "{run} is still running"
    );
}

/// Waits until `run` is in the middle of a second turn of [`steered`].
async fn working_again(client: &mut Conn, run: RunId) {
    let deadline = Instant::now() + PATIENCE;
    while texts(client, run)
        .await
        .iter()
        .filter(|text| *text == "Working")
        .count()
        < 2
    {
        assert!(Instant::now() < deadline, "{run} never started again");
        sleep(Duration::from_millis(50)).await;
    }
}

/// Accept never removes a worktree a thread is working in (0063): it refuses until the thread
/// ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_refuses_while_a_thread_works_in_the_worktree() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let child = task(
        &mcp.ok("delegate_task", json!({"task": "Keep editing."}))
            .await,
    );
    working(&mut client, child).await;
    steer(&mut client, me, "Wrap up.").await;
    idle(&mut client, me).await;

    let params = || AgentAcceptParams {
        run_id: me,
        id: AcceptId::generate(),
        commit: None,
    };
    let refused = client.call::<AgentAccept>(params()).await.unwrap_err();
    assert_eq!(
        refused.parallax_data().unwrap().kind,
        ErrorKind::MergeRefused
    );
    assert!(
        refused.message.contains(&child.to_string()),
        "{}",
        refused.message
    );

    steer(&mut client, child, "Finish.").await;
    mcp.ok("thread_wait", json!({"runId": child})).await;
    let after = client
        .call::<AgentAccept>(params())
        .await
        .err()
        .map(|error| error.message);
    assert!(
        !after
            .as_deref()
            .is_some_and(|message| message.contains("still work in")),
        "{after:?}"
    );
    host.server.stop().await;
}

/// Deleting a thread keeps its worktree while another thread works in it, and the last thread in
/// it removes it (0063).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shared_worktree_outlives_its_owner_until_its_last_thread_goes() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let path = worktree(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let child = task(
        &mcp.ok("delegate_task", json!({"task": "Keep editing."}))
            .await,
    );
    working(&mut client, child).await;
    drop(mcp);

    client
        .call::<ThreadDelete>(ThreadDeleteParams { run_id: me })
        .await
        .unwrap();
    sleep(QUIET).await;
    assert!(path.is_dir(), "its child still works in it");
    steer(&mut client, child, "Finish.").await;
    let deadline = Instant::now() + PATIENCE;
    while !texts(&mut client, child)
        .await
        .iter()
        .any(|text| text == "Finish.")
    {
        assert!(Instant::now() < deadline, "the child never got its message");
        sleep(Duration::from_millis(50)).await;
    }

    client
        .call::<ThreadDelete>(ThreadDeleteParams { run_id: child })
        .await
        .unwrap();
    let deadline = Instant::now() + PATIENCE;
    while path.exists() {
        assert!(
            Instant::now() < deadline,
            "the last thread left the worktree behind"
        );
        sleep(Duration::from_millis(50)).await;
    }
    host.server.stop().await;
}

/// At most 8 threads run in shared worktrees on a host at once, unlike T3 (0063). A retry that
/// names a run outside any shared workspace is refused, not given a lineage.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_worktree_threads_are_capped_at_eight_running() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let prompts: Vec<Value> = (0..8)
        .map(|i| json!({"prompt": format!("Part {i}.")}))
        .collect();
    let made = mcp.ok("create_threads", json!({"threads": prompts})).await;
    assert_eq!(made["threads"].as_array().unwrap().len(), 8, "{made}");
    let refused = mcp
        .refused("delegate_task", json!({"task": "One more."}))
        .await;
    assert!(refused.contains("8 threads already run"), "{refused}");

    let conflict = client
        .call::<TaskDelegate>(TaskDelegateParams {
            run_id: me,
            owner: me,
            prompt: "Again.".to_owned(),
            title: None,
            account: None,
            model: None,
            effort: None,
            permission: None,
            completion_wake: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        conflict.parallax_data().unwrap().kind,
        ErrorKind::IdConflict
    );
    host.server.stop().await;
}

/// `create_threads` makes top-level threads in the caller's worktree, and `thread_merge_back`
/// hands a child's conversation to its parent's next message, once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn threads_share_the_callers_worktree_and_a_child_merges_back_once() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let mine = worktree(&mut client, me).await;

    let made = mcp
        .ok(
            "create_threads",
            json!({"threads": [{"prompt": "First."}, {"prompt": "Second.", "title": "Two"}]}),
        )
        .await;
    let made: Vec<RunId> = made["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|thread| thread["threadId"].as_str().unwrap().parse().unwrap())
        .collect();
    assert_eq!(made.len(), 2);
    for thread_id in &made {
        working(&mut client, *thread_id).await;
        assert_eq!(
            thread(&mut client, *thread_id).await.parent,
            None,
            "top-level"
        );
        let cwd = texts(&mut client, *thread_id).await.remove(0);
        assert_eq!(std::fs::canonicalize(&cwd).unwrap(), mine);
    }
    let refused = mcp.refused("create_threads", json!({"threads": []})).await;
    assert!(refused.contains("1 to 20"), "{refused}");

    let child = task(
        &mcp.ok("delegate_task", json!({"task": "Find the bug."}))
            .await,
    );
    working(&mut client, child).await;
    steer(&mut client, child, "It's in the parser.").await;
    mcp.ok("thread_wait", json!({"runId": child})).await;
    let unrelated = mcp
        .refused(
            "thread_merge_back",
            json!({"sourceThreadId": made[0], "targetThreadId": me}),
        )
        .await;
    assert!(
        unrelated.contains("neither a fork nor a child"),
        "{unrelated}"
    );
    let merged = mcp
        .ok(
            "thread_merge_back",
            json!({"sourceThreadId": child, "targetThreadId": me}),
        )
        .await;
    assert_eq!(merged["status"], "pending", "{merged}");

    steer(&mut client, me, "Wrap up.").await;
    let deadline = Instant::now() + PATIENCE;
    let got = loop {
        let found = texts(&mut client, me)
            .await
            .into_iter()
            .find(|text| text.contains("merged their context back"));
        if let Some(found) = found {
            break found;
        }
        assert!(
            Instant::now() < deadline,
            "the merge never reached the parent"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert!(got.contains(&format!("<thread id=\"{child}\">")), "{got}");
    assert!(got.contains("It's in the parser."), "{got}");
    assert!(got.ends_with("The user's message:\nWrap up."), "{got}");
    let again = mcp
        .refused(
            "thread_merge_back",
            json!({"sourceThreadId": child, "targetThreadId": me}),
        )
        .await;
    assert!(again.contains("no turn of its own"), "{again}");
    host.server.stop().await;
}

/// Restart catch-up keeps the delegated task identity so `task_status` can suppress its wake.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restarted_delegated_completions_can_be_acknowledged() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let child = task(
        &mcp.ok("delegate_task", json!({"task": "Keep editing."}))
            .await,
    );
    working(&mut client, child).await;
    drop(mcp);
    drop(client);
    let host = host.restart(fake(echo())).await;
    let mut client = host.client().await;
    let mut mcp = tools(&host, me).await;
    mcp.ok("task_status", json!({"taskId": child})).await;
    sleep(QUIET).await;
    assert!(wakes(&mut client, me).await.is_empty());
    host.server.stop().await;
}

/// A child in an owner's separate worktree doesn't block switching the repository checkout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shared_worktree_child_doesnt_block_the_repository_checkout() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let child = task(
        &mcp.ok("delegate_task", json!({"task": "Keep editing."}))
            .await,
    );
    working(&mut client, child).await;
    mcp.ok(
        "thread_launch",
        json!({"prompt": "Use the checkout.", "backend": "fake", "workspace": "checkout", "branch": "main"}),
    )
    .await;
    host.server.stop().await;
}
