//! Remote access on the LAN (PLX-641, 0065): the HTTPS listener on loopback, pairing with a
//! one-time code over SPAKE2, DPoP-bound sessions, and refusing every client that didn't pair.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::methods::{
    AccessSetReadOnly, HostSettingsGet, HostSettingsSet, OrchestrationDispatch,
    OrchestrationGetFullThreadDiff, RemotePair, RemoteRevoke, RemoteSessions, RepoAdd,
    RepoGitStatus, TerminalOpen, TerminalWrite, ThreadStart,
};
use parallax_protocol::{
    AccessSetReadOnlyParams, DispatchMode, FullThreadDiffParams, HostSettingsGetParams,
    HostSettingsSetParams, RemotePairParams, RemoteRevokeParams, RemoteSessionsParams,
    RepoAddParams, RepoGitStatusParams, RepoId, RunId, TerminalCommand, TerminalOpenParams,
    TerminalWriteParams, ThreadStartParams, TurnId,
};
use plxd::backend::fake::Step;
use plxd::remote;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader, duplex};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

use crate::connect::free_port;
use crate::support::{Client, InProcess, PATIENCE, temp_dir};

pub(crate) const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

pub(crate) async fn set_remote(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.remote, Some(on));
}

/// Waits until something accepts at `port`, or stops accepting.
pub(crate) async fn wait_listening(port: u16, listening: bool) {
    let deadline = Instant::now() + PATIENCE;
    while TcpStream::connect((LOOPBACK, port)).await.is_ok() != listening {
        assert!(Instant::now() < deadline, "the listener never changed");
        sleep(Duration::from_millis(20)).await;
    }
}

/// A new pairing code, as the host shows it.
pub(crate) async fn new_code(client: &mut Client) -> String {
    let answer = client
        .call::<RemotePair>(RemotePairParams {})
        .await
        .unwrap();
    assert_eq!(
        answer.code.len(),
        remote::CODE_LENGTH + 1,
        "{}",
        answer.code
    );
    answer.code
}

/// A code that isn't `code`.
fn wrong(code: &str) -> String {
    let flipped = if code.ends_with('2') { '3' } else { '2' };
    format!("{}{flipped}", &code[..code.len() - 1])
}

/// An app's connection to a paired host: lines in and out, as `plxd dial` bridges them.
pub(crate) struct App {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
}

pub(crate) async fn open(
    routes: &[String],
    fingerprint: &str,
    data_dir: &Path,
) -> Result<App, remote::Error> {
    Ok(App::bridged(
        remote::dial(routes, fingerprint, data_dir).await?.socket,
    ))
}

/// An app's connection to the `account:` host `host_id` (0091).
pub(crate) async fn open_account(
    routes: &[String],
    host_id: &str,
    data_dir: &Path,
) -> Result<App, remote::Error> {
    Ok(App::bridged(
        remote::dial_account(routes, false, host_id, data_dir)
            .await?
            .socket,
    ))
}

impl App {
    pub(crate) fn bridged(
        socket: tokio_tungstenite::WebSocketStream<
            tokio_rustls::client::TlsStream<plxd::relay::Stream>,
        >,
    ) -> Self {
        let (app, stdio) = duplex(64 * 1024);
        let (input, output) = tokio::io::split(stdio);
        tokio::spawn(remote::bridge(socket, remote::Input::new(input), output));
        let (reader, writer) = tokio::io::split(app);
        App {
            lines: BufReader::new(reader).lines(),
            writer,
        }
    }

    /// An app that wrote `first` as it started `plxd dial`, so those lines wait on its input and
    /// go behind the upgrade to a host that keeps them (PLX-1483): the app, and the route.
    pub(crate) async fn dialed_with(
        routes: &[String],
        fingerprint: &str,
        data_dir: &Path,
        first: &str,
    ) -> Result<(Self, String), remote::Error> {
        let (app, stdio) = duplex(64 * 1024);
        let (input, output) = tokio::io::split(stdio);
        let (reader, mut writer) = tokio::io::split(app);
        writer.write_all(first.as_bytes()).await.unwrap();
        let mut input = remote::Input::new(input);
        let dialed = remote::dial_with_input(routes, fingerprint, data_dir, &mut input).await?;
        tokio::spawn(remote::bridge(dialed.socket, input, output));
        let lines = BufReader::new(reader).lines();
        Ok((App { lines, writer }, dialed.route))
    }

    pub(crate) async fn initialize(&mut self) -> Value {
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"test","version":"0"},"capabilities":{}}}"#;
        self.writer
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let line = timeout(PATIENCE, self.lines.next_line())
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line.expect("an answer")).unwrap()
    }

    /// Sends one JSON-RPC message.
    pub(crate) async fn send(&mut self, message: &str) {
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    /// The next message, within `PATIENCE`.
    pub(crate) async fn next(&mut self) -> String {
        let line = timeout(PATIENCE, self.lines.next_line()).await.unwrap();
        line.unwrap().expect("a message")
    }

    /// Whether the host closed the connection within `PATIENCE`.
    pub(crate) async fn closes(&mut self) -> bool {
        self.closes_within(PATIENCE).await
    }

    /// Whether the host closed the connection within `limit`.
    pub(crate) async fn closes_within(&mut self, limit: Duration) -> bool {
        matches!(
            timeout(limit, self.lines.next_line()).await,
            Ok(Ok(None) | Err(_))
        )
    }
}

/// Sends `method` on `app` and answers with its error's kind or message, if it failed.
pub(crate) async fn refusal(app: &mut App, id: u32, method: &str, params: &str) -> Option<String> {
    app.send(&format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#
    ))
    .await;
    let answer: Value = serde_json::from_str(&app.next().await).unwrap();
    let error = &answer["error"];
    (!error.is_null()).then(|| {
        error["data"]["kind"]
            .as_str()
            .unwrap_or(error["message"].as_str().unwrap_or_default())
            .to_owned()
    })
}

#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one device told step by step")]
async fn a_read_only_device_reads_threads_and_is_refused_writes_and_terminals() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let laptop = temp_dir();
    let code = new_code(&mut client).await;
    let route = format!("127.0.0.1:{port}");
    let routes = std::slice::from_ref(&route);
    let paired = remote::pair(routes, &code, "laptop", laptop.path())
        .await
        .unwrap();
    let fp = &paired.fingerprint;
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .sessions;
    assert!(!sessions[0].read_only, "full access until limited");
    let id = sessions[0].id.clone();
    let mut app = open(routes, fp, laptop.path()).await.unwrap();
    app.initialize().await;

    // Limiting it closes the connection it has, which came up with full access.
    let listed = client
        .call::<AccessSetReadOnly>(AccessSetReadOnlyParams { id: id.clone() })
        .await
        .unwrap();
    assert!(listed.sessions[0].read_only);
    assert!(app.closes().await, "limiting it closes its connection");

    let mut app = open(routes, fp, laptop.path()).await.unwrap();
    app.initialize().await;
    let read_only = Some("readOnly".to_owned());
    assert_eq!(refusal(&mut app, 2, "thread/list", "{}").await, None);
    let subscribe = r#"{"afterSeq":0}"#;
    assert_ne!(
        refusal(&mut app, 3, "events/subscribe", subscribe).await,
        read_only
    );
    let refused = [
        ("host/settings/set", r#"{"autoResume":false}"#),
        ("host/announceUpdate", "{}"),
        (
            "terminal/open",
            r#"{"threadId":"t","terminalId":"t","cwd":"/","cols":80,"rows":24}"#,
        ),
        (
            "agent/send",
            r#"{"runId":"00000000-0000-0000-0000-000000000000"}"#,
        ),
        ("remote/pair", "{}"),
        ("remote/revoke", r#"{"id":"x"}"#),
        ("access/setReadOnly", r#"{"id":"x"}"#),
        ("access/merge", "{}"),
        ("secret/answer", "{}"),
    ];
    for (n, (method, params)) in (10..).zip(refused) {
        assert_eq!(
            refusal(&mut app, n, method, params).await,
            read_only,
            "{method}"
        );
    }

    // It can name a terminal the host's own app opened, and what it types goes nowhere. A shell
    // runs what it reads in order, so once the app's line has run, the device's never will.
    if cfg!(unix) {
        let marks = temp_dir();
        let (refused, allowed) = (marks.path().join("refused"), marks.path().join("allowed"));
        let command = TerminalCommand {
            program: "/bin/sh".to_owned(),
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        // A connection of its own, as the terminal's output goes to the one that opened it.
        let mut shell = Client::ready(&server.socket).await;
        shell
            .send::<TerminalOpen>(TerminalOpenParams {
                thread_id: "t".to_owned(),
                terminal_id: "1".to_owned(),
                cwd: None,
                command: Some(command),
                cols: 80,
                rows: 24,
            })
            .await;
        while !matches!(
            shell.next().await,
            Some(parallax_protocol::jsonrpc::Message::Response(_))
        ) {}
        let write = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "terminal/write",
            "params": {
                "threadId": "t",
                "terminalId": "1",
                "data": format!("touch {}\n", refused.display()),
            },
        });
        app.send(&write.to_string()).await;
        // Answered, so plxd has read the notification before it.
        assert_eq!(refusal(&mut app, 30, "thread/list", "{}").await, None);
        shell
            .notify::<TerminalWrite>(TerminalWriteParams {
                thread_id: "t".to_owned(),
                terminal_id: "1".to_owned(),
                data: format!("touch {}\n", allowed.display()),
            })
            .await;
        let deadline = Instant::now() + PATIENCE;
        while !allowed.exists() {
            assert!(Instant::now() < deadline, "the app's line never ran");
            sleep(Duration::from_millis(20)).await;
        }
        assert!(!refused.exists(), "a read-only device typed in a terminal");
    }
    drop(app);

    // Nothing lifts the mark. Revoked and paired again, it's a new key, with full access.
    client
        .call::<RemoteRevoke>(RemoteRevokeParams { id })
        .await
        .unwrap();
    let code = new_code(&mut client).await;
    remote::pair(routes, &code, "laptop", laptop.path())
        .await
        .unwrap();
    let mut app = open(routes, fp, laptop.path()).await.unwrap();
    app.initialize().await;
    let settings = r#"{"autoResume":true}"#;
    assert_eq!(
        refusal(&mut app, 2, "host/settings/set", settings).await,
        None
    );

    set_remote(&mut client, false).await;
    server.stop().await;
}

/// A script at `dir/name` that touches `dir/name.ran`, then runs `then`.
#[cfg(unix)]
fn planted(dir: &Path, name: &str, then: &str) -> String {
    use std::os::unix::fs::PermissionsExt as _;
    let script = dir.join(name);
    let ran = dir.join(format!("{name}.ran"));
    let body = format!("#!/bin/sh\ntouch '{}'\n{then}\n", ran.display());
    std::fs::write(&script, body).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_str().unwrap().to_owned()
}

/// Waits until checkpoint `to` of `thread` can be diffed.
#[cfg(unix)]
async fn checkpointed(client: &mut Client, thread: RunId, to: u32) {
    let deadline = Instant::now() + PATIENCE;
    while client
        .call::<OrchestrationGetFullThreadDiff>(FullThreadDiffParams {
            thread_id: thread,
            to,
            ignore_whitespace: None,
        })
        .await
        .is_err()
    {
        assert!(Instant::now() < deadline, "no checkpoint {to}");
        sleep(Duration::from_millis(20)).await;
    }
}

/// What a repository's own config can have git run must not run for a read-only device: what it
/// can read runs none of it, and what would run it, `git status`, is refused.
#[cfg(unix)]
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "each plant, proven first, told in turn"
)]
async fn a_read_only_device_runs_nothing_the_repository_configures() {
    use std::process::Command;

    use crate::agents::{end_turn, fake, git, init, real_repo};
    use crate::orchestration::sent;
    use crate::threads::start_params;

    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.backends = Some(fake(vec![
        init("read-only"),
        end_turn("Turn 1."),
        Step::AwaitFollowUp,
        Step::WriteFile {
            path: "b.txt".to_owned(),
            content: "two\n".to_owned(),
        },
        end_turn("Turn 2."),
    ]));
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;

    let repos = temp_dir();
    let repo = real_repo(repos.path());
    let submodule = repo.join("sub");
    std::fs::create_dir(&submodule).unwrap();
    git(&submodule, &["init", "-q"]);
    git(&submodule, &["config", "user.name", "Test User"]);
    git(&submodule, &["config", "user.email", "test@example.com"]);
    std::fs::write(submodule.join("a.txt"), "one\n").unwrap();
    git(&submodule, &["add", "."]);
    git(&submodule, &["commit", "-q", "-m", "one"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "submodule"]);
    let repo_id = RepoId::generate();
    client
        .call::<RepoAdd>(RepoAddParams {
            id: repo_id,
            path: repo.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap();

    // A thread in the current checkout, with two checkpoints the submodule differs between.
    let thread = client
        .call::<ThreadStart>(ThreadStartParams {
            checkout: true,
            ..start_params(Some(repo_id), "Start")
        })
        .await
        .unwrap()
        .run
        .id;
    checkpointed(&mut client, thread, 1).await;
    std::fs::write(submodule.join("a.txt"), "two\n").unwrap();
    git(&submodule, &["commit", "-q", "-am", "two"]);
    client
        .call::<OrchestrationDispatch>(sent(
            thread,
            TurnId::generate(),
            "Go on",
            DispatchMode::QueueAfterActive,
        ))
        .await
        .unwrap();
    checkpointed(&mut client, thread, 2).await;
    let (from, to) = (
        format!("refs/parallax/checkpoints/{thread}/1"),
        format!("refs/parallax/checkpoints/{thread}/2"),
    );

    std::fs::write(repo.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
    std::fs::write(repo.join("notes.txt"), "hello\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "notes"]);

    // Everything a status or a diff can be configured to run. The same size, so git has to read
    // the file through its clean filter to tell that it changed.
    let scripts = temp_dir();
    let fsmonitor = planted(scripts.path(), "fsmonitor", "exit 0");
    let clean = planted(scripts.path(), "clean", "cat");
    let textconv = planted(scripts.path(), "textconv", "cat \"$1\"");
    let driver = planted(scripts.path(), "driver", "exit 0");
    let external = planted(scripts.path(), "external", "exit 0");
    let nested = planted(scripts.path(), "nested", "exit 0");
    for (name, value) in [
        ("core.fsmonitor", &fsmonitor),
        ("filter.evil.clean", &clean),
        ("diff.evil.textconv", &textconv),
        ("diff.evil.command", &driver),
        ("diff.external", &external),
        ("diff.submodule", &"diff".to_owned()),
    ] {
        git(&repo, &["config", name, value]);
    }
    git(&submodule, &["config", "diff.external", &nested]);
    std::fs::write(repo.join("notes.txt"), "HELLO\n").unwrap();
    let ran = |name: &str| scripts.path().join(format!("{name}.ran")).exists();
    let forget = || {
        for name in [
            "fsmonitor",
            "clean",
            "textconv",
            "driver",
            "external",
            "nested",
            "ssh",
        ] {
            let _ = std::fs::remove_file(scripts.path().join(format!("{name}.ran")));
        }
    };

    // They do run. Plain git starts the monitor and the filter, and `diff.submodule=diff` runs a
    // nested diff that ignores `--no-ext-diff`.
    git(&repo, &["status"]);
    assert!(ran("fsmonitor") && ran("clean"), "the plants never ran");
    forget();
    git(
        &repo,
        &["diff", "--no-ext-diff", "--no-textconv", &from, &to],
    );
    assert!(ran("nested"), "the submodule's plant never ran");
    forget();

    let laptop = temp_dir();
    let code = new_code(&mut client).await;
    let route = format!("127.0.0.1:{port}");
    let routes = std::slice::from_ref(&route);
    let paired = remote::pair(routes, &code, "laptop", laptop.path())
        .await
        .unwrap();
    let id = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .sessions[0]
        .id
        .clone();
    client
        .call::<AccessSetReadOnly>(AccessSetReadOnlyParams { id })
        .await
        .unwrap();
    let mut app = open(routes, &paired.fingerprint, laptop.path())
        .await
        .unwrap();
    app.initialize().await;

    let repo_param = serde_json::json!({ "repo": repo_id }).to_string();
    let grep = serde_json::json!({ "repo": repo_id, "query": "HELLO" }).to_string();
    let turn = serde_json::json!({ "threadId": thread, "from": 1, "to": 2 }).to_string();
    let whole = serde_json::json!({ "threadId": thread, "to": 2 }).to_string();
    for (n, (method, params)) in (10..).zip([
        ("repo/files", &repo_param),
        ("repo/grep", &grep),
        ("repo/logo", &repo_param),
        ("repo/refs", &repo_param),
        ("orchestration/getTurnDiff", &turn),
        ("orchestration/getFullThreadDiff", &whole),
    ]) {
        assert_eq!(refusal(&mut app, n, method, params).await, None, "{method}");
    }
    assert_eq!(
        refusal(&mut app, 20, "repo/gitStatus", &repo_param).await,
        Some("readOnly".to_owned())
    );
    for name in [
        "fsmonitor",
        "clean",
        "textconv",
        "driver",
        "external",
        "nested",
    ] {
        assert!(!ran(name), "a read-only device ran the repository's {name}");
    }

    // Why `repo/gitStatus` stays refused: on a full-access connection it runs the clean filter,
    // which no `-c` can turn off. Its monitor stays off even here.
    client
        .call::<RepoGitStatus>(RepoGitStatusParams { repo: repo_id })
        .await
        .unwrap();
    assert!(ran("clean"), "the refused read does run the filter");
    assert!(!ran("fsmonitor"));
    forget();

    // A partial clone missing a blob fetches it through `core.sshCommand`. Plain git does, and a
    // checkpoint's diff gets an error instead.
    let ssh = planted(scripts.path(), "ssh", "exit 1");
    let blob = git(&repo, &["rev-parse", &format!("{to}:b.txt")]);
    for (name, value) in [
        ("core.repositoryformatversion", "1"),
        ("extensions.partialClone", "origin"),
        ("remote.origin.url", "ssh://plant.invalid/repo.git"),
        ("remote.origin.promisor", "true"),
        ("core.sshCommand", &ssh),
    ] {
        git(&repo, &["config", name, value]);
    }
    let (fan, rest) = blob.split_at(2);
    std::fs::remove_file(repo.join(".git/objects").join(fan).join(rest)).unwrap();
    let plain = Command::new("git")
        .args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--submodule=short",
            &from,
            &to,
        ])
        .current_dir(&repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(!plain.status.success());
    assert!(ran("ssh"), "the partial clone's plant never ran");
    forget();
    for (n, (method, params)) in (30..).zip([
        ("orchestration/getTurnDiff", &turn),
        ("orchestration/getFullThreadDiff", &whole),
    ]) {
        assert_ne!(
            refusal(&mut app, n, method, params).await,
            Some("readOnly".to_owned()),
            "{method}"
        );
        assert!(!ran("ssh"), "{method} ran the repository's sshCommand");
    }

    drop(app);
    set_remote(&mut client, false).await;
    server.stop().await;
}

#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one pairing told step by step")]
async fn a_client_pairs_with_the_code_and_every_other_is_refused() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let laptop = temp_dir();
    let other = temp_dir();

    // Off by default: nothing listens, and there's no code.
    let settings = client
        .call::<HostSettingsGet>(HostSettingsGetParams {})
        .await
        .unwrap();
    assert_eq!(settings.remote, Some(false));
    assert!(TcpStream::connect((LOOPBACK, port)).await.is_err());
    assert!(
        client
            .call::<RemotePair>(RemotePairParams {})
            .await
            .is_err()
    );
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            device_name: Some("Studio".to_owned()),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();

    // Only HTTPS: a plain HTTP request gets no answer.
    let mut plain = TcpStream::connect((LOOPBACK, port)).await.unwrap();
    plain
        .write_all(b"GET /.well-known/parallax HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut answer = Vec::new();
    let _ = timeout(PATIENCE, plain.read_to_end(&mut answer))
        .await
        .unwrap();
    assert!(
        !answer.starts_with(b"HTTP/"),
        "{}",
        String::from_utf8_lossy(&answer)
    );

    let code = new_code(&mut client).await;
    let route = format!("127.0.0.1:{port}");
    let routes = std::slice::from_ref(&route);
    let refused = remote::pair(routes, &wrong(&code), "laptop", laptop.path()).await;
    assert!(
        matches!(refused, Err(remote::Error::Refused)),
        "{refused:?}"
    );
    // A wrong code doesn't use up the right one, and lowercase still matches it.
    let paired = remote::pair(routes, &code.to_lowercase(), "laptop", laptop.path())
        .await
        .unwrap();
    assert_eq!(paired.name, "Studio");
    assert_eq!(paired.fingerprint.len(), 64);
    assert_eq!(paired.routes, [route.as_str()]);
    let again = remote::pair(routes, &code, "thief", other.path()).await;
    assert!(
        matches!(again, Err(remote::Error::Refused)),
        "a code works once: {again:?}"
    );

    // Too many wrong codes lock the code, so the right one stops working too.
    let locked = new_code(&mut client).await;
    for _ in 0..remote::MAX_WRONG_CODES {
        let guess = remote::pair(routes, &wrong(&locked), "guesser", other.path()).await;
        assert!(matches!(guess, Err(remote::Error::Refused)), "{guess:?}");
    }
    let late = remote::pair(routes, &locked, "desktop", other.path()).await;
    assert!(
        matches!(late, Err(remote::Error::Refused)),
        "locked: {late:?}"
    );

    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert!(sessions.listening);
    let sessions = sessions.sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "laptop");

    // Routes are tried in order: the first is dead, the second answers.
    let dead = format!("127.0.0.1:{}", free_port());
    let fp = &paired.fingerprint;
    let mut app = open(&[dead, route.clone()], fp, laptop.path())
        .await
        .unwrap();
    let initialized = app.initialize().await;
    assert!(initialized["result"]["logId"].is_string(), "{initialized}");

    // No credential, or a stolen token without its DPoP key, is refused.
    let stranger = open(routes, fp, other.path()).await;
    assert!(
        matches!(stranger, Err(remote::Error::Refused)),
        "{:?}",
        stranger.err()
    );
    let second = new_code(&mut client).await;
    remote::pair(routes, &second, "desktop", other.path())
        .await
        .unwrap();
    let thief = temp_dir();
    let read = |dir: &Path| -> Value {
        let file = dir.join("remote-hosts").join(fp);
        serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
    };
    let (stolen, theirs) = (read(laptop.path()), read(other.path()));
    let mixed = serde_json::json!({ "token": stolen["token"], "key": theirs["key"] });
    std::fs::create_dir_all(thief.path().join("remote-hosts")).unwrap();
    std::fs::write(
        thief.path().join("remote-hosts").join(fp),
        mixed.to_string(),
    )
    .unwrap();
    let replayed = open(routes, fp, thief.path()).await;
    assert!(
        matches!(replayed, Err(remote::Error::Refused)),
        "{:?}",
        replayed.err()
    );

    // Revoking closes the session's connection and refuses it after.
    let id = sessions[0].id.clone();
    let left = client
        .call::<RemoteRevoke>(RemoteRevokeParams { id })
        .await
        .unwrap();
    assert_eq!(left.sessions.len(), 1, "the desktop's session stays");
    assert!(app.closes().await, "revoking closes its connection");
    let after = open(routes, fp, laptop.path()).await;
    assert!(
        matches!(after, Err(remote::Error::Refused)),
        "{:?}",
        after.err()
    );

    set_remote(&mut client, false).await;
    wait_listening(port, false).await;
    server.stop().await;
}

#[tokio::test]
async fn an_expired_code_ends_the_pairing_and_its_advertisement() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.remote_code_lifetime = Duration::from_millis(300);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;

    let code = new_code(&mut client).await;
    let status = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert!(status.pairing, "a code is waiting");
    let deadline = Instant::now() + PATIENCE;
    while client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .pairing
    {
        assert!(Instant::now() < deadline, "the pairing never ended");
        sleep(Duration::from_millis(50)).await;
    }
    let route = format!("127.0.0.1:{port}");
    let late = remote::pair(std::slice::from_ref(&route), &code, "laptop", dir.path()).await;
    assert!(matches!(late, Err(remote::Error::Refused)), "{late:?}");
    server.stop().await;
}

/// One HTTPS request to the listener on loopback `port`: its status, its headers by lowercase
/// name, and its body.
pub(crate) async fn https(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, HashMap<String, String>, Vec<u8>) {
    let (mut tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    tls.write_all(format!("{head}\r\n{body}").as_bytes())
        .await
        .unwrap();
    let mut answer = Vec::new();
    let _ = timeout(PATIENCE, tls.read_to_end(&mut answer))
        .await
        .unwrap();
    let mut parsed = [httparse::EMPTY_HEADER; 16];
    let mut response = httparse::Response::new(&mut parsed);
    let httparse::Status::Complete(length) = response.parse(&answer).unwrap() else {
        panic!("a partial answer");
    };
    let headers = response
        .headers
        .iter()
        .map(|h| {
            let value = String::from_utf8_lossy(h.value).into_owned();
            (h.name.to_ascii_lowercase(), value)
        })
        .collect();
    (response.code.unwrap(), headers, answer[length..].to_vec())
}

type WebSocket =
    tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<plxd::relay::Stream>>;

/// A WebSocket to `/ws` with `ticket`, sent from `origin`, once it has initialized.
async fn web_socket(
    port: u16,
    ticket: &str,
    origin: &str,
) -> Result<WebSocket, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let (tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    let mut request = format!("wss://127.0.0.1:{port}/ws?wsTicket={ticket}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::client_async(request, tls).await?;
    let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"browser","version":"0"},"capabilities":{}}}"#;
    socket.send(Message::text(initialize)).await?;
    let answer = timeout(PATIENCE, socket.next()).await.unwrap().unwrap()?;
    let answer: Value = serde_json::from_str(answer.to_text()?).unwrap();
    assert!(answer["result"]["logId"].is_string(), "{answer}");
    Ok(socket)
}

/// A ticket for the browser session `token`, bound to `key`: the status and the answer.
async fn web_ticket(port: u16, key: &remote::DpopKey, token: &str) -> (u16, Value) {
    let path = "/api/auth/websocket-ticket";
    let base = format!("https://127.0.0.1:{port}");
    let authorization = format!("DPoP {token}");
    let dpop = key.proof("POST", &format!("{base}{path}"), Some(token));
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", dpop.as_str()),
        ("Origin", base.as_str()),
    ];
    let (status, _, body) = https(port, "POST", path, &headers, "").await;
    (status, serde_json::from_slice(&body).unwrap())
}

async fn set_web(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote_web: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.remote_web, Some(on));
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the web client's whole surface, step by step"
)]
async fn the_web_client_is_served_only_when_on_and_pairs_a_browser_with_the_code() {
    let port = free_port();
    let dir = temp_dir();
    let web = temp_dir();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("web.html"), "<!doctype html>web").unwrap();
    std::fs::write(web.path().join("assets/app-1a.js"), "app()").unwrap();
    std::fs::write(web.path().join("secret.txt"), "secret").unwrap();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.remote_web_dir = Some(web.path().to_owned());
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let key = remote::DpopKey::generate();
    let base = format!("https://127.0.0.1:{port}");
    let pair = |code: &str| serde_json::json!({ "code": code, "clientLabel": "Phone" }).to_string();
    let proof =
        |path: &str, token: Option<&str>| key.proof("POST", &format!("{base}{path}"), token);
    // The status of a pairing with `code`, a fresh proof, and no `Origin`.
    let pair_status = async |code: &str| {
        let dpop = proof("/api/pair/browser", None);
        let headers = [("DPoP", dpop.as_str())];
        https(port, "POST", "/api/pair/browser", &headers, &pair(code))
            .await
            .0
    };

    // Off by default, even with `remote` on: no page, and no pairing with the code alone.
    let settings = client
        .call::<HostSettingsGet>(HostSettingsGetParams {})
        .await
        .unwrap();
    assert_eq!(settings.remote_web, Some(false));
    assert_eq!(https(port, "GET", "/", &[], "").await.0, 404);
    let code = new_code(&mut client).await;
    let dpop = proof("/api/pair/browser", None);
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &[("DPoP", &dpop)],
        &pair(&code),
    )
    .await;
    assert_eq!(status, 404);

    set_web(&mut client, true).await;

    // The page and its assets, with a policy that forbids framing and other origins' scripts.
    let (status, headers, body) = https(port, "GET", "/", &[], "").await;
    assert_eq!((status, body.as_slice()), (200, &b"<!doctype html>web"[..]));
    let csp = &headers["content-security-policy"];
    assert!(
        csp.contains("frame-ancestors 'none'") && csp.contains("script-src 'self';"),
        "{csp}"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let (status, headers, body) = https(port, "GET", "/assets/app-1a.js", &[], "").await;
    assert_eq!((status, body.as_slice()), (200, &b"app()"[..]));
    assert!(headers["content-type"].starts_with("text/javascript"));
    // Nothing else in the folder, or outside it.
    for path in [
        "/secret.txt",
        "/web.html",
        "/assets/../secret.txt",
        "/assets/..%2fsecret.txt",
        "/assets/",
        "/assets/.hidden",
        // Windows' devices, and the trailing dot it strips, aren't in the folder's listing.
        "/assets/CON",
        "/assets/nul.js",
        "/assets/app-1a.js.",
    ] {
        assert_eq!(https(port, "GET", path, &[], "").await.0, 404, "{path}");
    }

    // A page on another origin can't pair, even with the right code, and doesn't use it up.
    let evil = [("DPoP", dpop.as_str()), ("Origin", "https://evil.example")];
    let (status, ..) = https(port, "POST", "/api/pair/browser", &evil, &pair(&code)).await;
    assert_eq!(status, 403);
    // No proof, or a wrong code, is refused.
    let (status, ..) = https(port, "POST", "/api/pair/browser", &[], &pair(&code)).await;
    assert_eq!(status, 401);
    assert_eq!(pair_status(&wrong(&code)).await, 401);

    // A proof seen once is refused before it reaches the code, so a replay can't use it up.
    let seen = proof("/api/pair/browser", None);
    let headers = [("DPoP", seen.as_str())];
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &headers,
        &pair(&wrong(&code)),
    )
    .await;
    assert_eq!(status, 401);
    let (status, _, body) = https(port, "POST", "/api/pair/browser", &headers, &pair(&code)).await;
    assert_eq!(status, 401);
    assert!(String::from_utf8_lossy(&body).contains("replayed"));

    // The right code, as typed, from this host's own origin.
    let dpop = proof("/api/pair/browser", None);
    let own = [("DPoP", dpop.as_str()), ("Origin", base.as_str())];
    let typed = code.to_lowercase();
    let (status, _, body) = https(port, "POST", "/api/pair/browser", &own, &pair(&typed)).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let paired: Value = serde_json::from_slice(&body).unwrap();
    let token = paired["accessToken"].as_str().unwrap().to_owned();
    assert_eq!(pair_status(&code).await, 401, "a code works once");
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert_eq!(sessions.sessions[0].name, "Phone");

    // Too many wrong codes lock it, as for SPAKE2.
    let locked = new_code(&mut client).await;
    for _ in 0..remote::MAX_WRONG_CODES {
        assert_eq!(pair_status(&wrong(&locked)).await, 401);
    }
    assert_eq!(pair_status(&locked).await, 401, "locked");

    // The session opens the WebSocket through a ticket, from this origin only. An unknown token is
    // `invalid_token`, the only refusal that means pairing again.
    let (status, refusal) = web_ticket(port, &key, "nope").await;
    assert_eq!(
        (status, refusal["error"].as_str()),
        (401, Some("invalid_token"))
    );
    let (status, ticket) = web_ticket(port, &key, &token).await;
    assert_eq!(status, 200, "{ticket}");
    let ticket = ticket["ticket"].as_str().unwrap();
    let elsewhere = web_socket(port, ticket, "https://evil.example").await;
    assert!(
        matches!(&elsewhere, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 403),
        "{elsewhere:?}"
    );
    web_socket(port, ticket, &base).await.unwrap();
    let reused = web_socket(port, ticket, &base).await;
    assert!(
        matches!(&reused, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 401),
        "a ticket works once: {reused:?}"
    );

    // Off: the page is gone, a browser's open socket closes and it gets no ticket, and a paired
    // computer keeps working.
    let route = format!("127.0.0.1:{port}");
    let desktop = temp_dir();
    let second = new_code(&mut client).await;
    let paired = remote::pair(
        std::slice::from_ref(&route),
        &second,
        "desktop",
        desktop.path(),
    )
    .await
    .unwrap();
    let (_, ticket) = web_ticket(port, &key, &token).await;
    let mut socket = web_socket(port, ticket["ticket"].as_str().unwrap(), &base)
        .await
        .unwrap();
    set_web(&mut client, false).await;
    assert_eq!(https(port, "GET", "/", &[], "").await.0, 404);
    let closed = timeout(PATIENCE, socket.next()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Ok(Message::Close(_)) | Err(_))),
        "{closed:?}"
    );
    let (status, refusal) = web_ticket(port, &key, &token).await;
    assert_eq!(
        (status, refusal["error"].as_str()),
        (403, Some("access_denied"))
    );
    let mut app = open(&[route], &paired.fingerprint, desktop.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"]["logId"].is_string());

    // On again: the browser's session works as before.
    set_web(&mut client, true).await;
    let (status, ticket) = web_ticket(port, &key, &token).await;
    assert_eq!(status, 200, "{ticket}");
    web_socket(port, ticket["ticket"].as_str().unwrap(), &base)
        .await
        .unwrap();
    server.stop().await;
}

/// A WebSocket to `/ws` opened with `token` and the `DPoP` proof `dpop` on the upgrade (0091).
async fn proved_socket(
    port: u16,
    token: &str,
    dpop: &str,
) -> Result<WebSocket, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let (tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    let mut request = format!("wss://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    let headers = request.headers_mut();
    let authorization = format!("DPoP {token}");
    headers.insert("authorization", authorization.parse().unwrap());
    headers.insert("dpop", dpop.parse().unwrap());
    let (socket, _) = tokio_tungstenite::client_async(request, tls).await?;
    Ok(socket)
}

#[tokio::test]
async fn the_ws_upgrade_takes_a_sessions_proof_once_from_its_own_key() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    set_web(&mut client, true).await;
    let key = remote::DpopKey::generate();
    let base = format!("https://127.0.0.1:{port}");
    let code = new_code(&mut client).await;
    let dpop = key.proof("POST", &format!("{base}/api/pair/browser"), None);
    let body = serde_json::json!({ "code": code, "clientLabel": "Phone" }).to_string();
    let (status, _, answer) =
        https(port, "POST", "/api/pair/browser", &[("DPoP", &dpop)], &body).await;
    assert_eq!(status, 200);
    let answer: Value = serde_json::from_slice(&answer).unwrap();
    let token = answer["accessToken"].as_str().unwrap();
    let refused = |result: Result<WebSocket, tokio_tungstenite::tungstenite::Error>| matches!(result, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 401);

    // One round trip: the proof on the upgrade opens the socket, with no ticket first.
    let proof = key.proof("GET", &format!("{base}/ws"), Some(token));
    let mut socket = proved_socket(port, token, &proof).await.unwrap();
    let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"t","version":"0"},"capabilities":{}}}"#;
    socket.send(Message::text(initialize)).await.unwrap();
    let answer = timeout(PATIENCE, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(answer.to_text().unwrap().contains("logId"), "{answer:?}");

    // The same proof again, one from another key, one for another method, or an unknown token.
    assert!(
        refused(proved_socket(port, token, &proof).await),
        "a replay"
    );
    let other = remote::DpopKey::generate().proof("GET", &format!("{base}/ws"), Some(token));
    assert!(
        refused(proved_socket(port, token, &other).await),
        "another key"
    );
    let posted = key.proof("POST", &format!("{base}/ws"), Some(token));
    assert!(
        refused(proved_socket(port, token, &posted).await),
        "another method"
    );
    let fresh = key.proof("GET", &format!("{base}/ws"), Some("guess"));
    assert!(
        refused(proved_socket(port, "guess", &fresh).await),
        "an unknown token"
    );
    server.stop().await;
}

/// The session `remote::pair` saved in `dir` for the host with `fingerprint`, as `plxd dial` reads
/// it: its key and token.
fn saved_session(dir: &Path, fingerprint: &str) -> (remote::DpopKey, String) {
    let saved = std::fs::read(dir.join("remote-hosts").join(fingerprint)).unwrap();
    let saved: Value = serde_json::from_slice(&saved).unwrap();
    let key = remote::base64url_decode(saved["key"].as_str().unwrap()).unwrap();
    let token = saved["token"].as_str().unwrap().to_owned();
    (remote::DpopKey::from_pkcs8(&key).unwrap(), token)
}

/// `lines` as the masked text frames a WebSocket client sends.
async fn client_frames(lines: &[String]) -> Vec<u8> {
    use tokio_tungstenite::tungstenite::protocol::Role;
    let (near, mut far) = duplex(1024 * 1024);
    let mut socket =
        tokio_tungstenite::WebSocketStream::from_raw_socket(near, Role::Client, None).await;
    for line in lines {
        socket.send(Message::text(line.clone())).await.unwrap();
    }
    drop(socket);
    let mut frames = Vec::new();
    far.read_to_end(&mut frames).await.unwrap();
    frames
}

/// The header a WebSocket upgrade names its key in, as a line.
const WS_KEY: &str = "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";

/// A `/ws` upgrade with `token` and the proof `dpop`, and `behind` in the same write, from a client
/// that doesn't wait for the answer (PLX-1483): the socket, or a refusal's status and everything
/// the host sent before it closed.
async fn upgrade_with(
    port: u16,
    token: &str,
    dpop: &str,
    behind: &[u8],
) -> Result<WebSocket, (u16, Vec<u8>)> {
    let headers = format!("{WS_KEY}Authorization: DPoP {token}\r\nDPoP: {dpop}\r\n");
    upgrade_request(port, "/ws", &headers, behind).await
}

/// [`upgrade_with`], for a `GET` of `path` with these `headers` beside the upgrade's own, each a
/// line.
async fn upgrade_request(
    port: u16,
    path: &str,
    headers: &str,
    behind: &[u8],
) -> Result<WebSocket, (u16, Vec<u8>)> {
    use tokio_tungstenite::tungstenite::protocol::Role;
    let (mut tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(remote::EARLY_WS));
    let mut flight = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n{headers}\r\n"
    )
    .into_bytes();
    flight.extend_from_slice(behind);
    tls.write_all(&flight).await.unwrap();
    let mut answer = Vec::new();
    let head = loop {
        let mut chunk = [0; 4096];
        let read = timeout(PATIENCE, tls.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        assert!(read > 0, "the host closed without an answer");
        answer.extend_from_slice(&chunk[..read]);
        if let Some(at) = answer.windows(4).position(|four| four == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let status: u16 = std::str::from_utf8(&answer[9..12])
        .unwrap()
        .parse()
        .unwrap();
    if status == 101 {
        let rest = answer.split_off(head);
        let socket =
            tokio_tungstenite::WebSocketStream::from_partially_read(tls, rest, Role::Client, None);
        return Ok(socket.await);
    }
    let _ = timeout(PATIENCE, tls.read_to_end(&mut answer))
        .await
        .unwrap();
    Err((status, answer))
}

/// The next answer on `socket`, past any notification.
async fn next_answer(socket: &mut WebSocket) -> Value {
    loop {
        let frame = timeout(PATIENCE, socket.next()).await.unwrap().unwrap();
        if let Message::Text(text) = frame.unwrap() {
            let message: Value = serde_json::from_str(&text).unwrap();
            if !message["id"].is_null() {
                return message;
            }
        }
    }
}

/// A refused upgrade's status and JSON answer, which is all the host sent.
fn refused_upgrade(answer: Result<WebSocket, (u16, Vec<u8>)>) -> (u16, Value) {
    let Err((status, answer)) = answer else {
        panic!("the host accepted the upgrade");
    };
    let answer = String::from_utf8(answer).unwrap();
    let (_, body) = answer.split_once("\r\n\r\n").unwrap();
    let body = serde_json::from_str(body).expect("the refusal and nothing behind it");
    (status, body)
}

pub(crate) const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"t","version":"0"},"capabilities":{}}}"#;

/// A request that names this computer `name`, which a client with full access may.
fn rename(id: u32, name: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"host/settings/set","params":{{"deviceName":"{name}"}}}}"#
    )
}

async fn device_name(client: &mut Client) -> Option<String> {
    client
        .call::<HostSettingsSet>(HostSettingsSetParams::default())
        .await
        .unwrap()
        .device_name
}

/// A listening host and a laptop paired with it: the session's key, token, and id.
async fn paired_laptop(port: u16, client: &mut Client) -> (remote::DpopKey, String, String) {
    set_remote(client, true).await;
    wait_listening(port, true).await;
    let laptop = temp_dir();
    let code = new_code(client).await;
    let route = format!("127.0.0.1:{port}");
    let paired = remote::pair(&[route], &code, "laptop", laptop.path())
        .await
        .unwrap();
    let (key, token) = saved_session(laptop.path(), &paired.fingerprint);
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .sessions;
    (key, token, sessions[0].id.clone())
}

#[tokio::test]
async fn frames_behind_the_ws_upgrade_are_handled_once_it_passes_and_dropped_when_refused() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let (key, token, id) = paired_laptop(port, &mut client).await;
    let url = format!("https://127.0.0.1:{port}/ws");

    // `initialize`, a write, and enough reads that most arrive after what plxd holds with the
    // request. Each is answered, so none was lost or read before `initialize`.
    let mut lines = vec![INITIALIZE.to_owned(), rename(2, "behind")];
    lines.extend((3..=40).map(|id| {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"thread/list","params":{{}}}}"#)
    }));
    let behind = client_frames(&lines).await;
    assert!(behind.len() > 2048, "{}", behind.len());
    let proof = key.proof("GET", &url, Some(&token));
    let mut socket = upgrade_with(port, &token, &proof, &behind).await.unwrap();
    let mut answered = Vec::new();
    for _ in 1..=40 {
        let answer = next_answer(&mut socket).await;
        assert!(answer["error"].is_null(), "{answer}");
        answered.push(answer["id"].as_u64().unwrap());
    }
    assert_eq!(answered[0], 1, "initialize goes first");
    answered.sort_unstable();
    assert_eq!(answered, (1..=40).collect::<Vec<u64>>());
    assert_eq!(device_name(&mut client).await.as_deref(), Some("behind"));

    // The same write behind each kind of refused upgrade: a 401 and nothing else, and no effect.
    let behind = client_frames(&[INITIALIZE.to_owned(), rename(2, "refused")]).await;
    let refused = |answer: Result<WebSocket, (u16, Vec<u8>)>| {
        let (status, body) = refused_upgrade(answer);
        assert_eq!(status, 401);
        body["error_description"].as_str().unwrap().to_owned()
    };
    let other = remote::DpopKey::generate().proof("GET", &url, Some(&token));
    assert_eq!(
        refused(upgrade_with(port, &token, &other, &behind).await),
        "a DPoP proof from another key"
    );
    assert_eq!(
        refused(upgrade_with(port, &token, &proof, &behind).await),
        "a replayed DPoP proof"
    );
    // A device with no session, as one that isn't approved yet.
    let guess = key.proof("GET", &url, Some("guess"));
    assert_eq!(
        refused(upgrade_with(port, "guess", &guess, &behind).await),
        "an unknown or revoked session"
    );
    client
        .call::<RemoteRevoke>(RemoteRevokeParams { id })
        .await
        .unwrap();
    let fresh = key.proof("GET", &url, Some(&token));
    assert_eq!(
        refused(upgrade_with(port, &token, &fresh, &behind).await),
        "an unknown or revoked session"
    );
    assert_eq!(device_name(&mut client).await.as_deref(), Some("behind"));
    server.stop().await;
}

#[tokio::test]
async fn a_read_only_devices_write_behind_the_ws_upgrade_is_refused_as_one_sent_later_is() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let (key, token, id) = paired_laptop(port, &mut client).await;
    client
        .call::<AccessSetReadOnly>(AccessSetReadOnlyParams { id })
        .await
        .unwrap();
    let before = device_name(&mut client).await;

    let behind = client_frames(&[INITIALIZE.to_owned(), rename(2, "behind")]).await;
    let proof = key.proof("GET", &format!("https://127.0.0.1:{port}/ws"), Some(&token));
    let mut socket = upgrade_with(port, &token, &proof, &behind).await.unwrap();
    let initialized = next_answer(&mut socket).await;
    assert!(initialized["result"]["logId"].is_string(), "{initialized}");
    let early = next_answer(&mut socket).await;
    socket
        .send(Message::text(rename(3, "later")))
        .await
        .unwrap();
    let late = next_answer(&mut socket).await;
    assert_eq!(early["error"]["data"]["kind"], "readOnly", "{early}");
    assert_eq!(early["error"], late["error"]);
    assert_eq!(device_name(&mut client).await, before);
    server.stop().await;
}

#[tokio::test]
async fn frames_behind_a_ws_upgrade_refused_for_its_ticket_key_or_origin_are_dropped() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let (key, token, _) = paired_laptop(port, &mut client).await;
    let url = format!("https://127.0.0.1:{port}/ws");
    let before = device_name(&mut client).await;
    let behind = client_frames(&[INITIALIZE.to_owned(), rename(2, "refused")]).await;
    let no_ticket = serde_json::json!({
        "error": "invalid_grant",
        "error_description": "a wrong, used, or expired ticket",
    });

    let wrong = upgrade_request(port, "/ws?wsTicket=wrong", WS_KEY, &behind).await;
    assert_eq!(refused_upgrade(wrong), (401, no_ticket.clone()));

    // A ticket opens the socket once, with what came behind it, and is refused the second time.
    let (status, ticket) = web_ticket(port, &key, &token).await;
    assert_eq!(status, 200, "{ticket}");
    let path = format!("/ws?wsTicket={}", ticket["ticket"].as_str().unwrap());
    let first = client_frames(&[INITIALIZE.to_owned()]).await;
    let mut socket = upgrade_request(port, &path, WS_KEY, &first).await.unwrap();
    let initialized = next_answer(&mut socket).await;
    assert!(initialized["result"]["logId"].is_string(), "{initialized}");
    let used = upgrade_request(port, &path, WS_KEY, &behind).await;
    assert_eq!(refused_upgrade(used), (401, no_ticket));

    // A proof that would pass, on an upgrade with no key.
    let proof = key.proof("GET", &url, Some(&token));
    let headers = format!("Authorization: DPoP {token}\r\nDPoP: {proof}\r\n");
    let keyless = upgrade_request(port, "/ws", &headers, &behind).await;
    let invalid = serde_json::json!({ "error": "invalid_request" });
    assert_eq!(refused_upgrade(keyless), (400, invalid));

    // And one from another origin.
    let proof = key.proof("GET", &url, Some(&token));
    let headers = format!(
        "{WS_KEY}Authorization: DPoP {token}\r\nDPoP: {proof}\r\nOrigin: https://elsewhere.example\r\n"
    );
    let elsewhere = upgrade_request(port, "/ws", &headers, &behind).await;
    let forbidden =
        serde_json::json!({ "error": "forbidden", "error_description": "another origin" });
    assert_eq!(refused_upgrade(elsewhere), (403, forbidden));

    assert_eq!(device_name(&mut client).await, before);
    server.stop().await;
}
