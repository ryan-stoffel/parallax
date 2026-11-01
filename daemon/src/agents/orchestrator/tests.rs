//! An orchestrator is a thread (0093): it archives and settles like one, and an inbox item about
//! a child's end, or one that needs the user, brings it back into the list, saying why.

use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::{
    InboxKind, RunId, ScopeId, ThreadArchiveParams, ThreadUpdateParams, WakeReason,
};
use parallax_store::{OrchestratorFields, RunFields, RunState, Thread};
use uuid::Uuid;

use super::super::tests::run_fields;
use crate::agents::{NO_WRITE, store, store_error};
use crate::server::Daemon;

fn daemon(dir: &std::path::Path) -> Arc<Daemon> {
    Daemon::for_tests(dir, 10, Duration::from_secs(90))
}

/// Stores an orchestrator with `repo`, its run, and the run's thread, as `orchestrator/start`
/// does, and returns the orchestrator and its run.
pub(crate) async fn orchestrator(daemon: &Daemon, repo: Option<&str>) -> (ScopeId, RunId) {
    let (id, run) = (ScopeId::generate(), RunId::generate());
    let repo_path = repo.map(str::to_owned);
    store(daemon, move |db| {
        let fields = OrchestratorFields {
            name: "formula fly".to_owned(),
            repo_path,
            icon: None,
            permission: "auto".to_owned(),
            autonomy: "routine".to_owned(),
            base_branch: None,
        };
        db.create_orchestrator(id.into(), &fields)
            .map_err(|e| store_error(&e))?;
        let fields = RunFields {
            policy: NO_WRITE.to_owned(),
            orchestrator_thread: Some(run.into()),
            ..run_fields(id.into())
        };
        db.create_run(run.into(), &fields, &RunState::default())
            .map_err(|e| store_error(&e))?;
        db.create_orchestrator_thread(run.into(), id.into())
            .map_err(|e| store_error(&e))
    })
    .await
    .unwrap();
    (id, run)
}

/// Starts `orchestrator` over on a new run, as a Start over does, and returns the run.
pub(crate) async fn replace(daemon: &Daemon, orchestrator: ScopeId) -> RunId {
    let run = RunId::generate();
    store(daemon, move |db| {
        let fields = RunFields {
            policy: NO_WRITE.to_owned(),
            orchestrator_thread: Some(run.into()),
            ..run_fields(orchestrator.into())
        };
        db.create_run(run.into(), &fields, &RunState::default())
            .map_err(|e| store_error(&e))?;
        db.create_orchestrator_thread(run.into(), orchestrator.into())
            .map_err(|e| store_error(&e))
    })
    .await
    .unwrap();
    run
}

pub(crate) async fn thread(daemon: &Daemon, run: RunId) -> Thread {
    store(daemon, move |db| {
        db.get_thread(run.into()).map_err(|e| store_error(&e))
    })
    .await
    .unwrap()
    .unwrap()
}

pub(crate) async fn archive(daemon: &Arc<Daemon>, run_id: RunId, archived: bool) {
    let params = ThreadArchiveParams { run_id, archived };
    crate::threads::archive(daemon, params, None).await.unwrap();
}

/// Adds an inbox item of `kind` about `child` to `orchestrator`'s inbox.
async fn inbox(daemon: &Daemon, orchestrator: ScopeId, child: RunId, kind: InboxKind) {
    store(daemon, move |db| {
        crate::methods::inbox::record(db, orchestrator, child, kind, "t".to_owned())
    })
    .await
    .unwrap();
}

pub(crate) fn reason(thread: &Thread) -> Option<WakeReason> {
    thread
        .wake_reason
        .as_deref()
        .map(|reason| serde_json::from_str(reason).unwrap())
}

#[tokio::test]
async fn an_orchestrator_archives_and_settles_like_a_thread() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (id, run) = orchestrator(&daemon, None).await;
    let row = thread(&daemon, run).await;
    assert_eq!(row.orchestrator_id, Some(id.into()));
    assert_eq!(
        row.repo_id,
        Uuid::from(id),
        "in its orchestrator, as its children are"
    );

    archive(&daemon, run, true).await;
    assert!(thread(&daemon, run).await.archived);
    archive(&daemon, run, false).await;
    assert!(!thread(&daemon, run).await.archived);

    let settle = ThreadUpdateParams {
        run_id: run,
        seen: false,
        snoozed_until: None,
        title: None,
        settled: Some(true),
        pinned: None,
    };
    crate::threads::update(&daemon, settle, None).await.unwrap();
    assert!(thread(&daemon, run).await.settled);
}

#[tokio::test]
async fn a_childs_end_wakes_an_archived_orchestrator_and_says_which_child() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (id, run) = orchestrator(&daemon, Some("/src/app")).await;
    let child = RunId::generate();

    // In the list, it stays as it is.
    inbox(&daemon, id, child, InboxKind::Done).await;
    assert_eq!(thread(&daemon, run).await.wake_reason, None);

    archive(&daemon, run, true).await;
    inbox(&daemon, id, child, InboxKind::Failed).await;
    let woken = thread(&daemon, run).await;
    assert!(!woken.archived);
    assert_eq!(reason(&woken), Some(WakeReason::ChildFinished { child }));
    let entry = crate::threads::thread_entry(&woken).unwrap();
    assert_eq!(entry.wake_reason, Some(WakeReason::ChildFinished { child }));

    // Archiving it again forgets why it woke.
    archive(&daemon, run, true).await;
    assert_eq!(thread(&daemon, run).await.wake_reason, None);
}

#[tokio::test]
async fn needing_the_user_wakes_an_archived_orchestrator() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (id, run) = orchestrator(&daemon, None).await;
    let child = RunId::generate();
    archive(&daemon, run, true).await;

    // What the orchestrator decided or learned wakes nothing.
    inbox(&daemon, id, child, InboxKind::Learned).await;
    assert!(thread(&daemon, run).await.archived);

    inbox(&daemon, id, child, InboxKind::NeedsYou).await;
    let woken = thread(&daemon, run).await;
    assert!(!woken.archived && !woken.settled);
    assert_eq!(reason(&woken), Some(WakeReason::NeedsYou { run: child }));
}

#[tokio::test]
async fn an_orchestrator_with_no_repo_has_no_integration_branch() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (id, _) = orchestrator(&daemon, None).await;
    let row = crate::agents::integration(&daemon, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.repo_path, None);
    assert_eq!(row.integration_branch, None);
}
