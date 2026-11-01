use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::{OrchestratorCreateParams, ScopeId};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{Action, Command, Dispatcher, recover, work};
use crate::server::Daemon;
use crate::store::store_error;

fn daemon(dir: &Path) -> Arc<Daemon> {
    Daemon::for_tests(dir, 10, Duration::from_secs(90))
}

/// An orchestrator with no runs, and a file in its context folder for `project.cleanup` to remove.
async fn project(daemon: &Daemon) -> ScopeId {
    let id = ScopeId::generate();
    let (uuid, fields) = crate::store::fields(OrchestratorCreateParams {
        id,
        name: "p".to_owned(),
        repo_path: Some("/nowhere".to_owned()),
        icon: None,
        permission: None,
        autonomy: None,
        base_branch: None,
    });
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.create_orchestrator(uuid, &fields)
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

fn delete(command_id: Uuid, project: ScopeId) -> Command {
    Command::new(Some(command_id), project, Action::DeleteOrchestrator)
}

/// A connection of its own to the database in `dir`.
fn db(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("plxd.sqlite3")).unwrap()
}

/// One count from the database, read on a connection of its own.
fn count(dir: &Path, sql: &str) -> i64 {
    db(dir).query_row(sql, [], |row| row.get(0)).unwrap()
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
        .dispatcher
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
        .dispatcher
        .dispatch(&crashed, delete(Uuid::now_v7(), pending))
        .await
        .unwrap();
    db(dir.path())
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

/// #190 review, blocking item 3: releasing a run id's lock while a queued retry still holds a
/// clone of it must not let a *third*, fresh caller in on a different, uncontended lock. That
/// would mean the retry and the fresh caller could both end up inside the run's critical
/// section at once — exactly what happens after a failed `agent/start`, since the failed
/// attempt's fast path (`existing()`) has nothing to find, so a naive `release` looks safe to
/// call unconditionally.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_lock_is_not_reused_while_a_queued_retry_still_holds_it() {
    let locks = Arc::new(Dispatcher::default());
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
