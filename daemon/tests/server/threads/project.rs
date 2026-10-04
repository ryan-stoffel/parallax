//! `thread/start` with `project` (PLX-398, 0042): a Project's child, started by plxd under the
//! Project's coordinator without waiting on it.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{AgentSend, ProjectList, ProjectStart, ThreadStart};
use parallax_protocol::{
    AgentDelivery, AgentSendParams, ProjectId, ProjectListParams, ThreadStartParams, TurnId,
};
use plxd::backend::ToolPolicy;
use plxd::backend::fake::Step;

use crate::agents::{Host, create, end_turn, git, init, project_params, send_params, subscribe};
use crate::coordinator::{nth_launch, roles, sessions, start_params};
use crate::support::temp_dir;

fn task_params(project: ProjectId, task: &str) -> ThreadStartParams {
    ThreadStartParams {
        project: Some(project),
        ..super::start_params(None, task)
    }
}

/// Seven tasks started while the coordinator's turn is still open all return, each a child of
/// the coordinator with the header before the user's words, cut from the integration branch. Once
/// the turn ends, one wake-up names all seven.
#[tokio::test]
async fn seven_tasks_start_without_waiting_on_the_coordinator_and_wake_it_once() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(
        vec![init("worker-1"), Step::Hang],
        vec![
            vec![
                init("coordinator-1"),
                Step::AwaitFollowUp,
                end_turn("Planned."),
            ],
            vec![init("coordinator-1"), end_turn("Noted.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    sessions(&mut client, &[coordinator.id]).await;

    let mut children = Vec::new();
    for n in 1..=7 {
        let started = client
            .call::<ThreadStart>(task_params(project.id, &format!("Task {n}.")))
            .await
            .unwrap();
        assert_eq!(started.thread.parent, Some(coordinator.id));
        assert_eq!(started.run.project, project.id);
        assert!(started.run.approvals, "a child asks through the inbox");
        children.push(started.run);
    }
    let coordinator_launches = || {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|request| request.policy == ToolPolicy::NoWrite)
            .count()
    };
    assert_eq!(coordinator_launches(), 1, "its first turn is still open");
    let prompts: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.policy != ToolPolicy::NoWrite)
        .map(|request| request.prompt.clone())
        .collect();
    assert_eq!(prompts.len(), 7);
    for (n, prompt) in (1..).zip(&prompts) {
        assert!(
            prompt.starts_with("You are working on a task in the Parallax Project")
                && prompt.ends_with(&format!("Your task:\nTask {n}.")),
            "{prompt}"
        );
    }
    let integration = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .projects[0]
        .integration_branch
        .clone()
        .expect("the first child cut the integration branch");
    let tip = git(Path::new(&project.repo_path), &["rev-parse", &integration]);
    for child in &children {
        let worktree = child
            .worktree_path
            .as_deref()
            .expect("a child has a worktree");
        assert_eq!(git(Path::new(worktree), &["rev-parse", "HEAD"]), tip);
    }

    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(AgentDelivery::Steer),
            ..send_params(coordinator.id, TurnId::generate(), "Go on.")
        })
        .await
        .unwrap();
    let wake = nth_launch(&seen, 1).await;
    for (n, child) in (1..).zip(&children) {
        let line = format!("- Run {} (Task {n}.): started.", child.id);
        assert!(wake.prompt.contains(&line), "{}", wake.prompt);
    }
    // Past wake-ups' 2 s batch: nothing else wakes it.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(coordinator_launches(), 2, "one wake-up");
    host.server.stop().await;
}

/// A Project with no coordinator yet still starts the task, with no parent. A task can't pick
/// what the Project decides.
#[tokio::test]
async fn a_task_starts_with_no_parent_before_the_project_has_a_coordinator() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        temp_dir(),
        roles(vec![init("worker-1"), Step::Hang], Vec::new(), &seen),
    );
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;

    let started = client
        .call::<ThreadStart>(task_params(project.id, "Add a README."))
        .await
        .unwrap();
    assert_eq!(started.thread.parent, None);
    assert_eq!(started.run.project, project.id);

    let refused = client
        .call::<ThreadStart>(ThreadStartParams {
            checkout: true,
            ..task_params(project.id, "Add a license.")
        })
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "{}", refused.message);
    host.server.stop().await;
}
