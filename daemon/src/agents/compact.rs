//! Rewrites a finished turn's `agent.output` batches as one row (0052).
//!
//! A sweep runs at start and hourly. Each job compacts one turn whose last batch is older than
//! the in-memory window, so a live subscriber never sees the rewrite. Each sweep looks only past
//! what earlier ones covered: seqs only grow and only compaction rewrites a row, so nothing
//! before that point can become compactable.

use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AgentOutputItem, Compacted, ParallaxEvent, RunId};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::store_error;
use crate::server::Daemon;
use crate::store::Tx;

/// How often a sweep looks for another finished turn that has left the window.
pub(crate) const SWEEP_PERIOD: Duration = Duration::from_hours(1);

/// Compacts every finished turn that has left the window, then one more each hour until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut done = 0;
    sweep(&daemon, &stop, &mut done).await;
    let mut interval = time::interval_at(time::Instant::now() + SWEEP_PERIOD, SWEEP_PERIOD);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = interval.tick() => sweep(&daemon, &stop, &mut done).await,
        }
    }
}

/// Compacts eligible turns after seq `done` one job at a time, so no job holds the writer for a
/// long turn's rewrite, and moves `done` past what it covered. Stops between jobs once `stop` is
/// cancelled.
pub(crate) async fn sweep(daemon: &Daemon, stop: &CancellationToken, done: &mut u64) {
    while !stop.is_cancelled() {
        let floor = daemon.log.floor();
        match compact_one(daemon, floor, *done).await {
            Ok(Some(last)) => *done = last,
            Ok(None) => {
                *done = floor.saturating_sub(1);
                break;
            }
            Err(error) => {
                warn!(error = %error.message, "could not compact a finished turn");
                break;
            }
        }
    }
}

/// Rewrites the oldest finished turn that ends after seq `after` and before `floor`. Returns the
/// turn's last seq, or `None` if there was none.
pub(crate) async fn compact_one(
    daemon: &Daemon,
    floor: u64,
    after: u64,
) -> Result<Option<u64>, ErrorObject> {
    daemon
        .store
        .run(&CancellationToken::new(), move |tx| {
            compact_one_job(tx, floor, after)
        })
        .await
}

fn compact_one_job(tx: &mut Tx, floor: u64, after: u64) -> Result<Option<u64>, ErrorObject> {
    let Some(turn) = tx
        .find_compactable_turn(floor, after)
        .map_err(|error| store_error(&error))?
    else {
        return Ok(None);
    };
    let outputs = tx
        .output_events_in(turn.run_id, turn.from, turn.last)
        .map_err(|error| store_error(&error))?;
    let mut items = Vec::new();
    for stored in &outputs {
        if let Ok(ParallaxEvent::AgentOutput { items: batch, .. }) =
            serde_json::from_str(&stored.payload)
        {
            items.extend(batch);
        }
    }
    let run_id = RunId::try_from(turn.run_id).map_err(|error| {
        ErrorObject::internal_error(format!("compacted turn has an invalid run id: {error}"))
    })?;
    let event = ParallaxEvent::AgentOutput {
        run_id,
        items: compact_items(items),
        compacted: Some(Compacted { from: turn.from }),
    };
    let payload = serde_json::to_string(&event).unwrap_or_default();
    tx.update_event_payload(turn.last, &payload)
        .map_err(|error| store_error(&error))?;
    let others: Vec<u64> = outputs
        .iter()
        .filter(|event| event.seq != turn.last)
        .map(|event| event.seq)
        .collect();
    tx.delete_events(&others)
        .map_err(|error| store_error(&error))?;
    info!(run = %run_id, from = turn.from, seq = turn.last, "compacted a finished turn");
    Ok(Some(turn.last))
}

/// Merges consecutive text deltas and drops deltas that a whole `text` repeats. Tool calls and
/// results stay.
pub(crate) fn compact_items(items: Vec<AgentOutputItem>) -> Vec<AgentOutputItem> {
    drop_repeated_deltas(merge_consecutive_deltas(items))
}

fn merge_consecutive_deltas(items: Vec<AgentOutputItem>) -> Vec<AgentOutputItem> {
    let mut out = Vec::new();
    for item in items {
        let item = map_subagent(item, compact_items);
        if let (
            Some(AgentOutputItem::TextDelta {
                message_id: prev_id,
                text: prev,
            }),
            AgentOutputItem::TextDelta { message_id, text },
        ) = (out.last_mut(), &item)
            && prev_id == message_id
        {
            prev.push_str(text);
            continue;
        }
        out.push(item);
    }
    out
}

fn drop_repeated_deltas(items: Vec<AgentOutputItem>) -> Vec<AgentOutputItem> {
    let mut out = Vec::new();
    for item in items {
        if let AgentOutputItem::Text { message_id, text } = &item {
            // Keep identified deltas to preserve the message position across intervening tools.
            // Without a message id, the renderer only replaces the immediately preceding
            // partial message. Earlier deltas separated by tools are distinct messages.
            if message_id.is_none()
                && matches!(out.last(), Some(AgentOutputItem::TextDelta {
                    message_id: None, text: delta,
                }) if text.starts_with(delta.as_str()))
            {
                out.pop();
            }
        }
        out.push(item);
    }
    out
}

fn map_subagent(
    item: AgentOutputItem,
    map: fn(Vec<AgentOutputItem>) -> Vec<AgentOutputItem>,
) -> AgentOutputItem {
    match item {
        AgentOutputItem::Subagent {
            call_id,
            agent_type,
            model,
            item,
        } => {
            let compacted = map(vec![*item]);
            AgentOutputItem::Subagent {
                call_id,
                agent_type,
                model,
                item: Box::new(
                    compacted
                        .into_iter()
                        .next()
                        .unwrap_or(AgentOutputItem::Unknown),
                ),
            }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{compact_items, compact_one, sweep};
    use crate::event_log::run_of;
    use crate::server::Daemon;
    use crate::store::StoreHandle;
    use jiff::Timestamp;
    use parallax_protocol::{AgentOutputItem, Compacted, ParallaxEvent, ProjectId, RunId, TurnId};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn delta(text: &str) -> AgentOutputItem {
        AgentOutputItem::TextDelta {
            message_id: None,
            text: text.to_owned(),
        }
    }

    fn text(text: &str) -> AgentOutputItem {
        AgentOutputItem::Text {
            message_id: None,
            text: text.to_owned(),
        }
    }

    fn output(run_id: RunId, items: Vec<AgentOutputItem>) -> ParallaxEvent {
        ParallaxEvent::AgentOutput {
            run_id,
            items,
            compacted: None,
        }
    }

    fn turn_finished() -> AgentOutputItem {
        AgentOutputItem::TurnFinished {
            turn_id: Some(TurnId::generate()),
            result: Some("Hello".to_owned()),
        }
    }

    #[test]
    fn consecutive_text_deltas_merge_and_a_whole_text_drops_them() {
        let end = turn_finished();
        assert_eq!(
            compact_items(vec![delta("Hel"), delta("lo"), text("Hello"), end.clone()]),
            [text("Hello"), end]
        );
    }

    #[test]
    fn anonymous_messages_separated_by_tools_and_results_stay() {
        let call = AgentOutputItem::ToolCall {
            call_id: "c1".to_owned(),
            name: "Bash".to_owned(),
            input: serde_json::json!({"command": "ls"}),
        };
        let result = AgentOutputItem::ToolResult {
            call_id: "c1".to_owned(),
            status: parallax_protocol::AgentToolStatus::Ok,
            output: Some("ok".to_owned()),
        };
        let end = turn_finished();
        assert_eq!(
            compact_items(vec![
                delta("Hi"),
                call.clone(),
                result.clone(),
                text("Hi"),
                end.clone(),
            ]),
            [delta("Hi"), call, result, text("Hi"), end]
        );
    }

    #[test]
    fn identified_text_keeps_its_position_before_intervening_tools() {
        let delta = AgentOutputItem::TextDelta {
            message_id: Some("m1".to_owned()),
            text: "Hi".to_owned(),
        };
        let whole = AgentOutputItem::Text {
            message_id: Some("m1".to_owned()),
            text: "Hi".to_owned(),
        };
        let call = AgentOutputItem::ToolCall {
            call_id: "c1".to_owned(),
            name: "Bash".to_owned(),
            input: serde_json::json!({}),
        };
        assert_eq!(
            compact_items(vec![delta.clone(), call.clone(), whole.clone()]),
            [delta, call, whole]
        );
    }

    /// Compacts the oldest eligible turn, looking at every row.
    async fn compact(daemon: &Daemon) -> Option<u64> {
        compact_one(daemon, daemon.log.floor(), 0).await.unwrap()
    }

    async fn put(store: &StoreHandle, project: ProjectId, event: ParallaxEvent) -> u64 {
        store.append(Timestamp::now(), Some(project), event).await
    }

    /// A stored daemon whose in-memory window holds only the newest `retention` events.
    fn daemon(retention: usize) -> (tempfile::TempDir, Arc<Daemon>, ProjectId, RunId) {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), retention, Duration::from_secs(90));
        (dir, daemon, ProjectId::generate(), RunId::generate())
    }

    async fn finished_turn(store: &StoreHandle, project: ProjectId, run: RunId) -> (u64, u64, u64) {
        let first = put(
            store,
            project,
            output(
                run,
                vec![
                    AgentOutputItem::TurnStarted {
                        turn_id: None,
                        text: None,
                        wake: false,
                        from: None,
                        images: Vec::new(),
                        threads: Vec::new(),
                    },
                    delta("Hel"),
                ],
            ),
        )
        .await;
        let mid = put(
            store,
            project,
            output(
                run,
                vec![
                    delta("lo"),
                    AgentOutputItem::ToolCall {
                        call_id: "c1".to_owned(),
                        name: "Bash".to_owned(),
                        input: serde_json::json!({"command": "ls"}),
                    },
                ],
            ),
        )
        .await;
        let last = put(
            store,
            project,
            output(run, vec![text("Hello"), turn_finished()]),
        )
        .await;
        (first, mid, last)
    }

    #[tokio::test]
    async fn after_a_turn_leaves_the_window_one_output_row_remains() {
        let (_dir, daemon, project, run) = daemon(2);
        let (from, mid, last) = finished_turn(&daemon.store, project, run).await;
        // Evict the turn: two later events leave only those in a retention-2 window.
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        assert_eq!(daemon.log.floor(), last + 1);
        assert!(compact(&daemon).await.is_some());

        let (entries, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        let outputs: Vec<_> = entries
            .iter()
            .filter(|entry| matches!(entry.event, ParallaxEvent::AgentOutput { .. }))
            .collect();
        assert_eq!(outputs.len(), 1);
        let ParallaxEvent::AgentOutput {
            items,
            compacted,
            run_id,
        } = &outputs[0].event
        else {
            panic!("expected agent.output");
        };
        assert_eq!(*run_id, run);
        assert_eq!(outputs[0].seq, last);
        assert_eq!(compacted, &Some(Compacted { from }));
        assert!(
            items
                .iter()
                .any(|item| matches!(item, AgentOutputItem::TurnStarted { .. }))
        );
        assert!(items.iter().any(|item| matches!(
            item,
            AgentOutputItem::ToolCall { call_id, .. } if call_id == "c1"
        )));
        assert!(
            items
                .iter()
                .any(|item| matches!(item, AgentOutputItem::Text { text, .. } if text == "Hello"))
        );
        assert!(
            items
                .iter()
                .any(|item| matches!(item, AgentOutputItem::TurnFinished { .. }))
        );
        assert!(items.iter().any(
            |item| matches!(item, AgentOutputItem::TextDelta { text, .. } if text == "Hello")
        ));
        assert!(
            daemon
                .log
                .run_events(run, 0, 100, usize::MAX)
                .unwrap()
                .0
                .iter()
                .all(|entry| entry.seq != mid)
        );
    }

    #[tokio::test]
    async fn a_before_page_inside_a_compacted_turn_includes_the_compacted_row() {
        let (_dir, daemon, project, run) = daemon(2);
        let (from, _mid, last) = finished_turn(&daemon.store, project, run).await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        assert!(compact(&daemon).await.is_some());

        let before = from + 1;
        let (page, _) = daemon
            .log
            .run_events_before(run, before, 100, usize::MAX)
            .unwrap();
        let compacted = page.iter().find(|entry| entry.seq == last).unwrap();
        assert!(
            compacted.seq >= before,
            "the compacted row's seq is at or above before"
        );
        assert_eq!(
            compacted_from(&compacted.event),
            Some(from),
            "from < before ≤ seq"
        );
        assert!(from < before && before <= compacted.seq);
    }

    fn compacted_from(event: &ParallaxEvent) -> Option<u64> {
        match event {
            ParallaxEvent::AgentOutput {
                compacted: Some(compacted),
                ..
            } => Some(compacted.from),
            _ => None,
        }
    }

    #[tokio::test]
    async fn a_turn_still_in_the_window_is_not_rewritten_and_subscribers_see_no_change() {
        let (_dir, daemon, project, run) = daemon(100);
        let (from, mid, last) = finished_turn(&daemon.store, project, run).await;
        let head = daemon.log.head();
        assert!(
            last >= daemon.log.floor(),
            "the turn is still in the window"
        );
        assert!(compact(&daemon).await.is_none());
        assert_eq!(daemon.log.head(), head);

        let (entries, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        let seqs: Vec<u64> = entries
            .iter()
            .filter(|entry| run_of(&entry.event) == Some(run))
            .map(|entry| entry.seq)
            .collect();
        assert_eq!(seqs, [from, mid, last]);
        assert!(
            entries
                .iter()
                .all(|entry| compacted_from(&entry.event).is_none())
        );

        let (event, seq) = daemon.log.next(last, Some(project), |_| true).unwrap();
        assert!(event.is_none());
        assert_eq!(seq, head);
    }

    #[tokio::test]
    async fn sweep_skips_a_turn_in_the_window_and_rewrites_one_that_has_left() {
        let (_dir, daemon, project, run) = daemon(2);
        let (stop, mut done) = (CancellationToken::new(), 0);
        finished_turn(&daemon.store, project, run).await;
        sweep(&daemon, &stop, &mut done).await;
        let (before, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        assert_eq!(before.len(), 3, "still in the window");

        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        sweep(&daemon, &stop, &mut done).await;
        let (after, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        let outputs: Vec<_> = after
            .iter()
            .filter(|entry| matches!(entry.event, ParallaxEvent::AgentOutput { .. }))
            .collect();
        assert_eq!(outputs.len(), 1);
        assert!(compacted_from(&outputs[0].event).is_some());
    }

    #[tokio::test]
    async fn other_events_inside_the_turn_keep_their_rows() {
        let (_dir, daemon, project, run) = daemon(2);
        let first = put(&daemon.store, project, output(run, vec![delta("Hel")])).await;
        let updated = put(
            &daemon.store,
            project,
            ParallaxEvent::AgentWakeupsPaused { run_id: run },
        )
        .await;
        let last = put(
            &daemon.store,
            project,
            output(run, vec![text("Hello"), turn_finished()]),
        )
        .await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        put(&daemon.store, project, ParallaxEvent::Unknown).await;
        assert!(compact(&daemon).await.is_some());

        let (entries, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        let seqs: Vec<u64> = entries.iter().map(|entry| entry.seq).collect();
        assert_eq!(seqs, [updated, last]);
        assert!(
            !entries.iter().any(|entry| entry.seq == first),
            "the earlier output batch is gone"
        );
        assert!(matches!(
            entries
                .iter()
                .find(|entry| entry.seq == updated)
                .unwrap()
                .event,
            ParallaxEvent::AgentWakeupsPaused { .. }
        ));
    }
}
