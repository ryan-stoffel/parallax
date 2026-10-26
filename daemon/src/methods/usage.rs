//! `usage/get` and `usage/history`, from what plxd's own runs recorded, `usage/daily`, from
//! every Claude Code, Codex, and Cursor session on the host (0039), and `usage/limits`, from each
//! subscription's CLI (PLX-541).

mod ccusage;
mod cursor;

use jiff::tz::TimeZone;
use jiff::{ToSpan, Zoned};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountLimits, AccountRuns, AccountUsage, UsageDailyParams, UsageDailyResult, UsageGetParams,
    UsageGetResult, UsageHistoryParams, UsageHistoryResult, UsageHour, UsageLimitWindow,
    UsageLimitsParams, UsageLimitsResult, UsagePeriod, UsageProblem, UsageSource,
};
use parallax_store::{LimitSnapshot, Store, StoreError};

use super::Context;
use crate::backend::StartError;
use crate::backend::commands;
use crate::backend::process::SpawnError;
use crate::store::store_error;

/// How long a CLI gets to report its limit windows.
const LIMITS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Every account plxd has recorded usage or limits for, with today's and this week's sums
/// (local time on this host) and the latest limit windows.
pub(crate) async fn get(
    context: &Context,
    _: UsageGetParams,
) -> Result<UsageGetResult, ErrorObject> {
    let now = Zoned::now();
    let (day_start, week_start) = local_bounds(&now).map_err(ErrorObject::internal_error)?;
    let until = now.timestamp();
    context
        .daemon
        .reader
        .run(&context.cancel, move |store| {
            usage_report(store, day_start, week_start, until).map_err(|error| store_error(&error))
        })
        .await
}

/// Gathers every known account's usage report from the store. A plain, synchronous function so it
/// can run directly on the store's thread (see [`get`]) and be tested against a real [`Store`]
/// with no async runtime.
fn usage_report(
    store: &Store,
    day_start: jiff::Timestamp,
    week_start: jiff::Timestamp,
    until: jiff::Timestamp,
) -> Result<UsageGetResult, StoreError> {
    let mut accounts = Vec::new();
    for account_id in store.usage_account_ids()? {
        let today = usage_period(store.usage_summary(&account_id, day_start, until)?);
        let week = usage_period(store.usage_summary(&account_id, week_start, until)?);
        let limits = store
            .limit_snapshots(&account_id)?
            .into_iter()
            .map(limit_window)
            .collect();
        accounts.push(AccountUsage {
            account_id,
            today,
            week,
            limits,
        });
    }
    Ok(UsageGetResult { accounts })
}

/// Every account's usage since `params.since`, per UTC hour and model, and its run count.
pub(crate) async fn history(
    context: &Context,
    params: UsageHistoryParams,
) -> Result<UsageHistoryResult, ErrorObject> {
    let until = jiff::Timestamp::now();
    context
        .daemon
        .store
        .run(&context.cancel, move |store| {
            usage_history(store, params.since, until).map_err(|error| store_error(&error))
        })
        .await
}

/// Reads `usage/history`'s result from the store for `[since, until)`. Synchronous for the same
/// reason as [`usage_report`].
fn usage_history(
    store: &Store,
    since: jiff::Timestamp,
    until: jiff::Timestamp,
) -> Result<UsageHistoryResult, StoreError> {
    let hours = store
        .usage_hours(since, until)?
        .into_iter()
        .map(|hour| UsageHour {
            hour: hour.hour,
            account_id: hour.account_id,
            model: hour.model,
            input_tokens: hour.input_tokens,
            output_tokens: hour.output_tokens,
            cache_read_tokens: hour.cache_read_tokens,
            cache_write_tokens: hour.cache_write_tokens,
            cost_usd_micros: hour.cost_usd_micros,
        })
        .collect();
    let runs = store
        .usage_run_counts(since, until)?
        .into_iter()
        .map(|(account_id, runs)| AccountRuns { account_id, runs })
        .collect();
    Ok(UsageHistoryResult { hours, runs })
}

/// Every Claude Code and Codex session's usage from ccusage, and Cursor's from its API, since
/// `params.since`, by local day in `params.time_zone`, with Claude Code's and Codex's session
/// counts. A source that fails is a problem in the answer, beside the others' usage; sessions
/// that can't be counted are left out.
pub(crate) async fn daily(
    context: &Context,
    params: UsageDailyParams,
) -> Result<UsageDailyResult, ErrorObject> {
    let zone = TimeZone::get(&params.time_zone).map_err(ErrorObject::invalid_params)?;
    let launcher = context.daemon.cli_detector.launcher();
    // One ccusage at a time: two at once can fail on another agent's locked SQLite file.
    let ccusage = async {
        let days = ccusage::daily(launcher, params.since, &params.time_zone).await;
        // Sessions mean nothing without the days, and a failed ccusage may have timed out.
        let sessions = match days {
            Ok(_) => ccusage::sessions(launcher, params.since, &params.time_zone, &zone).await,
            Err(_) => None,
        };
        (days, sessions)
    };
    let sources = async { tokio::join!(ccusage, cursor::daily(launcher, params.since, &zone)) };
    // Dropping the sources kills whatever they're running.
    let ((claude_and_codex, sessions), cursor) = tokio::select! {
        () = context.cancel.cancelled() => return Err(ErrorObject::request_cancelled()),
        answers = sources => answers,
    };
    let mut result = UsageDailyResult {
        sessions,
        ..UsageDailyResult::default()
    };
    for (source, answer) in [
        (UsageSource::Ccusage, claude_and_codex),
        (UsageSource::Cursor, cursor),
    ] {
        match answer {
            Ok(days) => result.days.extend(days),
            Err(message) => result.problems.push(UsageProblem { source, message }),
        }
    }
    Ok(result)
}

/// Every subscription's limit windows, each read from its CLI at once, in the home folder. A
/// CLI that isn't installed is left out; one that fails to start or answer reports why.
pub(crate) async fn limits(
    context: &Context,
    _: UsageLimitsParams,
) -> Result<UsageLimitsResult, ErrorObject> {
    let home = std::env::home_dir()
        .filter(|home| home.is_absolute())
        .ok_or_else(|| ErrorObject::internal_error("the home folder is unknown"))?;
    let reads = context
        .daemon
        .agents
        .backends()
        .by_name()
        .into_iter()
        .filter_map(|(name, backend)| match backend.limits(&home) {
            Ok(None) | Err(StartError::Spawn(SpawnError::NotFound { .. })) => None,
            Ok(Some(probe)) => Some((name, Ok(probe))),
            Err(error) => Some((name, Err(error.to_string()))),
        })
        .map(|(account_id, probe)| async move {
            let answer = match probe {
                Ok(probe) => commands::list(probe, LIMITS_TIMEOUT).await,
                Err(error) => Err(error),
            };
            let (limits, problem) = match answer {
                Ok(limits) => (limits, None),
                Err(problem) => (Vec::new(), Some(problem)),
            };
            AccountLimits {
                account_id,
                limits,
                problem,
            }
        });
    // Dropping the reads kills their CLIs.
    tokio::select! {
        () = context.cancel.cancelled() => Err(ErrorObject::request_cancelled()),
        accounts = futures_util::future::join_all(reads) => Ok(UsageLimitsResult { accounts }),
    }
}

fn usage_period(summary: parallax_store::UsageSummary) -> UsagePeriod {
    UsagePeriod {
        input_tokens: summary.input_tokens,
        output_tokens: summary.output_tokens,
        cache_read_tokens: summary.cache_read_tokens,
        cache_write_tokens: summary.cache_write_tokens,
        cost_usd_micros: summary.cost_usd_micros,
    }
}

fn limit_window(snapshot: LimitSnapshot) -> UsageLimitWindow {
    UsageLimitWindow {
        window: snapshot.window,
        used_percent: snapshot.used_percent,
        resets_at: snapshot.resets_at,
        captured_at: snapshot.captured_at,
    }
}

/// Local midnight today, and local midnight of the most recent Monday (today, if today is
/// Monday), for `now`.
fn local_bounds(now: &Zoned) -> Result<(jiff::Timestamp, jiff::Timestamp), jiff::Error> {
    let day_start = now.start_of_day()?;
    let monday_offset = i64::from(now.date().weekday().to_monday_zero_offset());
    let week_start_date = now.date().saturating_sub(monday_offset.days());
    let week_start = week_start_date
        .to_zoned(now.time_zone().clone())?
        .start_of_day()?;
    Ok((day_start.timestamp(), week_start.timestamp()))
}
