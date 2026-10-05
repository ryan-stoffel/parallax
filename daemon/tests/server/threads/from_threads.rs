//! `project/fromThreads` (PLX-419, 0042): threads on one repo entry, each in its own worktree,
//! become a new Project's children under its coordinator.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{AgentSend, ProjectFromThreads, ProjectList, ThreadStart};
use parallax_protocol::{
    AccountChoice, AgentPermission, ErrorKind, ProjectFromThreadsParams, ProjectId,
    ProjectListParams, ProjectPermission, RunId, ThreadStartParams,
};
use plxd::backend::{RunRequest, ToolPolicy};
use tokio::time::Instant;

use super::{Host, message, real_repo, start_params};
use crate::agents::{end_turn, init};
use crate::coordinator::{nth_launch, roles_mapping};
use crate::support::{PATIENCE, kind};

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

/// Threads on two repositories, on the scratch entry, in the user's checkout, or whose kind lacks
/// the Project's mode can't make a Project, nor can an unknown one. A refusal, or a coordinator
/// that can't start, leaves no Project.
#[tokio::test]
async fn threads_on_two_repos_or_without_a_worktree_are_refused() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = host(&seen, &[AgentPermission::Bypass]);
    let mut client = host.client().await;
    let app = client.add(&real_repo(host.work.path(), "app")).await;
    let lib = client.add(&real_repo(host.work.path(), "lib")).await;
    let mut ids = Vec::new();
    for params in [
        start_params(Some(app.id), "In app."),
        start_params(Some(lib.id), "In lib."),
        start_params(None, "No repo."),
        ThreadStartParams {
            checkout: true,
            ..start_params(Some(app.id), "In the checkout.")
        },
    ] {
        ids.push(client.call::<ThreadStart>(params).await.unwrap().run.id);
    }
    let [on_app, on_lib, scratch, checkout] = ids[..] else {
        unreachable!()
    };

    for (threads, why) in [
        (vec![on_app, on_lib], "two repositories"),
        (vec![on_app, scratch], "no repository"),
        (vec![on_app, checkout], "no worktree"),
        (vec![on_app, on_app], "twice"),
        (Vec::new(), "at least one"),
    ] {
        let refused = client
            .call::<ProjectFromThreads>(params(threads))
            .await
            .unwrap_err();
        assert_eq!(refused.code, INVALID_PARAMS, "{why}: {}", refused.message);
        assert!(refused.message.contains(why), "{why}: {}", refused.message);
    }
    let unknown = client
        .call::<ProjectFromThreads>(params(vec![on_app, RunId::generate()]))
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::ThreadNotFound);
    let auto = client
        .call::<ProjectFromThreads>(ProjectFromThreadsParams {
            permission: ProjectPermission::Auto,
            ..params(vec![on_app])
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&auto), ErrorKind::UnsupportedOption);
    assert!(auto.message.contains("has no Auto"), "{}", auto.message);
    let no_coordinator = client
        .call::<ProjectFromThreads>(ProjectFromThreadsParams {
            account: Some(AccountChoice::Subscription {
                backend: "missing".to_owned(),
            }),
            ..params(vec![on_app])
        })
        .await;
    assert!(no_coordinator.is_err(), "{no_coordinator:?}");
    let projects = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .projects;
    assert!(projects.is_empty(), "a refusal leaves no Project");
    host.server.stop().await;
}
