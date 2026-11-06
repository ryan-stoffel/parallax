//! `plxd mcp --thread` for an orchestrator (PLX-380, decisions 0019 and 0041): the built
//! binary, speaking MCP on stdio, against an in-process plxd whose runs use the fake backend in a
//! real git repository.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{AgentList, ContextList, ThreadStart};
use parallax_protocol::{AgentListParams, AgentRun, ContextListParams, Orchestrator, ScopeId};
use plxd::backend::fake::Step;
use plxd::mcp::question::ORCHESTRATOR_TOOLS;
use plxd::mcp::thread::{CONTEXT_TOOLS, TOOLS};
use plxd::mcp::{board, delegation, device, files, html, land, preview, triggers};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{Instant, sleep, timeout};

use crate::agents::{Conn, Host, create, end_turn, init, orchestrator_params, text};
use crate::orchestrator::{plan, roles};
use crate::support::{PATIENCE, temp_dir};

/// A worker that edits the README, says so, waits for one message, echoes it, and finishes.
fn worker() -> Vec<Step> {
    vec![
        init("session-1"),
        Step::WriteFile {
            path: "README.md".to_owned(),
            content: "hello\nEdited by a subagent.\n".to_owned(),
        },
        text("Edited the README."),
        Step::EndTurn { result: None },
        Step::AwaitFollowUp,
        end_turn("Done."),
    ]
}

/// The tools every caller gets after its own (PLX-640).
pub(crate) fn every_callers_tools() -> Vec<&'static str> {
    [
        html::TOOLS,
        files::TOOLS,
        preview::TOOLS,
        device::TOOLS,
        triggers::TOOLS,
        delegation::TOOLS,
        plxd::mcp::COMPUTER_TOOLS,
    ]
    .concat()
}

/// `plxd mcp --thread`, initialized.
pub(crate) struct Mcp {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: i64,
}

/// `plxd mcp --data-dir <data_dir> <binding>`, with piped stdio.
pub(crate) fn mcp_command(data_dir: &Path, binding: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_plxd"));
    command
        .args(["mcp", "--data-dir"])
        .arg(data_dir)
        .args(binding)
        .env_remove("PLXD_DATA_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

impl Mcp {
    /// Starts and initializes `command`, a [`mcp_command`].
    pub(crate) async fn spawn(mut command: Command) -> Self {
        let mut child = command.spawn().expect("spawn plxd mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut mcp = Self {
            _child: child,
            stdin,
            stdout,
            next_id: 0,
        };
        let initialized = mcp
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "plxd-tests", "version": "0.0.0"},
                }),
            )
            .await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(initialized["result"]["serverInfo"]["name"], "plxd");
        assert!(initialized["result"]["capabilities"]["tools"].is_object());
        // Every thread's agent is told to show the documents it makes (PLX-755), to read and wait
        // on pull requests through plxd (PLX-837), and to open devices only in Parallax (PLX-908).
        let instructions = initialized["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("present_files"), "{instructions}");
        assert!(
            instructions.contains("pull_request_status")
                && instructions.contains("watch_pull_request"),
            "{instructions}"
        );
        assert!(
            instructions.contains("device_open") && instructions.contains("open -a Simulator"),
            "{instructions}"
        );
        mcp.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        mcp
    }

    pub(crate) async fn send(&mut self, message: &Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
    }

    pub(crate) async fn read(&mut self) -> Option<Value> {
        let line = timeout(PATIENCE, self.stdout.next_line())
            .await
            .expect("a line from plxd mcp")
            .unwrap()?;
        Some(serde_json::from_str(&line).expect("a JSON line"))
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        let response = self.read().await.expect("a response");
        assert_eq!(response["id"], id, "{response}");
        response
    }

    /// Calls a tool and returns its text and whether it is an error.
    pub(crate) async fn tool(&mut self, name: &str, arguments: Value) -> (String, bool) {
        let response = self
            .request("tools/call", json!({"name": name, "arguments": arguments}))
            .await;
        let result = &response["result"];
        assert!(result.is_object(), "{response}");
        (
            result["content"][0]["text"].as_str().unwrap().to_owned(),
            result["isError"].as_bool().unwrap(),
        )
    }

    /// Calls a tool that must succeed and parses its JSON text.
    pub(crate) async fn ok(&mut self, name: &str, arguments: Value) -> Value {
        let (text, is_error) = self.tool(name, arguments).await;
        assert!(!is_error, "{name} failed: {text}");
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("{name} returned {text}"))
    }

    /// Calls a tool that must fail, and returns its message.
    pub(crate) async fn refused(&mut self, name: &str, arguments: Value) -> String {
        let (text, is_error) = self.tool(name, arguments).await;
        assert!(is_error, "{name} succeeded: {text}");
        text
    }
}

async fn runs(client: &mut Conn, project: ScopeId) -> Vec<AgentRun> {
    client
        .call::<AgentList>(AgentListParams {
            project: Some(project),
        })
        .await
        .unwrap()
        .runs
}

/// A project whose orchestrator runs until stopped, on `worker` for its children, and its tools.
async fn orchestrator(host: &Host, client: &mut Conn) -> (Orchestrator, AgentRun, Mcp) {
    let project = create(client, orchestrator_params(host.dir.path())).await;
    let orchestrator = plan(client, project.id).await;
    let run = orchestrator.id.to_string();
    let mcp = Mcp::spawn(mcp_command(host.dir.path(), &["--thread", &run])).await;
    (project, orchestrator, mcp)
}

/// Polls `thread_wait` until `done` holds.
async fn wait_until(mcp: &mut Mcp, run_id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let waited = mcp
            .ok("thread_wait", json!({"runId": run_id, "timeoutSeconds": 1}))
            .await;
        if done(&waited) {
            return waited;
        }
        assert!(Instant::now() < deadline, "gave up; last {waited}");
        sleep(Duration::from_millis(50)).await;
    }
}

/// PLX-380: an orchestrator has a thread's tools, and the context tools. Its children are
/// the orchestrator's runs, which the Agents panel lists, with the orchestrator as their parent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_orchestrator_launches_steers_and_records_through_the_thread_tools() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            worker(),
            vec![vec![init("orchestrator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (project, orchestrator, mut mcp) = orchestrator(&host, &mut client).await;
    let me = orchestrator.id.to_string();

    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            TOOLS,
            CONTEXT_TOOLS,
            ORCHESTRATOR_TOOLS,
            land::TOOLS,
            board::TOOLS,
            &["memory_read", "memory_propose", "memory_write"],
            &every_callers_tools(),
        ]
        .concat()
    );

    let launched = mcp
        .ok(
            "thread_launch",
            json!({"prompt": "Edit the README.", "backend": "fake"}),
        )
        .await;
    assert_eq!(launched["parent"], me.as_str());
    let child = launched["runId"].as_str().unwrap().to_owned();
    let stored = runs(&mut client, project.id).await;
    let tagged: Vec<_> = stored
        .iter()
        .filter(|run| run.orchestrator_thread == orchestrator.orchestrator_thread)
        .map(|run| run.id.to_string())
        .collect();
    assert_eq!(
        tagged,
        [me.clone(), child.clone()],
        "the Agents panel lists the child as the orchestrator's"
    );

    let threads = mcp.ok("thread_list", json!({})).await;
    assert_eq!(threads["threads"][0]["runId"], child.as_str());
    assert_eq!(threads["threads"][0]["parent"], me.as_str());
    assert!(
        threads["threads"]
            .as_array()
            .unwrap()
            .iter()
            .all(|thread| thread["runId"] != me.as_str()),
        "the orchestrator never lists itself: {threads}"
    );
    let refused = mcp
        .refused(
            "thread_send",
            json!({"runId": me, "text": "Talk to yourself."}),
        )
        .await;
    assert!(refused.contains("itself"), "{refused}");

    wait_until(&mut mcp, &child, |waited| {
        waited["lastOutput"] == "Edited the README."
    })
    .await;
    mcp.ok("thread_send", json!({"runId": child, "text": "Wrap up."}))
        .await;
    let done = wait_until(&mut mcp, &child, |waited| {
        waited["thread"]["status"] == "completed"
    })
    .await;
    assert_eq!(done["lastOutput"], "Done.");
    let (read, is_error) = mcp.tool("thread_read", json!({"runId": child})).await;
    assert!(!is_error, "{read}");
    assert!(
        read.contains("Thread ") && read.contains("Wrap up."),
        "{read}"
    );
    let finished = runs(&mut client, project.id).await;
    let finished = finished.iter().find(|run| run.id.to_string() == child);
    assert_eq!(finished.unwrap().diff.as_ref().unwrap().files, 1);

    host.server.stop().await;
}

/// The context tools reach only the caller's own orchestrator, and a thread outside an orchestrator
/// has none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_context_tools_reach_only_the_callers_orchestrator() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            worker(),
            vec![vec![init("orchestrator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (ours, _, mut mcp) = orchestrator(&host, &mut client).await;
    let theirs = create(
        &mut client,
        orchestrator_params(&host.dir.path().join("theirs")),
    )
    .await;

    let refused = mcp
        .refused(
            "write_context",
            json!({"path": "x.md", "content": "x", "project": theirs.id}),
        )
        .await;
    assert!(refused.contains("unknown field"), "{refused}");
    let written = mcp
        .ok(
            "write_context",
            json!({"path": "plan.md", "content": "# Plan\n"}),
        )
        .await;
    assert_eq!(written["lastWriter"], "orchestrator");
    let listed = mcp.ok("read_context", json!({})).await;
    assert_eq!(listed["files"][0]["path"], "plan.md");
    let (content, is_error) = mcp.tool("read_context", json!({"path": "plan.md"})).await;
    assert!(!is_error);
    assert_eq!(content, "# Plan\n");
    let files = |project| ContextListParams { project };
    let their_files = client.call::<ContextList>(files(theirs.id)).await.unwrap();
    assert!(their_files.files.is_empty(), "{their_files:?}");
    let our_files = client.call::<ContextList>(files(ours.id)).await.unwrap();
    assert_eq!(our_files.files.len(), 1);

    let thread = client
        .call::<ThreadStart>(crate::open_pr::thread(None))
        .await
        .unwrap()
        .run
        .id
        .to_string();
    let mut outside = Mcp::spawn(mcp_command(host.dir.path(), &["--thread", &thread])).await;
    let listed = outside.request("tools/list", json!({})).await;
    assert_eq!(
        listed["result"]["tools"].as_array().unwrap().len(),
        TOOLS.len()
            + html::TOOLS.len()
            + files::TOOLS.len()
            + preview::TOOLS.len()
            + device::TOOLS.len()
            + triggers::TOOLS.len()
            + delegation::TOOLS.len()
            + plxd::mcp::COMPUTER_TOOLS.len()
    );
    let unknown = outside
        .request(
            "tools/call",
            json!({"name": "read_context", "arguments": {}}),
        )
        .await;
    assert_eq!(unknown["error"]["code"], -32602, "{unknown}");
    host.server.stop().await;
}
