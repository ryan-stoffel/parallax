use std::path::Path;

use jiff::Timestamp;
use parallax_protocol::{
    AgentApprovalBy, AgentApprovalDecision, AgentFailureKind, AgentOutcome, AgentOutputItem,
    AgentToolStatus, ApprovalId, ParallaxEvent, ProjectId, QueuedMessage, RunId, ThreadRun,
    ThreadRunStatus, TurnId,
};
use parallax_store::{Store, StoredEvent};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::store::StoreHandle;

fn open(dir: &Path) -> StoreHandle {
    StoreHandle::open(&dir.join("plxd.sqlite3"), 1000, usize::MAX, usize::MAX)
}

/// Stages `events` for one thread in one job, as the actor stages a batch.
async fn stage(store: &StoreHandle, project: ProjectId, events: Vec<ParallaxEvent>) {
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

async fn attempts(store: &StoreHandle, run: TurnId) -> Vec<(u32, String, String)> {
    store
        .run(&CancellationToken::new(), move |db| {
            Ok(db.run_attempts(run.into()).unwrap())
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
    let (thread, project) = (RunId::generate(), ProjectId::generate());
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
        attempts(&store, run.id).await,
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

/// A follow-up's turn can start before the turn it follows ends: both are open, output goes to
/// the newer, and each ends on its own `turnFinished`. A CLI's exit ends what is left, and an
/// interactive request is a user-input node.
#[tokio::test]
async fn overlapping_turns_end_on_their_own_and_the_exit_ends_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let (thread, project) = (RunId::generate(), ProjectId::generate());
    let (follow_up, third) = (TurnId::generate(), TurnId::generate());
    stage(
        &store,
        project,
        vec![
            output(thread, vec![started(None, "First")]),
            output(
                thread,
                vec![started(Some(follow_up), "Second"), tool_call("a")],
            ),
            output(thread, vec![finished(None)]),
            output(
                thread,
                vec![
                    finished(Some(follow_up)),
                    started(Some(third), "Third"),
                    approval(ApprovalId::generate(), true),
                ],
            ),
            ParallaxEvent::AgentFinished {
                run_id: thread,
                outcome: AgentOutcome::Cancelled,
            },
        ],
    )
    .await;
    let all = runs(&store, thread).await;
    let summary: Vec<_> = all
        .iter()
        .map(|run| (run.ordinal, run.status, run.text.clone()))
        .collect();
    assert_eq!(
        summary,
        [
            (
                Some(1),
                ThreadRunStatus::Completed,
                Some("First".to_owned())
            ),
            (
                Some(2),
                ThreadRunStatus::Completed,
                Some("Second".to_owned())
            ),
            (
                Some(3),
                ThreadRunStatus::Cancelled,
                Some("Third".to_owned())
            ),
        ]
    );
    assert_eq!(all[1].id, follow_up);
    assert_eq!(
        nodes(&store, thread, follow_up).await,
        pairs(&[("root_turn", "completed"), ("tool_call", "cancelled")]),
        "the second turn's tool call never got a result, and the exit ended it"
    );
    assert_eq!(
        nodes(&store, thread, third).await,
        pairs(&[
            ("root_turn", "cancelled"),
            ("user_input_request", "cancelled")
        ])
    );
}

/// A usage limit's fallback fails the attempt and leaves the run starting; its next
/// `turnStarted` is a second attempt on the same run, not a new run.
#[tokio::test]
async fn a_fallback_adds_an_attempt_to_the_same_run() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let (thread, project) = (RunId::generate(), ProjectId::generate());
    stage(
        &store,
        project,
        vec![
            output(thread, vec![started(None, "Go")]),
            ParallaxEvent::AgentAccountFallback {
                run_id: thread,
                from_account: "claude".to_owned(),
                to_account: "key".to_owned(),
                reason: AgentFailureKind::RateLimited,
            },
        ],
    )
    .await;
    assert_eq!(
        runs(&store, thread).await[0].status,
        ThreadRunStatus::Starting
    );
    stage(
        &store,
        project,
        vec![output(thread, vec![started(None, "Go"), finished(None)])],
    )
    .await;
    let all = runs(&store, thread).await;
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(
        (all[0].status, all[0].attempt),
        (ThreadRunStatus::Completed, Some(2))
    );
    assert_eq!(
        attempts(&store, all[0].id).await,
        [
            (1, "initial".to_owned(), "failed".to_owned()),
            (2, "provider_recovery".to_owned(), "completed".to_owned()),
        ]
    );
}

/// `queue.updated` writes the queued runs in order, held or not, and a queued run that starts
/// keeps its id and gets the next ordinal.
#[tokio::test]
async fn queued_runs_follow_the_queue_and_start_with_their_ids() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let (thread, project) = (RunId::generate(), ProjectId::generate());
    let (a, b) = (TurnId::generate(), TurnId::generate());
    let message = |id, text: &str| QueuedMessage {
        id,
        text: text.to_owned(),
        images: 1,
        threads: Vec::new(),
    };
    stage(
        &store,
        project,
        vec![
            output(thread, vec![started(None, "Go")]),
            ParallaxEvent::QueueUpdated {
                run_id: thread,
                messages: vec![message(a, "A"), message(b, "B")],
                held: true,
            },
        ],
    )
    .await;
    let queued: Vec<_> = runs(&store, thread)
        .await
        .into_iter()
        .filter(|run| run.status == ThreadRunStatus::Queued)
        .map(|run| (run.id, run.position, run.queue_held, run.images))
        .collect();
    assert_eq!(queued, [(a, Some(0), true, 1), (b, Some(1), true, 1)]);

    stage(
        &store,
        project,
        vec![
            ParallaxEvent::QueueUpdated {
                run_id: thread,
                messages: vec![message(b, "B")],
                held: false,
            },
            output(thread, vec![finished(None), started(Some(a), "A")]),
        ],
    )
    .await;
    let all: Vec<_> = runs(&store, thread)
        .await
        .into_iter()
        .map(|run| (run.id == a, run.ordinal, run.status, run.queue_held))
        .collect();
    assert_eq!(
        all,
        [
            (false, Some(1), ThreadRunStatus::Completed, false),
            (true, Some(2), ThreadRunStatus::Running, false),
            (false, None, ThreadRunStatus::Queued, false),
        ]
    );
}

/// A store from before the graph: the first event staged for a thread folds its stored events
/// first, compacted turns included, so its runs are numbered from the start, and tags each event
/// with its run.
#[tokio::test]
async fn a_thread_from_before_the_graph_is_imported_on_its_next_event() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plxd.sqlite3");
    let (thread, project) = (RunId::generate(), ProjectId::generate());
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

/// A job that rolls back forgets the import it made, so the next job imports the thread again
/// rather than skipping it.
#[tokio::test]
async fn a_rolled_back_import_is_done_again() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let (thread, project) = (RunId::generate(), ProjectId::generate());
    let failed = store
        .run(&CancellationToken::new(), move |db| {
            db.stage(
                Timestamp::now(),
                Some(project),
                output(thread, vec![started(None, "Lost")]),
            );
            Err::<(), _>(parallax_protocol::jsonrpc::ErrorObject::internal_error(
                "no",
            ))
        })
        .await;
    assert!(failed.is_err());
    assert!(runs(&store, thread).await.is_empty());
    stage(
        &store,
        project,
        vec![output(thread, vec![started(None, "Kept")])],
    )
    .await;
    let imported: i64 = rusqlite::Connection::open(dir.path().join("plxd.sqlite3"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM graph_imports", [], |row| row.get(0))
        .unwrap();
    assert_eq!(imported, 1);
    assert_eq!(runs(&store, thread).await.len(), 1);
}
