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

use super::{Fired, Trigger, check, fire, fire_job, hook, next_run, put, read, run, save};
use crate::server::Daemon;

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
    stop.cancel();
    timer.await.unwrap();
}

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
        }),
    });
    webhook.prompt =
        "Write notes for {{body.release.tag_name}} ({{headers.x-github-event}})".to_owned();
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

    let mut paused = params(task.schedule.clone());
    paused.id = Some(task.id.clone());
    paused.enabled = false;
    save(&daemon, paused).await.unwrap();
    let (status, _) = hook(&daemon, "POST", &endpoint.path, &headers(&digest), body).await;
    assert_eq!(status, 409, "paused");
    let kept = stored(&daemon, id).await;
    assert_eq!(
        kept.secret.as_deref(),
        Some("s3cret"),
        "a save without one keeps it"
    );
}
