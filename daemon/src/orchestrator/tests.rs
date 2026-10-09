use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, ProjectCreateParams, ProjectId};
use parallax_store::{Thread, ThreadFields, ThreadUpdate};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    Action, Change, Command, Decision, Effect, Orchestrator, Outcome, Refusal, Rows, ThreadRows,
    decide, recover, work,
};
use crate::server::Daemon;
use crate::store::store_error;

fn daemon(dir: &Path) -> Arc<Daemon> {
    Daemon::for_tests(dir, 10, Duration::from_secs(90))
}

/// A Project with no runs, and a file in its context folder for `project.cleanup` to remove.
async fn project(daemon: &Daemon) -> ProjectId {
    let id = ProjectId::generate();
    let (uuid, fields) = crate::store::fields(ProjectCreateParams {
        id,
        name: "p".to_owned(),
        repo_path: "/nowhere".to_owned(),
        icon: None,
        permission: None,
        autonomy: None,
        base_branch: None,
    });
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.create_project(uuid, &fields)
                .map_err(|e| store_error(&e))
                .map(drop)
        })
        .await
        .unwrap();
    let context = daemon.data_dir.context_dir(id);
    std::fs::create_dir_all(&context).unwrap();
    std::fs::write(context.join("notes.md"), "notes").unwrap();
    id
}

fn delete(command_id: Uuid, project: ProjectId) -> Command {
    Command::new(Some(command_id), project, Action::DeleteProject)
}

/// One count from the database, read on a connection of its own.
fn count(dir: &Path, sql: &str) -> i64 {
    rusqlite::Connection::open(dir.join("plxd.sqlite3"))
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

fn thread_row(title: Option<&str>, settled: bool, archived: bool) -> Thread {
    Thread {
        id: Uuid::now_v7(),
        repo_id: Uuid::now_v7(),
        archived,
        created_at: jiff::Timestamp::now(),
        seen_at: None,
        snoozed_until: None,
        last_prompt_at: jiff::Timestamp::now(),
        parent: None,
        fields: ThreadFields {
            forked_from: None,
            title: title.map(str::to_owned),
        },
        settled,
    }
}

fn rows(thread: Option<Thread>) -> Rows {
    Rows {
        thread: ThreadRows {
            thread,
            ..ThreadRows::default()
        },
        ..Rows::default()
    }
}

/// `decide` is pure: from the rows alone it drops what wouldn't change, applies nothing for a
/// thread already in the asked state, and rejects a missing thread.
#[test]
fn decide_changes_only_what_differs() {
    let id = Uuid::now_v7();
    let row = thread_row(Some("Title"), true, false);
    let update = ThreadUpdate {
        seen: false,
        snoozed_until: None,
        title: Some(Some("Title".to_owned())),
        settled: Some(false),
    };
    assert_eq!(
        decide(id, Action::Update(update), rows(Some(row.clone()))),
        Ok(Decision {
            changes: vec![Change::Update(ThreadUpdate {
                settled: Some(false),
                ..ThreadUpdate::default()
            })],
            effects: Vec::new(),
        })
    );
    let same = ThreadUpdate {
        title: Some(Some("Title".to_owned())),
        ..ThreadUpdate::default()
    };
    assert_eq!(
        decide(id, Action::Update(same), rows(Some(row.clone()))),
        Ok(Decision::default())
    );
    assert_eq!(
        decide(id, Action::Archive(false), rows(Some(row))),
        Ok(Decision::default())
    );
    let Err(Refusal::Rejected(missing)) = decide(id, Action::Archive(true), rows(None)) else {
        panic!("a missing thread is rejected");
    };
    assert_eq!(kind(&missing), ErrorKind::ThreadNotFound);
}

/// Archive and settle release the thread's live session through `provider-session.detach`
/// (0060); unarchiving and unsettling don't.
#[test]
fn archive_and_settle_detach_the_session() {
    let id = Uuid::now_v7();
    let row = thread_row(None, false, false);
    assert_eq!(
        decide(id, Action::Archive(true), rows(Some(row.clone()))),
        Ok(Decision {
            changes: vec![Change::Archive(true)],
            effects: vec![Effect::SessionDetach],
        })
    );
    let settle = ThreadUpdate {
        settled: Some(true),
        ..ThreadUpdate::default()
    };
    assert_eq!(
        decide(id, Action::Update(settle.clone()), rows(Some(row))),
        Ok(Decision {
            changes: vec![Change::Update(settle)],
            effects: vec![Effect::SessionDetach],
        })
    );
}

/// `project.delete` waits for the Project's runs and, once none is left, removes the row and
/// enqueues its cleanup.
#[test]
fn decide_deletes_a_project_only_once_it_has_no_runs() {
    let id = Uuid::now_v7();
    let run = Uuid::now_v7();
    let busy = Rows {
        project: Some("/src".to_owned()),
        runs: vec![run],
        ..Rows::default()
    };
    assert_eq!(
        decide(id, Action::DeleteProject, busy),
        Err(Refusal::Busy(vec![run]))
    );
    let empty = Rows {
        project: Some("/src".to_owned()),
        ..Rows::default()
    };
    assert_eq!(
        decide(id, Action::DeleteProject, empty),
        Ok(Decision {
            changes: vec![Change::DeleteProject],
            effects: vec![Effect::ProjectCleanup {
                repo_path: "/src".to_owned()
            }],
        })
    );
}

fn kind(error: &ErrorObject) -> ErrorKind {
    error.parallax_data().unwrap().kind
}

/// The change, its event, the receipt, and the effect commit in one transaction (0059): when
/// the receipt can't be stored, the Project stays, no event is stored or published, and no
/// effect is enqueued.
#[tokio::test]
async fn a_command_commits_its_change_event_receipt_and_effect_together_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let project = project(&daemon).await;
    let head = daemon.log.head();
    rusqlite::Connection::open(dir.path().join("plxd.sqlite3"))
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER no_receipts BEFORE INSERT ON orchestration_receipts
             BEGIN SELECT RAISE(FAIL, 'injected'); END;",
        )
        .unwrap();

    let failed = daemon
        .orchestrator
        .dispatch(&daemon, delete(Uuid::now_v7(), project))
        .await;
    assert!(failed.is_err(), "{failed:?}");
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM projects"), 1);
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM events"), 0);
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM effects"), 0);
    assert_eq!(daemon.log.head(), head, "nothing was published");

    rusqlite::Connection::open(dir.path().join("plxd.sqlite3"))
        .unwrap()
        .execute_batch("DROP TRIGGER no_receipts")
        .unwrap();
    let command_id = Uuid::now_v7();
    daemon
        .orchestrator
        .dispatch(&daemon, delete(command_id, project))
        .await
        .unwrap();
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM projects"), 0);
    assert_eq!(
        count(
            dir.path(),
            &format!("SELECT COUNT(*) FROM events WHERE command_id = '{command_id}'")
        ),
        1,
        "project.deleted, tagged with its command"
    );
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM effects"), 1);
    assert_eq!(daemon.log.head(), head + 1);
}

/// A repeated command returns its first outcome and applies nothing twice; the same id for
/// another Project is `idConflict`; a rejection is stored, and a repeat returns it.
#[tokio::test]
async fn a_receipt_replays_its_outcome_and_refuses_another_thread() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (first, second) = (project(&daemon).await, project(&daemon).await);
    let command_id = Uuid::now_v7();
    for _ in 0..2 {
        let outcome = daemon
            .orchestrator
            .dispatch(&daemon, delete(command_id, first))
            .await
            .unwrap();
        assert!(matches!(outcome, Outcome::Done(_)));
    }
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM events"), 1);
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM effects"), 1);

    let conflict = daemon
        .orchestrator
        .dispatch(&daemon, delete(command_id, second))
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    assert_eq!(count(dir.path(), "SELECT COUNT(*) FROM projects"), 1);

    let missing = Uuid::now_v7();
    for _ in 0..2 {
        let rejected = daemon
            .orchestrator
            .dispatch(&daemon, delete(missing, first))
            .await
            .unwrap_err();
        assert_eq!(kind(&rejected), ErrorKind::ProjectNotFound);
    }
    assert_eq!(
        count(
            dir.path(),
            "SELECT COUNT(*) FROM orchestration_receipts WHERE status = 'rejected'"
        ),
        1
    );
}

/// Effects survive a crash (0059): one left running when plxd died runs again at the next start,
/// one left pending runs then too, and one of a kind that can't replay is cancelled.
#[tokio::test]
async fn effects_replay_or_retire_after_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    let crashed = daemon(dir.path());
    let (running, pending) = (project(&crashed).await, project(&crashed).await);
    let running_dir = crashed.data_dir.context_dir(running);
    let pending_dir = crashed.data_dir.context_dir(pending);
    crashed
        .orchestrator
        .dispatch(&crashed, delete(Uuid::now_v7(), running))
        .await
        .unwrap();
    // The worker claimed it, and plxd died before it finished.
    crashed
        .store
        .run(&CancellationToken::new(), |db| {
            db.claim_effects(jiff::Timestamp::now(), 1)
                .map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
    crashed
        .orchestrator
        .dispatch(&crashed, delete(Uuid::now_v7(), pending))
        .await
        .unwrap();
    rusqlite::Connection::open(dir.path().join("plxd.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO effects (id, command_id, thread_id, kind, payload, status, attempts,
                 available_at, created_at)
             VALUES ('bound', 'c', ?1, 'provider-turn.start', '{}', 'running', 1, 'then', 'then')",
            [Uuid::now_v7().to_string()],
        )
        .unwrap();
    crashed.store.stop().await;
    crashed.reader.stop().await;
    drop(crashed);
    assert!(
        running_dir.exists() && pending_dir.exists(),
        "nothing ran yet"
    );

    let daemon = daemon(dir.path());
    recover(&daemon).await.unwrap();
    let stop = CancellationToken::new();
    let worker = tokio::spawn(work(Arc::clone(&daemon), stop.clone()));
    let done = "SELECT COUNT(*) FROM effects WHERE status = 'succeeded'";
    tokio::time::timeout(Duration::from_secs(10), async {
        while count(dir.path(), done) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both cleanups ran after the restart");
    stop.cancel();
    worker.await.unwrap();
    assert!(!running_dir.exists() && !pending_dir.exists());
    assert_eq!(
        count(
            dir.path(),
            "SELECT COUNT(*) FROM effects WHERE id = 'bound' AND status = 'cancelled'"
        ),
        1
    );
}

#[test]
fn different_run_ids_get_independent_locks() {
    let locks = Orchestrator::default();
    let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
    assert!(!Arc::ptr_eq(&locks.entry(a), &locks.entry(b)));
}

#[test]
fn the_same_run_id_gets_the_same_lock_until_it_is_released() {
    let locks = Orchestrator::default();
    let id = Uuid::now_v7();
    let first = locks.entry(id);
    assert!(Arc::ptr_eq(&first, &locks.entry(id)));
    locks.release(id);
    assert!(
        !Arc::ptr_eq(&first, &locks.entry(id)),
        "a released id starts fresh, for the next caller to lock uncontended"
    );
}

/// #190 N4: two different runs proceed concurrently through `agents::start`/`actor_for`,
/// while retries or a race for the very same run id still serialize, exactly as the single
/// lock this replaced did.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_different_run_ids_proceed_concurrently_while_the_same_one_serializes() {
    let locks = Orchestrator::default();
    let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
    let hold_a = locks.entry(a).lock_owned().await;

    tokio::time::timeout(Duration::from_millis(200), locks.entry(b).lock_owned())
        .await
        .expect("a different run id was blocked by an unrelated one's lock");

    let waiting = tokio::spawn({
        let lock = locks.entry(a);
        async move {
            lock.lock_owned().await;
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !waiting.is_finished(),
        "a retry for the same run id did not wait for its own lock"
    );
    drop(hold_a);
    waiting.await.unwrap();
}

/// #190 review, blocking item 3: releasing a run id's lock while a queued retry still holds a
/// clone of it must not let a *third*, fresh caller in on a different, uncontended lock. That
/// would mean the retry and the fresh caller could both end up inside the run's critical
/// section at once — exactly what happens after a failed `agent/start`, since the failed
/// attempt's fast path (`existing()`) has nothing to find, so a naive `release` looks safe to
/// call unconditionally.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_lock_is_not_reused_while_a_queued_retry_still_holds_it() {
    let locks = Arc::new(Orchestrator::default());
    let id = Uuid::now_v7();

    // The first attempt takes the lock, then fails and drops its own guard.
    let first = locks.entry(id);
    let first_guard = Arc::clone(&first).lock_owned().await;

    // A retry queues behind it, using the very same lock instance.
    let retry = locks.entry(id);
    assert!(
        Arc::ptr_eq(&first, &retry),
        "a queued retry shares the first attempt's own lock"
    );
    let retry_task = tokio::spawn({
        let retry = Arc::clone(&retry);
        async move {
            let _guard = retry.lock_owned().await;
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!retry_task.is_finished(), "the retry is still queued");

    // Only the map, the first attempt's guard, and the queued retry may hold the lock when
    // `release` runs, as in real use (PLX-91): the test's own `first`/`retry` clones would
    // keep the entry alive by themselves and hide a `release` that removes it too eagerly.
    // Checked with a `Weak`, which also serves the sweep check at the end.
    let old = Arc::downgrade(&retry);
    drop((first, retry));

    // The first attempt "fails" and releases, exactly as `agents::start`/`actor_for` do on any
    // error path. `Starting::drop` calls `release` while its guard is still alive, so the
    // guard is dropped only after the check below (PLX-91): dropping it first let the retry
    // take the lock on the other worker before the check ran.
    locks.release(id);

    // A caller arriving after the release, while the retry is still queued, must still be
    // handed the SAME lock: nothing has succeeded yet, so there is no fast path (`agents.
    // actor(id)`/`existing()`) to protect a third caller from racing the retry.
    let fresh = locks.entry(id);
    assert!(
        Arc::ptr_eq(&old.upgrade().unwrap(), &fresh),
        "a caller after the release still contends for the queued retry's own lock"
    );
    drop(first_guard);

    retry_task.await.unwrap();

    // Once nobody but the map itself holds it, the *next* `get` sweeps it away and a later
    // caller gets a brand-new, uncontended lock: the entry doesn't leak forever. Checked with
    // the `Weak` rather than comparing the new `Arc`'s address to the old one's: once the old
    // allocation is freed, a new one is free to reuse the very same address, which would make
    // a raw-pointer comparison an unreliable false negative.
    drop(fresh);
    let after = locks.entry(id);
    assert!(
        old.upgrade().is_none(),
        "the swept lock is still kept alive somewhere"
    );
    drop(after);
}
