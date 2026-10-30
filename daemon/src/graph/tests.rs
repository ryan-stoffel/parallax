use std::path::Path;

use jiff::Timestamp;
use parallax_protocol::{
    AgentApprovalBy, AgentApprovalDecision, AgentOutputItem, AgentToolStatus, ApprovalId,
    ParallaxEvent, RunId, ScopeId, ThreadRun, ThreadRunStatus, TurnId,
};
use parallax_store::{Store, StoredEvent};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::store::StoreHandle;

fn open(dir: &Path) -> StoreHandle {
    StoreHandle::open(&dir.join("plxd.sqlite3"), 1000, usize::MAX, usize::MAX)
}

/// Stages `events` for one thread in one job, as the actor stages a batch.
async fn stage(store: &StoreHandle, project: ScopeId, events: Vec<ParallaxEvent>) {
    store
        .run(&CancellationToken::new(), move |db| {
            for event in events {
                db.stage(Timestamp::now(), Some(project), event);
            }
            Ok(())
        })
        .await
        .unwrap();
}

fn output(thread: RunId, items: Vec<AgentOutputItem>) -> ParallaxEvent {
    ParallaxEvent::AgentOutput {
        run_id: thread,
        items,
        compacted: None,
    }
}

fn started(turn_id: Option<TurnId>, text: &str) -> AgentOutputItem {
    AgentOutputItem::TurnStarted {
        turn_id,
        text: Some(text.to_owned()),
        wake: false,
        from: None,
        images: Vec::new(),
        threads: Vec::new(),
    }
}

fn finished(turn_id: Option<TurnId>) -> AgentOutputItem {
    AgentOutputItem::TurnFinished {
        turn_id,
        result: None,
        cursor: None,
        session_id: None,
    }
}

fn tool_call(call_id: &str) -> AgentOutputItem {
    AgentOutputItem::ToolCall {
        call_id: call_id.to_owned(),
        name: "Read".to_owned(),
        input: serde_json::json!({}),
    }
}

fn tool_result(call_id: &str, status: AgentToolStatus) -> AgentOutputItem {
    AgentOutputItem::ToolResult {
        call_id: call_id.to_owned(),
        status,
        output: None,
        images: Vec::new(),
    }
}

fn approval(approval_id: ApprovalId, interactive: bool) -> AgentOutputItem {
    AgentOutputItem::ApprovalRequested {
        approval_id,
        tool_name: "Bash".to_owned(),
        input: serde_json::json!({"command": "ls"}),
        call_id: None,
        reason: None,
        blocked_path: None,
        subagent: None,
        always_allow: Vec::new(),
        interactive,
        expires_at: Timestamp::now(),
    }
}

fn resolved(approval_id: ApprovalId) -> AgentOutputItem {
    AgentOutputItem::ApprovalResolved {
        approval_id,
        decision: AgentApprovalDecision::Allowed,
        by: AgentApprovalBy::User,
        always: false,
        message: None,
    }
}

async fn runs(store: &StoreHandle, thread: RunId) -> Vec<ThreadRun> {
    store
        .run(&CancellationToken::new(), move |db| {
            super::runs(db, thread.into())
        })
        .await
        .unwrap()
}

/// `(kind, status)` of each of run `run`'s nodes, in the order they were made.
async fn nodes(store: &StoreHandle, thread: RunId, run: TurnId) -> Vec<(String, String)> {
    store
        .run(&CancellationToken::new(), move |db| {
            Ok(db
                .run_nodes(thread.into(), run.into())
                .unwrap()
                .into_iter()
                .map(|node| (node.kind, node.status))
                .collect())
        })
        .await
        .unwrap()
}

async fn attempts(store: &StoreHandle, thread: RunId, run: TurnId) -> Vec<(u32, String, String)> {
    store
        .run(&CancellationToken::new(), move |db| {
            Ok(db.run_attempts(thread.into(), run.into()).unwrap())
        })
        .await
        .unwrap()
}

fn pairs(nodes: &[(&str, &str)]) -> Vec<(String, String)> {
    nodes
        .iter()
        .map(|(kind, status)| ((*kind).to_owned(), (*status).to_owned()))
        .collect()
}

/// A turn is a run with an attempt and a root node; its tool calls and permission requests are
/// nodes under it, a request waits as a runtime request and makes the run wait until it is
/// answered, and the turn's end completes the run and its root.
#[tokio::test]
async fn a_turn_becomes_a_run_with_its_tools_and_requests_as_nodes() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let (thread, project) = (RunId::generate(), ScopeId::generate());
    let approval_id = ApprovalId::generate();
    stage(
        &store,
        project,
        vec![output(
            thread,
            vec![
                started(None, "Fix the bug"),
                tool_call("1"),
                approval(approval_id, false),
            ],
        )],
    )
    .await;
    let run = runs(&store, thread).await.remove(0);
    assert_eq!(
        (run.status, run.ordinal, run.attempt, run.text.as_deref()),
        (
            ThreadRunStatus::Waiting,
            Some(1),
            Some(1),
            Some("Fix the bug")
        )
    );
    let pending = store
        .run(&CancellationToken::new(), move |db| {
            super::requests(db, Some(thread.into()))
        })
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0].event, ParallaxEvent::AgentOutput { items, .. }
        if matches!(items[..], [AgentOutputItem::ApprovalRequested { approval_id: id, .. }] if id == approval_id))
    );

    stage(
        &store,
        project,
        vec![output(
            thread,
            vec![
                resolved(approval_id),
                tool_result("1", AgentToolStatus::Ok),
                tool_call("2"),
                tool_result("2", AgentToolStatus::Error),
                finished(None),
            ],
        )],
    )
    .await;
    let run = runs(&store, thread).await.remove(0);
    assert_eq!(run.status, ThreadRunStatus::Completed);
    assert!(run.completed_at.is_some());
    assert_eq!(
        nodes(&store, thread, run.id).await,
        pairs(&[
            ("root_turn", "completed"),
            ("tool_call", "completed"),
            ("approval_request", "completed"),
            ("tool_call", "failed"),
        ])
    );
    assert_eq!(
        attempts(&store, thread, run.id).await,
        [(1, "initial".to_owned(), "completed".to_owned())]
    );
    let pending = store
        .run(&CancellationToken::new(), move |db| {
            super::requests(db, Some(thread.into()))
        })
        .await
        .unwrap();
    assert!(pending.is_empty());
}

/// A store from before the graph: the first event staged for a thread folds its stored events
/// first, compacted turns included, so its runs are numbered from the start, and tags each event
/// with its run.
#[tokio::test]
async fn a_thread_from_before_the_graph_is_imported_on_its_next_event() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plxd.sqlite3");
    let (thread, project) = (RunId::generate(), ScopeId::generate());
    let second = TurnId::generate();
    {
        let store = Store::open(&path).unwrap();
        let old = [
            output(thread, vec![started(None, "Old"), tool_call("x")]),
            output(
                thread,
                vec![tool_result("x", AgentToolStatus::Ok), finished(None)],
            ),
            output(
                thread,
                vec![
                    started(Some(second), "Older follow-up"),
                    finished(Some(second)),
                ],
            ),
        ];
        for (seq, event) in (1..).zip(old) {
            store
                .append_event(&StoredEvent {
                    seq,
                    time: Timestamp::now(),
                    project_id: Some(project.into()),
                    thread_id: Some(thread.into()),
                    kind: "agent.output".to_owned(),
                    payload: serde_json::to_string(&event).unwrap(),
                    command_id: None,
                    run_id: None,
                })
                .unwrap();
        }
    }
    let store = open(dir.path());
    let third = TurnId::generate();
    stage(
        &store,
        project,
        vec![output(thread, vec![started(Some(third), "New")])],
    )
    .await;
    let summary: Vec<_> = runs(&store, thread)
        .await
        .into_iter()
        .map(|run| (run.ordinal, run.status, run.text))
        .collect();
    assert_eq!(
        summary,
        [
            (Some(1), ThreadRunStatus::Completed, Some("Old".to_owned())),
            (
                Some(2),
                ThreadRunStatus::Completed,
                Some("Older follow-up".to_owned())
            ),
            (Some(3), ThreadRunStatus::Running, Some("New".to_owned())),
        ]
    );
    let tagged: Vec<Option<String>> = rusqlite::Connection::open(&path)
        .unwrap()
        .prepare("SELECT run_id FROM events ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tagged.len(), 4);
    assert!(tagged.iter().all(Option::is_some), "{tagged:?}");
    assert_eq!(tagged[2], Some(Uuid::from(second).to_string()));
    assert_eq!(tagged[3], Some(Uuid::from(third).to_string()));
}
