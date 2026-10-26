//! `thread/start` with `project` (PLX-398, 0042): a Project's child, started by plxd under the
//! Project's coordinator without waiting on it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{AgentCancel, AgentList, ProjectUpdate, ThreadStart};
use parallax_protocol::{
    AccountChoice, AccountId, AgentCancelParams, AgentListParams, AgentStatus, InboxKind,
    ProjectId, ProjectUpdateParams, ThreadStartParams,
};
use plxd::backend::fake::Step;
use plxd::backend::{RunRequest, ToolPolicy};

use crate::agents::{Host, create, fake, init, project_params, subscribe};
use crate::coordinator::roles;
use crate::inbox::added;
use crate::support::{PATIENCE, project_update, temp_dir};

fn task_params(project: ProjectId, task: &str) -> ThreadStartParams {
    ThreadStartParams {
        project: Some(project),
        ..super::start_params(None, task)
    }
}

/// `project/update`'s params for `project` that change only `max_children` and `allow_api_keys`.
fn placement_update(
    project: ProjectId,
    max_children: Option<u32>,
    allow_api_keys: Option<bool>,
) -> ProjectUpdateParams {
    ProjectUpdateParams {
        max_children,
        allow_api_keys,
        ..project_update(project)
    }
}

/// The prompts the workers in `seen` were started with, once there are `n`.
async fn worker_prompts(seen: &Mutex<Vec<RunRequest>>, n: usize) -> Vec<String> {
    let deadline = std::time::Instant::now() + PATIENCE;
    loop {
        let prompts: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.policy != ToolPolicy::NoWrite)
            .map(|request| request.prompt.clone())
            .collect();
        if prompts.len() >= n {
            return prompts;
        }
        assert!(std::time::Instant::now() < deadline, "{prompts:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// PLX-413 (0046): over `maxChildren`, a task waits with a reason in the inbox. The queue survives
/// a restart, its oldest task starts once a slot frees, and the next when that one stops.
#[tokio::test]
async fn tasks_over_max_children_wait_across_a_restart_and_start_as_slots_free() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hang = || vec![init("worker"), Step::Hang];
    let host = Host::start(temp_dir(), roles(hang(), Vec::new(), &seen));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    client
        .call::<ProjectUpdate>(placement_update(project.id, Some(1), None))
        .await
        .unwrap();
    subscribe(&mut client, project.id, 0).await;

    let mut runs = Vec::new();
    for task in ["Task A.", "Task B.", "Task C."] {
        let run = client
            .call::<ThreadStart>(task_params(project.id, task))
            .await
            .unwrap()
            .run;
        runs.push(run);
    }
    let reason = "Waiting for a free slot: the Project runs at most 1 child at once";
    for run in &runs[1..] {
        assert_eq!(run.status, AgentStatus::Waiting);
        assert_eq!(run.error.as_deref(), Some(reason));
    }
    let item = added(&mut client, project.id).await;
    assert_eq!((item.run, item.kind), (runs[1].id, InboxKind::Failed));
    assert_eq!(item.text, format!("Task B.: {reason}"));
    assert_eq!(worker_prompts(&seen, 1).await.len(), 1);

    // A restart interrupts A, so B, the oldest waiting, starts with its task, and C waits on.
    let seen = Arc::new(Mutex::new(Vec::new()));
    let host = host.restart(roles(hang(), Vec::new(), &seen)).await;
    let mut client = host.client().await;
    let prompts = worker_prompts(&seen, 1).await;
    assert!(prompts[0].ends_with("Your task:\nTask B."), "{prompts:?}");
    let listed = client
        .call::<AgentList>(AgentListParams {
            project: Some(project.id),
        })
        .await
        .unwrap()
        .runs;
    let c = listed.iter().find(|run| run.id == runs[2].id).unwrap();
    assert_eq!(c.status, AgentStatus::Waiting);

    // Stopping B frees its slot for C.
    client
        .call::<AgentCancel>(AgentCancelParams {
            run_id: runs[1].id,
            from: None,
        })
        .await
        .unwrap();
    let prompts = worker_prompts(&seen, 2).await;
    assert!(prompts[1].ends_with("Your task:\nTask C."), "{prompts:?}");
    host.server.stop().await;
}

/// PLX-413 (0046): a Project's child runs on an API key account only when the Project allows it.
#[tokio::test]
async fn a_task_on_an_api_key_needs_the_project_to_allow_api_keys() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), Step::Hang]));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let on_key = || ThreadStartParams {
        account: Some(AccountChoice::Key {
            id: AccountId::generate(),
        }),
        ..task_params(project.id, "Spend money.")
    };
    let refused = client.call::<ThreadStart>(on_key()).await.unwrap_err();
    assert!(
        refused.message.contains("doesn't allow API keys"),
        "{}",
        refused.message
    );

    client
        .call::<ProjectUpdate>(placement_update(project.id, None, Some(true)))
        .await
        .unwrap();
    let error = client.call::<ThreadStart>(on_key()).await.unwrap_err();
    assert!(
        !error.message.contains("doesn't allow API keys"),
        "allowed, it goes on to look the key up: {}",
        error.message
    );
    host.server.stop().await;
}
