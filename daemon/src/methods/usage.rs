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
use crate::backend::commands;
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
        .store
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
/// `params.since`, by local day in `params.time_zone`. A source that fails is a problem in the
/// answer, beside the others' usage.
pub(crate) async fn daily(
    context: &Context,
    params: UsageDailyParams,
) -> Result<UsageDailyResult, ErrorObject> {
    let zone = TimeZone::get(&params.time_zone).map_err(ErrorObject::invalid_params)?;
    let launcher = context.daemon.cli_detector.launcher();
    let sources = async {
        tokio::join!(
            ccusage::daily(launcher, params.since, &params.time_zone),
            cursor::daily(launcher, params.since, &zone),
        )
    };
    // Dropping the sources kills whatever they're running.
    let (claude_and_codex, cursor) = tokio::select! {
        () = context.cancel.cancelled() => return Err(ErrorObject::request_cancelled()),
        answers = sources => answers,
    };
    let mut result = UsageDailyResult::default();
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
/// CLI that can't be started, such as one that isn't installed, is left out; one that fails
/// after starting reports why.
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
        .filter_map(|(name, backend)| Some((name, backend.limits(&home).ok()??)))
        .map(|(account_id, probe)| async move {
            match commands::list(probe, LIMITS_TIMEOUT).await {
                Ok(limits) => AccountLimits {
                    account_id,
                    limits,
                    problem: None,
                },
                Err(problem) => AccountLimits {
                    account_id,
                    limits: Vec::new(),
                    problem: Some(problem),
                },
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

#[cfg(test)]
mod tests {
    use jiff::civil::date;
    use parallax_store::{LimitSnapshot, Store, UsageDelta};
    use uuid::Uuid;

    use super::{local_bounds, usage_history, usage_report};

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("parallax.sqlite3");
        let store = Store::open(&path).unwrap();
        (dir, store)
    }

    #[test]
    fn week_start_is_the_most_recent_monday_in_the_zones_local_time() {
        for (day, expected_monday) in [
            (date(2026, 9, 21), date(2026, 9, 21)), // a Monday
            (date(2026, 9, 23), date(2026, 9, 21)), // mid-week
            (date(2026, 9, 27), date(2026, 9, 21)), // a Sunday: still last Monday
            (date(2026, 9, 28), date(2026, 9, 28)), // the next Monday
        ] {
            let zoned = day
                .at(15, 30, 0, 0)
                .to_zoned(jiff::tz::TimeZone::UTC)
                .unwrap();
            let (day_start, week_start) = local_bounds(&zoned).unwrap();
            assert_eq!(
                day_start,
                day.to_zoned(jiff::tz::TimeZone::UTC).unwrap().timestamp(),
                "{day:?}"
            );
            assert_eq!(
                week_start,
                expected_monday
                    .to_zoned(jiff::tz::TimeZone::UTC)
                    .unwrap()
                    .timestamp(),
                "{day:?}"
            );
        }
    }

    /// `local_bounds` has to resolve each date's own UTC offset, not carry over `now`'s: America's
    /// fall-back from PDT (UTC-7) to PST (UTC-8) happened at 2 a.m. on Sunday, November 1, 2026,
    /// so a week that starts on the preceding Monday, October 26, spans the transition.
    #[test]
    fn local_bounds_are_correct_across_a_dst_transition_in_an_observing_zone() {
        let tz =
            jiff::tz::TimeZone::get("America/Los_Angeles").expect("zoneinfo for the test zone");

        // Sunday, the day the clocks fall back. Local midnight is still before the 2 a.m.
        // transition, so it's PDT (UTC-7).
        let before = date(2026, 11, 1)
            .at(3, 0, 0, 0)
            .to_zoned(tz.clone())
            .unwrap();
        let (day_start, week_start) = local_bounds(&before).unwrap();
        assert_eq!(
            day_start,
            "2026-11-01T07:00:00Z".parse().unwrap(),
            "2026-11-01T00:00:00 PDT (UTC-7)"
        );
        assert_eq!(
            week_start,
            "2026-10-26T07:00:00Z".parse().unwrap(),
            "the preceding Monday, also PDT: the week spans the transition"
        );

        // The next day: local midnight is now PST (UTC-8).
        let after = date(2026, 11, 2)
            .at(10, 0, 0, 0)
            .to_zoned(tz.clone())
            .unwrap();
        let (day_start, week_start) = local_bounds(&after).unwrap();
        assert_eq!(
            day_start,
            "2026-11-02T08:00:00Z".parse().unwrap(),
            "2026-11-02T00:00:00 PST (UTC-8)"
        );
        assert_eq!(
            day_start, week_start,
            "Monday's own midnight is the week start"
        );
    }

    #[test]
    fn a_report_covers_every_account_with_usage_or_limits_and_omits_unreported_cost() {
        let (_dir, store) = open();
        store
            .record_usage_delta(&UsageDelta {
                run_id: Uuid::now_v7(),
                account_id: "claude-max".to_owned(),
                model: Some("opus".to_owned()),
                input_tokens: 100,
                output_tokens: 10,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_usd_micros: Some(50),
                at: jiff::Timestamp::now(),
            })
            .unwrap();
        store
            .record_limit_snapshot(&LimitSnapshot {
                account_id: "codex-work".to_owned(),
                window: "primary".to_owned(),
                used_percent: Some(5.0),
                resets_at: None,
                captured_at: jiff::Timestamp::now(),
            })
            .unwrap();

        let far_past = "2020-01-01T00:00:00Z".parse().unwrap();
        let far_future = "2030-01-01T00:00:00Z".parse().unwrap();
        let report = usage_report(&store, far_past, far_past, far_future).unwrap();
        assert_eq!(report.accounts.len(), 2);

        let claude = report
            .accounts
            .iter()
            .find(|a| a.account_id == "claude-max")
            .unwrap();
        assert_eq!(claude.today.input_tokens, 100);
        assert_eq!(claude.today.cost_usd_micros, Some(50));
        assert!(claude.limits.is_empty());

        let codex = report
            .accounts
            .iter()
            .find(|a| a.account_id == "codex-work")
            .unwrap();
        assert_eq!(codex.today.input_tokens, 0);
        assert_eq!(
            codex.today.cost_usd_micros, None,
            "not reported, since codex-work has no usage deltas at all"
        );
        assert_eq!(codex.limits.len(), 1);
    }

    #[test]
    fn a_store_with_no_usage_reports_no_accounts() {
        let (_dir, store) = open();
        let far_past = "2020-01-01T00:00:00Z".parse().unwrap();
        let far_future = "2030-01-01T00:00:00Z".parse().unwrap();
        let report = usage_report(&store, far_past, far_past, far_future).unwrap();
        assert!(report.accounts.is_empty());
    }

    #[test]
    fn a_history_reports_each_hours_usage_and_each_accounts_runs() {
        let (_dir, store) = open();
        store
            .record_usage_delta(&UsageDelta {
                run_id: Uuid::now_v7(),
                account_id: "codex-work".to_owned(),
                model: None,
                input_tokens: 100,
                output_tokens: 10,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                cost_usd_micros: None,
                at: "2026-09-29T19:42:10.5Z".parse().unwrap(),
            })
            .unwrap();

        let history = usage_history(
            &store,
            "2026-09-29T00:00:00Z".parse().unwrap(),
            "2026-09-30T00:00:00Z".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(
            history.hours,
            [parallax_protocol::UsageHour {
                hour: "2026-09-29T19:00:00Z".parse().unwrap(),
                account_id: "codex-work".to_owned(),
                model: None,
                input_tokens: 100,
                output_tokens: 10,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                cost_usd_micros: None,
            }]
        );
        assert_eq!(
            history.runs,
            [parallax_protocol::AccountRuns {
                account_id: "codex-work".to_owned(),
                runs: 1,
            }]
        );
    }
}
