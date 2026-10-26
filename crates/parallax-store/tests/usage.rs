//! Per-account usage: deltas, limit snapshots, and session totals, against a real store.

use parallax_store::{LimitSnapshot, SessionModelUsage, Store, UsageDelta, UsageHour};
use uuid::Uuid;

/// A store in a temporary directory, which lives as long as the `TempDir`.
fn open_temp() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = Store::open(dir.path().join("parallax.sqlite3")).expect("open");
    (dir, store)
}

fn delta(run_id: Uuid, account_id: &str, at: &str, input: u64) -> UsageDelta {
    UsageDelta {
        run_id,
        account_id: account_id.to_owned(),
        model: Some("claude-opus".to_owned()),
        input_tokens: input,
        output_tokens: input,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd_micros: Some(input * 10),
        at: at.parse().expect("parse timestamp"),
    }
}

/// The day boundary is `[start, end)`: a delta exactly at the end of a day belongs to the next
/// day, and one exactly at the start of a day belongs to it.
#[test]
fn deltas_are_bucketed_correctly_across_a_day_boundary() {
    let (_dir, store) = open_temp();
    let run = Uuid::now_v7();
    store
        .record_usage_delta(&delta(run, "acct", "2026-09-23T23:59:59Z", 1))
        .expect("record");
    store
        .record_usage_delta(&delta(run, "acct", "2026-09-24T00:00:00Z", 2))
        .expect("record");
    store
        .record_usage_delta(&delta(run, "acct", "2026-09-24T23:59:59.999999999Z", 4))
        .expect("record");
    store
        .record_usage_delta(&delta(run, "acct", "2026-09-25T00:00:00Z", 8))
        .expect("record");

    let today = store
        .usage_summary(
            "acct",
            "2026-09-24T00:00:00Z".parse().unwrap(),
            "2026-09-25T00:00:00Z".parse().unwrap(),
        )
        .expect("summary");
    assert_eq!(today.input_tokens, 2 + 4, "half-open range: [start, end)");

    let week = store
        .usage_summary(
            "acct",
            "2026-09-21T00:00:00Z".parse().unwrap(),
            "2026-09-25T00:00:00Z".parse().unwrap(),
        )
        .expect("summary");
    assert_eq!(
        week.input_tokens,
        1 + 2 + 4,
        "the week also excludes the 25th"
    );
}

fn hours(store: &Store, since: &str, until: &str) -> Vec<UsageHour> {
    store
        .usage_hours(since.parse().unwrap(), until.parse().unwrap())
        .expect("hours")
}

/// `(hour, account, model, input tokens, cost)` of a row, to compare in one assert.
type Row<'a> = (String, &'a str, Option<&'a str>, u64, Option<u64>);

fn summarize(hours: &[UsageHour]) -> Vec<Row<'_>> {
    hours
        .iter()
        .map(|h| {
            (
                h.hour.to_string(),
                h.account_id.as_str(),
                h.model.as_deref(),
                h.input_tokens,
                h.cost_usd_micros,
            )
        })
        .collect()
}

#[test]
fn usage_hours_sum_per_utc_hour_account_and_model() {
    let (_dir, store) = open_temp();
    let run = Uuid::now_v7();
    let with_model = |account, at, input, model: Option<&str>| UsageDelta {
        model: model.map(str::to_owned),
        ..delta(run, account, at, input)
    };
    for delta in [
        with_model("a", "2026-09-24T10:05:00Z", 1, Some("opus")),
        with_model("a", "2026-09-24T10:55:00Z", 2, Some("opus")),
        with_model("a", "2026-09-24T10:30:00Z", 4, Some("sonnet")),
        with_model("b", "2026-09-24T10:10:00Z", 8, Some("opus")),
        with_model("a", "2026-09-24T11:00:00Z", 16, Some("opus")),
        with_model("a", "2026-09-24T11:20:00Z", 32, None),
    ] {
        store.record_usage_delta(&delta).expect("record");
    }

    assert_eq!(
        summarize(&hours(
            &store,
            "2026-09-24T00:00:00Z",
            "2026-09-25T00:00:00Z"
        )),
        [
            (
                "2026-09-24T10:00:00Z".to_owned(),
                "a",
                Some("opus"),
                1 + 2,
                Some(30)
            ),
            (
                "2026-09-24T10:00:00Z".to_owned(),
                "a",
                Some("sonnet"),
                4,
                Some(40)
            ),
            (
                "2026-09-24T10:00:00Z".to_owned(),
                "b",
                Some("opus"),
                8,
                Some(80)
            ),
            ("2026-09-24T11:00:00Z".to_owned(), "a", None, 32, Some(320)),
            (
                "2026-09-24T11:00:00Z".to_owned(),
                "a",
                Some("opus"),
                16,
                Some(160)
            ),
        ],
        "one row per hour, account, and model, ordered that way; no row for empty hours"
    );
}

/// The range is `[since, until)`, even when `since` falls mid-hour: that hour's row sums only
/// the deltas from `since` on.
#[test]
fn usage_hours_cover_since_up_to_until() {
    let (_dir, store) = open_temp();
    let run = Uuid::now_v7();
    for (at, input) in [
        ("2026-09-24T10:29:59.999999999Z", 1),
        ("2026-09-24T10:30:00Z", 2),
        ("2026-09-24T10:45:00Z", 4),
        ("2026-09-24T12:00:00Z", 8),
    ] {
        store
            .record_usage_delta(&delta(run, "a", at, input))
            .expect("record");
    }

    assert_eq!(
        summarize(&hours(
            &store,
            "2026-09-24T10:30:00Z",
            "2026-09-24T12:00:00Z"
        )),
        [(
            "2026-09-24T10:00:00Z".to_owned(),
            "a",
            Some("claude-opus"),
            2 + 4,
            Some(60)
        )],
    );
}

#[test]
fn run_counts_are_distinct_runs_per_account_in_range() {
    let (_dir, store) = open_temp();
    let (first, second, other, earlier) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    for delta in [
        delta(first, "a", "2026-09-24T10:00:00Z", 1),
        delta(first, "a", "2026-09-24T11:00:00Z", 1),
        delta(second, "a", "2026-09-24T12:00:00Z", 1),
        delta(other, "b", "2026-09-24T10:00:00Z", 1),
        delta(earlier, "a", "2026-09-23T23:59:59Z", 1),
    ] {
        store.record_usage_delta(&delta).expect("record");
    }

    assert_eq!(
        store
            .usage_run_counts(
                "2026-09-24T00:00:00Z".parse().unwrap(),
                "2026-09-25T00:00:00Z".parse().unwrap(),
            )
            .expect("runs"),
        [("a".to_owned(), 2), ("b".to_owned(), 1)],
        "a run with several deltas counts once; one before `since` not at all"
    );
}

#[test]
fn a_newer_limit_snapshot_replaces_the_old_one_but_an_older_one_does_not() {
    let (_dir, store) = open_temp();
    let snapshot = |used_percent: f64, captured_at: &str| LimitSnapshot {
        account_id: "claude-max".to_owned(),
        window: "five_hour".to_owned(),
        used_percent: Some(used_percent),
        resets_at: Some("2026-09-24T17:00:00Z".parse().unwrap()),
        captured_at: captured_at.parse().unwrap(),
    };
    store
        .record_limit_snapshot(&snapshot(10.0, "2026-09-24T12:00:00Z"))
        .expect("record");
    store
        .record_limit_snapshot(&snapshot(42.5, "2026-09-24T13:00:00Z"))
        .expect("record");
    // Out of order: an older capture must not overwrite the newer one already stored.
    store
        .record_limit_snapshot(&snapshot(99.0, "2026-09-24T12:30:00Z"))
        .expect("record");

    let snapshots = store.limit_snapshots("claude-max").expect("limits");
    assert_eq!(snapshots.len(), 1, "one row per (account, window)");
    assert_eq!(snapshots[0].used_percent, Some(42.5));
}

#[test]
fn resuming_a_session_replaces_its_totals_instead_of_adding_to_them() {
    let (_dir, mut store) = open_temp();
    let first = SessionModelUsage {
        model: Some("opus".to_owned()),
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd_micros: Some(500),
    };
    store
        .set_session_usage_totals("sess-1", std::slice::from_ref(&first))
        .expect("set totals");
    assert_eq!(
        store.session_usage_totals("sess-1").expect("totals"),
        [first]
    );

    // A later run of the same session reports the vendor's new cumulative totals, which must
    // replace the baseline wholesale rather than add to it.
    let second = SessionModelUsage {
        model: Some("opus".to_owned()),
        input_tokens: 120,
        output_tokens: 15,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd_micros: Some(600),
    };
    store
        .set_session_usage_totals("sess-1", std::slice::from_ref(&second))
        .expect("set totals");
    assert_eq!(
        store.session_usage_totals("sess-1").expect("totals"),
        [second],
        "must not be 100+120 etc.: totals replace, they never add"
    );
}
