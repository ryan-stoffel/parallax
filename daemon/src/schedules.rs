//! Scheduled tasks (0063), as T3 Code's `ScheduledTaskService`: a prompt sent on an interval, at
//! a time of day, or on each request to a webhook. A task bound to a thread queues its prompt
//! into it, one in a Project messages the Project's coordinator, and any other launches a new
//! thread per fire.
//!
//! A task is a row of `scheduled_tasks`: its next run, and the [`ScheduledTask`] with its
//! webhook token as JSON. A webhook's signing secret is in the host's keystore under the task's
//! id (PLX-648), given in the save or as a `secretRef` from `request_secret`; [`run`] first moves
//! any a plxd before that kept in the row. [`run`] keeps one timer for the earliest next run, re-armed
//! whenever a task changes, and none while no task has one.
//!
//! A fire takes the task's orchestrator lane and commits in one writer job: a receipt for
//! `scheduled-task:<fire key>`, the task's next run and run count, and a `thread.wake` effect
//! ([`Wake`]). The fire key is the task's id with its due time, the time of a manual run, or a
//! webhook delivery's id, so a key that already has a receipt commits nothing and a restart
//! can't fire a run twice. The effect worker runs one task's wakes one at a time, so a task
//! never overlaps itself, and [`deliver`] sends each through today's paths: `agent/send`,
//! queued behind a running turn, or `thread/start`. Both are idempotent on an id the effect
//! keeps, so a wake a restart interrupted is sent again safely.

mod webhook;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use jiff::tz::TimeZone;
use jiff::{SignedDuration, Span, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AccountId, AgentEffort, AgentPermission, AgentSendParams, ErrorKind, ProjectId,
    RepoId, RunId, Schedule, ScheduleDeleteResult, ScheduleIdParams, ScheduleListResult,
    ScheduleRunStatus, ScheduleSaveParams, ScheduleWebhook, ScheduledTask, SignatureEncoding,
    ThreadStartParams, TurnId,
};
use parallax_store::OrchestrationReceipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::server::Daemon;
use crate::store::{Tx, store_error};

/// The shortest interval, as T3's.
const MIN_INTERVAL_MS: u64 = 60_000;

/// How late a fixed-time run may fire before it is skipped as missed, as T3's.
const MISSED_GRACE: SignedDuration = SignedDuration::from_mins(10);

/// The longest the timer sleeps. Its clock is monotonic, which stops while the computer sleeps,
/// so a long sleep would fire late after a wake; this bounds how late, well within
/// [`MISSED_GRACE`]. It is also how long a task that failed to fire waits to be tried again.
const MAX_SLEEP: Duration = Duration::from_mins(1);

/// The longest prompt or title, in bytes.
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_TITLE_BYTES: usize = 200;

/// Webhook requests a task takes a minute, and deliveries it holds at once, as T3's.
const WEBHOOKS_PER_MINUTE: u32 = 60;
const MAX_QUEUED_DELIVERIES: usize = 20;

/// The timer's wake-up, and each webhook task's requests this minute.
#[derive(Default)]
pub(crate) struct Schedules {
    changed: Notify,
    rate: Mutex<HashMap<Uuid, (Instant, u32)>>,
}

impl Schedules {
    /// Whether `task` may take another webhook request this minute, counting this one.
    fn admit(&self, task: Uuid) -> bool {
        let mut rate = self.rate.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        rate.retain(|_, (since, _)| now.duration_since(*since) < Duration::from_mins(1));
        let (_, count) = rate.entry(task).or_insert((now, 0));
        *count += 1;
        *count <= WEBHOOKS_PER_MINUTE
    }
}

/// A task as stored: what the protocol shows, and its webhook's token and where its secret is,
/// which it doesn't. `task.webhook` is filled in only when shown.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    task: ScheduledTask,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    /// A secret a plxd before PLX-648 kept here, which [`move_old_secrets`] moves to the
    /// keystore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    /// Whether the keystore holds its secret under the task's id.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    keychain: bool,
}

/// What fired a task.
enum Trigger {
    /// Its timer, at its next run.
    Scheduled,
    /// `schedule/run`.
    Manual,
    /// A request to its webhook, with the prompt rendered from it.
    Webhook { delivery: Uuid, prompt: String },
}

/// How a fire went.
enum Fired {
    /// Committed now or before, with the task as it is after.
    Sent(Box<Stored>),
    /// Nothing to do: the task is gone, paused, not due, or its fixed time was missed and moved.
    Skipped,
    /// A webhook task that is paused or no longer a webhook.
    Disabled,
    /// A webhook task already holding [`MAX_QUEUED_DELIVERIES`].
    Full,
}

/// A wake to send to a thread: a scheduled task's prompt, or a pull request watch's news. The
/// `thread.wake` effect's payload.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Wake {
    /// The scheduled task that fired, whose last run records how the send went.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub to: To,
    pub text: String,
}

/// Where a [`Wake`] goes, with the ids that make sending it again a no-op.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum To {
    /// Queued behind the thread's running turn, or as its next turn.
    Thread { run_id: RunId, turn_id: TurnId },
    /// A Project's coordinator, as it is when the wake is sent.
    Coordinator { project: ProjectId, turn_id: TurnId },
    /// A new thread.
    New {
        run_id: RunId,
        title: String,
        repo: Option<RepoId>,
        account: Option<AccountChoice>,
        model: Option<String>,
        effort: Option<AgentEffort>,
        permission: Option<AgentPermission>,
    },
}

/// `schedule/list`.
pub(crate) async fn list(daemon: &Daemon) -> Result<ScheduleListResult, ErrorObject> {
    let rows = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.scheduled_tasks().map_err(|e| store_error(&e))
        })
        .await?;
    let origin = origin(daemon).await;
    let mut tasks = Vec::with_capacity(rows.len());
    for (id, payload) in rows {
        match serde_json::from_str::<Stored>(&payload) {
            Ok(stored) => tasks.push(shown(stored, origin.as_deref())),
            Err(error) => warn!(%id, %error, "a stored scheduled task can't be read; skipping it"),
        }
    }
    Ok(ScheduleListResult { tasks })
}

/// Whether this host keeps secrets: the Keychain on macOS, the Secret Service on Linux. Windows
/// has no store yet (PLX-23).
const KEYSTORE: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// `schedule/save`: creates a task, or replaces one, keeping its run history, its webhook token,
/// and, when the save names no secret, its webhook secret. A new secret goes to the keystore
/// before the row, and a `secretRef` is used up only once the save has passed its checks.
pub(crate) async fn save(
    daemon: &Daemon,
    mut params: ScheduleSaveParams,
) -> Result<ScheduledTask, ErrorObject> {
    check(&params, KEYSTORE)?;
    let id = match &params.id {
        Some(id) => task_id(id)?,
        None => Uuid::now_v7(),
    };
    let key = AccountId::try_from(id)
        .map_err(|_| ErrorObject::invalid_params(format!("{id} is not a scheduled task's id")))?;
    let replacing = params.id.is_some();
    let _lane = daemon.orchestrator.lane(id).await;
    let checked = params.clone();
    let legacy = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let existing = read(db, id)?;
            if replacing && existing.is_none() {
                return Err(not_found(id));
            }
            check_targets(db, &checked)?;
            let given = new_secret_given(&checked);
            let legacy = existing
                .as_ref()
                .is_some_and(|stored| stored.secret.is_some());
            build(id, checked, existing, given, Timestamp::now()).map(|_| legacy)
        })
        .await?;
    let secret = new_secret(daemon, &mut params).await?;
    let given = secret.is_some();
    let previous = match &secret {
        Some(secret) => Some(set_secret(daemon, key, secret.clone()).await?),
        None => None,
    };
    let saved = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let existing = read(db, id)?;
            if replacing && existing.is_none() {
                return Err(not_found(id));
            }
            check_targets(db, &params)?;
            let stored = build(id, params, existing, given, Timestamp::now())?;
            if legacy {
                db.set_secure_delete(true).map_err(|e| store_error(&e))?;
            }
            put(db, &stored)?;
            Ok(stored)
        })
        .await;
    let stored = match saved {
        Ok(stored) => stored,
        Err(error) => {
            if let Some(previous) = previous {
                undo_secret(daemon, key, previous).await;
            }
            return Err(error);
        }
    };
    if legacy {
        wipe_store(daemon).await;
    }
    daemon.schedules.changed.notify_one();
    Ok(shown(stored, origin(daemon).await.as_deref()))
}

/// Keeps `secret` in the keystore as task `key`'s, and returns what was there before.
async fn set_secret(
    daemon: &Daemon,
    key: AccountId,
    secret: Zeroizing<String>,
) -> Result<Option<Zeroizing<String>>, ErrorObject> {
    let keys = Arc::clone(&daemon.keys);
    tokio::task::spawn_blocking(move || {
        let previous = keys.get(key)?;
        keys.set(key, &secret).map(|()| previous)
    })
    .await
    .map_err(|error| ErrorObject::internal_error(error.to_string()))?
    .map_err(|error| crate::methods::keychain_error(&error))
}

/// Puts task `key`'s keystore entry back as it was, `previous`, after its row failed to save.
async fn undo_secret(daemon: &Daemon, key: AccountId, previous: Option<Zeroizing<String>>) {
    let keys = Arc::clone(&daemon.keys);
    let undone = tokio::task::spawn_blocking(move || match previous {
        Some(previous) => keys.set(key, &previous),
        None => keys.delete(key),
    })
    .await;
    if !matches!(undone, Ok(Ok(()))) {
        warn!(%key, "could not put a webhook secret back after its task failed to save");
    }
}

/// `schedule/delete`.
pub(crate) async fn delete(
    daemon: &Daemon,
    params: ScheduleIdParams,
) -> Result<ScheduleDeleteResult, ErrorObject> {
    let id = task_id(&params.id)?;
    let _lane = daemon.orchestrator.lane(id).await;
    let (deleted, keychain) = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let keychain = read(db, id)?.is_some_and(|stored| stored.keychain);
            let deleted = db.delete_scheduled_task(id).map_err(|e| store_error(&e))?;
            Ok((deleted, keychain))
        })
        .await?;
    if keychain && let Ok(key) = AccountId::try_from(id) {
        let keys = Arc::clone(&daemon.keys);
        let removed = tokio::task::spawn_blocking(move || keys.delete(key)).await;
        if !matches!(removed, Ok(Ok(()))) {
            warn!(%id, "could not remove a deleted task's webhook secret from the keystore");
        }
    }
    daemon.schedules.changed.notify_one();
    Ok(ScheduleDeleteResult { deleted })
}

/// `schedule/run`: fires the task now, paused or not.
pub(crate) async fn run_now(
    daemon: &Daemon,
    params: ScheduleIdParams,
) -> Result<ScheduledTask, ErrorObject> {
    let id = task_id(&params.id)?;
    match fire(daemon, id, Trigger::Manual).await? {
        Fired::Sent(stored) => Ok(shown(*stored, origin(daemon).await.as_deref())),
        _ => Err(not_found(id)),
    }
}

/// The timer: see the module documentation. Returns when `stop` is cancelled.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    move_old_secrets(&daemon).await;
    loop {
        let next = daemon
            .reader
            .run(&CancellationToken::new(), |db| {
                db.next_scheduled_at().map_err(|e| store_error(&e))
            })
            .await
            .unwrap_or_else(|error| {
                warn!(error = %error.message, "could not read when the next scheduled task is due");
                None
            });
        let wait = next.map(|at| {
            Duration::try_from(at.duration_since(Timestamp::now()))
                .unwrap_or_default()
                .min(MAX_SLEEP)
        });
        tokio::select! {
            () = stop.cancelled() => return,
            () = daemon.schedules.changed.notified() => {}
            () = tokio::time::sleep(wait.unwrap_or_default()), if wait.is_some() => {
                fire_due(&daemon).await;
            }
        }
    }
}

/// Fires every task due now, one at a time. A task that fails to fire, such as one whose row
/// can't be read, is tried again [`MAX_SLEEP`] later rather than at once, so the timer never spins.
async fn fire_due(daemon: &Daemon) {
    let due = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.due_scheduled_tasks(Timestamp::now())
                .map_err(|e| store_error(&e))
        })
        .await;
    let due = match due {
        Ok(due) => due,
        Err(error) => return warn!(error = %error.message, "could not read the due tasks"),
    };
    for id in due {
        if let Err(error) = fire(daemon, id, Trigger::Scheduled).await {
            warn!(%id, error = %error.message, "a scheduled task could not fire");
            let retry = Timestamp::now() + SignedDuration::try_from(MAX_SLEEP).unwrap_or_default();
            let postponed = daemon
                .store
                .run(&CancellationToken::new(), move |db| {
                    db.postpone_scheduled_task(id, retry)
                        .map_err(|e| store_error(&e))
                })
                .await;
            if let Err(error) = postponed {
                warn!(%id, error = %error.message, "could not postpone a scheduled task");
            }
        }
    }
}

/// Fires task `id` in its lane: see the module documentation.
async fn fire(daemon: &Daemon, id: Uuid, trigger: Trigger) -> Result<Fired, ErrorObject> {
    let _lane = daemon.orchestrator.lane(id).await;
    let fired = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            fire_job(db, id, trigger, Timestamp::now())
        })
        .await?;
    if matches!(fired, Fired::Sent(_)) {
        daemon.orchestrator.notify();
    }
    daemon.schedules.changed.notify_one();
    Ok(fired)
}

fn fire_job(db: &mut Tx, id: Uuid, trigger: Trigger, now: Timestamp) -> Result<Fired, ErrorObject> {
    let Some(mut stored) = read(db, id)? else {
        return Ok(Fired::Skipped);
    };
    let task = &mut stored.task;
    let (key, text) = match trigger {
        Trigger::Scheduled => {
            let Some(due) = task.next_run_at.filter(|due| task.enabled && *due <= now) else {
                return Ok(Fired::Skipped);
            };
            if matches!(task.schedule, Schedule::FixedTime { .. })
                && now.duration_since(due) > MISSED_GRACE
            {
                task.next_run_at = next_run(&task.schedule, now, &TimeZone::system());
                put(db, &stored)?;
                return Ok(Fired::Skipped);
            }
            (
                format!("{id}:{}:scheduled", due.as_millisecond()),
                task.prompt.clone(),
            )
        }
        Trigger::Manual => (
            format!("{id}:{}:manual", now.as_millisecond()),
            task.prompt.clone(),
        ),
        Trigger::Webhook { delivery, prompt } => {
            if !task.enabled || !matches!(task.schedule, Schedule::Webhook { .. }) {
                return Ok(Fired::Disabled);
            }
            if db.open_effects(id).map_err(|e| store_error(&e))? >= MAX_QUEUED_DELIVERIES {
                return Ok(Fired::Full);
            }
            (format!("{id}:webhook:{delivery}"), prompt)
        }
    };
    let command_id = format!("scheduled-task:{key}");
    if db
        .orchestration_receipt(&command_id)
        .map_err(|e| store_error(&e))?
        .is_some()
    {
        return Ok(Fired::Sent(Box::new(stored)));
    }
    let to = if let Some(run_id) = task.thread {
        To::Thread {
            run_id,
            turn_id: TurnId::generate(),
        }
    } else if let Some(project) = task.project {
        To::Coordinator {
            project,
            turn_id: TurnId::generate(),
        }
    } else {
        To::New {
            run_id: RunId::generate(),
            title: task.title.clone(),
            repo: task.repo,
            account: task.account.clone(),
            model: task.model.clone(),
            effort: task.effort,
            permission: task.permission,
        }
    };
    task.last_run_at = Some(now);
    task.last_run_status = ScheduleRunStatus::Running;
    task.last_run_error = None;
    task.run_count += 1;
    task.next_run_at = task
        .enabled
        .then(|| next_run(&task.schedule, now, &TimeZone::system()))
        .flatten();
    put(db, &stored)?;
    db.insert_orchestration_receipt(&OrchestrationReceipt {
        command_id: command_id.clone(),
        thread_id: id,
        kind: "schedule.fire".to_owned(),
        result_seq: None,
        error: None,
    })
    .map_err(|e| store_error(&e))?;
    let wake = Wake {
        task: Some(id.to_string()),
        to,
        text,
    };
    crate::orchestrator::enqueue_wake(db, &command_id, id, wake)?;
    Ok(Fired::Sent(Box::new(stored)))
}

/// Sends `wake`, the `thread.wake` effect, and records how it went on its task. A failure isn't
/// retried, as T3's isn't: the task's last run says why.
pub(crate) async fn deliver(daemon: &Arc<Daemon>, wake: Wake) {
    let Wake { task, to, text } = wake;
    let sent = match to {
        To::Thread { run_id, turn_id } => send(daemon, run_id, turn_id, text).await,
        To::Coordinator { project, turn_id } => {
            let coordinator = daemon
                .store
                .run(&CancellationToken::new(), move |db| {
                    crate::agents::coordinator::coordinator_of(db, project.into())
                })
                .await;
            match coordinator {
                Ok(Some(run_id)) => send(daemon, run_id, turn_id, text).await,
                Ok(None) => Err(ErrorObject::invalid_params(format!(
                    "Project {project} has no coordinator"
                ))),
                Err(error) => Err(error),
            }
        }
        To::New {
            run_id,
            title,
            repo,
            account,
            model,
            effort,
            permission,
        } => crate::threads::start(
            Arc::clone(daemon),
            ThreadStartParams {
                run_id,
                repo,
                project: None,
                parent: None,
                notify: None,
                title: Some(title),
                prompt: text,
                account,
                model,
                effort,
                permission,
                context_window: None,
                fast: None,
                branch_slug: None,
                images: Vec::new(),
                approvals: true,
                checkout: false,
                base: None,
                checkout_ref: None,
                threads: Vec::new(),
                naming: None,
            },
        )
        .await
        .map(drop),
    };
    let Some(task) = task.and_then(|task| Uuid::try_parse(&task).ok()) else {
        if let Err(error) = sent {
            warn!(error = %error.message, "could not wake a thread");
        }
        return;
    };
    let _lane = daemon.orchestrator.lane(task).await;
    let recorded = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let Some(mut stored) = read(db, task)? else {
                return Ok(());
            };
            if stored.task.last_run_status == ScheduleRunStatus::Running {
                (stored.task.last_run_status, stored.task.last_run_error) = match sent {
                    Ok(()) => (ScheduleRunStatus::Succeeded, None),
                    Err(error) => (ScheduleRunStatus::Failed, Some(error.message)),
                };
                put(db, &stored)?;
            }
            Ok(())
        })
        .await;
    if let Err(error) = recorded {
        warn!(%task, error = %error.message, "could not record a scheduled task's run");
    }
}

/// `agent/send` of `text` to run `run_id`, queued behind its running turn.
async fn send(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    turn_id: TurnId,
    text: String,
) -> Result<(), ErrorObject> {
    crate::agents::send(
        Arc::clone(daemon),
        AgentSendParams {
            run_id,
            turn_id,
            text,
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            account: None,
            images: Vec::new(),
            threads: Vec::new(),
            from: None,
            delivery: None,
        },
    )
    .await
    .map(drop)
}

/// A webhook request to `path`, `/api/hooks/<id>/<token>` with its query, from the remote
/// listener: its status and JSON answer, as T3's `webhookRoute`.
pub(crate) async fn hook(
    daemon: &Daemon,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> (u16, Value) {
    let not_found = (404, json!({ "error": "hook_not_found" }));
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let Some((id, token)) = route
        .strip_prefix(webhook::PREFIX)
        .and_then(|rest| rest.split_once('/'))
    else {
        return not_found;
    };
    let Ok(id) = task_id(id) else {
        return not_found;
    };
    let stored = daemon
        .reader
        .run(&CancellationToken::new(), move |db| read(db, id))
        .await;
    let stored = match stored {
        Ok(Some(stored)) => stored,
        Ok(None) => return not_found,
        Err(_) => return (500, json!({ "error": "internal_error" })),
    };
    if !stored
        .token
        .as_deref()
        .is_some_and(|expected| webhook::same(expected, token))
    {
        return not_found;
    }
    let Schedule::Webhook { signature } = &stored.task.schedule else {
        return (409, json!({ "error": "hook_disabled" }));
    };
    if !stored.task.enabled {
        return (409, json!({ "error": "hook_disabled" }));
    }
    // A request with a bad signature counts too, as T3's.
    if !daemon.schedules.admit(id) {
        return (429, json!({ "error": "rate_limited" }));
    }
    if let Some(signature) = signature {
        if !stored.keychain {
            return (503, json!({ "error": "keychain_unavailable" }));
        }
        let Some(secret) = keystore_secret(daemon, id).await else {
            return (503, json!({ "error": "keychain_unavailable" }));
        };
        if secret.is_empty() || !webhook::verify(signature, &secret, headers, body) {
            return (401, json!({ "error": "invalid_signature" }));
        }
    }
    // Without the token, which would otherwise reach the prompt through `{{request}}`.
    let path = format!("{}{id}", webhook::PREFIX);
    let request = webhook::Request {
        method,
        path: &path,
        query,
        headers,
        body: &String::from_utf8_lossy(body),
    };
    let mut prompt = webhook::render(&stored.task.prompt, &request);
    if prompt.len() > MAX_PROMPT_BYTES {
        prompt.truncate(prompt.floor_char_boundary(MAX_PROMPT_BYTES));
    }
    let delivery = Uuid::now_v7();
    match fire(daemon, id, Trigger::Webhook { delivery, prompt }).await {
        Ok(Fired::Sent(_)) => (202, json!({ "deliveryId": delivery.to_string() })),
        Ok(Fired::Disabled | Fired::Skipped) => (409, json!({ "error": "hook_disabled" })),
        Ok(Fired::Full) => (429, json!({ "error": "rate_limited" })),
        Err(error) => {
            warn!(%id, error = %error.message, "a webhook delivery failed");
            (500, json!({ "error": "internal_error" }))
        }
    }
}

/// The next run of `schedule` after `from`, in time zone `tz`: none for a webhook.
fn next_run(schedule: &Schedule, from: Timestamp, tz: &TimeZone) -> Option<Timestamp> {
    match schedule {
        Schedule::Interval { every_ms } => {
            let ms = i64::try_from((*every_ms).max(MIN_INTERVAL_MS)).ok()?;
            from.checked_add(SignedDuration::from_millis(ms)).ok()
        }
        Schedule::FixedTime {
            time_of_day,
            weekdays,
        } => {
            let (hour, minute) = time_of_day_parts(time_of_day)?;
            let today = from.to_zoned(tz.clone()).date();
            (0..=7).find_map(|offset| {
                let day = today.checked_add(Span::new().days(offset)).ok()?;
                let at = day
                    .at(hour, minute, 0, 0)
                    .to_zoned(tz.clone())
                    .ok()?
                    .timestamp();
                let weekday = u8::try_from(day.weekday().to_sunday_zero_offset()).ok()?;
                (at > from && (weekdays.is_empty() || weekdays.contains(&weekday))).then_some(at)
            })
        }
        Schedule::Webhook { .. } | Schedule::Unknown => None,
    }
}

/// `H:MM` or `HH:MM`, 24-hour, as T3's `parseTimeOfDay`.
fn time_of_day_parts(text: &str) -> Option<(i8, i8)> {
    let (hour, minute) = text.trim().split_once(':')?;
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if !(1..=2).contains(&hour.len()) || minute.len() != 2 || !digits(hour) || !digits(minute) {
        return None;
    }
    let (hour, minute): (i8, i8) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some((hour, minute))
}

/// Refuses a save whose fields are out of range.
/// Refuses a save that can't be valid, and on a host without a keystore, one that sets a
/// signature's secret, as `request_secret` is refused there.
fn check(params: &ScheduleSaveParams, keystore: bool) -> Result<(), ErrorObject> {
    if !keystore && matches!(&params.schedule, Schedule::Webhook { signature: Some(_) }) {
        return Err(ErrorObject::parallax(
            ErrorKind::KeychainUnavailable,
            crate::keystore::UNAVAILABLE_MESSAGE,
        ));
    }
    let invalid = |message: &str| Err(ErrorObject::invalid_params(message));
    if params.title.trim().is_empty() || params.title.len() > MAX_TITLE_BYTES {
        return invalid("title must be 1 to 200 bytes");
    }
    if params.prompt.trim().is_empty() || params.prompt.len() > MAX_PROMPT_BYTES {
        return invalid("prompt must be 1 byte to 64 KiB");
    }
    if usize::from(params.thread.is_some()) + usize::from(params.project.is_some()) > 1
        || (params.repo.is_some() && (params.thread.is_some() || params.project.is_some()))
    {
        return invalid("name at most one of thread, project, and repo");
    }
    match &params.schedule {
        Schedule::Interval { every_ms } if *every_ms < MIN_INTERVAL_MS => {
            invalid("an interval is at least 60000 ms")
        }
        Schedule::FixedTime {
            time_of_day,
            weekdays,
        } if time_of_day_parts(time_of_day).is_none() || weekdays.iter().any(|day| *day > 6) => {
            invalid("timeOfDay is HH:MM, 24-hour, and weekdays are 0 (Sunday) to 6")
        }
        Schedule::Webhook {
            signature: Some(signature),
        } if signature.header.trim().is_empty()
            || signature.encoding == SignatureEncoding::Unknown
            || signature.secret.as_deref().is_some_and(str::is_empty)
            || (signature.secret.is_some() && signature.secret_ref.is_some()) =>
        {
            invalid(
                "a signature needs a header, hex or base64, and a non-empty secret or a \
                 secretRef, not both",
            )
        }
        Schedule::Unknown => invalid("schedule's type must be interval, fixed_time, or webhook"),
        _ => Ok(()),
    }
}

/// Refuses a save whose thread, Project, or repo entry doesn't exist.
fn check_targets(db: &Tx, params: &ScheduleSaveParams) -> Result<(), ErrorObject> {
    let error = |e| store_error(&e);
    let missing = |what: &str, id: &dyn std::fmt::Display| {
        Err(ErrorObject::invalid_params(format!(
            "no {what} has id {id}"
        )))
    };
    if let Some(run) = params.thread
        && db.get_run(run.into()).map_err(error)?.is_none()
    {
        return missing("thread", &run);
    }
    if let Some(project) = params.project
        && db.get_project(project.into()).map_err(error)?.is_none()
    {
        return missing("Project", &project);
    }
    if let Some(repo) = params.repo
        && db.get_repo(repo.into()).map_err(error)?.is_none()
    {
        return missing("repo entry", &repo);
    }
    Ok(())
}

/// The task `params` saves, over `existing`.
fn build(
    id: Uuid,
    params: ScheduleSaveParams,
    existing: Option<Stored>,
    given: bool,
    now: Timestamp,
) -> Result<Stored, ErrorObject> {
    let ScheduleSaveParams {
        id: _,
        title,
        prompt,
        enabled,
        schedule,
        thread,
        project,
        repo,
        account,
        model,
        effort,
        permission,
        from: _,
    } = params;
    // A webhook keeps its token, and its secret unless the save gave a new one, which `save`
    // keeps in the keystore.
    let (token, keychain) = match &schedule {
        Schedule::Webhook { signature } => {
            let token = existing
                .as_ref()
                .and_then(|stored| stored.token.clone())
                .map_or_else(webhook::new_token, Ok)?;
            let keychain = signature.is_some()
                && (given || existing.as_ref().is_some_and(|stored| stored.keychain));
            if signature.is_some() && !keychain {
                return Err(ErrorObject::invalid_params(
                    "a new signature needs its secret",
                ));
            }
            (Some(token), keychain)
        }
        _ => (None, false),
    };
    let before = existing.map(|stored| stored.task);
    // An unchanged trigger keeps its next run, so an edit doesn't push it back.
    let next_run_at = if !enabled {
        None
    } else if let Some(at) = before
        .as_ref()
        .filter(|before| before.enabled && same_trigger(&before.schedule, &schedule))
        .and_then(|before| before.next_run_at)
    {
        Some(at)
    } else {
        next_run(&schedule, now, &TimeZone::system())
    };
    Ok(Stored {
        task: ScheduledTask {
            id: id.to_string(),
            title: title.trim().to_owned(),
            prompt,
            enabled,
            schedule,
            thread,
            project,
            repo,
            account,
            model,
            effort,
            permission,
            next_run_at,
            last_run_at: before.as_ref().and_then(|before| before.last_run_at),
            last_run_status: before
                .as_ref()
                .map_or(ScheduleRunStatus::Never, |before| before.last_run_status),
            last_run_error: before
                .as_ref()
                .and_then(|before| before.last_run_error.clone()),
            run_count: before.as_ref().map_or(0, |before| before.run_count),
            webhook: None,
            created_at: before.map_or(now, |before| before.created_at),
        },
        token,
        secret: None,
        keychain,
    })
}

/// Whether `params` gives a webhook signature a new secret, itself or as a `secretRef`.
fn new_secret_given(params: &ScheduleSaveParams) -> bool {
    matches!(&params.schedule, Schedule::Webhook { signature: Some(signature) }
        if signature.secret.is_some() || signature.secret_ref.is_some())
}

/// Moves the webhook secrets a plxd before PLX-648 kept in their tasks' rows to the keystore, and
/// wipes them from the store: the update runs with `secure_delete` on, so no freed page keeps the
/// text, and a WAL checkpoint then empties the log. On a host with no keystore they stay put, and
/// those tasks' signed requests are refused.
async fn move_old_secrets(daemon: &Daemon) {
    let old = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            Ok(db
                .scheduled_tasks()
                .map_err(|e| store_error(&e))?
                .into_iter()
                .filter_map(|(id, payload)| {
                    let stored: Stored = serde_json::from_str(&payload).ok()?;
                    stored.secret.map(|_| id)
                })
                .collect::<Vec<_>>())
        })
        .await
        .unwrap_or_default();
    let mut moved = false;
    for id in old {
        let _lane = daemon.orchestrator.lane(id).await;
        let Ok(Some(mut stored)) = daemon
            .reader
            .run(&CancellationToken::new(), move |db| read(db, id))
            .await
        else {
            continue;
        };
        let Some(secret) = stored.secret.take() else {
            continue;
        };
        if !KEYSTORE {
            warn!(%id, "a webhook task's signing is off: this host has no keystore for its secret");
            continue;
        }
        let Ok(key) = AccountId::try_from(id) else {
            continue;
        };
        let previous = match set_secret(daemon, key, Zeroizing::new(secret)).await {
            Ok(previous) => previous,
            Err(error) => {
                warn!(%id, error = %error.message, "could not move a webhook secret to the keystore");
                continue;
            }
        };
        stored.keychain = true;
        let saved = daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                db.set_secure_delete(true).map_err(|e| store_error(&e))?;
                put(db, &stored)
            })
            .await;
        if let Err(error) = saved {
            undo_secret(daemon, key, previous).await;
            warn!(%id, error = %error.message, "could not wipe an old webhook secret from the store");
        } else {
            moved = true;
        }
    }
    if moved {
        wipe_store(daemon).await;
    }
}

/// Rebuilds the database to remove old freed pages, then truncates its WAL after migrating or
/// replacing legacy plaintext. This runs outside a writer transaction because VACUUM requires it.
async fn wipe_store(daemon: &Daemon) {
    let path = daemon.data_dir.store_file();
    let wiped = tokio::task::spawn_blocking(move || -> Result<(), rusqlite::Error> {
        let conn = rusqlite::Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("VACUUM")?;
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(rusqlite::Error::ExecuteReturnedResults);
        }
        Ok(())
    })
    .await;
    if !matches!(wiped, Ok(Ok(()))) {
        warn!("could not wipe database pages and WAL after moving a legacy webhook secret");
    }
}

/// Takes the save's new webhook secret out of `params`: its `secret`, or the value of its
/// `secretRef`, which only the thread in `from` can use, and which this uses up.
async fn new_secret(
    daemon: &Daemon,
    params: &mut ScheduleSaveParams,
) -> Result<Option<Zeroizing<String>>, ErrorObject> {
    let Schedule::Webhook {
        signature: Some(signature),
    } = &mut params.schedule
    else {
        return Ok(None);
    };
    if let Some(secret) = signature.secret.take() {
        return Ok(Some(Zeroizing::new(secret)));
    }
    match signature.secret_ref.take() {
        Some(secret_ref) => crate::secrets::consume(daemon, &secret_ref, params.from)
            .await
            .map(Some),
        None => Ok(None),
    }
}

/// Task `id`'s webhook secret from the keystore, if it can be read.
async fn keystore_secret(daemon: &Daemon, id: Uuid) -> Option<Zeroizing<String>> {
    let key = AccountId::try_from(id).ok()?;
    let keys = Arc::clone(&daemon.keys);
    tokio::task::spawn_blocking(move || keys.get(key))
        .await
        .ok()?
        .ok()
        .flatten()
}

/// Whether two triggers fire at the same times, as T3's `isSameSchedule`.
fn same_trigger(a: &Schedule, b: &Schedule) -> bool {
    match (a, b) {
        (Schedule::Interval { every_ms: a }, Schedule::Interval { every_ms: b }) => a == b,
        (
            Schedule::FixedTime {
                time_of_day: a,
                weekdays: a_days,
            },
            Schedule::FixedTime {
                time_of_day: b,
                weekdays: b_days,
            },
        ) => {
            let days = |days: &[u8]| {
                let mut days = days.to_vec();
                days.sort_unstable();
                days.dedup();
                if days.len() == 7 { Vec::new() } else { days }
            };
            time_of_day_parts(a) == time_of_day_parts(b) && days(a_days) == days(b_days)
        }
        (Schedule::Webhook { .. }, Schedule::Webhook { .. }) => true,
        _ => false,
    }
}

/// `stored` as the protocol shows it, with its webhook's path and, while remote access is on,
/// its URL at `origin`.
fn shown(stored: Stored, origin: Option<&str>) -> ScheduledTask {
    let Stored {
        mut task,
        token,
        keychain,
        ..
    } = stored;
    if let Some(token) = token {
        let path = format!("{}{}/{token}", webhook::PREFIX, task.id);
        task.webhook = Some(ScheduleWebhook {
            url: origin.map(|origin| format!("{origin}{path}")),
            path,
            has_secret: keychain,
        });
    }
    task
}

/// `https://<LAN address>:<port>` while the remote listener is on.
async fn origin(daemon: &Daemon) -> Option<String> {
    if !daemon
        .remote
        .listening
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return None;
    }
    let route = crate::server::remote::routes(daemon)
        .await
        .into_iter()
        .next()?;
    Some(if route.contains(':') {
        format!("https://{route}")
    } else {
        format!("https://{route}:{}", daemon.remote.port)
    })
}

fn read(db: &Tx, id: Uuid) -> Result<Option<Stored>, ErrorObject> {
    db.scheduled_task(id)
        .map_err(|e| store_error(&e))?
        .map(|payload| serde_json::from_str(&payload).map_err(ErrorObject::internal_error))
        .transpose()
}

fn put(db: &Tx, stored: &Stored) -> Result<(), ErrorObject> {
    let id = task_id(&stored.task.id)?;
    let payload = serde_json::to_string(stored).map_err(ErrorObject::internal_error)?;
    db.put_scheduled_task(id, stored.task.next_run_at, &payload)
        .map_err(|e| store_error(&e))
}

fn task_id(id: &str) -> Result<Uuid, ErrorObject> {
    Uuid::try_parse(id)
        .map_err(|_| ErrorObject::invalid_params(format!("{id:?} is not a scheduled task's id")))
}

fn not_found(id: Uuid) -> ErrorObject {
    ErrorObject::invalid_params(format!("no scheduled task has id {id}"))
}

#[cfg(test)]
mod tests;
