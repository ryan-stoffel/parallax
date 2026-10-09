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

/// Counts provider mutations independently of graph events.
struct CountingRewind {
    fake: plxd::backend::fake::FakeBackend,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    uncertain: bool,
}

impl plxd::backend::Backend for CountingRewind {
    fn name(&self) -> &str {
        self.fake.name()
    }
    fn capabilities(&self) -> plxd::backend::Capabilities {
        self.fake.capabilities()
    }
    fn start(
        &self,
        request: plxd::backend::RunRequest,
    ) -> Result<plxd::backend::Started, plxd::backend::StartError> {
        self.fake.start(request)
    }
    fn rewind(
        &self,
        rewind: plxd::backend::Rewind,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.uncertain {
            Box::pin(std::future::ready(Err(
                "provider disconnected after mutation".to_owned(),
            )))
        } else {
            self.fake.rewind(rewind)
        }
    }
}

fn counting_backend(
    calls: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    uncertain: bool,
) -> plxd::routing::BackendRegistry {
    let mut backends = plxd::routing::BackendRegistry::new();
    backends.register(
        parallax_protocol::Provider::Anthropic,
        std::sync::Arc::new(CountingRewind {
            fake: super::fake_backend(three_turns()),
            calls: std::sync::Arc::clone(calls),
            uncertain,
        }),
    );
    backends
}

impl Conn {
    async fn rollback_command(
        &mut self,
        command: OrchestrationCommand,
        command_id: uuid::Uuid,
    ) -> Result<parallax_protocol::DispatchResult, parallax_protocol::jsonrpc::ErrorObject> {
        let mut params = serde_json::to_value(command).unwrap();
        params.as_object_mut().unwrap().insert(
            "commandId".to_owned(),
            serde_json::json!(command_id.to_string()),
        );
        let id = parallax_protocol::jsonrpc::RequestId::String(uuid::Uuid::now_v7().to_string());
        self.client
            .send_message(&parallax_protocol::jsonrpc::Request {
                id: id.clone(),
                method: "orchestration/dispatch".to_owned(),
                params: Some(params),
            })
            .await;
        loop {
            match self.client.next().await {
                Some(parallax_protocol::jsonrpc::Message::Response(response)) => {
                    assert_eq!(response.id, Some(id));
                    return response.into_result();
                }
                Some(parallax_protocol::jsonrpc::Message::Notification(notification)) => {
                    self.pending.push_back(super::event(notification));
                }
                other => panic!("expected response, got {other:?}"),
            }
        }
    }
}

async fn assert_pending_actions(client: &mut Conn, thread: RunId) {
    // While local completion is pending, no new provider turn or stale branch action is allowed.
    let pending = client
        .call::<OrchestrationDispatch>(OrchestrationCommand::MessageDispatch {
            thread_id: thread,
            message_id: TurnId::generate(),
            text: "must wait".to_owned(),
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
        .unwrap_err();
    assert_eq!(
        pending.parallax_data().unwrap().kind,
        ErrorKind::RevertRefused
    );
    let accept = client
        .call::<parallax_protocol::methods::AgentAccept>(parallax_protocol::AgentAcceptParams {
            run_id: thread,
            id: parallax_protocol::AcceptId::generate(),
            commit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        accept.parallax_data().unwrap().kind,
        ErrorKind::RevertRefused
    );
    let push = client
        .call::<parallax_protocol::methods::AgentPush>(parallax_protocol::AgentPushParams {
            run_id: thread,
        })
        .await
        .unwrap_err();
    assert_eq!(push.parallax_data().unwrap().kind, ErrorKind::RevertRefused);
    let pr = client
        .call::<parallax_protocol::methods::AgentOpenPr>(crate::open_pr::open(
            thread,
            "must wait",
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(pr.parallax_data().unwrap().kind, ErrorKind::RevertRefused);
}

async fn failed_restore(restart: bool) {
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let host = Host::start(counting_backend(&calls, false));
    let path = real_repo(host.work.path(), "retry");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut events = host.client().await;
    events.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "one"))
        .await
        .unwrap()
        .run;
    let thread = started.id;
    let worktree = std::path::PathBuf::from(started.worktree_path.unwrap());
    checkpointed(&mut events, thread, 1).await;
    send(&mut client, thread, "two").await;
    checkpointed(&mut events, thread, 2).await;
    let git_dir = super::git(&worktree, &["rev-parse", "--absolute-git-dir"]);
    let lock = std::path::Path::new(&git_dir).join("index.lock");
    std::fs::write(&lock, "test lock").unwrap();
    let command = OrchestrationCommand::CheckpointRollback {
        thread_id: thread,
        ordinal: 1,
        restore_files: true,
    };
    let command_id = uuid::Uuid::now_v7();
    assert!(
        client
            .rollback_command(command.clone(), command_id)
            .await
            .is_err()
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_pending_actions(&mut client, thread).await;
    let host = if restart {
        host.restart(counting_backend(&calls, false)).await
    } else {
        host
    };
    let mut client = if restart { host.client().await } else { client };
    std::fs::remove_file(lock).unwrap();
    let first = client
        .rollback_command(command.clone(), command_id)
        .await
        .unwrap();
    let again = client.rollback_command(command, command_id).await.unwrap();
    assert_eq!(first.seq, again.seq);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(worktree.join("a.txt").exists());
    assert!(!worktree.join("b.txt").exists());
    let runs = client
        .call::<OrchestrationThreadRuns>(ThreadRunsParams { thread_id: thread })
        .await
        .unwrap()
        .runs;
    assert_eq!(runs[1].status, ThreadRunStatus::RolledBack);
}

#[tokio::test]
async fn a_failed_restore_retries_local_completion_without_rewinding_twice() {
    failed_restore(false).await;
}

#[tokio::test]
async fn a_failed_restore_survives_restart_without_rewinding_twice() {
    failed_restore(true).await;
}

#[tokio::test]
async fn reverting_files_commits_the_restored_branch_and_accept_uses_it() {
    let tools = crate::open_pr::Tools::new();
    let dir = crate::support::temp_dir();
    let mut config = crate::support::InProcess::config(dir.path());
    config.backends = Some(fake(three_turns()));
    config.agent_environment = Some(tools.environment());
    let host = Host {
        dir,
        work: crate::support::temp_dir(),
        server: crate::support::InProcess::start(config),
    };
    let path = real_repo(host.work.path(), "accept-revert");
    let origin = crate::open_pr::add_origin(&path, host.work.path());
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut events = host.client().await;
    events.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "one"))
        .await
        .unwrap()
        .run;
    let thread = started.id;
    let branch = started.branch.unwrap();
    let worktree = std::path::PathBuf::from(started.worktree_path.unwrap());
    checkpointed(&mut events, thread, 1).await;
    send(&mut client, thread, "two").await;
    checkpointed(&mut events, thread, 2).await;
    client
        .call::<OrchestrationDispatch>(OrchestrationCommand::CheckpointRollback {
            thread_id: thread,
            ordinal: 1,
            restore_files: true,
        })
        .await
        .unwrap();
    let restored_head = super::git(&worktree, &["rev-parse", "HEAD"]);
    assert_eq!(super::git(&worktree, &["status", "--porcelain"]), "");
    assert!(!super::git(&worktree, &["ls-tree", "--name-only", "HEAD"]).contains("b.txt"));
    // Push and Open PR read this branch HEAD; Accept reads the actor's refreshed commit.
    client
        .call::<parallax_protocol::methods::AgentPush>(parallax_protocol::AgentPushParams {
            run_id: thread,
        })
        .await
        .unwrap();
    assert_eq!(super::git(&origin, &["rev-parse", &branch]), restored_head);
    assert_eq!(
        super::git(&origin, &["show", &format!("{branch}:a.txt")]),
        "one"
    );
    client
        .call::<parallax_protocol::methods::AgentOpenPr>(crate::open_pr::open(
            thread,
            "Restored turn",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(super::git(&origin, &["rev-parse", &branch]), restored_head);
    assert!(
        tools
            .log()
            .iter()
            .any(|call| call.contains("pr create") && call.contains(&branch))
    );
    let accepted = client
        .call::<parallax_protocol::methods::AgentAccept>(parallax_protocol::AgentAcceptParams {
            run_id: thread,
            id: parallax_protocol::AcceptId::generate(),
            commit: Some(restored_head.clone()),
        })
        .await
        .unwrap();
    assert_eq!(accepted.run.diff.unwrap().commit, restored_head);
    assert!(path.join("a.txt").exists());
    assert!(!path.join("b.txt").exists());
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "hello\n"
    );
}

#[tokio::test]
async fn an_unknown_provider_outcome_is_held_across_retry_and_restart() {
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let host = Host::start(counting_backend(&calls, true));
    let path = real_repo(host.work.path(), "uncertain-revert");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut events = host.client().await;
    events.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "one"))
        .await
        .unwrap()
        .run;
    let thread = started.id;
    checkpointed(&mut events, thread, 1).await;
    send(&mut client, thread, "two").await;
    checkpointed(&mut events, thread, 2).await;
    let command = OrchestrationCommand::CheckpointRollback {
        thread_id: thread,
        ordinal: 1,
        restore_files: true,
    };
    assert!(
        client
            .rollback_command(command.clone(), uuid::Uuid::now_v7())
            .await
            .is_err()
    );
    assert_pending_actions(&mut client, thread).await;
    let host = host.restart(counting_backend(&calls, true)).await;
    let mut client = host.client().await;
    let refused = client
        .rollback_command(command, uuid::Uuid::now_v7())
        .await
        .unwrap_err();
    assert!(refused.message.contains("outcome is unknown"));
    assert_pending_actions(&mut client, thread).await;
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}
