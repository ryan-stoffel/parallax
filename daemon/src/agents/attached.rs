//! Threads attached to a message as context (PLX-372, decision 0047).
//!
//! `agent/start`, `thread/start`, and `agent/send` take `threads`, which [`check`] checks when
//! the request arrives. Once the message reaches a CLI, [`prompt`] puts a summary of each thread
//! ahead of the user's text: its id, its title, and what was said in it, rendered as 0014's handoff renders a
//! conversation, without tool calls, and cut from the front to [`SUMMARY_BYTES`]. The transcript
//! keeps the user's own text, and the message's `turnStarted` lists the threads.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, ParallaxEvent, RunId};
use parallax_store::{Store, StoreError};

use crate::event_log::EventLog;

use super::actor::{LEFT_OUT, conversation};
use super::{store, store_error};
use crate::server::Daemon;

/// The most threads one message takes.
pub(crate) const MAX_THREADS: usize = 8;

/// About the most of one thread's conversation its summary holds, in bytes: its latest messages.
pub(crate) const SUMMARY_BYTES: usize = 32 * 1024;

/// How many of a thread's events [`summary`] reads at a time, newest first.
const PAGE_EVENTS: usize = 100;

/// `threads` without repeats, in order, after checking there are at most [`MAX_THREADS`] and
/// each is a thread on this host (`threadNotFound` otherwise).
pub(crate) async fn check(daemon: &Daemon, threads: Vec<RunId>) -> Result<Vec<RunId>, ErrorObject> {
    let mut unique = Vec::with_capacity(threads.len());
    for id in threads {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.len() > MAX_THREADS {
        return Err(ErrorObject::invalid_params(format!(
            "threads must list at most {MAX_THREADS} threads"
        )));
    }
    if unique.is_empty() {
        return Ok(unique);
    }
    store(daemon, move |db| {
        for &id in &unique {
            if db
                .get_thread(id.into())
                .map_err(|e| store_error(&e))?
                .is_none()
            {
                return Err(ErrorObject::parallax(
                    ErrorKind::ThreadNotFound,
                    format!("no thread has run id {id}"),
                ));
            }
        }
        Ok(unique)
    })
    .await
}

/// `text` as its CLI gets it: a summary of each of `threads` first, from what their logs hold
/// now. `text` alone when there are none.
pub(super) async fn prompt(
    daemon: &Daemon,
    threads: &[RunId],
    text: &str,
) -> Result<String, ErrorObject> {
    if threads.is_empty() {
        return Ok(text.to_owned());
    }
    let mut prompt = String::from(
        "The user attached these Parallax threads for context. Each holds what was said in \
         it, oldest first, without tool calls:\n\n",
    );
    for &id in threads {
        let _ = writeln!(prompt, "<thread id=\"{id}\">");
        if let Some(title) = title(daemon, id).await? {
            let _ = writeln!(prompt, "Title: {title}");
        }
        let summary = summary(daemon, id).await?;
        let _ = write!(prompt, "{summary}\n</thread>\n\n");
    }
    let _ = write!(prompt, "The user's message:\n{text}");
    Ok(prompt)
}

/// Thread `id`'s title, when it has one (0041). A thread deleted since [`check`] has none.
async fn title(daemon: &Daemon, id: RunId) -> Result<Option<String>, ErrorObject> {
    store(daemon, move |db| {
        let thread = db.get_thread(id.into()).map_err(|e| store_error(&e))?;
        Ok(thread.and_then(|thread| thread.fields.title))
    })
    .await
}

/// Thread `id`'s conversation, cut to [`SUMMARY_BYTES`]. Its events are read newest first, a page
/// at a time, and only until the messages read fill the cap, so a long thread's older events,
/// tool output included, are never loaded.
async fn summary(daemon: &Daemon, id: RunId) -> Result<String, ErrorObject> {
    let log = Arc::clone(&daemon.log);
    tokio::task::spawn_blocking(move || {
        if let Some(summary) = log.with_stored_read(|db| summary_from(db, id))? {
            return Ok(summary);
        }
        summary_from_log(&log, id)
    })
    .await
    .map_err(ErrorObject::internal_error)?
    .map_err(|error| store_error(&error))
}

/// Pages `id`'s events newest first inside the caller's read transaction (0052).
fn summary_from(db: &Store, id: RunId) -> Result<String, StoreError> {
    let mut events = VecDeque::new();
    let mut before = u64::MAX;
    loop {
        let (page, more) = db.run_events_before(id.into(), before, PAGE_EVENTS, usize::MAX)?;
        let page_before = before;
        if let Some(oldest) = page.iter().rfind(|event| event.seq < before) {
            before = oldest.seq;
        }
        // Older pages may inject a covering compacted row already read on a newer page.
        for stored in page.into_iter().filter(|event| event.seq < page_before) {
            events.push_front(
                serde_json::from_str(&stored.payload).unwrap_or(ParallaxEvent::Unknown),
            );
        }
        let summary = conversation(events.make_contiguous(), SUMMARY_BYTES);
        if !more || summary.starts_with(LEFT_OUT) {
            return Ok(summary);
        }
    }
}

fn summary_from_log(log: &EventLog, id: RunId) -> Result<String, StoreError> {
    let mut events = VecDeque::new();
    let mut before = u64::MAX;
    loop {
        let (page, more) = log.run_events_before(id, before, PAGE_EVENTS, usize::MAX)?;
        let page_before = before;
        if let Some(oldest) = page.iter().rfind(|entry| entry.seq < before) {
            before = oldest.seq;
        }
        for entry in page.into_iter().filter(|event| event.seq < page_before) {
            events.push_front(entry.event.clone());
        }
        let summary = conversation(events.make_contiguous(), SUMMARY_BYTES);
        if !more || summary.starts_with(LEFT_OUT) {
            return Ok(summary);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use jiff::Timestamp;
    use parallax_protocol::{AgentOutputItem, ParallaxEvent, RunId};

    use super::{LEFT_OUT, PAGE_EVENTS, SUMMARY_BYTES, summary};
    use crate::server::Daemon;

    /// Recovery rows injected on older pages must not repeat an already read turn.
    #[tokio::test]
    async fn a_compacted_turn_spanning_summary_pages_is_included_once() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let id = RunId::generate();
        let first = daemon
            .store
            .append(
                Timestamp::now(),
                None,
                ParallaxEvent::AgentOutput {
                    run_id: id,
                    items: vec![],
                    compacted: None,
                },
            )
            .await;
        for _ in 0..=PAGE_EVENTS {
            daemon
                .store
                .append(
                    Timestamp::now(),
                    None,
                    ParallaxEvent::AgentWakeupsPaused { run_id: id },
                )
                .await;
        }
        daemon
            .store
            .append(
                Timestamp::now(),
                None,
                ParallaxEvent::AgentOutput {
                    run_id: id,
                    items: vec![AgentOutputItem::Text {
                        message_id: None,
                        text: "Hello".to_owned(),
                    }],
                    compacted: Some(parallax_protocol::Compacted { from: first }),
                },
            )
            .await;
        assert_eq!(summary(&daemon, id).await.unwrap(), "Agent:\nHello");
    }

    /// A thread longer than the cap is read newest first, here two pages of its three, and keeps
    /// its latest messages. A short one is read whole.
    #[tokio::test]
    async fn a_summary_keeps_the_latest_messages_across_pages() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (long, short) = (RunId::generate(), RunId::generate());
        let said = |run_id, text: String| ParallaxEvent::AgentOutput {
            run_id,
            items: vec![AgentOutputItem::Text {
                message_id: None,
                text,
            }],
            compacted: None,
        };
        for i in 0..PAGE_EVENTS * 3 {
            let text = format!("{i:03}{}", "x".repeat(200));
            daemon
                .store
                .append(Timestamp::now(), None, said(long, text))
                .await;
        }
        daemon
            .store
            .append(Timestamp::now(), None, said(short, "Hi".to_owned()))
            .await;

        let kept = summary(&daemon, long).await.unwrap();
        assert!(kept.starts_with(LEFT_OUT), "{}", &kept[..80]);
        let newest = format!("{}{}", PAGE_EVENTS * 3 - 1, "x".repeat(200));
        assert!(kept.ends_with(&newest));
        // The cap counts messages, not the blank lines between them.
        assert!(kept.len() <= SUMMARY_BYTES + 1024, "{}", kept.len());
        assert_eq!(summary(&daemon, short).await.unwrap(), "Agent:\nHi");
    }
}
