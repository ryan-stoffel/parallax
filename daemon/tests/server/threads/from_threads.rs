//! `orchestrator/fromThreads` (PLX-419, 0042): threads on one repo entry, each in its own worktree,
//! become a new orchestrator's children under its orchestrator.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{AgentSend, OrchestratorFromThreads, ThreadStart};
use parallax_protocol::{
    AccountChoice, AgentPermission, OrchestratorFromThreadsParams, OrchestratorPermission, RunId,
    ScopeId,
};
use plxd::backend::{RunRequest, ToolPolicy};
use tokio::time::Instant;

use super::{Host, message, real_repo, start_params};
use crate::agents::{end_turn, init};
use crate::orchestrator::{nth_launch, roles_mapping};
use crate::support::PATIENCE;

fn params(threads: Vec<RunId>) -> OrchestratorFromThreadsParams {
    OrchestratorFromThreadsParams {
        id: ScopeId::generate(),
        run_id: RunId::generate(),
        name: "app".to_owned(),
        permission: OrchestratorPermission::Bypass,
        threads,
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
    }
}

/// Workers end each turn at once, and the orchestrator has a script for its first turn and the
/// wake-ups the joined threads send it. Both run in an orchestrator only in `permissions`.
fn host(seen: &Arc<Mutex<Vec<RunRequest>>>, permissions: &'static [AgentPermission]) -> Host {
    let orchestrator = || vec![init("orchestrator-1"), end_turn("Here's a draft brief.")];
    Host::start(roles_mapping(
        vec![init("worker-1"), end_turn("Done.")],
        vec![orchestrator(), orchestrator(), orchestrator()],
        seen,
        permissions,
    ))
}

/// The worker launches `seen`, once there are `n`.
async fn worker_launches(seen: &Mutex<Vec<RunRequest>>, n: usize) -> Vec<RunRequest> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let workers: Vec<RunRequest> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.policy != ToolPolicy::NoWrite)
            .cloned()
            .collect();
        if workers.len() >= n {
            return workers;
        }
        assert!(Instant::now() < deadline, "{n} worker launches never came");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Two threads become an orchestrator's children: the orchestrator is on their repository, its
/// orchestrator is asked to read them and propose the brief, and each keeps its repo entry and
/// worktree, takes the orchestrator as its parent, and runs its next turn in the orchestrator's
/// mode.
#[tokio::test]
async fn threads_become_a_orchestrators_children_under_its_orchestrator() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = host(&seen, &[AgentPermission::Auto, AgentPermission::Bypass]);
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut threads = Vec::new();
    for task in ["Fix the login bug.", "Add a test for it."] {
        let started = client
            .call::<ThreadStart>(start_params(Some(repo.id), task))
            .await
            .unwrap();
        threads.push(started.run);
    }
    let first = worker_launches(&seen, 2).await;
    assert!(first.iter().all(|launch| launch.permission.is_none()));

    let request = params(threads.iter().map(|run| run.id).collect());
    let made = client
        .call::<OrchestratorFromThreads>(request.clone())
        .await
        .unwrap();
    assert_eq!(made.orchestrator.id, request.id);
    assert_eq!(made.orchestrator.repo_path, repo.path);
    assert_eq!(
        made.orchestrator.permission,
        Some(OrchestratorPermission::Bypass)
    );
    assert_eq!(made.orchestrator.run, Some(request.run_id));
    assert_eq!(made.run.id, request.run_id);

    let kickoff = nth_launch(&seen, 0).await.prompt;
    assert!(kickoff.contains("thread_read"), "{kickoff}");
    assert!(kickoff.contains("memory_propose (kind brief"), "{kickoff}");
    for thread in &threads {
        assert!(kickoff.contains(&thread.id.to_string()), "{kickoff}");
    }

    let listed = client.list().await;
    for thread in &threads {
        let row = listed
            .threads
            .iter()
            .find(|row| row.id == thread.id)
            .unwrap();
        assert_eq!(row.parent, Some(request.run_id));
        assert_eq!(row.repo, repo.id, "it keeps its repo entry");
        assert!(Path::new(thread.worktree_path.as_deref().unwrap()).is_dir());
    }

    let again = client
        .call::<OrchestratorFromThreads>(request)
        .await
        .unwrap();
    assert_eq!(again.orchestrator.id, made.orchestrator.id, "idempotent");
    assert_eq!(again.run.id, made.run.id);

    client
        .call::<AgentSend>(message(threads[0].id, "Go on."))
        .await
        .unwrap();
    let next = worker_launches(&seen, 3).await.pop().unwrap();
    assert_eq!(next.run_id, threads[0].id);
    assert_eq!(next.permission, Some(AgentPermission::Bypass));
    assert!(next.approvals, "a child asks through the inbox");
    let worktree = Path::new(threads[0].worktree_path.as_deref().unwrap());
    assert_eq!(
        next.cwd.canonicalize().unwrap(),
        worktree.canonicalize().unwrap()
    );
    host.server.stop().await;
}
