//! The `OpenCode` backend against a fake `opencode serve`: a local HTTP server that answers the
//! routes plxd calls and streams events in the shapes `opencode serve` 1.18.34 sends, so every
//! test goes through the real `curl` both ways. No test runs `OpenCode`.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::stream::{Step, Translator};
use super::{Opencode, OpencodeBackend, inspect};
use crate::backend::process::{Environment, Launcher};
use crate::backend::{
    AccountRef, AgentPermission, Answer, Backend, Credential, Decision, Event, EventStream,
    Outcome, Resume, RunId, RunRequest, StartError, ToolPolicy, ToolStatus,
};
use crate::paths::DataDir;

/// The `Authorization` header curl sends for `opencode:hunter2`.
static AUTH: LazyLock<String> = LazyLock::new(|| {
    const DIGITS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::from("Basic ");
    for chunk in b"opencode:hunter2".chunks(3) {
        let bits = chunk.iter().enumerate().fold(0u32, |bits, (i, byte)| {
            bits | u32::from(*byte) << (16 - 8 * i)
        });
        for i in 0..4 {
            let digit = usize::try_from(bits >> (18 - 6 * i) & 63).unwrap();
            encoded.push(if i <= chunk.len() {
                char::from(DIGITS[digit])
            } else {
                '='
            });
        }
    }
    encoded
});

/// One request the fake server took.
#[derive(Clone, Debug)]
struct Request {
    method: String,
    /// The path and query.
    target: String,
    body: Value,
    auth: Option<String>,
}

/// What the fake answers a request with, and the events it streams after.
type Script = dyn Fn(&Request) -> (u16, Value, Vec<Value>) + Send + Sync;

/// A fake `opencode serve` on a free local port.
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    /// Serves `script`'s answers, and its events on the first `/event` stream.
    async fn start(
        script: impl Fn(&Request) -> (u16, Value, Vec<Value>) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (events, stream) = mpsc::unbounded_channel::<Value>();
        let stream = Arc::new(tokio::sync::Mutex::new(Some(stream)));
        let script: Arc<Script> = Arc::new(script);
        let kept = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let (script, requests, events, stream) = (
                    Arc::clone(&script),
                    Arc::clone(&kept),
                    events.clone(),
                    Arc::clone(&stream),
                );
                tokio::spawn(async move {
                    let (read, mut write) = socket.into_split();
                    let mut read = BufReader::new(read);
                    let mut line = String::new();
                    read.read_line(&mut line).await.unwrap();
                    let mut words = line.split_whitespace();
                    let (method, target) = (words.next().unwrap(), words.next().unwrap());
                    let (method, target) = (method.to_owned(), path_of(target).to_owned());
                    let mut headers = HashMap::new();
                    loop {
                        line.clear();
                        read.read_line(&mut line).await.unwrap();
                        let Some((name, value)) = line.trim_end().split_once(": ") else {
                            break;
                        };
                        headers.insert(name.to_ascii_lowercase(), value.to_owned());
                    }
                    let length = headers
                        .get("content-length")
                        .map_or(0, |length| length.parse().unwrap());
                    let mut body = vec![0; length];
                    read.read_exact(&mut body).await.unwrap();
                    let auth = headers.get("authorization").cloned();
                    if target.starts_with("/event") && auth.as_deref() != Some(AUTH.as_str()) {
                        let head = "HTTP/1.1 401 X\r\ncontent-length: 0\r\n\r\n";
                        write.write_all(head.as_bytes()).await.unwrap();
                        return;
                    }
                    if target.starts_with("/event") {
                        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n";
                        write.write_all(head.as_bytes()).await.unwrap();
                        let connected = json!({"type": "server.connected", "properties": {}});
                        write
                            .write_all(format!("data: {connected}\n\n").as_bytes())
                            .await
                            .unwrap();
                        let Some(mut stream) = stream.lock().await.take() else {
                            return;
                        };
                        while let Some(event) = stream.recv().await {
                            let line = format!("data: {event}\n\n");
                            if write.write_all(line.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                        return;
                    }
                    let request = Request {
                        method,
                        target,
                        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                        auth,
                    };
                    requests.lock().unwrap().push(request.clone());
                    let (status, answer, then) = if request.auth.as_deref() != Some(AUTH.as_str()) {
                        (401, json!({"name": "Unauthorized"}), Vec::new())
                    } else if request.target == "/global/health" {
                        (
                            200,
                            json!({"healthy": true, "version": "1.18.34"}),
                            Vec::new(),
                        )
                    } else {
                        script(&request)
                    };
                    let answer = if answer.is_null() {
                        String::new()
                    } else {
                        answer.to_string()
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                        answer.len()
                    );
                    write.write_all(reply.as_bytes()).await.unwrap();
                    for event in then {
                        let _ = events.send(event);
                    }
                });
            }
        });
        Self { url, requests }
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    fn find(&self, method: &str, path: &str) -> Option<Request> {
        self.requests()
            .into_iter()
            .find(|request| request.method == method && request.target.starts_with(path))
    }
}

/// A request's path and query: as a proxy, the fake takes `GET http://host/path`.
fn path_of(target: &str) -> &str {
    target
        .strip_prefix("http://")
        .map_or(target, |rest| &rest[rest.find('/').unwrap_or(rest.len())..])
}

/// An `OpenCode` event for the session `ses_1`.
fn event(kind: &str, properties: Value) -> Value {
    let mut properties = properties;
    properties["sessionID"] = "ses_1".into();
    json!({"type": kind, "properties": properties})
}

fn busy() -> Value {
    event("session.status", json!({"status": {"type": "busy"}}))
}

fn idle() -> Value {
    event("session.idle", json!({}))
}

fn part(part: Value) -> Value {
    let mut part = part;
    part["sessionID"] = "ses_1".into();
    part["messageID"] = "msg_2".into();
    event("message.part.updated", json!({"part": part}))
}

fn bash(status: &str) -> Value {
    call("call_1", status)
}

/// A `bash` call `cat a.txt`, `id`, in `status`.
fn call(id: &str, status: &str) -> Value {
    let mut state = json!({"status": status, "input": {"command": "cat a.txt"}});
    if status == "completed" {
        state["output"] = "hello world\n".into();
    }
    part(
        json!({"id": format!("prt_{id}"), "type": "tool", "tool": "bash", "callID": id, "state": state}),
    )
}

fn reply(text: &str) -> Vec<Value> {
    vec![
        part(json!({"id": "prt_text", "type": "text", "text": ""})),
        event(
            "message.part.delta",
            json!({"messageID": "msg_2", "partID": "prt_text", "field": "text", "delta": text}),
        ),
        part(
            json!({"id": "prt_step", "type": "step-finish", "tokens": {"input": 100, "output": 7, "reasoning": 1, "cache": {"read": 50, "write": 0}}}),
        ),
    ]
}

fn asked() -> Value {
    asked_for("per_1", "call_1")
}

/// `OpenCode` asks `id` before the `bash` call `call`.
fn asked_for(id: &str, call: &str) -> Value {
    event(
        "permission.asked",
        json!({"id": id, "permission": "bash", "patterns": ["cat a.txt"], "metadata": {"command": "cat a.txt"},
               "always": ["cat *"], "tool": {"messageID": "msg_2", "callID": call}}),
    )
}

/// A launcher with curl on `PATH`, and the folder a run works in.
fn launcher(dir: &TempDir, path: &str) -> (Launcher, PathBuf) {
    proxied(dir, path, None)
}

/// [`launcher`], with every proxy variable set to `proxy`.
fn proxied(dir: &TempDir, path: &str, proxy: Option<&str>) -> (Launcher, PathBuf) {
    let root = dir.path().canonicalize().unwrap();
    let mut base: Environment = [("PATH", path.to_owned())].into_iter().collect();
    if let Some(proxy) = proxy {
        for name in ["http_proxy", "https_proxy", "HTTPS_PROXY", "ALL_PROXY"] {
            base.set(name, proxy);
        }
    }
    let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
    (launcher, root)
}

fn opencode(url: Option<&str>, password: Option<&str>) -> Opencode {
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> =
        vec![("OPENCODE_CONFIG_DIR".into(), "/oc".into())];
    if let Some(url) = url {
        env.push((super::URL_VAR.into(), url.into()));
    }
    if let Some(password) = password {
        env.push((super::PASSWORD_VAR.into(), password.into()));
    }
    Opencode::new("opencode", "OpenCode", "opencode", Vec::new(), env)
}

fn request(cwd: PathBuf) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: None,
        cwd,
        prompt: "Run cat a.txt".into(),
        images: Vec::new(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: None,
        account: AccountRef {
            id: "opencode".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: Some("opencode/big-pickle".into()),
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        coordinator_tools: None,
        thread_tools: None,
        approvals: true,
        thread: true,
    }
}

async fn next(events: &mut EventStream) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .expect("an event in time")
        .expect("an event before the end")
}

/// Every event until the one `until` matches, which is returned last.
async fn until(events: &mut EventStream, until: impl Fn(&Event) -> bool) -> Vec<Event> {
    let mut seen = Vec::new();
    loop {
        let event = next(events).await;
        let done = until(&event);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

/// The script of a server that runs one turn with a `bash` call that asks first.
fn one_turn(request: &Request) -> (u16, Value, Vec<Value>) {
    let path = request.target.split('?').next().unwrap_or_default();
    match (request.method.as_str(), path) {
        ("POST", "/session") => (200, json!({"id": "ses_1"}), Vec::new()),
        ("POST", "/session/ses_1/prompt_async") => (
            204,
            Value::Null,
            vec![busy(), bash("pending"), bash("running"), asked()],
        ),
        ("POST", "/permission/per_1/reply") => {
            let mut then = vec![bash("completed")];
            then.extend(reply("It printed hello world."));
            then.push(idle());
            (200, json!(true), then)
        }
        _ => (
            404,
            json!({"name": "NotFoundError", "data": {"message": "no route"}}),
            Vec::new(),
        ),
    }
}

#[tokio::test]
async fn a_thread_at_a_server_url_streams_asks_and_finishes() {
    let server = Server::start(one_turn).await;
    let dir = tempfile::tempdir().unwrap();
    let (launcher, cwd) = launcher(&dir, "/usr/bin:/bin");
    let backend = OpencodeBackend::new(launcher, opencode(Some(&server.url), Some("hunter2")));
    let started = backend.start(request(cwd.clone())).unwrap();
    let mut events = started.events;

    let seen = until(&mut events, |e| matches!(e, Event::ApprovalRequested(_))).await;
    assert!(
        matches!(&seen[0], Event::SessionStarted { session_id, model, .. }
        if session_id == "ses_1" && model.as_deref() == Some("opencode/big-pickle"))
    );
    assert!(seen.contains(&Event::ToolCall {
        call_id: "call_1".into(),
        name: "Bash".into(),
        input: json!({"command": "cat a.txt"}),
    }));
    let Some(Event::ApprovalRequested(asked)) = seen.last() else {
        unreachable!()
    };
    assert_eq!(asked.tool_name, "Bash");
    assert_eq!(asked.call_id.as_deref(), Some("call_1"));
    started
        .run
        .answer(Answer {
            approval_id: asked.approval_id,
            decision: Decision::Allow {
                input: None,
                always: false,
            },
        })
        .unwrap();

    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    assert!(seen.contains(&Event::ToolResult {
        call_id: "call_1".into(),
        status: ToolStatus::Ok,
        output: Some("hello world\n".into()),
    }));
    let usage: Vec<_> = seen
        .iter()
        .filter_map(|e| match e {
            Event::Usage(usage) => Some(usage.usage),
            _ => None,
        })
        .collect();
    assert_eq!(usage.len(), 1);
    assert_eq!(
        (
            usage[0].input_tokens,
            usage[0].output_tokens,
            usage[0].cache_read_tokens
        ),
        (100, 8, 50)
    );
    assert!(seen.contains(&Event::TurnFinished {
        turn_id: None,
        result: Some("It printed hello world.".into()),
    }));
    assert!(matches!(
        seen.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { .. },
            ..
        })
    ));

    // Every call signed in, for the run's folder; Auto-accept edits asks before commands only.
    let folder = super::encode(&cwd);
    assert!(
        server
            .requests()
            .iter()
            .all(|r| r.auth.as_deref() == Some(AUTH.as_str())
                && (r.target == "/global/health"
                    || r.target.ends_with(&format!("?directory={folder}"))))
    );
    let session = server.find("POST", "/session?").unwrap();
    assert_eq!(
        session.body["permission"],
        super::rules(AgentPermission::Edit)
    );
    let prompt = server.find("POST", "/session/ses_1/prompt_async").unwrap();
    assert_eq!(
        prompt.body,
        json!({
            "parts": [{"type": "text", "text": "Run cat a.txt"}],
            "model": {"providerID": "opencode", "modelID": "big-pickle"},
        })
    );
    let answer = server.find("POST", "/permission/per_1/reply").unwrap();
    assert_eq!(answer.body, json!({"reply": "once"}));
}

#[tokio::test]
async fn a_resumed_plan_run_appends_its_rules_and_an_interrupting_denial_aborts() {
    let server = Server::start(|request| {
        let path = request.target.split('?').next().unwrap_or_default();
        match (request.method.as_str(), path) {
            ("GET" | "PATCH", "/session/ses_1") => (200, json!({"id": "ses_1"}), Vec::new()),
            // As a real server can, the request comes before the call's running update.
            ("POST", "/session/ses_1/prompt_async") => (204, Value::Null, vec![busy(), bash("pending"), asked(), bash("running")]),
            ("POST", "/permission/per_1/reply") => (200, json!(true), Vec::new()),
            ("POST", "/session/ses_1/abort") => {
                let aborted = event("session.error", json!({"error": {"name": "MessageAbortedError", "data": {"message": "Aborted"}}}));
                (200, json!(true), vec![aborted, idle()])
            }
            _ => (404, Value::Null, Vec::new()),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (launcher, cwd) = launcher(&dir, "/usr/bin:/bin");
    let backend = OpencodeBackend::new(launcher, opencode(Some(&server.url), Some("hunter2")));
    let mut request = request(cwd);
    request.resume = Some(Resume::new("ses_1"));
    request.permission = Some(AgentPermission::Plan);
    request.model = None;
    let started = backend.start(request).unwrap();
    let mut events = started.events;

    let seen = until(&mut events, |e| matches!(e, Event::ApprovalRequested(_))).await;
    let Some(Event::ApprovalRequested(asked)) = seen.last() else {
        unreachable!()
    };
    assert_eq!(asked.input, json!({"command": "cat a.txt"}));
    assert!(
        matches!(&seen[seen.len() - 2], Event::ToolCall { input, .. } if *input == asked.input)
    );
    started
        .run
        .answer(Answer {
            approval_id: asked.approval_id,
            decision: Decision::Deny {
                message: "not now".into(),
                interrupt: true,
            },
        })
        .unwrap();
    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    assert!(seen.contains(&Event::ToolResult {
        call_id: "call_1".into(),
        status: ToolStatus::Denied,
        output: None,
    }));
    assert!(seen.contains(&Event::TurnFinished {
        turn_id: None,
        result: None
    }));
    assert!(matches!(
        seen.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { .. },
            ..
        })
    ));

    assert!(server.find("POST", "/session?").is_none(), "no new session");
    let patched = server.find("PATCH", "/session/ses_1").unwrap();
    assert_eq!(
        patched.body["permission"][1]["action"], "deny",
        "Plan never edits"
    );
    let prompt = server.find("POST", "/session/ses_1/prompt_async").unwrap();
    assert_eq!(prompt.body["agent"], "plan");
    let denied = server.find("POST", "/permission/per_1/reply").unwrap();
    assert_eq!(
        denied.body,
        json!({"reply": "reject", "message": "not now"})
    );
    assert!(server.find("POST", "/session/ses_1/abort").is_some());
}

#[tokio::test]
async fn a_wrong_password_and_a_failed_turn_fail_the_run() {
    let server = Server::start(|request| match request.method.as_str() {
        "POST" if request.target.starts_with("/session?") => (200, json!({"id": "ses_1"}), Vec::new()),
        _ => {
            let error = json!({"error": {"name": "UnknownError", "data": {"message": "Model not found: opencode/nope\n    at stack"}}});
            (204, Value::Null, vec![busy(), event("session.error", error)])
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (launcher, cwd) = launcher(&dir, "/usr/bin:/bin");

    let backend =
        OpencodeBackend::new(launcher.clone(), opencode(Some(&server.url), Some("wrong")));
    let mut events = backend.start(request(cwd.clone())).unwrap().events;
    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    let Some(Event::Finished {
        outcome: Outcome::Failed(failure),
        ..
    }) = seen.last()
    else {
        panic!("expected a failure: {seen:?}");
    };
    assert!(
        failure.message.contains("refused the password"),
        "{}",
        failure.message
    );

    let backend = OpencodeBackend::new(launcher, opencode(Some(&server.url), Some("hunter2")));
    let mut events = backend.start(request(cwd)).unwrap().events;
    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    let Some(Event::Finished {
        outcome: Outcome::Failed(failure),
        ..
    }) = seen.last()
    else {
        panic!("expected a failure: {seen:?}");
    };
    assert_eq!(failure.message, "Model not found: opencode/nope");
}

#[tokio::test]
async fn a_started_server_gets_the_password_and_no_url() {
    let server = Server::start(one_turn).await;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let fake = bin.join("opencode");
    let script = format!(
        "#!/bin/sh\nenv > \"{}/env\"\necho \"$@\" > \"{}/args\"\necho 'opencode server listening on {}'\nexec sleep 30\n",
        dir.path().display(),
        dir.path().display(),
        server.url
    );
    fs::write(&fake, script).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let (launcher, cwd) = launcher(&dir, &format!("{}:/usr/bin:/bin", bin.display()));
    let backend = OpencodeBackend::new(launcher, opencode(None, Some("hunter2")));
    let started = backend.start(request(cwd)).unwrap();
    let mut events = started.events;
    let seen = until(&mut events, |e| matches!(e, Event::ApprovalRequested(_))).await;
    assert!(
        matches!(&seen[0], Event::SessionStarted { .. }),
        "signed in with its password"
    );
    started.run.cancel();
    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    assert!(matches!(
        seen.last(),
        Some(Event::Finished {
            outcome: Outcome::Cancelled,
            ..
        })
    ));

    let env = fs::read_to_string(dir.path().join("env")).unwrap();
    assert!(env.contains("OPENCODE_SERVER_PASSWORD=hunter2\n"));
    assert!(
        env.contains(r#"OPENCODE_CONFIG_CONTENT={"experimental":{"continue_loop_on_deny":true}}"#)
    );
    assert!(env.contains("OPENCODE_CONFIG_DIR=/oc\n"));
    assert!(!env.contains("OPENCODE_SERVER_URL"));
    let args = fs::read_to_string(dir.path().join("args")).unwrap();
    assert_eq!(args.trim(), "serve --hostname 127.0.0.1 --port 0");
    assert!(
        server.find("POST", "/session/ses_1/abort").is_some(),
        "cancel aborts the turn"
    );
}

#[tokio::test]
async fn inspecting_a_server_lists_its_models_and_version() {
    let server = Server::start(|_| {
        let providers =
            json!([{"id": "opencode", "models": {"big-pickle": {"name": "Big Pickle"}}}]);
        (
            200,
            json!({"providers": providers, "default": {}}),
            Vec::new(),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (launcher, _) = launcher(&dir, "/usr/bin:/bin");

    let found = inspect(
        &launcher,
        &opencode(Some(&server.url), Some("hunter2")),
        false,
    )
    .await;
    assert_eq!(found.version.as_deref(), Some("1.18.34"));
    assert_eq!(found.models.len(), 1);
    assert_eq!(
        (found.models[0].id.as_str(), found.models[0].name.as_str()),
        ("opencode/big-pickle", "Big Pickle")
    );

    // A password kept in the keychain isn't read, so the server only says it's there.
    let found = inspect(&launcher, &opencode(Some(&server.url), None), true).await;
    assert!(found.models.is_empty());
    assert!(found.note.unwrap().contains("is reachable"));
    let found = inspect(
        &launcher,
        &opencode(Some("http://127.0.0.1:9"), None),
        false,
    )
    .await;
    assert!(found.note.unwrap().contains("couldn't reach"));

    // A remote server goes through the host's proxy, here the fake server itself, and a
    // loopback one never does, here past a proxy that isn't there.
    let (behind_proxy, _) = proxied(&dir, "/usr/bin:/bin", Some(&server.url));
    let remote = opencode(Some("http://opencode.example.invalid"), Some("hunter2"));
    let found = inspect(&behind_proxy, &remote, false).await;
    assert_eq!(
        found.version.as_deref(),
        Some("1.18.34"),
        "{:?}",
        found.note
    );
    let (dead_proxy, _) = proxied(&dir, "/usr/bin:/bin", Some("http://127.0.0.1:9"));
    let found = inspect(
        &dead_proxy,
        &opencode(Some(&server.url), Some("hunter2")),
        false,
    )
    .await;
    assert_eq!(
        found.version.as_deref(),
        Some("1.18.34"),
        "{:?}",
        found.note
    );
}

#[tokio::test]
async fn a_denial_goes_on_and_a_request_opencode_rejected_is_withdrawn() {
    let server = Server::start(|request| {
        let path = request.target.split('?').next().unwrap_or_default();
        match (request.method.as_str(), path) {
            ("POST", "/session") => (200, json!({"id": "ses_1"}), Vec::new()),
            ("POST", "/session/ses_1/prompt_async") => {
                let then = vec![
                    busy(),
                    call("call_1", "running"),
                    call("call_2", "running"),
                    asked_for("per_1", "call_1"),
                    asked_for("per_2", "call_2"),
                ];
                (204, Value::Null, then)
            }
            // As `OpenCode` does, one rejection rejects the session's other requests.
            ("POST", "/permission/per_1/reply") => {
                let replied = event(
                    "permission.replied",
                    json!({"requestID": "per_2", "reply": "reject"}),
                );
                let mut then = vec![replied];
                then.extend(reply("Skipped both."));
                then.push(idle());
                (200, json!(true), then)
            }
            _ => (404, Value::Null, Vec::new()),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let (launcher, cwd) = launcher(&dir, "/usr/bin:/bin");
    let backend = OpencodeBackend::new(launcher, opencode(Some(&server.url), Some("hunter2")));
    let mut request = request(cwd);
    request.permission = Some(AgentPermission::Manual);
    let started = backend.start(request).unwrap();
    let mut events = started.events;
    let mut asked = Vec::new();
    while asked.len() < 2 {
        if let Event::ApprovalRequested(request) = next(&mut events).await {
            asked.push(request);
        }
    }
    started
        .run
        .answer(Answer {
            approval_id: asked[0].approval_id,
            decision: Decision::Deny {
                message: String::new(),
                interrupt: false,
            },
        })
        .unwrap();
    let seen = until(&mut events, |e| matches!(e, Event::Finished { .. })).await;
    assert!(seen.contains(&Event::ApprovalWithdrawn {
        approval_id: asked[1].approval_id
    }));
    assert!(seen.contains(&Event::ToolResult {
        call_id: "call_2".into(),
        status: ToolStatus::Denied,
        output: None
    }));
    assert!(matches!(
        seen.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { .. },
            ..
        })
    ));
    let denied = server.find("POST", "/permission/per_1/reply").unwrap();
    assert_eq!(
        denied.body,
        json!({"reply": "reject", "message": "The user denied this."}),
        "a message keeps the turn going"
    );
    assert!(server.find("POST", "/session/ses_1/abort").is_none());
}

#[test]
fn every_level_below_full_access_turns_off_subagents_and_every_level_questions() {
    let rule = |level, permission: &str| {
        let rules = super::rules(level);
        let rules = rules.as_array().unwrap();
        let rule = rules
            .iter()
            .find(|rule| rule["permission"] == permission)
            .unwrap();
        rule["action"].as_str().unwrap().to_owned()
    };
    for (level, bash, edit, task) in [
        (AgentPermission::Manual, "ask", "ask", "deny"),
        (AgentPermission::Edit, "ask", "allow", "deny"),
        (AgentPermission::Plan, "ask", "deny", "deny"),
        (AgentPermission::Bypass, "allow", "allow", "allow"),
    ] {
        assert_eq!(
            [
                rule(level, "bash"),
                rule(level, "edit"),
                rule(level, "task"),
                rule(level, "question"),
                rule(level, "plan_exit"),
            ],
            [bash, edit, task, "deny", "deny"],
            "{level:?}"
        );
    }
}

#[test]
fn a_bad_model_or_url_is_refused() {
    let mut request = request(PathBuf::from("/"));
    request.model = Some("big-pickle".into());
    assert!(matches!(
        super::check("OpenCode", &request),
        Err(StartError::Invalid(_))
    ));
    assert!(super::check_url("--config=/x").is_err());
    assert!(super::check_url("file:///tmp/x").is_err());
    assert!(super::check_url("https://oc.example.com").is_ok());
}

#[test]
fn the_translator_keeps_to_its_session_and_the_turn_in_flight() {
    let mut translator = Translator::default();
    translator.asks = true;
    translator.permission = Some(AgentPermission::Edit);
    translator.session = "ses_1".into();
    let prompt = event(
        "message.updated",
        json!({"info": {"id": "msg_1", "role": "user"}}),
    );
    assert!(translator.event(&prompt).is_empty());
    let mut echoed = part(json!({"id": "prt_prompt", "type": "text", "text": "Run cat a.txt"}));
    echoed["properties"]["part"]["messageID"] = "msg_1".into();
    assert!(
        translator.event(&echoed).is_empty(),
        "the prompt isn't the reply"
    );
    assert!(
        translator.event(&idle()).is_empty(),
        "an idle before busy is the last turn's"
    );

    // Reasoning goes once, when its part ends.
    let thinking = |end: Option<u64>| {
        part(
            json!({"id": "prt_r", "type": "reasoning", "text": "hmm", "time": {"start": 1, "end": end}}),
        )
    };
    assert!(translator.event(&thinking(None)).is_empty());
    assert_eq!(
        translator.event(&thinking(Some(2))),
        [Step::Emit(Event::Reasoning {
            message_id: None,
            text: "hmm".into()
        })]
    );
    assert!(translator.event(&thinking(Some(2))).is_empty());

    // A subagent's session asks too, and Auto-accept edits allows its edit.
    let child = json!({"type": "session.created", "properties": {"sessionID": "ses_2", "info": {"id": "ses_2", "parentID": "ses_1"}}});
    assert!(translator.event(&child).is_empty());
    let edit = json!({"type": "permission.asked", "properties": {"id": "per_2", "sessionID": "ses_2", "permission": "edit", "patterns": [], "metadata": {}, "always": []}});
    assert_eq!(
        translator.event(&edit),
        [Step::Post {
            path: "/permission/per_2/reply".into(),
            body: json!({"reply": "once"})
        }]
    );
    let elsewhere = json!({"type": "permission.asked", "properties": {"id": "per_3", "sessionID": "ses_9", "permission": "edit"}});
    assert!(
        translator.event(&elsewhere).is_empty(),
        "another session's request isn't the run's"
    );

    let replied = json!({"type": "permission.replied", "properties": {"sessionID": "ses_2", "requestID": "per_2", "reply": "once"}});
    assert_eq!(
        translator.event(&replied),
        [Step::Replied {
            id: "per_2".into(),
            rejected: false
        }]
    );

    // Without anyone to ask, plxd rejects with a message, so the agent goes on.
    translator.asks = false;
    let bash = event(
        "permission.asked",
        json!({"id": "per_4", "permission": "bash", "patterns": [], "metadata": {}, "always": []}),
    );
    assert!(
        matches!(&translator.event(&bash)[..], [Step::Post { body, .. }]
        if body["reply"] == "reject" && body["message"].is_string())
    );
    // A question another tool asks is answered, so the turn goes on.
    let question = event(
        "question.asked",
        json!({"id": "que_1", "questions": [{"question": "Build it?", "header": "Plan", "options": []}]}),
    );
    assert_eq!(
        translator.event(&question),
        [Step::Post {
            path: "/question/que_1/reply".into(),
            body: json!({"answers": [[super::stream::QUESTION_ANSWER]]}),
        }]
    );
    let todos = event(
        "todo.updated",
        json!({"todos": [{"content": "test it", "status": "in_progress"}]}),
    );
    assert!(
        matches!(&translator.event(&todos)[..], [Step::Emit(Event::TodoList { items })] if items.len() == 1)
    );
    assert!(translator.event(&busy()).is_empty());
    assert_eq!(translator.event(&idle()), [Step::Idle]);
}
