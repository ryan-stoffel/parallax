//! Linked pull requests end to end (PLX-318): an agent's `gh pr create` links what it prints,
//! the link survives a restart, and `pr/view` and `pr/act` reach only a linked one, through
//! `open_pr`'s fake `gh`.

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{AgentList, AgentStart, PrAct, PrView};
use parallax_protocol::{
    AgentListParams, AgentStatus, ErrorKind, ParallaxEvent, PrActParams, PrAction, PrState,
    PrViewParams, RunId,
};
use plxd::backend::fake::Step;
use plxd::backend::{Event, ToolStatus};
use serde_json::json;

use crate::agents::{
    Conn, create, end_turn, fake, init, project_params, start_params, subscribe, until, updated_to,
};
use crate::open_pr::{Tools, start};
use crate::support::{kind, temp_dir};

const FIRST: &str = "https://github.com/me/app/pull/1";
const SECOND: &str = "https://github.com/me/app/pull/2";

/// A tool call and its result, as the fake CLI prints them.
fn tool(call_id: &str, name: &str, input: serde_json::Value, output: &str) -> [Step; 2] {
    [
        Step::Emit(Event::ToolCall {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            input,
        }),
        Step::Emit(Event::ToolResult {
            call_id: call_id.to_owned(),
            status: ToolStatus::Ok,
            output: Some(output.to_owned()),
        }),
    ]
}

/// The first run's linked pull requests, from `agent/list`.
async fn linked(client: &mut Conn) -> Vec<String> {
    client
        .call::<AgentList>(AgentListParams::default())
        .await
        .unwrap()
        .runs
        .remove(0)
        .pull_requests
}

fn view(run_id: RunId, url: &str) -> PrViewParams {
    PrViewParams {
        run_id,
        url: url.to_owned(),
    }
}

/// A turn that opens pull requests the way each backend reports a shell command.
fn opening() -> Vec<Step> {
    let mut steps = vec![init("s")];
    // Claude's Bash.
    steps.extend(tool(
        "c1",
        "Bash",
        json!({"command": "gh pr create --title \"Add a README\" --body \"Done.\""}),
        &format!("{FIRST}\n"),
    ));
    // Codex's command, through a shell.
    steps.extend(tool(
        "c2",
        "command_execution",
        json!({"command": "/bin/zsh -lc 'gh pr create --fill'", "cwd": "/src/app"}),
        &format!("Creating pull request for parallax/x into main in me/app\n\n{SECOND}\n"),
    ));
    // Cursor's shell, opening the same one again.
    steps.extend(tool(
        "c3",
        "Bash",
        json!({"command": "gh pr create --fill"}),
        &format!("a pull request for branch \"x\" into branch \"main\" already exists:\n{FIRST}"),
    ));
    // Another command that prints a pull request doesn't link it.
    steps.extend(tool(
        "c4",
        "Bash",
        json!({"command": "gh pr view 3 --json=url"}),
        "https://github.com/me/app/pull/3",
    ));
    steps.push(end_turn("Opened it."));
    steps
}

#[tokio::test]
async fn an_agent_s_gh_pr_create_links_its_pull_request_and_only_that_one_is_viewed() {
    let tools = Tools::new();
    let dir = temp_dir();
    let params = project_params(dir.path());
    let host = start(dir, opening(), &tools);
    let mut client = host.client().await;
    let project = create(&mut client, params).await;
    subscribe(&mut client, project.id, 0).await;
    let start = start_params(project.id, "Open a pull request");
    let run_id = start.run_id;
    client.call::<AgentStart>(start).await.unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert!(
        events.iter().any(|event| matches!(&event.event,
            ParallaxEvent::AgentUpdated { state, .. } if state.pull_requests == [FIRST])),
        "linking appends agent.updated"
    );
    assert_eq!(linked(&mut client).await, [FIRST, SECOND]);

    tools.view(
        &json!({
            "number": 1, "title": "Add a README", "url": FIRST, "state": "OPEN",
            "isDraft": false, "author": {"login": "me"}, "updatedAt": "2026-10-02T12:00:00Z",
            "baseRefName": "main", "headRefName": "parallax/x", "changedFiles": 1,
            "additions": 3, "deletions": 0, "body": "", "comments": [], "reviews": [],
            "reviewRequests": [], "labels": [], "statusCheckRollup": [],
            "mergeStateStatus": "CLEAN", "autoMergeRequest": null
        })
        .to_string(),
    );
    let viewed = client.call::<PrView>(view(run_id, FIRST)).await.unwrap();
    assert_eq!((viewed.number, viewed.repo.as_str()), (1, "me/app"));
    assert_eq!(viewed.state, PrState::Open);

    // A URL the run never linked never reaches gh.
    let before = tools.log().len();
    let refused = client
        .call::<PrView>(view(run_id, "https://github.com/me/app/pull/3"))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    let refused = client
        .call::<PrAct>(PrActParams {
            run_id,
            url: "--help".to_owned(),
            action: PrAction::Close,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    assert_eq!(tools.log().len(), before);

    for action in [
        PrAction::Merge,
        PrAction::Squash,
        PrAction::AutoMerge,
        PrAction::DisableAutoMerge,
        PrAction::Draft,
        PrAction::Ready,
        PrAction::Close,
    ] {
        let acted = client
            .call::<PrAct>(PrActParams {
                run_id,
                url: SECOND.to_owned(),
                action,
            })
            .await
            .unwrap();
        assert_eq!(acted.number, 1, "the fresh view gh printed");
    }
    let acts: Vec<String> = tools
        .log()
        .into_iter()
        .skip(before)
        .filter(|line| !line.starts_with("pr view"))
        .collect();
    assert_eq!(
        acts,
        [
            format!("pr merge {SECOND} --merge"),
            format!("pr merge {SECOND} --squash"),
            format!("pr merge {SECOND} --auto --merge"),
            format!("pr merge {SECOND} --disable-auto"),
            format!("pr ready {SECOND} --undo"),
            format!("pr ready {SECOND}"),
            format!("pr close {SECOND}"),
        ]
    );

    tools.mode("signed-out");
    let error = client
        .call::<PrView>(view(run_id, FIRST))
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::GhUnavailable);

    // The links outlive plxd.
    let host = host.restart(fake(Vec::new())).await;
    let mut client = host.client().await;
    assert_eq!(linked(&mut client).await, [FIRST, SECOND]);
    host.server.stop().await;
}
