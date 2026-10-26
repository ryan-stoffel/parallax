//! Permission requests end to end (PLX-222, decision 0031): `agent/approve` against an in-process
//! plxd whose backend is the fake CLI, which asks and prints the answer it gets as JSON.

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{AgentApprove, AgentEvents, AgentStart};
use parallax_protocol::{
    AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision, AgentApproveParams,
    AgentApproveResult, AgentEventsParams, AgentOutputItem, AgentStartParams, AgentStatus,
    ApprovalId, ErrorKind, EventsEventParams, ParallaxEvent, RunId,
};
use plxd::backend::fake::{AskedApproval, Step};
use serde_json::{Value, json};

use crate::agents::{Conn, Host, end_turn, fake, init, items, start_params, until, updated_to};
use crate::support::{InProcess, kind, temp_dir};

/// A host whose runs play `steps`.
fn host(steps: Vec<Step>) -> Host {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(steps));
    let server = InProcess::start(config);
    Host { dir, server }
}

/// A request to run the tests, which offers to always allow them.
fn bash() -> AskedApproval {
    AskedApproval {
        tool_name: "Bash".to_owned(),
        input: json!({"command": "pnpm test"}),
        call_id: Some("toolu_1".to_owned()),
        reason: None,
        always_allow: vec!["Bash(pnpm test:*)".to_owned()],
        interactive: false,
    }
}

/// A request to edit a file, which offers nothing to always allow.
fn edit() -> AskedApproval {
    AskedApproval {
        tool_name: "Edit".to_owned(),
        input: json!({"file_path": "README.md"}),
        call_id: None,
        reason: Some("Claude requested permissions to edit a sensitive file.".to_owned()),
        always_allow: Vec::new(),
        interactive: false,
    }
}

/// A script that asks `asked`, prints the answer it gets, and ends its turn.
fn asking(asked: AskedApproval) -> Vec<Step> {
    vec![
        init("approval-1"),
        Step::RequestApproval(asked),
        Step::AwaitApproval,
        end_turn("Done."),
    ]
}

/// Starts a worker on `host`'s script in a new project, with a client subscribed to its events,
/// answering its permission requests when `approvals`.
async fn start_run(host: &Host, approvals: bool) -> (Conn, RunId) {
    let (mut client, project) = host.project_client().await;
    let params = AgentStartParams {
        approvals,
        ..start_params(project.id, "Run the tests")
    };
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    (client, run_id)
}

/// [`start_run`] for a client that answers permission requests.
async fn start_worker(host: &Host) -> (Conn, RunId) {
    start_run(host, true).await
}

/// [`start_worker`], once its permission request is logged.
async fn start(host: &Host) -> (Conn, RunId, ApprovalId) {
    let (mut client, run_id) = start_worker(host).await;
    let events = until(&mut client, |event| !requested(event).is_empty()).await;
    let approval_id = events.iter().flat_map(requested).next().unwrap();
    (client, run_id, approval_id)
}

/// The permission requests an event logs.
fn requested(event: &EventsEventParams) -> Vec<ApprovalId> {
    let ParallaxEvent::AgentOutput { items, .. } = &event.event else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            AgentOutputItem::ApprovalRequested { approval_id, .. } => Some(*approval_id),
            _ => None,
        })
        .collect()
}

/// The `approvalResolved` items of `events`, in order.
fn resolutions(events: &[EventsEventParams]) -> Vec<AgentOutputItem> {
    items(events)
        .into_iter()
        .filter(|item| matches!(item, AgentOutputItem::ApprovalResolved { .. }))
        .collect()
}

fn resolved(
    approval_id: ApprovalId,
    decision: AgentApprovalDecision,
    by: AgentApprovalBy,
) -> AgentOutputItem {
    AgentOutputItem::ApprovalResolved {
        approval_id,
        decision,
        by,
        always: false,
        message: None,
    }
}

fn result(decision: AgentApprovalDecision, by: AgentApprovalBy) -> AgentApproveResult {
    AgentApproveResult {
        decision,
        by,
        always: false,
        message: None,
    }
}

fn answer(
    run_id: RunId,
    approval_id: ApprovalId,
    decision: AgentApprovalAnswer,
) -> AgentApproveParams {
    AgentApproveParams {
        run_id,
        approval_id,
        decision,
        input: None,
        always: false,
        message: None,
    }
}

/// The answers the fake CLI printed.
fn printed(events: &[EventsEventParams]) -> Vec<Value> {
    items(events)
        .into_iter()
        .filter_map(|item| match item {
            AgentOutputItem::Text { text, .. } => serde_json::from_str(&text).ok(),
            _ => None,
        })
        .collect()
}

/// The run's whole log, as a reopened chat reads it.
async fn logged(client: &mut Conn, run_id: RunId) -> Vec<AgentOutputItem> {
    let page = client
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
            run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap();
    page.events
        .into_iter()
        .filter_map(|event| match event.event {
            ParallaxEvent::AgentOutput { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn a_denied_request_tells_the_agent_why() {
    let host = host(asking(edit()));
    let (mut client, run_id, approval_id) = start(&host).await;
    let invalid = [
        AgentApproveParams {
            always: true,
            ..answer(run_id, approval_id, AgentApprovalAnswer::Allow)
        },
        AgentApproveParams {
            message: Some("No.".to_owned()),
            ..answer(run_id, approval_id, AgentApprovalAnswer::Allow)
        },
        AgentApproveParams {
            input: Some(json!(["not", "an", "object"])),
            ..answer(run_id, approval_id, AgentApprovalAnswer::Allow)
        },
        AgentApproveParams {
            input: Some(json!({"file_path": "README.md"})),
            ..answer(run_id, approval_id, AgentApprovalAnswer::Deny)
        },
        answer(run_id, approval_id, AgentApprovalAnswer::Unknown),
    ];
    for params in invalid {
        let error = client
            .call::<AgentApprove>(params.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{params:?}");
    }
    let missing = answer(run_id, ApprovalId::generate(), AgentApprovalAnswer::Deny);
    let error = client.call::<AgentApprove>(missing).await.unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ApprovalNotFound);

    let message = "Leave the settings alone.";
    let deny = AgentApproveParams {
        message: Some(message.to_owned()),
        ..answer(run_id, approval_id, AgentApprovalAnswer::Deny)
    };
    let denied = AgentApproveResult {
        message: Some(message.to_owned()),
        ..result(AgentApprovalDecision::Denied, AgentApprovalBy::User)
    };
    assert_eq!(client.call::<AgentApprove>(deny).await.unwrap(), denied);
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        printed(&events),
        [json!({
            "approvalId": approval_id,
            "decision": "deny",
            "message": message,
            "interrupt": false,
        })]
    );
    assert_eq!(
        resolutions(&events),
        [AgentOutputItem::ApprovalResolved {
            approval_id,
            decision: AgentApprovalDecision::Denied,
            by: AgentApprovalBy::User,
            always: false,
            message: Some(message.to_owned()),
        }]
    );
}

#[tokio::test]
async fn stopping_plxd_denies_what_waits() {
    let script = vec![
        init("approval-1"),
        Step::RequestApproval(bash()),
        Step::Hang,
    ];
    let host = host(script);
    let (client, run_id, approval_id) = start(&host).await;
    drop(client);
    let host = host.restart(fake(Vec::new())).await;
    let mut client = host.client().await;
    let after = logged(&mut client, run_id).await;
    assert!(
        after.contains(&resolved(
            approval_id,
            AgentApprovalDecision::Denied,
            AgentApprovalBy::Stop
        )),
        "{after:?}"
    );
    let late = answer(run_id, approval_id, AgentApprovalAnswer::Allow);
    let error = client.call::<AgentApprove>(late).await.unwrap_err();
    assert_eq!(
        kind(&error),
        ErrorKind::ApprovalNotFound,
        "a new plxd has no CLI to answer"
    );
}

/// Computer use (PLX-897): `computer/ask` logs a request plxd answers itself and answers
/// `pending` while it waits, asking again keeps waiting on the same card, Always allow saves the
/// app for every thread even with no asker waiting, and `computer/forget` makes it ask again.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn computer_use_asks_in_the_transcript_and_remembers_always() {
    use parallax_protocol::methods::{ComputerAsk, ComputerForget};
    use parallax_protocol::{ComputerAnswer, ComputerAskParams, ComputerForgetParams};

    let host = host(vec![
        init("computer-1"),
        Step::AwaitFollowUp,
        end_turn("Done."),
    ]);
    let (mut client, run_id) = start_worker(&host).await;
    let ask = move |app: &str, wait_ms| ComputerAskParams {
        run_id,
        app: app.to_owned(),
        wait_ms,
    };
    let mut second = host.client().await;
    let status = |answer: parallax_protocol::ComputerAskResult| answer.status;

    // Nobody answers within the wait, and asking again doesn't ask the user twice.
    let first = second.call::<ComputerAsk>(ask("Notes", 50)).await.unwrap();
    assert_eq!(status(first), ComputerAnswer::Pending);
    let again = second.call::<ComputerAsk>(ask("notes", 50)).await.unwrap();
    assert_eq!(status(again), ComputerAnswer::Pending);
    let events = until(&mut client, |event| !requested(event).is_empty()).await;
    let asked: Vec<AgentOutputItem> = logged(&mut client, run_id)
        .await
        .into_iter()
        .filter(|item| matches!(item, AgentOutputItem::ApprovalRequested { .. }))
        .collect();
    let [
        AgentOutputItem::ApprovalRequested {
            approval_id,
            tool_name,
            input,
            always_allow,
            ..
        },
    ] = &asked[..]
    else {
        panic!("one request, not {asked:?}");
    };
    assert_eq!(events.iter().flat_map(requested).next(), Some(*approval_id));
    assert_eq!(tool_name, "computer_use");
    assert_eq!(input, &json!({"app": "Notes"}));
    assert_eq!(always_allow, &["Notes"]);

    // Answered while no call waits: Always allow still saves it, for every thread.
    let always = AgentApproveParams {
        always: true,
        ..answer(run_id, *approval_id, AgentApprovalAnswer::Allow)
    };
    client.call::<AgentApprove>(always).await.unwrap();
    let later = second.call::<ComputerAsk>(ask("Notes", 50)).await.unwrap();
    assert_eq!(status(later), ComputerAnswer::Always);
    let forgot = client
        .call::<ComputerForget>(ComputerForgetParams {
            app: "Notes".to_owned(),
        })
        .await
        .unwrap();
    assert!(forgot.apps.is_empty());

    // Once forgotten it asks again. A denial between two rounds reaches the next one.
    let asked = second.call::<ComputerAsk>(ask("Notes", 50)).await.unwrap();
    assert_eq!(status(asked), ComputerAnswer::Pending);
    let events = until(&mut client, |event| !requested(event).is_empty()).await;
    let approval_id = events.iter().flat_map(requested).next().unwrap();
    let deny = answer(run_id, approval_id, AgentApprovalAnswer::Deny);
    client.call::<AgentApprove>(deny).await.unwrap();
    let next = second.call::<ComputerAsk>(ask("Notes", 50)).await.unwrap();
    assert_eq!(status(next), ComputerAnswer::Denied);

    // And a call waiting when the user answers gets it at once.
    let asking = tokio::spawn(async move { second.call::<ComputerAsk>(ask("Mail", 50_000)).await });
    let events = until(&mut client, |event| !requested(event).is_empty()).await;
    let approval_id = events.iter().flat_map(requested).next().unwrap();
    let allow = answer(run_id, approval_id, AgentApprovalAnswer::Allow);
    client.call::<AgentApprove>(allow).await.unwrap();
    assert_eq!(
        status(asking.await.unwrap().unwrap()),
        ComputerAnswer::Allowed
    );
}
