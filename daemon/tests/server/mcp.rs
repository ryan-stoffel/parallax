//! `plxd mcp --thread` for a Project's coordinator (PLX-380, decisions 0019 and 0041): the built
//! binary, speaking MCP on stdio, against an in-process plxd whose runs use the fake backend in a
//! real git repository.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{AgentList, ContextList, ProjectStart, ThreadStart};
use parallax_protocol::{
    AgentListParams, AgentRun, ContextListParams, Project, ProjectId, ThreadStartParams,
};
use plxd::backend::fake::Step;
use plxd::mcp::question::COORDINATOR_TOOLS;
use plxd::mcp::thread::{CONTEXT_TOOLS, TOOLS};
use plxd::mcp::{MAX_CONTEXT_BYTES, MAX_MESSAGE_BYTES, MAX_PATH_BYTES, MAX_TEXT_BYTES};
use plxd::mcp::{device, land};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{Instant, sleep, timeout};

use crate::agents::{Conn, Host, create, end_turn, init, project_params, text};
use crate::coordinator::{roles, start_params as coordinator_params};
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

/// `plxd mcp --thread`, initialized.
pub(crate) struct Mcp {
    child: Child,
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
            child,
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

async fn runs(client: &mut Conn, project: ProjectId) -> Vec<AgentRun> {
    client
        .call::<AgentList>(AgentListParams {
            project: Some(project),
        })
        .await
        .unwrap()
        .runs
}

/// A project whose coordinator runs until stopped, on `worker` for its children, and its tools.
async fn coordinator(host: &Host, client: &mut Conn) -> (Project, AgentRun, Mcp) {
    let project = create(client, project_params(host.dir.path())).await;
    let coordinator = client
        .call::<ProjectStart>(coordinator_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let run = coordinator.id.to_string();
    let mcp = Mcp::spawn(mcp_command(host.dir.path(), &["--thread", &run])).await;
    (project, coordinator, mcp)
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

/// PLX-380: a Project's coordinator has a thread's tools, and the context tools. Its children are
/// the Project's runs, which the Agents panel lists, with the coordinator as their parent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_coordinator_launches_steers_and_records_through_the_thread_tools() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            worker(),
            vec![vec![init("coordinator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (project, coordinator, mut mcp) = coordinator(&host, &mut client).await;
    let me = coordinator.id.to_string();

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
            COORDINATOR_TOOLS,
            land::TOOLS,
            &["memory_read", "memory_propose", "memory_write"],
            device::TOOLS,
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
        .filter(|run| run.coordinator_thread == coordinator.coordinator_thread)
        .map(|run| run.id.to_string())
        .collect();
    assert_eq!(
        tagged,
        [me.clone(), child.clone()],
        "the Agents panel lists the child as the coordinator's"
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
        "the coordinator never lists itself: {threads}"
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

/// PLX-398: a task the user starts with `thread/start`'s `project` has a thread row as well as a
/// Project run, and the coordinator's `thread_list` lists it once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_coordinator_lists_a_task_the_user_started_once() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            vec![init("worker-1"), Step::Hang],
            vec![vec![init("coordinator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (project, _, mut mcp) = coordinator(&host, &mut client).await;
    let task = client
        .call::<ThreadStart>(ThreadStartParams {
            project: Some(project.id),
            ..crate::threads::start_params(None, "Add a README.")
        })
        .await
        .unwrap()
        .run
        .id
        .to_string();

    let threads = mcp.ok("thread_list", json!({})).await;
    let listed = threads["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|thread| thread["runId"] == task.as_str())
        .count();
    assert_eq!(listed, 1, "{threads}");
    host.server.stop().await;
}

/// The context tools reach only the caller's own Project, and a thread outside a Project has none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_context_tools_reach_only_the_callers_project() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            worker(),
            vec![vec![init("coordinator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (ours, _, mut mcp) = coordinator(&host, &mut client).await;
    let theirs = create(&mut client, project_params(&host.dir.path().join("theirs"))).await;

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
    assert_eq!(written["lastWriter"], "coordinator");
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
        TOOLS.len() + device::TOOLS.len()
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_inputs_are_size_limited() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(
            worker(),
            vec![vec![init("coordinator-1"), Step::Hang]],
            &seen,
        ),
    );
    let mut client = host.client().await;
    let (project, _, mut mcp) = coordinator(&host, &mut client).await;

    let long = "x".repeat(MAX_TEXT_BYTES + 1);
    let refused = mcp.refused("thread_launch", json!({"prompt": long})).await;
    assert!(refused.contains("at most"), "{refused}");
    assert_eq!(
        runs(&mut client, project.id).await.len(),
        1,
        "only the coordinator"
    );
    let path = format!("{}.md", "p".repeat(MAX_PATH_BYTES));
    let refused = mcp.refused("read_context", json!({"path": path})).await;
    assert!(refused.contains("at most"), "{refused}");
    let content = "x".repeat(MAX_CONTEXT_BYTES + 1);
    let refused = mcp
        .refused(
            "write_context",
            json!({"path": "big.md", "content": content}),
        )
        .await;
    assert!(refused.contains("at most"), "{refused}");

    for (option, value) in [
        ("workspace", json!("checkout")),
        ("mode", json!("bypass")),
        ("title", json!("Mine")),
    ] {
        let mut arguments = json!({"prompt": "Elsewhere."});
        arguments[option] = value;
        let refused = mcp.refused("thread_launch", arguments).await;
        assert!(
            refused.contains(&format!("leave out {option}")),
            "{refused}"
        );
    }

    for gone in ["spawn_agent", "plan_approve"] {
        let unknown = mcp
            .request("tools/call", json!({"name": gone, "arguments": {}}))
            .await;
        assert_eq!(unknown["error"]["code"], -32602, "{unknown}");
    }

    let mut huge = format!(
        r#"{{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{{"name":"thread_list","arguments":{{"pad":"{}"}}}}}}"#,
        "x".repeat(MAX_MESSAGE_BYTES)
    );
    huge.push('\n');
    // The server stops reading once the line passes the limit and exits (0019), so the rest of
    // the write can hit a closed pipe.
    if let Err(error) = mcp.stdin.write_all(huge.as_bytes()).await {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe, "{error}");
    }
    let answer = mcp.read().await.expect("an error for the oversized line");
    assert_eq!(answer["error"]["code"], -32600, "{answer}");
    assert!(answer["id"].is_null());
    let status = timeout(PATIENCE, mcp.child.wait()).await.unwrap().unwrap();
    assert!(!status.success(), "the server ends after an oversized line");
    host.server.stop().await;
}
