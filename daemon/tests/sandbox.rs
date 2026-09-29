//! Claude Code's worker sandbox, for real (0013). Runs the Claude Code named in
//! `WISP_SANDBOX_CLAUDE` with the arguments wispd gives a worker, against a fake Messages API on
//! 127.0.0.1 that asks for one Bash command, then checks what that command could do. Nothing
//! reaches Anthropic, and no login is used.
//!
//! Skipped when `WISP_SANDBOX_CLAUDE` is unset. CI's Linux legs install bubblewrap, socat, and a
//! pinned Claude Code, and set it.
#![cfg(unix)]

use std::ffi::OsStr;
use std::fmt::Write as _;
use std::fs;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use wispd::backend::claude::arguments;
use wispd::backend::{AccountRef, Credential, RunId, RunRequest, ToolPolicy, WorkerSandbox};

const SECRET: &str = "wisp-sandbox-test-secret";

#[tokio::test]
async fn a_worker_cannot_read_secrets_write_outside_its_worktree_or_reach_unix_sockets() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: WISP_SANDBOX_CLAUDE doesn't name a Claude Code to test");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    // Canonical, since Seatbelt matches real paths and macOS's temp folder is behind a symlink.
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    let data = root.join("data");
    let worktree = data.join("worktrees/run");
    let context = data.join("context/p");
    let git_dir = root.join("repo/.git");
    for folder in [
        &home.join(".ssh"),
        &worktree,
        &context,
        &data.join("context/other"),
        &git_dir,
        &root.join("tmp"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    // A key in the home folder, and another project's context in wispd's data folder.
    fs::write(home.join(".ssh/id_ed25519"), format!("{SECRET}-key")).unwrap();
    fs::write(
        data.join("context/other/notes.md"),
        format!("{SECRET}-notes"),
    )
    .unwrap();
    let git_file = format!("gitdir: {}/worktrees/run\n", git_dir.display());
    fs::write(worktree.join(".git"), &git_file).unwrap();
    let socket = root.join("probe.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();

    // The probe is a script in the worktree, so Claude Code's permission checks can't see what it
    // touches, as with any build script a worker runs. Only the OS sandbox stands in its way.
    let path = |path: &Path| path.display().to_string();
    let mut probe = format!(
        "cat '{key}'\n\
         cat '{notes}'\n\
         echo x > '{home_file}'\n\
         echo x > '{root_file}'\n\
         echo x > '{git_file}'\n\
         echo x > '{inside}' && echo wrote-inside\n\
         echo x > '{note}' && echo wrote-context\n",
        key = path(&home.join(".ssh/id_ed25519")),
        notes = path(&data.join("context/other/notes.md")),
        home_file = path(&home.join("outside")),
        root_file = path(&root.join("outside")),
        git_file = path(&worktree.join(".git")),
        inside = path(&worktree.join("inside")),
        note = path(&context.join("note")),
    );
    if cfg!(target_os = "linux") {
        // The seccomp filter's job: no Unix sockets, such as the D-Bus session bus.
        writeln!(
            probe,
            "socat -u OPEN:/dev/null 'UNIX-CONNECT:{}' && echo socket-connected",
            path(&socket)
        )
        .unwrap();
    }
    fs::write(worktree.join("probe.sh"), probe).unwrap();

    let request = RunRequest {
        run_id: RunId::generate(),
        turn_id: None,
        cwd: worktree.clone(),
        prompt: "Run the probe.".into(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: Some(WorkerSandbox::for_worktree(
            &home, &data, &worktree, &git_dir, &context,
        )),
        account: AccountRef {
            id: "test".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: Some("claude-sonnet-4-6".into()),
        coordinator_tools: None,
    };
    let (stdout, transcript) = run_worker(&claude, &request, &root, &home).await;

    let result = tool_result(&stdout).unwrap_or_else(|| panic!("no Bash result:\n{transcript}"));
    assert!(result.contains("wrote-inside"), "{transcript}");
    assert!(result.contains("wrote-context"), "{result}");
    assert!(worktree.join("inside").exists());
    assert!(context.join("note").exists());
    assert!(!stdout.contains(SECRET), "a secret was read:\n{result}");
    assert!(!home.join("outside").exists(), "{result}");
    assert!(!root.join("outside").exists(), "{result}");
    assert_eq!(fs::read_to_string(worktree.join(".git")).unwrap(), git_file);
    if cfg!(target_os = "linux") {
        assert!(!result.contains("socket-connected"), "{result}");
        assert!(
            listener.accept().is_err(),
            "a Unix socket connect got through"
        );
    }
}

/// Runs `claude` with the arguments wispd gives `request`, against a fake Messages API whose one
/// Bash call runs `sh probe.sh` in the worktree. Returns stdout, and stdout with stderr for
/// failure messages. Like wispd, it leaves `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` unset for a
/// worker: on Linux it widens the sandbox's writes (RYA-20).
async fn run_worker(
    claude: &OsStr,
    request: &RunRequest,
    root: &Path,
    home: &Path,
) -> (String, String) {
    let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", api.local_addr().unwrap());
    tokio::spawn(serve(api, "sh probe.sh".to_owned()));

    let mut child = tokio::process::Command::new(claude)
        .args(arguments(request).unwrap())
        .current_dir(&request.cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("TMPDIR", root.join("tmp"))
        .env("CLAUDE_CONFIG_DIR", root.join("config"))
        .env("ANTHROPIC_API_KEY", "sk-ant-wisp-sandbox-test")
        .env("ANTHROPIC_BASE_URL", base_url)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("DISABLE_AUTOUPDATER", "1")
        .env("CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let prompt = json!({
        "type": "user",
        "message": {"role": "user", "content": request.prompt},
        "parent_tool_use_id": null,
    });
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(format!("{prompt}\n").as_bytes())
        .await
        .unwrap();
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .expect("Claude Code didn't finish within 120 s")
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let transcript = format!("{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    (stdout, transcript)
}

/// The output of the run's Bash call, from its `tool_result` on stdout.
fn tool_result(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["type"] == "user")
        .find_map(|event| {
            let content = event.pointer("/message/content/0/content")?;
            Some(match content {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
        })
}

/// A fake Messages API: the first turn asks for a Bash call running `command`, and the turn that
/// carries its result ends the conversation. Everything else is a 404.
async fn serve(listener: TcpListener, command: String) {
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(answer(stream, command.clone()));
    }
}

async fn answer(mut stream: TcpStream, command: String) -> std::io::Result<()> {
    let mut request = Vec::new();
    let mut chunk = [0; 16 * 1024];
    let body_start = loop {
        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&request[..body_start]).to_ascii_lowercase();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    while request.len() < body_start + length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let target = head.split_whitespace().nth(1).unwrap_or_default();
    let messages_api = target == "/v1/messages" || target.starts_with("/v1/messages?");
    let response = if head.starts_with("post ") && messages_api {
        let body: Value = serde_json::from_slice(&request[body_start..body_start + length])?;
        let events = messages(&body, &command);
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\
             connection: close\r\n\r\n{events}",
            events.len()
        )
    } else {
        "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
    };
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

/// The streamed reply to a Messages request, as server-sent events.
fn messages(request: &Value, command: &str) -> String {
    let answered = request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|last| last["content"].as_array())
        .is_some_and(|content| content.iter().any(|block| block["type"] == "tool_result"));
    let (block, delta, stop) = if answered {
        (
            json!({"type": "text", "text": ""}),
            json!({"type": "text_delta", "text": "done"}),
            "end_turn",
        )
    } else {
        let input = json!({"command": command, "description": "Probe the sandbox"});
        (
            json!({"type": "tool_use", "id": "toolu_01WispProbe", "name": "Bash", "input": {}}),
            json!({"type": "input_json_delta", "partial_json": input.to_string()}),
            "tool_use",
        )
    };
    let usage = json!({"input_tokens": 1, "output_tokens": 1});
    let message = json!({
        "id": "msg_01WispProbe", "type": "message", "role": "assistant",
        "model": request["model"], "content": [], "stop_reason": null, "stop_sequence": null,
        "usage": usage,
    });
    let events = [
        json!({"type": "message_start", "message": message}),
        json!({"type": "content_block_start", "index": 0, "content_block": block}),
        json!({"type": "content_block_delta", "index": 0, "delta": delta}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": null},
               "usage": {"output_tokens": 1}}),
        json!({"type": "message_stop"}),
    ];
    let mut stream = String::new();
    for event in events {
        let kind = event["type"].as_str().unwrap();
        writeln!(stream, "event: {kind}\ndata: {event}\n").unwrap();
    }
    stream
}
