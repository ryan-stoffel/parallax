//! `project/fromThreads` (PLX-419, 0042): threads on one repo entry, each in its own worktree,
//! become a new Project's children under its coordinator.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{AgentSend, ProjectFromThreads, ThreadStart};
use parallax_protocol::{
    AccountChoice, AgentPermission, ProjectFromThreadsParams, ProjectId, ProjectPermission, RunId,
};
use plxd::backend::{RunRequest, ToolPolicy};
use tokio::time::Instant;

use super::{Host, message, real_repo, start_params};
use crate::agents::{end_turn, init};
use crate::coordinator::{nth_launch, roles_mapping};
use crate::support::PATIENCE;

fn params(threads: Vec<RunId>) -> ProjectFromThreadsParams {
    ProjectFromThreadsParams {
        id: ProjectId::generate(),
        run_id: RunId::generate(),
        name: "app".to_owned(),
        permission: ProjectPermission::Bypass,
        threads,
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
    }
}

/// Workers end each turn at once, and the coordinator has a script for its first turn and the
/// wake-ups the joined threads send it. Both run in a Project only in `permissions`.
fn host(seen: &Arc<Mutex<Vec<RunRequest>>>, permissions: &'static [AgentPermission]) -> Host {
    let coordinator = || vec![init("coordinator-1"), end_turn("Here's a draft brief.")];
    Host::start(roles_mapping(
        vec![init("worker-1"), end_turn("Done.")],
        vec![coordinator(), coordinator(), coordinator()],
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

/// Two threads become a Project's children: the Project is on their repository, its coordinator
/// is asked to read them and propose the brief, and each keeps its repo entry and worktree, takes
/// the coordinator as its parent, and runs its next turn in the Project's mode.
#[tokio::test]
async fn threads_become_a_projects_children_under_its_coordinator() {
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
        .call::<ProjectFromThreads>(request.clone())
        .await
        .unwrap();
    assert_eq!(made.project.id, request.id);
    assert_eq!(made.project.repo_path, repo.path);
    assert_eq!(made.project.permission, Some(ProjectPermission::Bypass));
    assert_eq!(made.project.coordinator, Some(request.run_id));
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

    let again = client.call::<ProjectFromThreads>(request).await.unwrap();
    assert_eq!(again.project.id, made.project.id, "idempotent");
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
