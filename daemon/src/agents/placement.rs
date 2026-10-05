//! Placing a Project's children on accounts (PLX-413, decision 0046), by fixed rules, with no
//! model involved.
//!
//! Each provider instance can keep a reserve: a percent of every limit window `usage/get` reports
//! for it that Projects leave for the user. Its headroom is the least of `100 - reserve - used`
//! over those windows, and it takes new children only while that is above 0. A window whose reset
//! has passed counts as reset, and an instance that reports no limits is always eligible.
//!
//! [`decide`] holds the rules: (1) the instance the composer picked, or the worker default, if it
//! is enabled, not signed out, has the Project's mode, and is under its reserve; (2) otherwise the
//! instance of the same kind that serves the model with the most headroom; (3) otherwise, when
//! only quota stops them, the child waits. Before them, a Project already running `maxChildren`
//! children makes it wait too. Any other refusal, such as an instance signed out with no other to
//! go to, starts on the picked instance, which then fails saying why, as before.
//!
//! A child that waits is recorded like any run, with its worktree, as `waiting` with the reason as
//! its error, and a `failed` inbox item (0043). Its first message waits in the store's placement
//! queue, so a restart keeps it. [`start`]'s dispatcher looks at the queue, oldest first, when a
//! child ends, when a Project's settings change, and every [`EVERY`], and starts each child that
//! now has room through its actor. A message or Resume now starts a waiting child at once on its
//! picked instance; Cancel or delete takes it out of the queue. One lock covers placing a child
//! until it counts as starting or waiting, so children placed at once never overshoot
//! `maxChildren`. A waiting child is recorded on its picked instance, or on a blocked sibling when
//! the picked one can't run.
//!
//! An API key account is used only when the Project allows it: `agents::prepare_run` refuses one
//! otherwise, and turns off routing's automatic fallback to one (0012) for a Project's children.

use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AgentRun, ErrorKind, InboxKind, ProjectId, ProjectPermission, PromptImage,
    ProviderKind, Role, RunId,
};
use parallax_store::LimitSnapshot;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::actor::{Command, session_account};
use super::convert::{NO_WRITE, RUNNING, STARTING, WAITING};
use super::worker::StoredKeyAccounts;
use super::{ask, in_mode, project_mode, store, store_error, wake};
use crate::server::Daemon;

/// How often the dispatcher looks at the queue when nothing woke it, for limits that reset.
const EVERY: Duration = Duration::from_secs(30);

/// One instance as the rules see it.
#[derive(Clone, Debug)]
pub(crate) struct Instance {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    pub enabled: bool,
    /// `None` when plxd can't tell.
    pub signed_in: Option<bool>,
    /// Whether it runs the Project's mode (0042).
    pub in_mode: bool,
    /// The models it serves. Empty when plxd doesn't know, which serves any.
    pub models: Vec<String>,
    /// The percent of each window left for the user.
    pub reserve: u8,
    /// Its limit windows, as `usage/get` reports them.
    pub limits: Vec<LimitSnapshot>,
}

impl Instance {
    /// Enabled, not signed out, and in the Project's mode: all but quota.
    fn usable(&self) -> bool {
        self.enabled && self.signed_in != Some(false) && self.in_mode
    }

    fn serves(&self, model: Option<&str>) -> bool {
        model.is_none_or(|model| self.models.is_empty() || self.models.iter().any(|m| m == model))
    }

    /// The windows still counting at `now`, with how much each is used.
    fn live(&self, now: Timestamp) -> impl Iterator<Item = (&LimitSnapshot, f64)> {
        self.limits
            .iter()
            .filter(move |window| window.resets_at.is_none_or(|reset| reset > now))
            .filter_map(|window| Some((window, window.used_percent?)))
    }

    /// The least of `100 - reserve - used` over its windows, or 100 with none.
    fn headroom(&self, now: Timestamp) -> f64 {
        let reserve = f64::from(self.reserve);
        self.live(now)
            .map(|(_, used)| 100.0 - reserve - used)
            .fold(100.0, f64::min)
    }

    /// When every window over the line has reset, if each says when.
    fn frees_at(&self, now: Timestamp) -> Option<Timestamp> {
        let line = 100.0 - f64::from(self.reserve);
        self.live(now)
            .filter(|(_, used)| *used >= line)
            .map(|(window, _)| window.resets_at)
            .try_fold(None, |latest: Option<Timestamp>, reset| {
                Some(latest.max(Some(reset?)))
            })
            .flatten()
    }
}

/// What [`decide`] says.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Decision {
    /// Start on this instance.
    Start(String),
    /// Wait for quota on the picked instance, named `name`, until `until` when it's known,
    /// recorded on instance `on`: the picked one, or when it can't run, a blocked sibling.
    Wait {
        name: String,
        until: Option<Timestamp>,
        on: String,
    },
    /// Start on the picked instance as it is: it isn't an instance plxd lists, or something
    /// other than quota stops every instance, which the start reports.
    Picked,
}

/// The rules of the module documentation, for a child that asks for `model` on instance `picked`.
pub(crate) fn decide(
    picked: &str,
    model: Option<&str>,
    instances: &[Instance],
    now: Timestamp,
) -> Decision {
    let Some(first) = instances.iter().find(|instance| instance.id == picked) else {
        return Decision::Picked;
    };
    if first.usable() && first.headroom(now) > 0.0 {
        return Decision::Start(first.id.clone());
    }
    let others: Vec<&Instance> = instances
        .iter()
        .filter(|other| other.id != picked && other.kind == first.kind)
        .filter(|other| other.usable() && other.serves(model))
        .collect();
    let mut best: Option<(&Instance, f64)> = None;
    for other in &others {
        let headroom = other.headroom(now);
        if headroom > 0.0 && best.is_none_or(|(_, most)| headroom > most) {
            best = Some((other, headroom));
        }
    }
    if let Some((best, _)) = best {
        return Decision::Start(best.id.clone());
    }
    let blocked: Vec<&Instance> = std::iter::once(first)
        .filter(|first| first.usable())
        .chain(others)
        .collect();
    if blocked.is_empty() {
        return Decision::Picked;
    }
    Decision::Wait {
        name: first.name.clone(),
        until: blocked
            .iter()
            .filter_map(|instance| instance.frees_at(now))
            .min(),
        on: blocked[0].id.clone(),
    }
}

/// A waiting child's reason, for people, in `zone`'s time: "Waiting for Claude Code quota,
/// resets at 3:40 PM PDT".
pub(crate) fn quota_reason(name: &str, until: Option<Timestamp>, zone: &TimeZone) -> String {
    let Some(until) = until else {
        return format!("Waiting for {name} quota");
    };
    let at = until.to_zoned(zone.clone());
    let today = Timestamp::now().to_zoned(zone.clone()).date() == at.date();
    let time = at.strftime("%-I:%M %p %Z");
    if today {
        format!("Waiting for {name} quota, resets at {time}")
    } else {
        format!(
            "Waiting for {name} quota, resets {} at {time}",
            at.strftime("%A")
        )
    }
}

/// Where a Project's child goes.
pub(super) enum Placed {
    /// On this account.
    Start(AccountChoice),
    /// Nowhere yet, for `reason`. Recorded on `on`, or the account it asked for when `None`.
    Wait {
        reason: String,
        on: Option<AccountChoice>,
    },
    /// On the account it asked for, or the worker default.
    Picked,
}

/// Places a child of `project`, in `mode`, that asked for `account` and `model`. `run` is the
/// child itself when it already counts among the Project's runs.
pub(super) async fn place(
    daemon: &Arc<Daemon>,
    project: ProjectId,
    run: Option<RunId>,
    account: Option<&AccountChoice>,
    model: Option<&str>,
    mode: ProjectPermission,
) -> Result<Placed, ErrorObject> {
    let (max, running, default) = store(daemon, move |db| {
        let max = db
            .get_project(project.into())
            .map_err(|e| store_error(&e))?
            .map_or(10, |row| row.max_children);
        let running = db
            .list_runs(Some(project.into()))
            .map_err(|e| store_error(&e))?
            .iter()
            .filter(|row| Some(row.id) != run.map(Into::into))
            .filter(|row| row.fields.policy != NO_WRITE)
            .filter(|row| [STARTING, RUNNING].contains(&row.state.status.as_str()))
            .count();
        let default = crate::methods::read_defaults(db)?.worker;
        Ok((max, running, default))
    })
    .await?;
    let Some(AccountChoice::Subscription { backend: picked }) = account.cloned().or(default) else {
        return Ok(slot(running, max, None).unwrap_or(Placed::Picked));
    };
    let instances = instances(daemon, mode).await?;
    let decision = decide(&picked, model, &instances, Timestamp::now());
    // Where it goes, or waits, when that isn't the instance it asked for.
    let elsewhere = match &decision {
        Decision::Start(id) | Decision::Wait { on: id, .. } if *id != picked => {
            Some(AccountChoice::Subscription {
                backend: id.clone(),
            })
        }
        _ => None,
    };
    if let Some(full) = slot(running, max, elsewhere.clone()) {
        return Ok(full);
    }
    Ok(match (decision, elsewhere) {
        (Decision::Wait { name, until, .. }, on) => Placed::Wait {
            reason: quota_reason(&name, until, &TimeZone::system()),
            on,
        },
        (Decision::Start(_), Some(account)) => Placed::Start(account),
        _ => Placed::Picked,
    })
}

/// A wait for a free slot, recorded on `on`, when the Project already runs `max` children.
fn slot(running: usize, max: u32, on: Option<AccountChoice>) -> Option<Placed> {
    if running < usize::try_from(max).unwrap_or(usize::MAX) {
        return None;
    }
    let children = if max == 1 { "child" } else { "children" };
    Some(Placed::Wait {
        reason: format!(
            "Waiting for a free slot: the Project runs at most {max} {children} at once"
        ),
        on,
    })
}

/// The host's instances as [`decide`] sees them, with their limit windows from the store.
async fn instances(
    daemon: &Arc<Daemon>,
    mode: ProjectPermission,
) -> Result<Vec<Instance>, ErrorObject> {
    let known = daemon.providers.known(&daemon.cli_detector).await;
    let mut instances: Vec<Instance> = known
        .into_iter()
        .map(|info| {
            let backend = daemon.agents.backends().by_backend_name(&info.instance.id);
            let mut models: Vec<String> = info.models.into_iter().map(|m| m.id).collect();
            models.extend(info.instance.models.into_iter().map(|m| m.id));
            Instance {
                in_mode: backend
                    .is_some_and(|(_, backend)| in_mode(backend.as_ref(), mode).is_ok()),
                id: info.instance.id,
                kind: info.instance.kind,
                name: info.instance.name,
                enabled: info.instance.enabled,
                signed_in: info.signed_in,
                models,
                reserve: info.instance.reserve.unwrap_or(0),
                limits: Vec::new(),
            }
        })
        .collect();
    let ids: Vec<String> = instances.iter().map(|i| i.id.clone()).collect();
    let limits = store(daemon, move |db| {
        ids.iter()
            .map(|id| db.limit_snapshots(id).map_err(|e| store_error(&e)))
            .collect::<Result<Vec<_>, _>>()
    })
    .await?;
    for (instance, limits) in instances.iter_mut().zip(limits) {
        instance.limits = limits;
    }
    Ok(instances)
}

/// Refuses an API key account, `chosen` for a child of `project` (a run in `role` `Worker`),
/// unless the Project allows API keys, and then takes every key account out of `accounts`, so
/// routing never falls back to one (0046). Leaves a coordinator or a run outside a Project alone.
pub(super) fn api_keys(
    role: Role,
    project: Option<&parallax_store::Project>,
    chosen: Option<&AccountChoice>,
    accounts: &mut StoredKeyAccounts,
) -> Result<(), ErrorObject> {
    let Some(project) = project.filter(|project| !project.allow_api_keys && role == Role::Worker)
    else {
        return Ok(());
    };
    if matches!(chosen, Some(AccountChoice::Key { .. })) {
        return Err(ErrorObject::parallax(
            ErrorKind::UnsupportedOption,
            format!(
                "The Project \"{}\" doesn't allow API keys. Pick a subscription, or allow API \
                 keys in its settings.",
                project.name
            ),
        ));
    }
    accounts.0.clear();
    Ok(())
}

/// What a waiting child's first message needs besides its text, as its queue row's JSON.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Extra {
    images: Vec<PromptImage>,
    threads: Vec<RunId>,
    account: Option<AccountChoice>,
}

/// Puts `run`, just recorded as waiting with its reason as its error, in the placement queue with
/// its first message `prompt`, and adds the reason to its Project's inbox.
pub(super) async fn queue(
    daemon: &Arc<Daemon>,
    run: &AgentRun,
    prompt: String,
    images: Vec<PromptImage>,
    threads: Vec<RunId>,
    account: Option<AccountChoice>,
) -> Result<(), ErrorObject> {
    let extra = Extra {
        images,
        threads,
        account,
    };
    let row = parallax_store::Placement {
        run_id: run.id.into(),
        project_id: run.project.into(),
        prompt,
        // Plain data, which serializes.
        extra: serde_json::to_string(&extra).unwrap_or_default(),
    };
    store(daemon, move |db| {
        db.add_placement(&row).map_err(|e| store_error(&e))
    })
    .await?;
    let reason = run.error.clone().unwrap_or_default();
    info!(run = %run.id, %reason, "a Project's child waits to be placed");
    let text = format!("{}: {reason}", wake::task(&run.prompt));
    crate::methods::inbox::add(daemon, run.project, run.id, InboxKind::Failed, text).await;
    Ok(())
}

/// A waiting child's first message, for its actor to start it with once placed.
pub(super) struct Pending {
    pub prompt: String,
    pub images: Vec<PromptImage>,
    pub threads: Vec<RunId>,
}

/// Run `id`'s first message, taking it out of the queue, if it waits to be placed.
pub(super) async fn take(daemon: &Daemon, id: RunId) -> Result<Option<Pending>, ErrorObject> {
    store(daemon, move |db| {
        let row = db
            .placements()
            .map_err(|e| store_error(&e))?
            .into_iter()
            .find(|row| row.run_id == uuid::Uuid::from(id));
        if row.is_some() {
            db.remove_placement(id.into())
                .map_err(|e| store_error(&e))?;
        }
        Ok(row.map(pending))
    })
    .await
}

fn pending(row: parallax_store::Placement) -> Pending {
    let extra: Extra = serde_json::from_str(&row.extra).unwrap_or_default();
    Pending {
        prompt: row.prompt,
        images: extra.images,
        threads: extra.threads,
    }
}

/// Starts the dispatcher, which runs until plxd stops. Called once at startup.
pub(super) fn start(daemon: &Arc<Daemon>) {
    let stop = daemon.agents.shutdown.clone();
    let owned = Arc::clone(daemon);
    daemon.agents.tracker.spawn(async move {
        let daemon = owned;
        loop {
            dispatch(&daemon).await;
            tokio::select! {
                () = stop.cancelled() => break,
                () = daemon.agents.placement.notified() => {}
                () = tokio::time::sleep(EVERY) => {}
            }
        }
    });
}

/// Starts every waiting child that now has room, oldest first, and drops from the queue those
/// that no longer wait.
async fn dispatch(daemon: &Arc<Daemon>) {
    let rows = store(daemon, |db| db.placements().map_err(|e| store_error(&e))).await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error.message, "could not read the children waiting to be placed");
            return;
        }
    };
    for row in rows {
        if let Err(error) = dispatch_one(daemon, row).await {
            warn!(error = %error.message, "could not place a waiting child");
        }
    }
}

/// Starts waiting child `row` if it now has room.
async fn dispatch_one(
    daemon: &Arc<Daemon>,
    row: parallax_store::Placement,
) -> Result<(), ErrorObject> {
    let run_id = row.run_id;
    let (Ok(id), Ok(project)) = (RunId::try_from(run_id), ProjectId::try_from(row.project_id))
    else {
        return drop_row(daemon, run_id).await;
    };
    let run = store(daemon, move |db| {
        db.get_run(run_id).map_err(|e| store_error(&e))
    })
    .await?;
    let mode = project_mode(daemon, project).await?;
    let (Some(run), Some(mode)) = (run, mode) else {
        return drop_row(daemon, run_id).await;
    };
    // A message, Resume now, or Cancel already ended its wait.
    if run.state.status != WAITING {
        return drop_row(daemon, run_id).await;
    }
    let extra: Extra = serde_json::from_str(&row.extra).unwrap_or_default();
    let model = run.fields.model.as_deref();
    // Held until the child runs, so a new child can't take the same slot meanwhile.
    let placing = daemon.agents.placing.lock().await;
    let account = match place(
        daemon,
        project,
        Some(id),
        extra.account.as_ref(),
        model,
        mode,
    )
    .await?
    {
        Placed::Wait { .. } => return Ok(()),
        Placed::Start(account) => account,
        Placed::Picked => session_account(&run.state.account_id),
    };
    info!(run = %id, account = ?account, "placing a waiting child");
    let pending = pending(row);
    ask(daemon, id, |reply| Command::Place {
        account,
        pending,
        reply,
    })
    .await?;
    drop(placing);
    drop_row(daemon, run_id).await
}

async fn drop_row(daemon: &Daemon, run_id: uuid::Uuid) -> Result<(), ErrorObject> {
    store(daemon, move |db| {
        db.remove_placement(run_id).map_err(|e| store_error(&e))
    })
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use jiff::{SignedDuration, Timestamp};
    use parallax_protocol::ProviderKind;
    use parallax_store::LimitSnapshot;

    use super::{Decision, Instance, decide, quota_reason};

    fn now() -> Timestamp {
        "2026-10-04T12:00:00Z".parse().unwrap()
    }

    fn at(minutes: i64) -> Timestamp {
        now() + SignedDuration::from_mins(minutes)
    }

    /// A signed-in Claude Code instance in the Project's mode, with no reserve and no limits.
    fn claude(id: &str) -> Instance {
        Instance {
            id: id.to_owned(),
            kind: ProviderKind::Claude,
            name: format!("Claude {id}"),
            enabled: true,
            signed_in: Some(true),
            in_mode: true,
            models: Vec::new(),
            reserve: 0,
            limits: Vec::new(),
        }
    }

    /// `instance` with a window `used` percent used, resetting in `resets` minutes.
    fn used(mut instance: Instance, used: f64, resets: i64) -> Instance {
        instance.limits.push(LimitSnapshot {
            account_id: instance.id.clone(),
            window: format!("w{}", instance.limits.len()),
            used_percent: Some(used),
            resets_at: Some(at(resets)),
            captured_at: now(),
        });
        instance
    }

    fn start(id: &str) -> Decision {
        Decision::Start(id.to_owned())
    }

    #[test]
    fn the_picked_instance_takes_the_child_while_under_its_reserve() {
        let instances = [used(claude("a"), 70.0, 60), claude("b")];
        assert_eq!(decide("a", None, &instances, now()), start("a"));
        let mut reserved = instances.clone();
        reserved[0].reserve = 30;
        assert_eq!(decide("a", None, &reserved, now()), start("b"));
    }

    #[test]
    fn at_its_limit_minus_its_reserve_an_instance_takes_no_child() {
        let mut a = used(claude("a"), 80.0, 60);
        a.reserve = 20;
        let decided = decide("a", None, &[a], now());
        assert_eq!(
            decided,
            Decision::Wait {
                name: "Claude a".to_owned(),
                until: Some(at(60)),
                on: "a".to_owned(),
            }
        );
    }

    #[test]
    fn every_window_counts_and_one_that_reset_counts_as_reset() {
        // The weekly window is full, so the five-hour one's room doesn't help.
        let full = used(used(claude("a"), 10.0, 60), 100.0, 3000);
        assert!(matches!(
            decide("a", None, &[full], now()),
            Decision::Wait { .. }
        ));
        // A full window whose reset has passed is no longer full.
        let reset = used(claude("a"), 100.0, -5);
        assert_eq!(decide("a", None, &[reset], now()), start("a"));
    }

    #[test]
    fn an_instance_that_reports_no_limits_is_always_eligible() {
        let mut cursor = claude("cursor");
        cursor.kind = ProviderKind::Cursor;
        cursor.reserve = 100;
        assert_eq!(decide("cursor", None, &[cursor], now()), start("cursor"));
    }

    #[test]
    fn a_disabled_signed_out_or_modeless_pick_goes_to_another_of_its_kind() {
        let mut disabled = claude("a");
        disabled.enabled = false;
        let mut signed_out = claude("a");
        signed_out.signed_in = Some(false);
        let mut modeless = claude("a");
        modeless.in_mode = false;
        for picked in [disabled, signed_out, modeless] {
            assert_eq!(decide("a", None, &[picked, claude("b")], now()), start("b"));
        }
        // Unknown sign-in doesn't stop it.
        let mut unknown = claude("a");
        unknown.signed_in = None;
        assert_eq!(decide("a", None, &[unknown], now()), start("a"));
    }

    #[test]
    fn a_disabled_pick_whose_siblings_are_full_waits_recorded_on_a_sibling() {
        let mut disabled = claude("a");
        disabled.enabled = false;
        let full = used(claude("b"), 100.0, 45);
        assert_eq!(
            decide("a", None, &[disabled, full], now()),
            Decision::Wait {
                name: "Claude a".to_owned(),
                until: Some(at(45)),
                on: "b".to_owned(),
            }
        );
    }

    #[test]
    fn another_instance_must_be_the_same_kind_serve_the_model_and_have_the_most_headroom() {
        let full = used(claude("a"), 100.0, 60);
        let mut codex = claude("codex");
        codex.kind = ProviderKind::Codex;
        let mut other_models = claude("b");
        other_models.models = vec!["sonnet".to_owned()];
        let roomy = used(claude("c"), 20.0, 60);
        let roomier = used(claude("d"), 10.0, 60);
        let instances = [full, codex, other_models, roomy, roomier];
        assert_eq!(decide("a", Some("opus"), &instances, now()), start("d"));
        // `b` lists `sonnet`, and an instance that lists none serves any model.
        let instances = [instances[0].clone(), instances[2].clone()];
        assert_eq!(decide("a", Some("sonnet"), &instances, now()), start("b"));
        assert!(matches!(
            decide("a", Some("opus"), &instances, now()),
            Decision::Wait { .. }
        ));
    }

    #[test]
    fn with_no_room_anywhere_the_child_waits_for_the_first_reset() {
        let instances = [
            used(claude("a"), 100.0, 90),
            used(claude("b"), 100.0, 30),
            used(used(claude("c"), 100.0, 10), 100.0, 120),
        ];
        assert_eq!(
            decide("a", None, &instances, now()),
            Decision::Wait {
                name: "Claude a".to_owned(),
                until: Some(at(30)),
                on: "a".to_owned(),
            }
        );
    }

    #[test]
    fn when_something_other_than_quota_stops_every_instance_the_pick_starts_and_says_why() {
        let mut signed_out = claude("a");
        signed_out.signed_in = Some(false);
        assert_eq!(decide("a", None, &[signed_out], now()), Decision::Picked);
        // An account plxd doesn't list as an instance starts as it always did.
        assert_eq!(decide("x", None, &[claude("a")], now()), Decision::Picked);
    }

    #[test]
    fn without_the_projects_allowance_a_child_never_uses_or_falls_back_to_an_api_key() {
        use std::collections::HashMap;

        use parallax_protocol::{AccountChoice, AccountId, Provider, Role};

        use super::api_keys;
        use crate::agents::worker::StoredKeyAccounts;

        let key = AccountId::generate();
        let keys = || StoredKeyAccounts(HashMap::from([(key, Provider::Anthropic)]));
        let project = |allow_api_keys| parallax_store::Project {
            id: uuid::Uuid::now_v7(),
            name: "app".to_owned(),
            repo_path: "/src/app".to_owned(),
            icon: None,
            permission: "bypass".to_owned(),
            autonomy: "routine".to_owned(),
            base_branch: None,
            integration_branch: None,
            auto_land: false,
            max_children: 10,
            allow_api_keys,
            checks: None,
            proposed_checks: None,
            created_at: now(),
            updated_at: now(),
        };
        let on_key = AccountChoice::Key { id: key };
        let on_login = AccountChoice::Subscription {
            backend: "claude".to_owned(),
        };

        let mut accounts = keys();
        assert!(
            api_keys(
                Role::Worker,
                Some(&project(false)),
                Some(&on_key),
                &mut accounts
            )
            .is_err()
        );
        api_keys(
            Role::Worker,
            Some(&project(false)),
            Some(&on_login),
            &mut accounts,
        )
        .unwrap();
        assert!(accounts.0.is_empty(), "no fallback to a key");

        for (project, choice) in [(Some(project(true)), &on_key), (None, &on_key)] {
            let mut accounts = keys();
            api_keys(Role::Worker, project.as_ref(), Some(choice), &mut accounts).unwrap();
            assert_eq!(accounts.0.len(), 1);
        }
        let coordinator = parallax_protocol::Role::Coordinator;
        api_keys(
            coordinator,
            Some(&project(false)),
            Some(&on_key),
            &mut keys(),
        )
        .unwrap();
    }

    #[test]
    fn the_reason_names_the_instance_and_its_reset_in_local_time() {
        let zone = jiff::tz::TimeZone::fixed(jiff::tz::offset(-7));
        let reset = Timestamp::now()
            .to_zoned(zone.clone())
            .date()
            .at(15, 40, 0, 0)
            .to_zoned(zone.clone())
            .unwrap()
            .timestamp();
        let named = reset.to_zoned(zone.clone()).strftime("%Z").to_string();
        assert_eq!(
            quota_reason("Claude", Some(reset), &zone),
            format!("Waiting for Claude quota, resets at 3:40 PM {named}")
        );
        assert_eq!(
            quota_reason("Claude", None, &zone),
            "Waiting for Claude quota"
        );
        let later = reset + SignedDuration::from_hours(48);
        assert!(
            quota_reason("Claude", Some(later), &zone).contains(" at 3:40 PM "),
            "a reset on another day names the day"
        );
    }
}
