#[cfg(unix)]
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use jiff::tz::TimeZone;
use jiff::{SignedDuration, Timestamp};
use parallax_protocol::{Schedule, ScheduleRunStatus, ScheduleSaveParams};
#[cfg(unix)]
use parallax_protocol::{SignatureEncoding, WebhookSignature};
#[cfg(unix)]
use ring::hmac;
use uuid::Uuid;

#[cfg(unix)]
use super::hook;
use super::{Fired, Trigger, fire, next_run, put, read, reader, save};
use crate::server::Daemon;
#[cfg(unix)]
use crate::store::store_error;
use crate::threads::store;

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
        orchestrator: None,
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

/// A connection of its own to the database in `dir`.
fn db(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("plxd.sqlite3")).unwrap()
}

/// The thread.wake effects' payloads for task `id`, oldest first.
fn wakes(dir: &Path, id: Uuid) -> Vec<String> {
    let conn = db(dir);
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
    store(daemon, move |db| {
        let mut stored = read(db, id)?.unwrap();
        stored.task.next_run_at = Some(due);
        put(db, &stored)
    })
    .await
    .unwrap();
}

async fn stored(daemon: &Daemon, id: Uuid) -> super::Stored {
    reader(daemon, move |db| read(db, id))
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

/// 0093: a task bound to a run that Start over replaced still brings the orchestrator's thread
/// back.
#[tokio::test]
async fn a_fire_to_a_replaced_run_wakes_the_orchestrators_thread() {
    use crate::agents::orchestrator::tests::{archive, orchestrator, replace, thread};

    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (scope, old) = orchestrator(&daemon, None).await;
    let new = replace(&daemon, scope).await;
    archive(&daemon, new, true).await;
    let task = save(
        &daemon,
        ScheduleSaveParams {
            thread: Some(old),
            ..params(HOURLY)
        },
    )
    .await
    .unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    due_at(&daemon, id, Timestamp::now() - SignedDuration::from_secs(1)).await;
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Sent(_)
    ));
    assert!(!thread(&daemon, new).await.archived);
}

/// 0093: a task that fires into an archived orchestrator brings its thread back, naming the task.
#[tokio::test]
async fn a_fire_wakes_an_archived_orchestrator_thread() {
    use crate::agents::orchestrator::tests::{archive, orchestrator, reason, thread};

    let dir = tempfile::tempdir().unwrap();
    let daemon = daemon(dir.path());
    let (scope, run) = orchestrator(&daemon, None).await;
    archive(&daemon, run, true).await;
    let task = save(
        &daemon,
        ScheduleSaveParams {
            orchestrator: Some(scope),
            ..params(HOURLY)
        },
    )
    .await
    .unwrap();
    let id = Uuid::try_parse(&task.id).unwrap();
    due_at(&daemon, id, Timestamp::now() - SignedDuration::from_secs(1)).await;
    assert!(matches!(
        fire(&daemon, id, Trigger::Scheduled).await.unwrap(),
        Fired::Sent(_)
    ));
    let woken = thread(&daemon, run).await;
    assert!(!woken.archived);
    assert_eq!(
        reason(&woken),
        Some(parallax_protocol::WakeReason::Schedule {
            task: task.id,
            title: "Triage".to_owned(),
        })
    );
}

#[cfg(unix)]
#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one webhook told step by step")]
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
    let row = reader(&daemon, move |db| {
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
    let (status, _) = hook(&daemon, "POST", &wrong, &headers(&digest), body, None).await;
    assert_eq!(status, 404, "a wrong token");
    let (status, _) = hook(&daemon, "POST", &endpoint.path, &headers("00"), body, None).await;
    assert_eq!(status, 401, "a wrong signature");
    assert!(wakes(dir.path(), id).is_empty());

    let path = format!("{}?source=ci", endpoint.path);
    // The relay's delivery id keys the fire, so a request it delivers again fires once (PLX-652).
    let delivery = Uuid::new_v4();
    for _ in 0..2 {
        let (status, answer) = hook(
            &daemon,
            "POST",
            &path,
            &headers(&digest),
            body,
            Some(delivery),
        )
        .await;
        assert_eq!(status, 202, "{answer}");
        assert_eq!(answer["deliveryId"], delivery.to_string());
    }
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
    let (status, _) = hook(
        &daemon,
        "POST",
        &endpoint.path,
        &headers(&digest),
        body,
        None,
    )
    .await;
    assert_eq!(status, 409, "paused");
    let key = stored(&daemon, id)
        .await
        .secret_key
        .expect("a save without one keeps it");
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
#[cfg(unix)]
struct FaultKeys {
    values: std::sync::Mutex<HashMap<parallax_protocol::AccountId, String>>,
    fail_read: std::sync::atomic::AtomicBool,
    fail_write: std::sync::atomic::AtomicBool,
    fail_delete: std::sync::atomic::AtomicBool,
    deletes: std::sync::atomic::AtomicUsize,
}

#[cfg(unix)]
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
        if self.fail_delete.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::keystore::KeyStoreError::unavailable(
                "test delete failure",
            ));
        }
        self.values.lock().unwrap().remove(&id);
        Ok(())
    }
}

#[cfg(unix)]
fn fault_daemon(dir: &Path) -> (Arc<Daemon>, Arc<FaultKeys>) {
    let mut daemon = daemon(dir);
    let keys = Arc::new(FaultKeys::default());
    Arc::get_mut(&mut daemon).unwrap().keys = keys.clone();
    (daemon, keys)
}

/// The webhook secret the keystore holds for task `id`'s row.
#[cfg(unix)]
async fn secret_of(daemon: &Daemon, keys: &FaultKeys, id: Uuid) -> Option<String> {
    let key = stored(daemon, id).await.secret_key?;
    keys.values.lock().unwrap().get(&key).cloned()
}

#[cfg(unix)]
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
    assert!(save(&daemon, replacement).await.is_err());
    assert_eq!(stored(&daemon, id).await.task, before.task);
    assert_eq!(
        secret_of(&daemon, &keys, id).await.as_deref(),
        Some("working-value")
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
    store(&daemon, move |db| {
        let mut row = read(db, id)?.unwrap();
        row.secret_key = None;
        row.secret = Some(LEGACY.to_owned());
        put(db, &row)
    })
    .await
    .unwrap();
    keys.fail_write.store(true, SeqCst);
    super::move_old_secrets(&daemon).await;
    assert_eq!(stored(&daemon, id).await.secret.as_deref(), Some(LEGACY));
    let endpoint = task.webhook.unwrap();
    let (status, answer) = hook(
        &daemon,
        "POST",
        &endpoint.path,
        &HashMap::new(),
        b"{}",
        None,
    )
    .await;
    assert_eq!(status, 503, "{answer}");
    keys.fail_write.store(false, SeqCst);
    super::move_old_secrets(&daemon).await;
    assert!(stored(&daemon, id).await.secret.is_none());
    assert_eq!(secret_of(&daemon, &keys, id).await.as_deref(), Some(LEGACY));
    assert!(
        !holds(dir.path(), LEGACY),
        "the store retains migrated plaintext"
    );
}

/// Whether the store's database or WAL file holds `text`.
#[cfg(unix)]
fn holds(dir: &Path, text: &str) -> bool {
    ["plxd.sqlite3", "plxd.sqlite3-wal"].iter().any(|name| {
        std::fs::read(dir.join(name))
            .unwrap_or_default()
            .windows(text.len())
            .any(|window| window == text.as_bytes())
    })
}
