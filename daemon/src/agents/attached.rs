//! Threads attached to a message as context (PLX-372, decision 0041).
//!
//! `agent/start`, `thread/start`, and `agent/send` take `threads`, which [`check`] checks when
//! the request arrives. Once the message reaches a CLI, [`prompt`] puts a summary of each thread
//! ahead of the user's text: its id and what was said in it, rendered as 0014's handoff renders a
//! conversation, without tool calls, and cut from the front to [`SUMMARY_BYTES`]. The transcript
//! keeps the user's own text, and the message's `turnStarted` lists the threads.

use std::fmt::Write as _;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, RunId};

use super::actor::{conversation, logged_events};
use super::{store, store_error};
use crate::server::Daemon;

/// The most threads one message takes.
pub(crate) const MAX_THREADS: usize = 8;

/// About the most of one thread's conversation its summary holds, in bytes: its latest messages.
pub(crate) const SUMMARY_BYTES: usize = 32 * 1024;

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
        let events = logged_events(daemon, id).await?;
        let summary = conversation(&events, SUMMARY_BYTES);
        let _ = write!(prompt, "<thread id=\"{id}\">\n{summary}\n</thread>\n\n");
    }
    let _ = write!(prompt, "The user's message:\n{text}");
    Ok(prompt)
}
