//! Permission requests end to end (RYA-222, decision 0031): `agent/approve` against an in-process
//! wispd whose backend is the fake CLI, which asks and prints the answer it gets as JSON.

use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use serde_json::{Value, json};
use wisp_protocol::jsonrpc::INVALID_PARAMS;
use wisp_protocol::methods::{AgentApprove, AgentCancel, AgentEvents, AgentStart, ProjectStart};
use wisp_protocol::{
    AccountChoice, AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision, AgentApproveParams,
    AgentApproveResult, AgentCancelParams, AgentEventsParams, AgentOutcome, AgentOutputItem,
    AgentStatus, ApprovalId, ErrorKind, EventsEventParams, ProjectStartParams, RunId, WispEvent,
};
use wispd::backend::fake::{AskedApproval, Step};

use crate::agents::{
    Conn, Host, create, end_turn, fake, init, items, outcomes, project_params, start_params,
    subscribe, until, updated_to,
};
use crate::support::{InProcess, kind, temp_dir};

/// Long enough that no request expires during a test that doesn't wait for it.
const NEVER: Duration = Duration::from_secs(600);

/// A host whose runs play `steps`, and whose permission requests expire after `timeout`.
fn host(steps: Vec<Step>, timeout: Duration) -> Host {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(steps));
    config.approval_timeout = timeout;
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

/// Starts a worker on `host`'s script in a new project, with a client subscribed to its events.
async fn start_worker(host: &Host) -> (Conn, RunId) {
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Run the tests");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    (client, run_id)
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
    let WispEvent::AgentOutput { items, .. } = &event.event else {
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
            run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap();
    page.events
        .into_iter()
        .filter_map(|event| match event.event {
            WispEvent::AgentOutput { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn an_allowed_request_reaches_the_cli_and_its_answer_is_logged_once() {
    let host = host(asking(bash()), NEVER);
    let (mut client, run_id, approval_id) = start(&host).await;
    let asked = logged(&mut client, run_id)
        .await
        .into_iter()
        .find(|item| matches!(item, AgentOutputItem::ApprovalRequested { .. }))
        .unwrap();
    let AgentOutputItem::ApprovalRequested {
        tool_name,
        input,
        call_id,
        always_allow,
        interactive,
        expires_at,
        ..
    } = asked
    else {
        unreachable!();
    };
    assert_eq!(tool_name, "Bash");
    assert_eq!(input, json!({"command": "pnpm test"}));
    assert_eq!(call_id.as_deref(), Some("toolu_1"));
    assert_eq!(always_allow, ["Bash(pnpm test:*)"]);
    assert!(!interactive);
    let left = expires_at.duration_since(Timestamp::now());
    assert!(
        left > SignedDuration::from_secs(500) && left <= SignedDuration::from_secs(600),
        "{left:?}"
    );

    let allow = AgentApproveParams {
        always: true,
        ..answer(run_id, approval_id, AgentApprovalAnswer::Allow)
    };
    let allowed = AgentApproveResult {
        always: true,
        ..result(AgentApprovalDecision::Allowed, AgentApprovalBy::User)
    };
    assert_eq!(
        client.call::<AgentApprove>(allow.clone()).await.unwrap(),
        allowed
    );
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        printed(&events),
        [json!({"approvalId": approval_id, "decision": "allow", "always": true})]
    );
    assert_eq!(
        resolutions(&events),
        [AgentOutputItem::ApprovalResolved {
            approval_id,
            decision: AgentApprovalDecision::Allowed,
            by: AgentApprovalBy::User,
            always: true,
            message: None,
        }]
    );
    // A retry, or a change of mind, gets how it ended.
    assert_eq!(client.call::<AgentApprove>(allow).await.unwrap(), allowed);
    let deny = answer(run_id, approval_id, AgentApprovalAnswer::Deny);
    assert_eq!(client.call::<AgentApprove>(deny).await.unwrap(), allowed);
}

#[tokio::test]
async fn a_denied_request_tells_the_agent_why() {
    let host = host(asking(edit()), NEVER);
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
async fn an_edited_input_replaces_the_one_asked_with() {
    let host = host(asking(bash()), NEVER);
    let (mut client, run_id, approval_id) = start(&host).await;
    let edited = json!({"command": "pnpm test parser"});
    let allow = AgentApproveParams {
        input: Some(edited.clone()),
        ..answer(run_id, approval_id, AgentApprovalAnswer::Allow)
    };
    client.call::<AgentApprove>(allow).await.unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        printed(&events),
        [json!({"approvalId": approval_id, "decision": "allow", "input": edited})]
    );
}

#[tokio::test]
async fn a_request_nobody_answers_expires_and_the_agent_is_told() {
    let host = host(asking(bash()), Duration::from_millis(300));
    let (mut client, run_id, approval_id) = start(&host).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        resolutions(&events),
        [resolved(
            approval_id,
            AgentApprovalDecision::Expired,
            AgentApprovalBy::Timeout
        )]
    );
    let printed = printed(&events);
    assert_eq!(printed.len(), 1, "{printed:?}");
    assert_eq!(printed[0]["decision"], "deny");
    assert_eq!(printed[0]["interrupt"], false);
    assert!(
        printed[0]["message"].as_str().unwrap().contains("in time"),
        "{printed:?}"
    );
    let late = answer(run_id, approval_id, AgentApprovalAnswer::Allow);
    assert_eq!(
        client.call::<AgentApprove>(late).await.unwrap(),
        result(AgentApprovalDecision::Expired, AgentApprovalBy::Timeout)
    );
}

#[tokio::test]
async fn cancelling_the_run_denies_what_waits() {
    let script = vec![
        init("approval-1"),
        Step::RequestApproval(bash()),
        Step::Hang,
    ];
    let host = host(script, NEVER);
    let (mut client, run_id, approval_id) = start(&host).await;
    client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Cancelled)).await;
    assert_eq!(
        resolutions(&events),
        [resolved(
            approval_id,
            AgentApprovalDecision::Denied,
            AgentApprovalBy::Cancel
        )]
    );
    assert_eq!(outcomes(&events), [AgentOutcome::Cancelled]);
}

#[tokio::test]
async fn a_reopened_chat_finds_a_pending_request_and_then_its_answer() {
    let host = host(asking(bash()), NEVER);
    let (mut client, run_id, approval_id) = start(&host).await;
    let mut reopened = host.client().await;
    let before = logged(&mut reopened, run_id).await;
    assert!(before.iter().any(|item| matches!(
        item,
        AgentOutputItem::ApprovalRequested { approval_id: id, .. } if *id == approval_id
    )));
    assert!(
        !before
            .iter()
            .any(|item| matches!(item, AgentOutputItem::ApprovalResolved { .. })),
        "{before:?}"
    );
    let allow = answer(run_id, approval_id, AgentApprovalAnswer::Allow);
    reopened.call::<AgentApprove>(allow).await.unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let after = logged(&mut reopened, run_id).await;
    let resolved_items: Vec<&AgentOutputItem> = after
        .iter()
        .filter(|item| matches!(item, AgentOutputItem::ApprovalResolved { .. }))
        .collect();
    assert_eq!(
        resolved_items,
        [&resolved(
            approval_id,
            AgentApprovalDecision::Allowed,
            AgentApprovalBy::User
        )]
    );
}

#[tokio::test]
async fn a_request_the_cli_withdraws_or_leaves_behind_is_withdrawn() {
    let script = vec![
        init("approval-1"),
        Step::RequestApproval(bash()),
        Step::WithdrawApproval,
        Step::RequestApproval(edit()),
        end_turn("Done."),
    ];
    let host = host(script, NEVER);
    let (mut client, run_id) = start_worker(&host).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    let asked: Vec<ApprovalId> = events.iter().flat_map(requested).collect();
    let [first, second] = asked[..] else {
        panic!("expected two requests in {events:#?}");
    };
    assert_eq!(
        resolutions(&events),
        [
            resolved(
                first,
                AgentApprovalDecision::Withdrawn,
                AgentApprovalBy::Agent
            ),
            resolved(
                second,
                AgentApprovalDecision::Withdrawn,
                AgentApprovalBy::Agent
            ),
        ]
    );
    let late = answer(run_id, second, AgentApprovalAnswer::Allow);
    assert_eq!(
        client.call::<AgentApprove>(late).await.unwrap(),
        result(AgentApprovalDecision::Withdrawn, AgentApprovalBy::Agent)
    );
}

#[tokio::test]
async fn stopping_wispd_denies_what_waits() {
    let script = vec![
        init("approval-1"),
        Step::RequestApproval(bash()),
        Step::Hang,
    ];
    let host = host(script, NEVER);
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
        "a new wispd has no CLI to answer"
    );
}

/// A coordinator asks the same way (0024), here with `ExitPlanMode`'s plan.
#[tokio::test]
async fn a_coordinator_asks_too() {
    let plan = AskedApproval {
        tool_name: "ExitPlanMode".to_owned(),
        input: json!({"plan": "1. Add a README."}),
        call_id: None,
        reason: None,
        always_allow: Vec::new(),
        interactive: true,
    };
    let host = host(asking(plan), NEVER);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = ProjectStartParams {
        project: project.id,
        run_id: RunId::generate(),
        prompt: "Plan the README.".to_owned(),
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        model: None,
        effort: None,
        permission: None,
        images: Vec::new(),
    };
    let run_id = params.run_id;
    client.call::<ProjectStart>(params).await.unwrap();
    let events = until(&mut client, |event| !requested(event).is_empty()).await;
    let approval_id = events.iter().flat_map(requested).next().unwrap();
    assert!(items(&events).iter().any(|item| matches!(
        item,
        AgentOutputItem::ApprovalRequested {
            interactive: true,
            ..
        }
    )));
    let allow = answer(run_id, approval_id, AgentApprovalAnswer::Allow);
    client.call::<AgentApprove>(allow).await.unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        printed(&events),
        [json!({"approvalId": approval_id, "decision": "allow"})]
    );
}
