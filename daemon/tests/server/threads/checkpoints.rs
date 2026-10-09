//! Per-turn checkpoints, their diffs, and revert (0062), on the fake CLI in a real repository.

use parallax_protocol::methods::{
    OrchestrationDispatch, OrchestrationGetFullThreadDiff, OrchestrationGetTurnDiff,
    OrchestrationThreadRuns, ThreadStart,
};
use parallax_protocol::{
    CheckpointFile, CheckpointStatus, DispatchMode, ErrorKind, EventsEventParams,
    FullThreadDiffParams, OrchestrationCommand, ParallaxEvent, RunId, ThreadRunStatus,
    ThreadRunsParams, TurnCheckpoint, TurnDiffParams, TurnId,
};
use plxd::backend::fake::Step;

use super::{Conn, Host, fake, real_repo, scope, start_params};
use crate::agents::{end_turn, init};

fn write(path: &str, content: &str) -> Step {
    Step::WriteFile {
        path: path.to_owned(),
        content: content.to_owned(),
    }
}

/// Three turns: the first adds `a.txt`, the second `b.txt` and a line to the README, the third
/// nothing.
fn three_turns() -> Vec<Step> {
    vec![
        init("checkpoints-1"),
        write("a.txt", "one\n"),
        end_turn("Turn 1."),
        Step::AwaitFollowUp,
        write("b.txt", "two\n"),
        write("README.md", "hello\nagain\n"),
        end_turn("Turn 2."),
        Step::AwaitFollowUp,
        end_turn("Turn 3."),
    ]
}

/// Waits for thread `run`'s checkpoint after run `ordinal`.
async fn checkpointed(runs: &mut Conn, run: RunId, ordinal: u32) -> TurnCheckpoint {
    let mut found = None;
    runs.until(|event: &EventsEventParams| match &event.event {
        ParallaxEvent::ThreadCheckpoint {
            run_id,
            ordinal: at,
            checkpoint,
            ..
        } if *run_id == run && *at == ordinal => {
            found = Some(checkpoint.clone());
            true
        }
        _ => false,
    })
    .await;
    found.unwrap()
}

async fn send(client: &mut Conn, thread_id: RunId, text: &str) {
    client
        .call::<OrchestrationDispatch>(OrchestrationCommand::MessageDispatch {
            thread_id,
            message_id: TurnId::generate(),
            text: text.to_owned(),
            images: Vec::new(),
            threads: Vec::new(),
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            account: None,
            dispatch_mode: DispatchMode::QueueAfterActive,
        })
        .await
        .unwrap();
}

async fn diff(client: &mut Conn, thread_id: RunId, from: u32, to: u32) -> String {
    client
        .call::<OrchestrationGetTurnDiff>(TurnDiffParams {
            thread_id,
            from,
            to,
            ignore_whitespace: None,
        })
        .await
        .unwrap()
        .diff
}

fn file(path: &str, additions: u32, deletions: u32) -> CheckpointFile {
    CheckpointFile {
        path: path.to_owned(),
        additions,
        deletions,
    }
}

#[tokio::test]
async fn each_turn_is_checkpointed_diffed_and_revertible_with_its_files() {
    let host = Host::start(fake(three_turns()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Add a"))
        .await
        .unwrap()
        .run;
    let (thread, worktree) = (started.id, started.worktree_path.unwrap());
    let worktree = std::path::Path::new(&worktree);

    let first = checkpointed(&mut runs, thread, 1).await;
    assert_eq!(first.status, CheckpointStatus::Ready);
    assert_eq!(first.files, [file("a.txt", 1, 0)]);
    send(&mut client, thread, "Add b").await;
    let second = checkpointed(&mut runs, thread, 2).await;
    assert_eq!(second.files, [file("README.md", 1, 0), file("b.txt", 1, 0)]);

    let turn = diff(&mut client, thread, 1, 2).await;
    assert!(
        turn.contains("+++ b/b.txt") && !turn.contains("a.txt"),
        "{turn}"
    );
    let whole = client
        .call::<OrchestrationGetFullThreadDiff>(FullThreadDiffParams {
            thread_id: thread,
            to: 2,
            ignore_whitespace: None,
        })
        .await
        .unwrap()
        .diff;
    assert!(
        whole.contains("+++ b/a.txt") && whole.contains("+++ b/b.txt"),
        "{whole}"
    );

    // Back to the first turn, files and all: the second turn's edits go, the first's stay.
    client
        .call::<OrchestrationDispatch>(OrchestrationCommand::CheckpointRollback {
            thread_id: thread,
            ordinal: 1,
            restore_files: true,
        })
        .await
        .unwrap();
    assert!(worktree.join("a.txt").exists());
    assert!(!worktree.join("b.txt").exists());
    assert_eq!(
        std::fs::read_to_string(worktree.join("README.md")).unwrap(),
        "hello\n"
    );
    let listed = client
        .call::<OrchestrationThreadRuns>(ThreadRunsParams { thread_id: thread })
        .await
        .unwrap()
        .runs;
    let statuses: Vec<_> = listed.iter().map(|run| run.status).collect();
    assert_eq!(
        statuses,
        [ThreadRunStatus::Completed, ThreadRunStatus::RolledBack]
    );
    assert_eq!(
        listed[1].checkpoint.as_ref().unwrap().status,
        CheckpointStatus::Stale
    );
    let stale = client
        .call::<OrchestrationDispatch>(OrchestrationCommand::CheckpointRollback {
            thread_id: thread,
            ordinal: 2,
            restore_files: false,
        })
        .await
        .unwrap_err();
    assert_eq!(
        stale.parallax_data().unwrap().kind,
        ErrorKind::RevertRefused
    );

    // The next turn starts from the reverted folder, and its diff is its own.
    send(&mut client, thread, "Carry on").await;
    let third = checkpointed(&mut runs, thread, 3).await;
    assert_eq!(third.status, CheckpointStatus::Ready);
    assert_eq!(diff(&mut client, thread, 2, 3).await, "");
    assert!(!diff(&mut client, thread, 0, 3).await.contains("b.txt"));
}
