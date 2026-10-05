//! Threads attached to a message as context (PLX-372, decision 0047).
//!
//! `agent/start`, `thread/start`, and `agent/send` take `threads`, which [`check`] checks when
//! the request arrives. Once the message reaches a CLI, [`prompt`] puts a summary of each thread
//! ahead of the user's text: its id, its title, and what was said in it, rendered as 0014's handoff
//! renders a conversation, without tool calls, and kept to [`SUMMARY_BYTES`] by [`super::handoff`].
//! A thread the target has seen before sends only what was logged after that cursor. The transcript
//! keeps the user's own text, and the message's `turnStarted` lists the threads.

use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, RunId};
use uuid::Uuid;

use super::handoff::{self, Budget, HandoffEvent};
use super::{store, store_error};
use crate::event_log::EventLog;
use crate::server::Daemon;

/// The most threads one message takes.
pub(crate) const MAX_THREADS: usize = 8;

/// About the most of one thread's conversation its summary holds, in bytes.
pub(crate) const SUMMARY_BYTES: usize = 32 * 1024;

/// `text` as its CLI gets it, and the source `seq` each attached thread's summary read.
pub(super) struct Prompt {
    pub text: String,
    pub seen: Vec<(Uuid, u64)>,
}

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
    target: RunId,
    threads: &[RunId],
    text: &str,
) -> Result<Prompt, ErrorObject> {
    if threads.is_empty() {
        return Ok(Prompt {
            text: text.to_owned(),
            seen: Vec::new(),
        });
    }
    let mut prompt = String::from(
        "The user attached these Parallax threads for context. Each holds what was said in \
         it, oldest first, without tool calls:\n\n",
    );
    let mut seen = Vec::with_capacity(threads.len());
    for &id in threads {
        let _ = writeln!(prompt, "<thread id=\"{id}\">");
        if let Some(title) = title(daemon, id).await? {
            let _ = writeln!(prompt, "Title: {title}");
        }
        let (summary, cursor) = summary(daemon, target, id).await?;
        seen.push((id.into(), cursor));
        let _ = write!(prompt, "{summary}\n</thread>\n\n");
    }
    let _ = write!(prompt, "The user's message:\n{text}");
    Ok(Prompt { text: prompt, seen })
}

/// Thread `id`'s title, when it has one (0041). A thread deleted since [`check`] has none.
async fn title(daemon: &Daemon, id: RunId) -> Result<Option<String>, ErrorObject> {
    store(daemon, move |db| {
        let thread = db.get_thread(id.into()).map_err(|e| store_error(&e))?;
        Ok(thread.and_then(|thread| thread.fields.title))
    })
    .await
}

/// Thread `source`'s conversation for `target`: a full summary the first time, then only what
/// was logged after the last cursor.
async fn summary(
    daemon: &Daemon,
    target: RunId,
    source: RunId,
) -> Result<(String, u64), ErrorObject> {
    let seen = store(daemon, move |db| {
        db.attached_seen(target.into(), source.into())
            .map_err(|e| store_error(&e))
    })
    .await?;
    let log = Arc::clone(&daemon.log);
    tokio::task::spawn_blocking(move || match seen {
        Some(seq) => load_since(&log, source, seq),
        None => load_summary(&log, source),
    })
    .await
    .map_err(ErrorObject::internal_error)?
    .map_err(|error| store_error(&error))
}

fn load_summary(
    log: &EventLog,
    source: RunId,
) -> Result<(String, u64), parallax_store::StoreError> {
    let events = load_after(log, source, 0)?;
    let cursor = events.last().map_or(0, |event| event.seq);
    Ok((
        handoff::handoff(&events, Budget::Summary { cap: SUMMARY_BYTES }),
        cursor,
    ))
}

fn load_since(
    log: &EventLog,
    source: RunId,
    seq: u64,
) -> Result<(String, u64), parallax_store::StoreError> {
    let mut events = load_after(log, source, seq)?;
    let start = events
        .iter()
        .filter_map(|event| {
            let from = event.compacted_from?;
            (from <= seq && seq < event.seq).then_some(from)
        })
        .min()
        .map_or(seq, |from| from.saturating_sub(1));
    if start < seq {
        events = load_after(log, source, start)?;
    }
    let cursor = events.last().map_or(seq, |event| event.seq);
    Ok((
        handoff::handoff(
            &events,
            Budget::Since {
                seq,
                cap: SUMMARY_BYTES,
            },
        ),
        cursor,
    ))
}

fn load_after(
    log: &EventLog,
    source: RunId,
    after: u64,
) -> Result<Vec<HandoffEvent>, parallax_store::StoreError> {
    let mut events = Vec::new();
    let mut after = after;
    loop {
        let (page, more) = log.run_events(source, after, 1000, 4 * 1024 * 1024)?;
        after = page.last().map_or(after, |entry| entry.seq);
        events.extend(page.iter().map(|entry| HandoffEvent::from_entry(entry)));
        if !more || page.is_empty() {
            return Ok(events);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use jiff::Timestamp;
    use parallax_protocol::{AgentOutputItem, ParallaxEvent, RunId};

    use super::{SUMMARY_BYTES, summary};
    use crate::agents::handoff::LEFT_OUT;
    use crate::server::Daemon;

    /// A thread longer than the cap keeps its first task and its latest messages.
    #[tokio::test]
    async fn a_summary_keeps_the_task_and_the_latest_messages() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (long, short) = (RunId::generate(), RunId::generate());
        let target = RunId::generate();
        let said = |run_id, text: String| ParallaxEvent::AgentOutput {
            run_id,
            items: vec![AgentOutputItem::Text {
                message_id: None,
                text,
            }],
        };
        for i in 0..300 {
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

        let (kept, cursor) = summary(&daemon, target, long).await.unwrap();
        assert!(
            kept.starts_with("Agent:\n000"),
            "{}",
            &kept[..80.min(kept.len())]
        );
        assert!(kept.contains(LEFT_OUT), "{}", &kept[..80.min(kept.len())]);
        let newest = format!("{}{}", 299, "x".repeat(200));
        assert!(kept.ends_with(&newest));
        assert!(kept.len() <= SUMMARY_BYTES, "{}", kept.len());
        assert!(cursor > 0);
        assert_eq!(
            summary(&daemon, target, short).await.unwrap().0,
            "Agent:\nHi"
        );
    }
}
