use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use parallax_protocol::{
    Schedule, ScheduleRunStatus, ScheduleSaveParams, SignatureEncoding, WebhookSignature,
};
use ring::hmac;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{Fired, Trigger, fire, fire_job, hook, next_run, put, read, run, save};
use crate::server::Daemon;
use crate::store::store_error;

fn check(params: &ScheduleSaveParams) -> Result<(), parallax_protocol::jsonrpc::ErrorObject> {
    super::check(params, true)
}

fn daemon(dir: &Path) -> Arc<Daemon> {
    Daemon::for_tests(dir, 10, Duration::from_secs(90))
}

fn params(schedule: Schedule) -> ScheduleSaveParams {
    ScheduleSaveParams {
        id: None,
        title: "Triage".to_owned(),
        prompt: "Triage today's issues.".to_owned(),
        enabled: true,
        schedule,
        thread: None,
        project: None,
        repo: None,
        account: None,
        model: None,
        effort: None,
        permission: None,
        from: None,
    }
}

const HOURLY: Schedule = Schedule::Interval {
    every_ms: 3_600_000,
};

fn at(text: &str) -> Timestamp {
    text.parse().unwrap()
}

/// The thread.wake effects' payloads for task `id`, oldest first.
fn wakes(dir: &Path, id: Uuid) -> Vec<String> {
    let conn = rusqlite::Connection::open(dir.join("plxd.sqlite3")).unwrap();
    let mut stmt = conn
        .prepare("SELECT payload FROM effects WHERE thread_id = ?1 ORDER BY rowid")
        .unwrap();
    stmt.query_map([id.to_string()], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Moves task `id`'s next run to `due`, as if it came due.
async fn due_at(daemon: &Daemon, id: Uuid, due: Timestamp) {
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let mut stored = read(db, id)?.unwrap();
            stored.task.next_run_at = Some(due);
            put(db, &stored)
        })
        .await
        .unwrap();
}

async fn stored(daemon: &Daemon, id: Uuid) -> super::Stored {
    daemon
        .reader
        .run(&CancellationToken::new(), move |db| read(db, id))
        .await
        .unwrap()
        .unwrap()
}

#[test]
fn next_runs_follow_t3s_rules() {
    let utc = TimeZone::UTC;
    // Friday morning.
    let from = at("2026-10-09T08:30:00Z");
    let short = Schedule::Interval { every_ms: 1_000 };
    assert_eq!(
        next_run(&short, from, &utc),
        Some(at("2026-10-09T08:31:00Z"))
    );
    assert_eq!(
        next_run(&HOURLY, from, &utc),
        Some(at("2026-10-09T09:30:00Z"))
    );

    let daily = |time: &str, weekdays: Vec<u8>| Schedule::FixedTime {
        time_of_day: time.to_owned(),
        weekdays,
    };
    assert_eq!(
        next_run(&daily("9:00", Vec::new()), from, &utc),
        Some(at("2026-10-09T09:00:00Z"))
    );
    assert_eq!(
        next_run(&daily("08:30", Vec::new()), from, &utc),
        Some(at("2026-10-10T08:30:00Z")),
        "a time already reached is tomorrow's"
    );
    assert_eq!(
        next_run(&daily("09:00", vec![1]), from, &utc),
        Some(at("2026-10-12T09:00:00Z")),
        "Mondays only"
    );
    assert_eq!(
        next_run(&Schedule::Webhook { signature: None }, from, &utc),
        None
    );
}

#[test]
fn a_save_out_of_range_is_refused() {
    assert!(check(&params(HOURLY)).is_ok());
    assert!(check(&params(Schedule::Interval { every_ms: 59_999 })).is_err());
    for time in ["24:00", "9:5", "09:60", "nine", "009:00"] {
        let schedule = Schedule::FixedTime {
            time_of_day: time.to_owned(),
            weekdays: Vec::new(),
        };
        assert!(check(&params(schedule)).is_err(), "{time}");
    }
    let schedule = Schedule::FixedTime {
        time_of_day: "09:00".to_owned(),
        weekdays: vec![7],
    };
    assert!(check(&params(schedule)).is_err());
    let mut both = params(HOURLY);
    both.thread = Some(parallax_protocol::RunId::generate());
    both.project = Some(parallax_protocol::ProjectId::generate());
    assert!(check(&both).is_err());
    let mut empty = params(HOURLY);
    empty.prompt = " ".to_owned();
    assert!(check(&empty).is_err());
}

#[tokio::test]
async fn a_fire_commits_once_per_due_time_even_when_tried_again() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let task = save(&daemon, params(HOURLY)).await.unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    let created = task.next_run_at.unwrap();
    assert!(created > Timestamp::now() + SignedDuration::from_mins(59));
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Skipped
    ));
    assert!(wakes(dir.path(), id).is_empty(), "not due yet");

    let due = Timestamp::now() - SignedDuration::from_secs(1);
    due_at(&daemon, id, due).await;
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Sent(_)
    ));
    let fired = stored(&daemon, id).await.task;
    assert_eq!(fired.run_count, 1);
    assert_eq!(fired.last_run_status, ScheduleRunStatus::Running);
    assert!(fired.next_run_at.unwrap() > Timestamp::now() + SignedDuration::from_mins(59));
    let sent = wakes(dir.path(), id);
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains(r#""kind":"thread.wake""#), "{}", sent[0]);
    assert!(sent[0].contains(r#""type":"new""#), "{}", sent[0]);
    assert!(sent[0].contains("Triage today's issues."), "{}", sent[0]);

    // The next run moved with the fire, so the timer finds nothing due.
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Skipped
    ));
    // A task back at a due time it already fired for, as a restart would retry it, finds the
    // fire's receipt and commits nothing.
    due_at(&daemon, id, due).await;
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Sent(_)
    ));
    assert_eq!(wakes(dir.path(), id).len(), 1);
    assert_eq!(stored(&daemon, id).await.task.run_count, 1);
}

#[tokio::test]
async fn a_fixed_time_missed_by_more_than_ten_minutes_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let schedule = Schedule::FixedTime {
        time_of_day: "09:00".to_owned(),
        weekdays: Vec::new(),
    };
    let id = Uuid::try_parse(&save(&daemon, params(schedule)).await.unwrap().id).unwrap();
    let missed = Timestamp::now() - SignedDuration::from_mins(11);
    due_at(&daemon, id, missed).await;
    let now = Timestamp::now();
    let skipped = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            fire_job(db, id, Trigger::Scheduled, now)
        })
        .await
        .unwrap();
    assert!(matches!(skipped, Fired::Skipped));
    assert!(wakes(dir.path(), id).is_empty());
    let task = stored(&daemon, id).await.task;
    assert_eq!(task.run_count, 0);
    assert!(task.next_run_at.unwrap() > now, "moved to the next 09:00");
}

#[tokio::test]
async fn the_timer_fires_a_task_when_it_comes_due() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let stop = CancellationToken::new();
    let timer = tokio::spawn(run(Arc::clone(&daemon), stop.clone()));
    // A due row that can't be read fails to fire, and is tried again later, not at once, so it
    // neither spins the timer nor holds back the task after it.
    let broken = Uuid::now_v7();
    let overdue = Timestamp::now() - SignedDuration::from_secs(1);
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.put_scheduled_task(broken, Some(overdue), "not json")
                .map_err(|e| crate::store::store_error(&e))
        })
        .await
        .unwrap();
    let id = Uuid::try_parse(&save(&daemon, params(HOURLY)).await.unwrap().id).unwrap();
    due_at(
        &daemon,
        id,
        Timestamp::now() + SignedDuration::from_millis(200),
    )
    .await;
    daemon.schedules.changed.notify_one();
    tokio::time::timeout(Duration::from_secs(10), async {
        while wakes(dir.path(), id).is_empty() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the timer fired");
    assert_eq!(stored(&daemon, id).await.task.run_count, 1);
    let retry: String = rusqlite::Connection::open(dir.path().join("plxd.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT next_run_at FROM scheduled_tasks WHERE id = ?1",
            [broken.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        retry.parse::<Timestamp>().unwrap() > Timestamp::now(),
        "postponed"
    );
    stop.cancel();
    timer.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_signed_webhook_fires_its_prompt_with_the_bodys_values() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let mut webhook = params(Schedule::Webhook {
        signature: Some(WebhookSignature {
            header: "x-hub-signature-256".to_owned(),
            encoding: SignatureEncoding::Hex,
            prefix: "sha256=".to_owned(),
            secret: Some("s3cret".to_owned()),
            secret_ref: None,
        }),
    });
    webhook.prompt =
        "Write notes for {{body.release.tag_name}} ({{headers.x-github-event}})\n{{request}}"
            .to_owned();
    let task = save(&daemon, webhook).await.unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    let endpoint = task.webhook.unwrap();
    assert!(endpoint.has_secret);
    assert_eq!(endpoint.url, None, "remote access is off");
    assert!(task.next_run_at.is_none());
    let Schedule::Webhook {
        signature: Some(signature),
    } = &task.schedule
    else {
        panic!("{:?}", task.schedule);
    };
    assert_eq!(signature.secret, None, "never shown");
    let row = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.scheduled_task(id).map_err(|e| store_error(&e))
        })
        .await
        .unwrap()
        .unwrap();
    assert!(!row.contains("s3cret"), "the keystore keeps it: {row}");

    let body = br#"{"action":"published","release":{"tag_name":"v1.2"}}"#;
    let key = hmac::Key::new(hmac::HMAC_SHA256, b"s3cret");
    let digest = data_encoding::HEXLOWER.encode(hmac::sign(&key, body).as_ref());
    let headers = |signature: &str| {
        HashMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("x-github-event".to_owned(), "release".to_owned()),
            (
                "x-hub-signature-256".to_owned(),
                format!("sha256={signature}"),
            ),
        ])
    };
    let wrong = format!("{}nope", endpoint.path);
    let (status, _) = hook(&daemon, "POST", &wrong, &headers(&digest), body).await;
    assert_eq!(status, 404, "a wrong token");
    let (status, _) = hook(&daemon, "POST", &endpoint.path, &headers("00"), body).await;
    assert_eq!(status, 401, "a wrong signature");
    assert!(wakes(dir.path(), id).is_empty());

    let path = format!("{}?source=ci", endpoint.path);
    let (status, answer) = hook(&daemon, "POST", &path, &headers(&digest), body).await;
    assert_eq!(status, 202, "{answer}");
    assert!(answer["deliveryId"].is_string());
    let sent = wakes(dir.path(), id);
    assert_eq!(sent.len(), 1);
    assert!(
        sent[0].contains("Write notes for v1.2 (release)"),
        "{}",
        sent[0]
    );
    let token = endpoint.path.rsplit('/').next().unwrap();
    let line = format!("POST /api/hooks/{id}?source=ci");
    assert!(sent[0].contains(&line), "{}", sent[0]);
    assert!(
        !sent[0].contains(token),
        "the token never reaches the prompt"
    );

    let mut paused = params(task.schedule.clone());
    paused.id = Some(task.id.clone());
    paused.enabled = false;
    save(&daemon, paused).await.unwrap();
    let (status, _) = hook(&daemon, "POST", &endpoint.path, &headers(&digest), body).await;
    assert_eq!(status, 409, "paused");
    assert!(
        stored(&daemon, id).await.keychain,
        "a save without one keeps it"
    );
    let key = parallax_protocol::AccountId::try_from(id).unwrap();
    assert_eq!(
        daemon.keys.get(key).unwrap().as_deref().map(String::as_str),
        Some("s3cret")
    );
    super::delete(&daemon, parallax_protocol::ScheduleIdParams { id: task.id })
        .await
        .unwrap();
    assert_eq!(
        daemon.keys.get(key).unwrap(),
        None,
        "deleting it removes its secret"
    );
}

#[derive(Debug, Default)]
struct FaultKeys {
    values: std::sync::Mutex<HashMap<parallax_protocol::AccountId, String>>,
    fail_read: std::sync::atomic::AtomicBool,
    fail_write: std::sync::atomic::AtomicBool,
    deletes: std::sync::atomic::AtomicUsize,
}

impl crate::keystore::KeyStore for FaultKeys {
    fn get(
        &self,
        id: parallax_protocol::AccountId,
    ) -> Result<Option<zeroize::Zeroizing<String>>, crate::keystore::KeyStoreError> {
        if self.fail_read.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::keystore::KeyStoreError::unavailable(
                "test read failure",
            ));
        }
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .map(Into::into))
    }
    fn set(
        &self,
        id: parallax_protocol::AccountId,
        value: &str,
    ) -> Result<(), crate::keystore::KeyStoreError> {
        if self.fail_write.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::keystore::KeyStoreError::unavailable(
                "test write failure",
            ));
        }
        self.values.lock().unwrap().insert(id, value.to_owned());
        Ok(())
    }
    fn delete(
        &self,
        id: parallax_protocol::AccountId,
    ) -> Result<(), crate::keystore::KeyStoreError> {
        self.deletes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.values.lock().unwrap().remove(&id);
        Ok(())
    }
}

fn fault_daemon(dir: &Path) -> (Arc<Daemon>, Arc<FaultKeys>) {
    let mut daemon = daemon(dir);
    let keys = Arc::new(FaultKeys::default());
    Arc::get_mut(&mut daemon).unwrap().keys = keys.clone();
    (daemon, keys)
}

fn signed(secret: &str) -> ScheduleSaveParams {
    params(Schedule::Webhook {
        signature: Some(WebhookSignature {
            header: "x-signature".to_owned(),
            encoding: SignatureEncoding::Hex,
            prefix: String::new(),
            secret: Some(secret.to_owned()),
            secret_ref: None,
        }),
    })
}

#[test]
fn windows_refuses_signed_webhooks_before_any_store_operation() {
    assert_eq!(
        super::check(&signed("test-value"), false)
            .unwrap_err()
            .parallax_data()
            .unwrap()
            .kind,
        parallax_protocol::ErrorKind::KeychainUnavailable
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_secret_writes_leave_no_task_and_keep_existing_tasks() {
    use std::sync::atomic::Ordering::SeqCst;
    let dir = tempfile::tempdir().unwrap();
    let (daemon, keys) = fault_daemon(dir.path());
    keys.fail_write.store(true, SeqCst);
    assert!(save(&daemon, signed("new-value")).await.is_err());
    assert!(super::list(&daemon).await.unwrap().tasks.is_empty());
    keys.fail_write.store(false, SeqCst);
    let task = save(&daemon, signed("working-value")).await.unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    let before = stored(&daemon, id).await;
    let mut replacement = signed("replacement-value");
    replacement.id = Some(task.id);
    replacement.title = "Changed".to_owned();
    keys.fail_write.store(true, SeqCst);
    assert!(save(&daemon, replacement.clone()).await.is_err());
    assert_eq!(stored(&daemon, id).await.task, before.task);
    keys.fail_write.store(false, SeqCst);
    keys.fail_read.store(true, SeqCst);
    assert!(save(&daemon, replacement).await.is_err());
    assert_eq!(
        keys.values
            .lock()
            .unwrap()
            .get(&parallax_protocol::AccountId::try_from(id).unwrap())
            .unwrap(),
        "working-value"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_row_write_restores_the_previous_working_secret() {
    let dir = tempfile::tempdir().unwrap();
    let (daemon, keys) = fault_daemon(dir.path());
    let task = save(&daemon, signed("working-value")).await.unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("plxd.sqlite3")).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_schedule BEFORE INSERT ON scheduled_tasks BEGIN SELECT RAISE(FAIL, 'test row failure'); END;").unwrap();
    let mut replacement = signed("replacement-value");
    replacement.id = Some(task.id);
    assert!(save(&daemon, replacement).await.is_err());
    assert_eq!(
        keys.values
            .lock()
            .unwrap()
            .get(&parallax_protocol::AccountId::try_from(id).unwrap())
            .unwrap(),
        "working-value"
    );
    assert!(save(&daemon, signed("new-value")).await.is_err());
    assert_eq!(
        keys.values.lock().unwrap().len(),
        1,
        "new task key rolled back"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn legacy_secrets_migrate_and_are_wiped_only_with_a_working_store() {
    use std::sync::atomic::Ordering::SeqCst;
    const LEGACY: &str = "plx648-legacy-test-value";
    let dir = tempfile::tempdir().unwrap();
    let (daemon, keys) = fault_daemon(dir.path());
    let task = save(&daemon, signed(LEGACY)).await.unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    keys.values.lock().unwrap().clear();
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let mut row = read(db, id)?.unwrap();
            row.keychain = false;
            row.secret = Some(LEGACY.to_owned());
            put(db, &row)
        })
        .await
        .unwrap();
    keys.fail_write.store(true, SeqCst);
    super::move_old_secrets(&daemon).await;
    assert_eq!(stored(&daemon, id).await.secret.as_deref(), Some(LEGACY));
    let endpoint = task.webhook.unwrap();
    let (status, answer) = hook(&daemon, "POST", &endpoint.path, &HashMap::new(), b"{}").await;
    assert_eq!(status, 503, "{answer}");
    keys.fail_write.store(false, SeqCst);
    super::move_old_secrets(&daemon).await;
    let row = stored(&daemon, id).await;
    assert!(row.secret.is_none());
    assert!(row.keychain);
    assert_eq!(
        keys.values
            .lock()
            .unwrap()
            .get(&parallax_protocol::AccountId::try_from(id).unwrap())
            .unwrap(),
        LEGACY
    );
    for name in ["plxd.sqlite3", "plxd.sqlite3-wal"] {
        let bytes = std::fs::read(dir.path().join(name)).unwrap_or_default();
        assert!(
            !bytes
                .windows(LEGACY.len())
                .any(|window| window == LEGACY.as_bytes()),
            "{name} retains migrated plaintext"
        );
    }
}

#[tokio::test]
async fn deleting_an_unsigned_task_never_calls_the_keystore() {
    let dir = tempfile::tempdir().unwrap();
    let (daemon, keys) = fault_daemon(dir.path());
    let task = save(&daemon, params(HOURLY)).await.unwrap();
    super::delete(&daemon, parallax_protocol::ScheduleIdParams { id: task.id })
        .await
        .unwrap();
    assert_eq!(keys.deletes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn validation_and_transient_read_errors_preserve_a_secret_ref() {
    use crate::keystore::KeyStore;
    use std::sync::atomic::Ordering::SeqCst;
    let dir = tempfile::tempdir().unwrap();
    let (daemon, keys) = fault_daemon(dir.path());
    let key = parallax_protocol::AccountId::generate();
    let thread = parallax_protocol::RunId::generate();
    keys.set(key, "ref-test-value").unwrap();
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.add_secret_ref(
                key.into(),
                thread.into(),
                Timestamp::now() + SignedDuration::from_hours(1),
            )
            .map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
    let secret_ref = format!("secret-ref:{key}");
    let mut invalid = signed("unused");
    invalid.from = Some(thread);
    invalid.id = Some(Uuid::now_v7().to_string());
    if let Schedule::Webhook {
        signature: Some(signature),
    } = &mut invalid.schedule
    {
        signature.secret = None;
        signature.secret_ref = Some(secret_ref.clone());
    }
    assert!(
        save(&daemon, invalid.clone()).await.is_err(),
        "missing task"
    );
    invalid.id = None;
    invalid.thread = Some(parallax_protocol::RunId::generate());
    assert!(save(&daemon, invalid).await.is_err(), "missing target");
    keys.fail_read.store(true, SeqCst);
    assert!(
        crate::secrets::consume(&daemon, &secret_ref, Some(thread))
            .await
            .is_err()
    );
    assert_eq!(keys.deletes.load(SeqCst), 0);
    keys.fail_read.store(false, SeqCst);
    assert_eq!(
        &*crate::secrets::consume(&daemon, &secret_ref, Some(thread))
            .await
            .unwrap(),
        "ref-test-value"
    );
}
