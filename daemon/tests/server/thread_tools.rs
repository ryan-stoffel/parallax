//! `plxd mcp --thread`, a thread's host-wide Parallax tools (0041, PLX-373): the built binary,
//! speaking MCP on stdio, against an in-process plxd whose threads run on the fake backend in a
//! real git repository.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{
    AgentAccept, AgentEvents, AgentList, AgentSend, AgentWait, OrchestrationDispatch, TaskDelegate,
    ThreadDelete, ThreadList, ThreadStart,
};
use parallax_protocol::{
    AcceptId, AgentAcceptParams, AgentDelivery, AgentEventsParams, AgentListParams,
    AgentOutputItem, AgentSendParams, AgentStatus, AgentWaitParams, AgentWaitUntil, ErrorKind,
    OrchestrationCommand, ParallaxEvent, RepoId, RunId, TaskDelegateParams, Thread,
    ThreadDeleteParams, ThreadListParams, TurnId,
};
use plxd::backend::fake::Step;
use plxd::mcp::thread::TOOLS;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::{Instant, sleep};

use crate::agents::{Conn, Host, end_turn, fake, init, real_repo, send_params, text};
use crate::mcp::{Mcp, every_callers_tools, mcp_command};
use crate::support::{PATIENCE, temp_dir};
use crate::threads::start_params;

/// Echoes each message, takes a moment, and finishes its turn.
fn echo() -> Vec<Step> {
    vec![
        init("echo-1"),
        Step::EchoPrompt,
        Step::SleepMs(300),
        end_turn("Done."),
    ]
}

/// A thread the user started in a new repo entry under `repos`, which the tools are bound to.
async fn caller(client: &mut Conn, repos: &TempDir) -> (RunId, RepoId) {
    let repo = client.add(&real_repo(repos.path())).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Plan the work."))
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
    assert_eq!(names, [TOOLS, memory, &every_callers_tools(),].concat());

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
            delivery: Some(AgentDelivery::Steer),
            ..send_params(run, TurnId::generate(), text)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_refuses_idle_child_edits_after_the_reviewed_commit() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let path = worktree(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let made = mcp
        .ok(
            "create_threads",
            json!({"threads": [{"prompt": "Edit later."}]}),
        )
        .await;
    let child: RunId = made["threads"][0]["threadId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    working(&mut client, child).await;
    std::fs::write(path.join("parent.txt"), "parent committed change").unwrap();
    steer(&mut client, me, "Finish parent.").await;
    idle(&mut client, me).await;
    std::fs::write(path.join("child.txt"), "child work after parent commit").unwrap();
    steer(&mut client, child, "Finish child.").await;
    idle(&mut client, child).await;
    assert!(path.join("child.txt").is_file());
    let accepted = client
        .call::<AgentAccept>(AgentAcceptParams {
            run_id: me,
            id: AcceptId::generate(),
            commit: None,
        })
        .await;
    assert_eq!(
        accepted.unwrap_err().parallax_data().unwrap().kind,
        ErrorKind::MergeRefused
    );
    assert_eq!(
        std::fs::read_to_string(path.join("child.txt")).unwrap(),
        "child work after parent commit"
    );
    host.server.stop().await;
}

/// The worktree's owner can't restore files while a thread from `create_threads` works in it, so
/// a revert never deletes that thread's edits (0062, 0063).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_revert_refuses_while_a_thread_shares_the_worktree() {
    let host = Host::start(temp_dir(), fake(steered()));
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let path = worktree(&mut client, me).await;
    let mut mcp = tools(&host, me).await;
    let made = mcp
        .ok(
            "create_threads",
            json!({"threads": [{"prompt": "Keep editing."}]}),
        )
        .await;
    let child: RunId = made["threads"][0]["threadId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    working(&mut client, child).await;
    steer(&mut client, me, "Finish parent.").await;
    idle(&mut client, me).await;
    std::fs::write(path.join("child.txt"), "child work").unwrap();
    let refused = client
        .call::<OrchestrationDispatch>(OrchestrationCommand::CheckpointRollback {
            thread_id: me,
            ordinal: 1,
            restore_files: true,
        })
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("isolated worktree"),
        "{}",
        refused.message
    );
    assert_eq!(
        std::fs::read_to_string(path.join("child.txt")).unwrap(),
        "child work"
    );
    host.server.stop().await;
}

/// A keystore in memory, so a test never touches the real one.
#[derive(Debug, Default)]
pub(crate) struct Keys(Mutex<std::collections::HashMap<parallax_protocol::AccountId, String>>);

impl plxd::keystore::KeyStore for Keys {
    fn set(
        &self,
        account: parallax_protocol::AccountId,
        key: &str,
    ) -> Result<(), plxd::keystore::KeyStoreError> {
        self.0.lock().unwrap().insert(account, key.to_owned());
        Ok(())
    }

    fn get(
        &self,
        account: parallax_protocol::AccountId,
    ) -> Result<Option<zeroize::Zeroizing<String>>, plxd::keystore::KeyStoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&account)
            .cloned()
            .map(Into::into))
    }

    fn delete(
        &self,
        account: parallax_protocol::AccountId,
    ) -> Result<(), plxd::keystore::KeyStoreError> {
        self.0.lock().unwrap().remove(&account);
        Ok(())
    }
}

/// Every file under `dir`, recursively.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files(&path));
        } else if path.is_file() {
            found.push(path);
        }
    }
    found
}

/// Scans real files while the daemon runs and after shutdown, requiring a live WAL and logger.
fn assert_no_secret_files(dir: &Path, secret: &str, live: bool) {
    let written = files(dir);
    if live {
        for required in ["plxd.sqlite3", "plxd.sqlite3-wal", "plxd.log"] {
            let file = written
                .iter()
                .find(|file| file.file_name().unwrap() == required)
                .unwrap_or_else(|| panic!("missing live {required}: {written:?}"));
            assert!(
                std::fs::metadata(file).unwrap().len() > 0,
                "empty live {required}"
            );
        }
        assert!(
            std::fs::read_to_string(dir.join("logs/plxd.log"))
                .unwrap()
                .contains("listening"),
            "real daemon logging is active"
        );
    }
    for file in written {
        // A live daemon can remove a temporary file between the listing and the read. The scan
        // after shutdown, with nothing running, reads every file that remains.
        let bytes = match std::fs::read(&file) {
            Err(error) if live && error.kind() == std::io::ErrorKind::NotFound => continue,
            read => read.unwrap(),
        };
        assert!(
            !bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes()),
            "{} holds the secret",
            file.display()
        );
    }
}

/// Run `run`'s secret requests in its transcript, by id, with how each ended.
async fn secret_requests(
    client: &mut Conn,
    run: RunId,
) -> Vec<(String, Option<parallax_protocol::SecretStatus>)> {
    let mut found: Vec<(String, Option<parallax_protocol::SecretStatus>)> = Vec::new();
    for item in transcript(client, run).await {
        match item {
            AgentOutputItem::SecretRequested { request_id, .. } => found.push((request_id, None)),
            AgentOutputItem::SecretResolved { request_id, status } => {
                if let Some(asked) = found.iter_mut().find(|(id, _)| *id == request_id) {
                    asked.1 = Some(status);
                }
            }
            _ => {}
        }
    }
    found
}

/// PLX-648 (0063): `request_secret` puts a card in the thread, the user's answer goes to the
/// keystore, and the agent gets only a one-time ref, which `schedule_task` uses up. The value is
/// in no file of plxd's, no event, and no tool result. An unanswered request times out and closes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_secret_reaches_only_the_keystore_and_the_agent_gets_a_one_time_ref() {
    const SECRET: &str = "plx648-test-value";
    let keys = Arc::new(Keys::default());
    let dir = temp_dir();
    let log = dir.path().join("logs/plxd.log");
    plxd::logging::init(&log, &"debug".parse().unwrap()).unwrap();
    let host = Host::start_with_keys(dir, fake(steered()), keys.clone());
    let mut client = host.client().await;
    let repos = temp_dir();
    let (me, _) = caller(&mut client, &repos).await;
    working(&mut client, me).await;
    let mut mcp = tools(&host, me).await;

    let mut other = host.client().await;
    let (saved, ()) = tokio::join!(
        mcp.ok(
            "request_secret",
            json!({"label": "GitHub webhook secret", "reason": "To check the release webhook's signature."}),
        ),
        async {
            let deadline = Instant::now() + PATIENCE;
            let request_id = loop {
                if let Some((id, _)) = secret_requests(&mut other, me).await.pop() {
                    break id;
                }
                assert!(Instant::now() < deadline, "no secret card");
                sleep(Duration::from_millis(50)).await;
            };
            other
                .call::<parallax_protocol::methods::SecretAnswer>(
                    parallax_protocol::SecretAnswerParams {
                        run_id: me,
                        request_id,
                        answer: parallax_protocol::SecretChoice::Save {
                            secret: SECRET.to_owned(),
                        },
                    },
                )
                .await
                .unwrap();
        },
    );
    assert_eq!(saved["status"], "saved", "{saved}");
    let secret_ref = saved["secretRef"].as_str().unwrap().to_owned();
    assert!(secret_ref.starts_with("secret-ref:"), "{secret_ref}");
    assert_eq!(
        secret_requests(&mut client, me).await[0].1,
        Some(parallax_protocol::SecretStatus::Saved)
    );

    let schedule = json!({
        "prompt": "Note the release {{body.release.tag_name}}.",
        "schedule": {"type": "webhook", "signature": {
            "header": "x-hub-signature-256", "encoding": "hex", "prefix": "sha256=", "secretRef": secret_ref,
        }},
    });
    let task = mcp.ok("schedule_task", schedule.clone()).await;
    assert_eq!(task["webhookSignature"], "set", "{task}");
    let again = mcp.refused("schedule_task", schedule).await;
    assert!(again.contains("used already"), "one use: {again}");
    let held: Vec<String> = keys.0.lock().unwrap().values().cloned().collect();
    assert_eq!(held, [SECRET], "only the task's copy is left");

    let timed_out = mcp
        .ok(
            "request_secret",
            json!({"label": "API token", "reason": "To call the API.", "timeoutMs": 1000}),
        )
        .await;
    assert_eq!(timed_out["status"], "timed_out", "{timed_out}");
    assert_eq!(
        secret_requests(&mut client, me).await[1].1,
        Some(parallax_protocol::SecretStatus::Cancelled),
        "the card closes"
    );

    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
            run_id: me,
            after: 0,
            limit: Some(1000),
        })
        .await
        .unwrap();
    assert!(!serde_json::to_string(&events).unwrap().contains(SECRET));
    assert_no_secret_files(host.dir.path(), SECRET, true);
    host.server.stop().await;
    settle(host.dir.path()).await;
    assert_no_secret_files(host.dir.path(), SECRET, false);
}

/// Waits until plxd's shutdown stops removing files under `dir`: its tasks drop a little after
/// it stops, and the last store connection to close deletes the WAL.
async fn settle(dir: &Path) {
    let deadline = Instant::now() + PATIENCE;
    let mut before = files(dir);
    loop {
        sleep(Duration::from_millis(200)).await;
        let now = files(dir);
        if now == before {
            return;
        }
        assert!(Instant::now() < deadline, "plxd's files never settled");
        before = now;
    }
}
