//! Linked pull requests end to end (PLX-318): an agent's `gh pr create` links what it prints,
//! the link survives a restart, `pr/view`, `pr/diff` (PLX-328), and `pr/act` reach only a
//! linked one, `pr/view` serves the shared GraphQL read and `pr/act` sends each action through
//! the paced queue (PLX-1151), and a merge through `pr/act` archives its thread (PLX-839),
//! through `open_pr`'s fake `gh`.

use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{
    AgentList, AgentStart, PrAct, PrDiff, PrView, ThreadList, ThreadStart,
};
use parallax_protocol::{
    AgentListParams, AgentStatus, ErrorKind, ParallaxEvent, PrActParams, PrAction, PrMergeMethod,
    PrState, PrViewParams, RunId, ThreadListParams,
};
use plxd::backend::fake::Step;
use plxd::backend::{Event, ToolStatus};
use serde_json::json;

use crate::agents::{
    Conn, create, end_turn, fake, init, orchestrator_params, real_repo, scope, start_params,
    subscribe, until, updated_to,
};
use crate::open_pr::{Tools, start, thread};
use crate::support::{kind, temp_dir};

const FIRST: &str = "https://github.com/me/app/pull/1";
const SECOND: &str = "https://github.com/me/app/pull/2";
const SUBAGENT_S: &str = "https://github.com/me/app/pull/4";

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
            images: Vec::new(),
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

/// GitHub's answer to plxd's pull request read for pull request 1, in `state`, with a required
/// failing Actions job and an open review thread.
fn answer(state: &str) -> String {
    let merged_at = jiff::Timestamp::now();
    r#"{"data": {
      "viewer": {"login": "me"},
      "repository": {
        "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": true,
        "pullRequest": {
          "number": 1, "url": "https://github.com/me/app/pull/1", "title": "Add a README",
          "body": "", "state": "STATE", "isDraft": false, "updatedAt": "2026-10-02T12:00:00Z",
          "mergedAt": "MERGED_AT", "author": {"login": "me", "avatarUrl": "https://avatars/me"},
          "baseRefName": "main", "headRefName": "parallax/x", "headRefOid": "abc123",
          "headRepository": {"nameWithOwner": "me/app"},
          "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED",
          "reviewDecision": "REVIEW_REQUIRED", "changedFiles": 1, "additions": 3, "deletions": 0,
          "commits": {"nodes": [{"commit": {
            "checkSuites": {"pageInfo": {"hasNextPage": false}, "nodes": []},
            "statusCheckRollup": {"contexts": {"nodes": [
              {"__typename": "CheckRun", "name": "test", "status": "COMPLETED",
               "conclusion": "FAILURE", "detailsUrl": "https://ci/7", "databaseId": 7,
               "isRequired": true, "checkSuite": {"workflowRun": {"databaseId": 70}}}
            ]}}
          }}]},
          "comments": {"nodes": []},
          "reviews": {"nodes": []},
          "reviewThreads": {"nodes": [{
            "id": "th1", "path": "README.md", "line": 2, "isOutdated": false,
            "isResolved": false, "comments": {"nodes": [{
              "id": "t1", "author": {"login": "rev"}, "body": "Typo",
              "createdAt": "2026-10-02T12:01:00Z", "url": "https://gh/t1",
              "diffHunk": "@@ -1 +1,2 @@"
            }]}
          }]}
        }
      }
    }}"#
    .replace("STATE", state)
    .replace("MERGED_AT", &merged_at.to_string())
}

fn view(run_id: RunId, url: &str) -> PrViewParams {
    PrViewParams {
        run_id,
        url: url.to_owned(),
    }
}

fn act(run_id: RunId, url: &str, action: PrAction) -> PrActParams {
    PrActParams {
        run_id,
        url: url.to_owned(),
        action,
        method: None,
        delete_branch: false,
        head_sha: None,
        workflow_run_id: None,
        job_id: None,
    }
}

/// `pr/view`, `pr/diff`, and `pr/act` each refuse a URL run `run_id` never linked.
async fn refuses_unlinked(client: &mut Conn, run_id: RunId) {
    let refused = client
        .call::<PrView>(view(run_id, "https://github.com/me/app/pull/3"))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    let refused = client
        .call::<PrDiff>(view(run_id, "https://github.com/me/app/pull/3"))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    let refused = client
        .call::<PrAct>(act(run_id, "--help", PrAction::Close))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
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
    // One of Claude Code's own subagents (PLX-382).
    steps.extend(
        tool(
            "c5",
            "Bash",
            json!({"command": "gh pr create --fill"}),
            &format!("{SUBAGENT_S}\n"),
        )
        .map(|step| match step {
            Step::Emit(event) => Step::Emit(Event::Subagent {
                call_id: "agent1".to_owned(),
                agent_type: Some("general-purpose".to_owned()),
                model: None,
                event: Box::new(event),
            }),
            step => step,
        }),
    );
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
    let params = orchestrator_params(dir.path());
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
    assert_eq!(linked(&mut client).await, [FIRST, SECOND, SUBAGENT_S]);

    tools.graphql(&answer("OPEN"));
    let viewed = client.call::<PrView>(view(run_id, FIRST)).await.unwrap();
    assert_eq!((viewed.number, viewed.repo.as_str()), (1, "me/app"));
    assert_eq!(viewed.state, PrState::Open);
    assert_eq!(viewed.behind_by, Some(2));
    assert_eq!(viewed.ready, Some(false));
    assert_eq!(
        viewed.reasons,
        [
            "2 commits behind main",
            "failing: test",
            "1 unresolved review thread"
        ]
    );
    assert_eq!(
        viewed.merge_methods,
        [PrMergeMethod::Squash, PrMergeMethod::Rebase]
    );
    let check = &viewed.checks[0];
    assert_eq!(
        (check.required, check.run_id, check.job_id),
        (true, Some(70), Some(7))
    );
    assert_eq!(viewed.review_threads[0].id, "th1");
    let reads = tools.log().len();
    client.call::<PrView>(view(run_id, FIRST)).await.unwrap();
    assert_eq!(
        tools.log().len(),
        reads,
        "a second window's read shares the first's"
    );
    let diff = client.call::<PrDiff>(view(run_id, FIRST)).await.unwrap();
    assert_eq!(
        (diff.diff.as_str(), diff.truncated),
        ("diff --git a/README.md b/README.md\n", false)
    );

    let before = tools.log().len();
    refuses_unlinked(&mut client, run_id).await;
    assert_eq!(
        tools.log().len(),
        before,
        "a URL the run never linked never reaches gh"
    );
    acts_reach_gh(&mut client, &tools, run_id).await;

    tools.mode("signed-out");
    client
        .call::<PrView>(view(run_id, SECOND))
        .await
        .expect("the last act's read still serves it");
    let error = client
        .call::<PrView>(view(run_id, SUBAGENT_S))
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::GhUnavailable);

    // The links outlive plxd.
    let host = host.restart(fake(Vec::new())).await;
    let mut client = host.client().await;
    assert_eq!(linked(&mut client).await, [FIRST, SECOND, SUBAGENT_S]);
    host.server.stop().await;
}

/// `pr/act` sends each action to `gh`, one after another through the paced queue, and refuses
/// one missing what it needs.
async fn acts_reach_gh(client: &mut Conn, tools: &Tools, run_id: RunId) {
    let before = tools.log().len();
    let pinned = PrActParams {
        head_sha: Some("abc123".to_owned()),
        delete_branch: true,
        ..act(run_id, SECOND, PrAction::Rebase)
    };
    let squash = PrActParams {
        method: Some(PrMergeMethod::Squash),
        ..act(run_id, SECOND, PrAction::AutoMerge)
    };
    let rebase = PrActParams {
        method: Some(PrMergeMethod::Rebase),
        ..act(run_id, SECOND, PrAction::UpdateBranch)
    };
    let run = |action| PrActParams {
        workflow_run_id: Some(70),
        ..act(run_id, SECOND, action)
    };
    let job = PrActParams {
        job_id: Some(7),
        ..act(run_id, SECOND, PrAction::RerunJob)
    };
    let mut acts: Vec<PrActParams> = [
        PrAction::Merge,
        PrAction::Squash,
        PrAction::AutoMerge,
        PrAction::DisableAutoMerge,
        PrAction::Draft,
        PrAction::Ready,
        PrAction::Close,
        PrAction::UpdateBranch,
    ]
    .into_iter()
    .map(|action| act(run_id, SECOND, action))
    .collect();
    acts.extend([
        pinned,
        squash,
        rebase,
        run(PrAction::RerunFailed),
        job,
        run(PrAction::CancelRun),
    ]);
    for params in acts {
        let acted = client.call::<PrAct>(params).await.unwrap();
        assert_eq!(acted.number, 1, "the fresh read GitHub answered");
    }
    let sent: Vec<String> = tools
        .log()
        .into_iter()
        .skip(before)
        .filter(|line| line != "api graphql")
        .collect();
    assert_eq!(
        sent,
        [
            format!("pr merge {SECOND} --merge"),
            format!("pr merge {SECOND} --squash"),
            format!("pr merge {SECOND} --auto --merge"),
            format!("pr merge {SECOND} --disable-auto"),
            format!("pr ready {SECOND} --undo"),
            format!("pr ready {SECOND}"),
            format!("pr close {SECOND}"),
            format!("pr update-branch {SECOND}"),
            format!("pr merge {SECOND} --rebase --match-head-commit=abc123 --delete-branch"),
            format!("pr merge {SECOND} --auto --squash"),
            format!("pr update-branch {SECOND} --rebase"),
            "api -X POST repos/me/app/actions/runs/70/rerun-failed-jobs".to_owned(),
            "api -X POST repos/me/app/actions/jobs/7/rerun".to_owned(),
            "api -X POST repos/me/app/actions/runs/70/cancel".to_owned(),
        ]
    );
    let refused = client
        .call::<PrAct>(act(run_id, SECOND, PrAction::RerunJob))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "a job re-run needs its job");
    let refused = client
        .call::<PrAct>(act(run_id, SECOND, PrAction::DeleteBranch))
        .await
        .unwrap_err();
    assert_eq!(
        kind(&refused),
        ErrorKind::PrFailed,
        "an open pull request keeps its branch"
    );
}

#[tokio::test]
async fn merging_with_pr_act_archives_the_thread_before_the_next_sweep() {
    let tools = Tools::new();
    let work = temp_dir();
    let repo = real_repo(work.path());
    let host = start(temp_dir(), opening(), &tools);
    let mut client = host.client().await;
    let entry = client.add(&repo).await;
    subscribe(&mut client, scope(entry.id), 0).await;
    let start = thread(Some(entry.id));
    let run_id = start.run_id;
    client.call::<ThreadStart>(start).await.unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    // Every linked pull request now reads as merged, after the thread's last message.
    tools.state("MERGED");
    tools.view(
        &json!({
            "number": 1, "title": "Add a README", "url": FIRST, "state": "MERGED",
            "isDraft": false, "author": {"login": "me"}, "updatedAt": "2026-10-02T12:00:00Z",
            "baseRefName": "main", "headRefName": "parallax/x", "changedFiles": 1,
            "additions": 3, "deletions": 0, "body": "", "mergeStateStatus": "CLEAN",
            "autoMergeRequest": null, "mergedAt": jiff::Timestamp::now().to_string()
        })
        .to_string(),
    );
    tools.graphql(&answer("MERGED"));
    client
        .call::<PrAct>(act(run_id, FIRST, PrAction::Squash))
        .await
        .unwrap();
    // The next timed sweep is a minute away.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !client
        .call::<ThreadList>(ThreadListParams {})
        .await
        .unwrap()
        .threads[0]
        .archived
    {
        assert!(
            Instant::now() < deadline,
            "the merge didn't archive the thread"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    host.server.stop().await;
}
