//! 0093's old names, for one release: an app or phone from before it declares no `projects`
//! capability, calls `project/*` and `coordinator/*`, and gets the old names back in results,
//! events, and errors.

use parallax_protocol::jsonrpc::Message;
use parallax_protocol::methods::Initialize;
use parallax_protocol::{Capabilities, ProtocolRange};
use serde_json::{Value, json};

use crate::support::{Client, Plxd, create_params, initialize_params, temp_dir};

/// A client from before 0093, initialized.
async fn old_client(plxd: &Plxd) -> (Client, Value) {
    let mut client = Client::connect(&plxd.socket).await;
    let mut params = initialize_params(ProtocolRange::SUPPORTED);
    params.capabilities = Capabilities::default();
    let result = client.call::<Initialize>(params).await.expect("initialize");
    (client, serde_json::to_value(result.capabilities).unwrap())
}

/// Sends request `id` and returns its answer, and any events that came before it.
async fn call(client: &mut Client, id: i64, method: &str, params: Value) -> (Value, Vec<Value>) {
    client
        .send_message(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
        .await;
    let mut events = Vec::new();
    loop {
        match client.next().await.expect("a message") {
            Message::Response(response) => {
                let answer = match response.result {
                    Ok(result) => result,
                    Err(error) => json!({"error": error.data, "code": error.code}),
                };
                return (answer, events);
            }
            Message::Notification(event) => events.push(event.params.unwrap_or_default()),
            Message::Request(request) => panic!("plxd sent a request: {request:?}"),
        }
    }
}

/// The next event, after any already received.
async fn next_event(client: &mut Client, received: &mut Vec<Value>) -> Value {
    if !received.is_empty() {
        return received.remove(0);
    }
    match client.next().await.expect("an event") {
        Message::Notification(event) => event.params.unwrap_or_default(),
        other => panic!("expected an event, got {other:?}"),
    }
}

#[tokio::test]
async fn an_app_from_before_0093_keeps_its_names() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let (mut client, capabilities) = old_client(&plxd).await;
    for name in [
        "coordinator",
        "orchestrator",
        "projectEdit",
        "orchestratorEdit",
    ] {
        assert!(capabilities.get(name).is_some(), "advertises {name}");
    }

    call(&mut client, 1, "events/subscribe", json!({"after": 0})).await;
    let params = serde_json::to_value(create_params(dir.path(), "formula fly")).unwrap();
    let id = params["id"].clone();
    let (created, mut events) = call(&mut client, 2, "project/create", params).await;
    assert_eq!(created["project"]["name"], "formula fly");
    assert!(created.get("orchestrator").is_none(), "{created}");
    let event = next_event(&mut client, &mut events).await;
    assert_eq!(event["event"]["kind"], "project.created");
    assert_eq!(event["event"]["project"]["id"], id);

    let (listed, _) = call(&mut client, 3, "project/list", json!({})).await;
    assert_eq!(listed["projects"][0]["id"], id, "{listed}");

    let rename = json!({"project": id, "name": "renamed"});
    let (updated, _) = call(&mut client, 4, "project/update", rename).await;
    assert_eq!(updated["project"]["name"], "renamed");

    let unknown = json!({"project": "01a0f755-f200-74dd-8cfc-06d0b225c5ea"});
    let (missing, _) = call(&mut client, 5, "project/delete", unknown).await;
    assert_eq!(missing["error"]["kind"], "projectNotFound");

    // Its Space is a Project now, in its old names.
    let space = json!({"id": "01a0f755-f200-74dd-8cfc-06d0b225c5eb", "name": "Coursework"});
    let (made, mut events) = call(&mut client, 6, "space/create", space).await;
    assert_eq!(made["repo"]["space"], true, "{made}");
    assert!(made["repo"].get("project").is_none(), "{made}");
    let added = next_event(&mut client, &mut events).await;
    assert_eq!(added["event"]["kind"], "repo.added");
    assert_eq!(added["event"]["repo"]["space"], true);
}

#[tokio::test]
async fn an_app_from_0093_on_gets_the_new_names() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let params = serde_json::to_value(create_params(dir.path(), "formula fly")).unwrap();
    let (created, _) = call(&mut client, 1, "orchestrator/create", params).await;
    assert_eq!(created["orchestrator"]["name"], "formula fly");
    let (listed, _) = call(&mut client, 2, "orchestrator/list", json!({})).await;
    assert_eq!(listed["orchestrators"].as_array().map(Vec::len), Some(1));
    // To it, `project/*` is a Project's (once a Space), never an orchestrator's.
    let (old, _) = call(&mut client, 3, "project/list", json!({})).await;
    assert_eq!(old["code"], -32601, "{old}");
    let project = json!({"id": "01a0f755-f200-74dd-8cfc-06d0b225c5eb", "name": "Coursework"});
    let (made, _) = call(&mut client, 4, "project/create", project).await;
    assert_eq!(made["repo"]["project"], true, "{made}");
    let (spaced, _) = call(
        &mut client,
        5,
        "space/create",
        json!({"id": made["repo"]["id"], "name": "Coursework"}),
    )
    .await;
    assert_eq!(
        spaced["repo"]["project"], true,
        "space/create still works: {spaced}"
    );
}
