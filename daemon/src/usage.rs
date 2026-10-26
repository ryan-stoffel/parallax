//! Turns backend usage events (0004, #113) into `parallax-store` rows (#120).
//!
//! [`record_event`] is a plain, synchronous function over `&mut parallax_store::Store`, the same
//! shape [`crate::methods::project`] uses for `project/create`. The runner (`crate::agents`,
//! #156) calls it once per event through the store's single-thread owner
//! ([`crate::store::StoreHandle::run`](../store/struct.StoreHandle.html#method.run)), charged to
//! whichever account the run is on at that point, which changes on `Event::AccountFallback`.

use jiff::Timestamp;
use parallax_store::{LimitSnapshot, SessionModelUsage, Store, StoreError, UsageDelta};

use crate::backend::{Event, ModelUsage, RunId};

/// Turns one backend event into store writes for `run_id`, charged to `account_id`, in
/// `session_id`'s vendor session (from that run's earlier `Event::SessionStarted`). Every other
/// event kind is a no-op.
///
/// # Errors
///
/// Returns a database error.
pub fn record_event(
    store: &mut Store,
    run_id: RunId,
    account_id: &str,
    session_id: &str,
    event: &Event,
) -> Result<(), StoreError> {
    match event {
        Event::Usage(delta) if !delta.usage.is_zero() => {
            store.record_usage_delta(&usage_delta(run_id, account_id, delta))?;
        }
        Event::RateLimit(window) => {
            store.record_limit_snapshot(&LimitSnapshot {
                account_id: account_id.to_owned(),
                window: window.window.clone(),
                used_percent: window.used_percent,
                resets_at: window.resets_at,
                captured_at: Timestamp::now(),
            })?;
        }
        // `usage_totals` is empty only when the vendor's own totals are genuinely empty (a
        // fresh session that used nothing, in which case there is no baseline to lose), or when
        // `EventStream` synthesizes this event because the backend task died without ever
        // calling `EventSink::finish` (`EventStream::next` in `backend/mod.rs`). In the second case the
        // session may already have a real baseline recorded from before the crash, and replacing
        // it with nothing would make the next resume start from zero and double-count every
        // delta the vendor's cumulative total already carries. Skipping the write leaves the
        // last known baseline in place either way.
        Event::Finished { usage_totals, .. } if !usage_totals.is_empty() => {
            let totals: Vec<_> = usage_totals.iter().map(session_total).collect();
            store.set_session_usage_totals(session_id, &totals)?;
        }
        _ => {}
    }
    Ok(())
}

fn usage_delta(run_id: RunId, account_id: &str, delta: &ModelUsage) -> UsageDelta {
    UsageDelta {
        run_id: run_id.into(),
        account_id: account_id.to_owned(),
        model: delta.model.clone(),
        input_tokens: delta.usage.input_tokens,
        output_tokens: delta.usage.output_tokens,
        cache_read_tokens: delta.usage.cache_read_tokens,
        cache_write_tokens: delta.usage.cache_write_tokens,
        cost_usd_micros: delta.usage.cost_usd_micros,
        at: Timestamp::now(),
    }
}

fn session_total(total: &ModelUsage) -> SessionModelUsage {
    SessionModelUsage {
        model: total.model.clone(),
        input_tokens: total.usage.input_tokens,
        output_tokens: total.usage.output_tokens,
        cache_read_tokens: total.usage.cache_read_tokens,
        cache_write_tokens: total.usage.cache_write_tokens,
        cost_usd_micros: total.usage.cost_usd_micros,
    }
}

#[cfg(test)]
mod tests {
    use parallax_store::Store;

    use super::record_event;
    use crate::backend::{Event, ModelUsage, Outcome, RunId, Usage};

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("parallax.sqlite3");
        let store = Store::open(&path).unwrap();
        (dir, store)
    }

    fn usage(input: u64, output: u64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            ..Usage::default()
        }
    }

    /// A usage delta of `input` and `output` tokens, on no model.
    fn delta(input: u64, output: u64) -> Event {
        Event::Usage(ModelUsage {
            model: None,
            usage: usage(input, output),
        })
    }

    /// A run that completed with session totals of `input` and `output` tokens, on no model.
    fn completed(input: u64, output: u64) -> Event {
        Event::Finished {
            outcome: Outcome::Completed { result: None },
            usage_totals: vec![ModelUsage {
                model: None,
                usage: usage(input, output),
            }],
        }
    }

    /// A resumed session's second run starts from a `Resume` baseline (0004/#113), so its own
    /// `Usage` deltas are already the *new* amount only; recording them must not add the
    /// baseline in a second time when the run's `Finished` replaces the session's totals.
    #[test]
    fn resuming_a_session_does_not_double_count_the_baseline() {
        let (_dir, mut store) = open();
        let run_id = RunId::generate();

        // First run: session starts fresh.
        record_event(
            &mut store,
            run_id,
            "claude-max",
            "sess-resume",
            &delta(1000, 100),
        )
        .unwrap();
        record_event(
            &mut store,
            run_id,
            "claude-max",
            "sess-resume",
            &completed(1000, 100),
        )
        .unwrap();

        // Second run resumes the session. The backend's `EventSink` (#113) already turns the
        // vendor's cumulative total into a delta of only what is new, so this event carries just
        // 200 more input tokens, and `Finished` reports the session's new grand total of 1200.
        let resumed_run = RunId::generate();
        record_event(
            &mut store,
            resumed_run,
            "claude-max",
            "sess-resume",
            &delta(200, 20),
        )
        .unwrap();
        record_event(
            &mut store,
            resumed_run,
            "claude-max",
            "sess-resume",
            &completed(1200, 120),
        )
        .unwrap();

        let far_past = "2020-01-01T00:00:00Z".parse().unwrap();
        let far_future = "2030-01-01T00:00:00Z".parse().unwrap();
        let summary = store
            .usage_summary("claude-max", far_past, far_future)
            .unwrap();
        assert_eq!(
            summary.input_tokens, 1200,
            "deltas from both runs, not the baseline counted twice"
        );

        let totals = store.session_usage_totals("sess-resume").unwrap();
        assert_eq!(totals.len(), 1);
        assert_eq!(
            totals[0].input_tokens, 1200,
            "the session's stored baseline is the vendor's real cumulative total"
        );
    }
}
