//! An orchestrator is a thread (0093, PLX-1176): `orchestrator/start` makes its run a thread with
//! orchestration on, and one with no repo plans in a folder of its own, its children work in
//! scratch repositories, and nothing lands.

use parallax_protocol::methods::{
    AgentStart, LandQueue, OrchestratorStart, ThreadArchive, ThreadDelete, ThreadFork, ThreadList,
    ThreadUpdate,
};
use parallax_protocol::{
    AgentOutputItem, AgentStartParams, AgentStatus, ErrorKind, LandQueueParams,
    OrchestratorCreateParams, ParallaxEvent, RunId, ThreadArchiveParams, ThreadDeleteParams,
    ThreadForkParams, ThreadListParams, ThreadUpdateParams, WakeReason,
};

use plxd::backend::fake::{AskedApproval, Step};

use crate::agents::{Host, create, end_turn, fake, init, subscribe, until, updated_to};
use crate::orchestrator::start_params;
use crate::support::{kind, temp_dir};

#[tokio::test]
async fn an_orchestrator_with_no_repo_is_a_thread_whose_children_never_land() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), end_turn("Planned.")]));
    let mut client = host.client().await;
    let orchestrator = create(
        &mut client,
        OrchestratorCreateParams {
            repo_path: None,
            ..crate::agents::orchestrator_params(host.dir.path())
        },
    )
    .await;
    assert_eq!(orchestrator.repo_path, "");
    assert_eq!(orchestrator.integration_branch, None);
    subscribe(&mut client, orchestrator.id, 0).await;

    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan it."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let folder = host
        .dir
        .path()
        .join("coordinators")
        .join(orchestrator.id.to_string());
    assert!(
        folder.is_dir() && !folder.join(".git").exists(),
        "its own folder"
    );
    let threads = client
        .call::<ThreadList>(ThreadListParams::default())
        .await
        .unwrap()
        .threads;
    let thread = threads.iter().find(|thread| thread.id == run.id).unwrap();
    assert_eq!(thread.orchestrator, Some(orchestrator.id));

    let child = client
        .call::<AgentStart>(AgentStartParams {
            orchestrator_thread: run.orchestrator_thread,
            ..crate::agents::start_params(orchestrator.id, "Build it.")
        })
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let scratch = host.dir.path().join("scratch").join(child.id.to_string());
    assert!(
        scratch.join(".git").exists(),
        "a scratch repository of its own"
    );
    let refused = client
        .call::<LandQueue>(LandQueueParams { run_id: child.id })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::LandRefused);
    assert!(
        refused.message.contains("has no repo"),
        "{}",
        refused.message
    );
    host.server.stop().await;
}

/// The sidebar's actions reach the thread `orchestrator/start` makes (PLX-1217): pinning and
/// archiving it, and forking it into an ordinary thread on its repository.
#[tokio::test]
async fn an_orchestrators_thread_pins_archives_and_forks_like_any_thread() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), end_turn("Planned.")]));
    let mut client = host.client().await;
    // Outside plxd's data folder, where `repo/add` refuses a repository.
    let outside = temp_dir();
    let params = crate::agents::orchestrator_params(outside.path());
    let repo_path = params.repo_path.clone().unwrap();
    let orchestrator = create(&mut client, params).await;
    subscribe(&mut client, orchestrator.id, 0).await;
    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan it."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let pinned = client
        .call::<ThreadUpdate>(ThreadUpdateParams {
            run_id: run.id,
            seen: false,
            snoozed_until: None,
            title: None,
            settled: None,
            pinned: Some(true),
        })
        .await
        .unwrap()
        .thread;
    assert!(pinned.pinned);
    let archived = client
        .call::<ThreadArchive>(ThreadArchiveParams {
            run_id: run.id,
            archived: true,
        })
        .await
        .unwrap()
        .thread;
    assert!(archived.archived);

    let forked = client
        .call::<ThreadFork>(fork_params(run.id))
        .await
        .unwrap();
    let listed = client
        .call::<ThreadList>(ThreadListParams::default())
        .await
        .unwrap();
    let entry = listed
        .repos
        .iter()
        .find(|repo| repo.id == forked.thread.repo)
        .unwrap();
    let canonical = std::path::Path::new(&repo_path).canonicalize().unwrap();
    assert_eq!(std::path::Path::new(&entry.path), canonical);
    assert_eq!(forked.thread.orchestrator, None);
    host.server.stop().await;
}

/// An orchestrator's own permission request brings its archived thread back: nothing else shows
/// that it waits on the user (0093).
#[tokio::test]
async fn an_orchestrators_permission_request_wakes_its_archived_thread() {
    let host = Host::start(
        temp_dir(),
        fake(vec![
            init("s"),
            // Time to archive it mid-turn: a message from the user would un-archive it.
            Step::SleepMs(1000),
            Step::RequestApproval(AskedApproval {
                tool_name: "Bash".to_owned(),
                input: serde_json::json!({"command": "pnpm test"}),
                call_id: None,
                reason: None,
                always_allow: Vec::new(),
                interactive: false,
            }),
            Step::AwaitApproval,
            end_turn("Done."),
        ]),
    );
    let mut client = host.client().await;
    let orchestrator = create(
        &mut client,
        crate::agents::orchestrator_params(host.dir.path()),
    )
    .await;
    subscribe(&mut client, orchestrator.id, 0).await;
    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan it."))
        .await
        .unwrap()
        .run;
    let archived = client
        .call::<ThreadArchive>(ThreadArchiveParams {
            run_id: run.id,
            archived: true,
        })
        .await
        .unwrap()
        .thread;
    assert!(archived.archived);

    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. }
            if items.iter().any(|item| matches!(item, AgentOutputItem::ApprovalRequested { .. })))
    })
    .await;
    let mut woken = None;
    for _ in 0..50 {
        let threads = client
            .call::<ThreadList>(ThreadListParams::default())
            .await
            .unwrap()
            .threads;
        woken = threads.into_iter().find(|thread| thread.id == run.id);
        if woken.as_ref().is_some_and(|thread| !thread.archived) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let woken = woken.unwrap();
    assert!(!woken.archived);
    assert_eq!(
        woken.wake_reason,
        Some(WakeReason::NeedsYou { run: run.id })
    );
    host.server.stop().await;
}

/// `thread/delete` refuses an orchestrator's thread: its memory, board, and children would be left
/// behind. Storage's Delete all sends it for every archived thread.
#[tokio::test]
async fn an_orchestrators_thread_goes_only_with_the_orchestrator() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), end_turn("Planned.")]));
    let mut client = host.client().await;
    let orchestrator = create(
        &mut client,
        crate::agents::orchestrator_params(host.dir.path()),
    )
    .await;
    subscribe(&mut client, orchestrator.id, 0).await;
    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan it."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let refused = client
        .call::<ThreadDelete>(ThreadDeleteParams { run_id: run.id })
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("is an orchestrator's"),
        "{}",
        refused.message
    );
    let threads = client
        .call::<ThreadList>(ThreadListParams::default())
        .await
        .unwrap()
        .threads;
    assert!(threads.iter().any(|thread| thread.id == run.id));
    host.server.stop().await;
}

/// A fork of an orchestrator with no repo is a thread with no repo.
#[tokio::test]
async fn a_fork_of_an_orchestrator_with_no_repo_has_no_repo() {
    let host = Host::start(temp_dir(), fake(vec![init("s"), end_turn("Planned.")]));
    let mut client = host.client().await;
    let orchestrator = create(
        &mut client,
        OrchestratorCreateParams {
            repo_path: None,
            ..crate::agents::orchestrator_params(host.dir.path())
        },
    )
    .await;
    subscribe(&mut client, orchestrator.id, 0).await;
    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan it."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let forked = client
        .call::<ThreadFork>(fork_params(run.id))
        .await
        .unwrap();
    let listed = client
        .call::<ThreadList>(ThreadListParams::default())
        .await
        .unwrap();
    let entry = listed
        .repos
        .iter()
        .find(|repo| repo.id == forked.thread.repo)
        .unwrap();
    assert!(entry.scratch);
    host.server.stop().await;
}

fn fork_params(run_id: RunId) -> ThreadForkParams {
    ThreadForkParams {
        run_id,
        turn_id: None,
        new_run_id: RunId::generate(),
        account: None,
        model: None,
        parent: None,
    }
}
