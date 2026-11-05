//! Agents working across computers without a relay in the way (0101): who gets a session at
//! `POST /api/auth/peer`, what the caller refuses by itself, and that `peer/*` is the local
//! socket's alone. `relay.rs` runs the whole path behind `wrangler dev`.

use parallax_protocol::methods::{
    AccessMerge, AccessRemove, HostHealth, HostSettingsSet, PeerCall, RelayId, RemoteRevoke,
    RemoteSessions,
};
use parallax_protocol::{
    AccessMergeParams, AccessRemoveParams, HostHealthParams, HostSettingsSetParams, PeerCallParams,
    RelayIdParams, RemoteRevokeParams, RemoteSessionsParams,
};
use plxd::remote::{self, DpopKey};
use serde_json::{Value, json};

use crate::agents::{Host, end_turn, fake, init};
use crate::connect::free_port;
use crate::mcp::{Mcp, mcp_command};
use crate::remote::{LOOPBACK, https, set_remote, wait_listening};
use crate::support::{Client, InProcess, temp_dir};

async fn set_agent_work(client: &mut Client, on: bool) {
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            agent_work: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
}

/// `POST /api/auth/peer` by `key`, as another computer named `Mac`: its status and JSON body.
async fn ask(port: u16, key: &DpopKey) -> (u16, Value) {
    let proof = key.proof(
        "POST",
        &format!("https://127.0.0.1:{port}/api/auth/peer"),
        None,
    );
    let (status, _, body) = https(
        port,
        "POST",
        "/api/auth/peer",
        &[("DPoP", &proof)],
        r#"{"clientLabel":"Mac"}"#,
    )
    .await;
    (status, serde_json::from_slice(&body).unwrap())
}

async fn approve(client: &mut Client, host_id: &str) {
    client
        .call::<AccessMerge>(AccessMergeParams {
            approved_hosts: vec![host_id.to_owned()],
            ..AccessMergeParams::default()
        })
        .await
        .unwrap();
}

fn refused_because(answer: &(u16, Value), why: &str) {
    assert_eq!(answer.0, 403, "{answer:?}");
    let said = answer.1["error_description"].as_str().unwrap_or_default();
    assert!(said.contains(why), "{answer:?}");
}

#[tokio::test]
async fn a_computer_gets_a_session_only_while_agent_work_is_on_and_it_is_approved() {
    let dir = temp_dir();
    let port = free_port();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let key = DpopKey::generate();
    let other = key.thumbprint();
    let sessions = async |client: &mut Client| {
        let listed = client.call::<RemoteSessions>(RemoteSessionsParams {});
        listed.await.unwrap().sessions
    };

    refused_because(&ask(port, &key).await, "off");
    approve(&mut client, &other).await;
    refused_because(&ask(port, &key).await, "off");

    set_agent_work(&mut client, true).await;
    let stranger = DpopKey::generate();
    refused_because(&ask(port, &stranger).await, "hasn't approved");

    let (status, answer) = ask(port, &key).await;
    assert_eq!(status, 200, "{answer}");
    let (status, _) = ask(port, &key).await;
    assert_eq!(status, 200);
    let listed = sessions(&mut client).await;
    assert_eq!(
        listed.len(),
        1,
        "a new session replaces the last: {listed:?}"
    );
    assert_eq!(listed[0].name, "Mac agents");

    // Revoked in Settings, it stays out here until the setting goes off and on.
    let id = listed[0].id.clone();
    client
        .call::<RemoteRevoke>(RemoteRevokeParams { id })
        .await
        .unwrap();
    refused_because(&ask(port, &key).await, "revoked");
    set_agent_work(&mut client, false).await;
    set_agent_work(&mut client, true).await;
    assert_eq!(ask(port, &key).await.0, 200);

    // Off closes what it gave, and a removed key is out for good.
    set_agent_work(&mut client, false).await;
    assert!(sessions(&mut client).await.is_empty());
    set_agent_work(&mut client, true).await;
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: other.clone(),
        })
        .await
        .unwrap();
    refused_because(&ask(port, &key).await, "removed");
    server.stop().await;
}

#[tokio::test]
async fn agent_work_and_the_remote_listener_go_together() {
    let dir = temp_dir();
    let server = InProcess::start(InProcess::config(dir.path()));
    let mut client = Client::ready(&server.socket).await;
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            agent_work: Some(true),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(
        (settings.agent_work, settings.remote),
        (Some(true), Some(true))
    );
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote: Some(false),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(
        (settings.agent_work, settings.remote),
        (Some(false), Some(false))
    );
    let health = client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert!(health.load.is_some_and(|load| load.memory > 0));
}

#[tokio::test]
async fn the_caller_refuses_a_computer_its_own_list_never_approved() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    // Nothing answers here: the refusal has to come before the relay.
    config.relay_url = "http://127.0.0.1:9".to_owned();
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let stranger = DpopKey::generate().thumbprint();
    let call = PeerCallParams {
        computer: stranger.clone(),
        method: "agent/list".to_owned(),
        params: json!({}),
    };
    let refused = client.call::<PeerCall>(call.clone()).await.unwrap_err();
    assert!(refused.message.contains("hasn't approved"), "{refused:?}");

    let own = client.call::<RelayId>(RelayIdParams {}).await.unwrap();
    let refused = client
        .call::<PeerCall>(PeerCallParams {
            computer: own.host_id,
            ..call.clone()
        })
        .await
        .unwrap_err();
    assert!(refused.message.contains("this computer"), "{refused:?}");

    let refused = client
        .call::<PeerCall>(PeerCallParams {
            method: "thread/delete".to_owned(),
            ..call
        })
        .await
        .unwrap_err();
    assert!(refused.message.contains("isn't forwarded"), "{refused:?}");
}

#[tokio::test]
async fn peer_methods_are_only_for_the_local_socket() {
    let dir = temp_dir();
    let port = free_port();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_agent_work(&mut client, true).await;
    wait_listening(port, true).await;
    let key = DpopKey::generate();
    approve(&mut client, &key.thumbprint()).await;
    let (status, answer) = ask(port, &key).await;
    assert_eq!(status, 200, "{answer}");
    let token = answer["accessToken"].as_str().unwrap().to_owned();

    let host_id = client
        .call::<RelayId>(RelayIdParams {})
        .await
        .unwrap()
        .host_id;
    let tcp = tokio::net::TcpStream::connect((LOOPBACK, port))
        .await
        .unwrap();
    let socket = remote::peer_socket(Box::new(tcp), &host_id, &token, &key)
        .await
        .unwrap();
    let mut app = crate::remote::App::bridged(socket);
    assert!(app.initialize().await["result"].is_object());
    app.send(r#"{"jsonrpc":"2.0","id":2,"method":"peer/computers","params":{}}"#)
        .await;
    let answer = app.next().await;
    assert!(answer.contains("only for this computer"), "{answer}");
    drop(app);
    server.stop().await;
}

#[tokio::test]
async fn a_tool_that_asks_for_less_approval_than_its_caller_is_refused() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), end_turn("Done.")]));
    let mut client = host.client().await;
    let repos = temp_dir();
    let repo = client.add(&crate::agents::real_repo(repos.path())).await;
    // With no mode, it runs in Edit.
    let started = crate::threads::start_params(Some(repo.id), "Plan the work.");
    let run = client
        .call::<parallax_protocol::methods::ThreadStart>(started)
        .await
        .unwrap()
        .run
        .id;
    let mut mcp = Mcp::spawn(mcp_command(
        host.dir.path(),
        &["--thread", &run.to_string()],
    ))
    .await;
    let computer = DpopKey::generate().thumbprint();
    for (tool, arguments) in [
        (
            "thread_launch",
            json!({"prompt": "Go.", "computer": computer, "mode": "bypass"}),
        ),
        (
            "delegate_task",
            json!({"task": "Go.", "target": {"computer": computer}, "runtimeMode": "auto"}),
        ),
    ] {
        let (text, is_error) = mcp.tool(tool, arguments).await;
        assert!(is_error && text.contains("needs less approval"), "{text}");
    }
}
