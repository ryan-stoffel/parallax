//! Threads attached to a message as context (PLX-372, decision 0047).
//!
//! `agent/start`, `thread/start`, and `agent/send` take `threads`, which [`check`] checks when
//! the request arrives. Once the message reaches a CLI, [`prompt`] puts a summary of each thread
//! ahead of the user's text: its id, its title, and what was said in it, rendered as 0014's handoff
//! renders a conversation, without tool calls, and kept to [`SUMMARY_BYTES`] by [`super::handoff`].
//! A thread the target has seen before sends only what was logged after that cursor. The transcript
//! keeps the user's own text, and the message's `turnStarted` lists the threads. A thread that
//! merged its context back (`thread_merge_back`, 0063) goes with the next message the same way,
//! and recording what that message read consumes its transfer.
//!
//! `thread/start` and `agent/send` also take `computers` and `remoteThreads` (0101), which
//! [`check_mentions`] checks. [`prompt`] says which computers the user named and how to run work on
//! them, and lists each thread on another computer as a reference for the agent to read with
//! `thread_read`, so attaching a long one costs nothing until then.

use std::fmt::Write as _;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, RemoteThreadRef, RunId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::handoff::{self, Budget};
use super::{store, store_error};
use crate::server::Daemon;

/// The most threads one message takes.
pub(crate) const MAX_THREADS: usize = 8;

/// About the most of one thread's conversation its summary holds, in bytes.
pub(crate) const SUMMARY_BYTES: usize = 32 * 1024;

/// What a message has attached as context beside its text and images.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Attachments {
    /// Threads on this host.
    pub threads: Vec<RunId>,
    /// Computers the user named, by relay id (0101).
    pub computers: Vec<String>,
    /// Threads on the user's other computers (0101).
    pub remote_threads: Vec<RemoteThreadRef>,
}

impl From<Vec<RunId>> for Attachments {
    fn from(threads: Vec<RunId>) -> Self {
        Self {
            threads,
            ..Self::default()
        }
    }
}

/// The longest title a thread on another computer may bring into a prompt, in bytes.
const MAX_REMOTE_TITLE_BYTES: usize = 256;

/// Checks `computers` and `remote_threads` as a message brings them: at most [`MAX_THREADS`] of
/// each, naming relay ids, with titles of a sane length.
pub(crate) fn check_mentions(
    computers: &[String],
    remote_threads: &[RemoteThreadRef],
) -> Result<(), ErrorObject> {
    if computers.len() > MAX_THREADS || remote_threads.len() > MAX_THREADS {
        return Err(ErrorObject::invalid_params(format!(
            "a message names at most {MAX_THREADS} computers and {MAX_THREADS} threads on them"
        )));
    }
    let ids = computers
        .iter()
        .chain(remote_threads.iter().map(|thread| &thread.computer));
    for id in ids {
        if !crate::remote::is_host_id(id) {
            return Err(ErrorObject::invalid_params(format!(
                "{id:?} isn't a computer's relay id"
            )));
        }
    }
    if remote_threads
        .iter()
        .any(|thread| thread.title.len() > MAX_REMOTE_TITLE_BYTES)
    {
        return Err(ErrorObject::invalid_params(format!(
            "a thread's title is at most {MAX_REMOTE_TITLE_BYTES} bytes"
        )));
    }
    Ok(())
}

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

/// `text` as its CLI gets it: a summary of each of `attachments`' threads first, from what their
/// logs hold now, then of each thread that merged its context back into `target`
/// (`thread_merge_back`, 0063) and isn't among them, then the computers and the threads on them it
/// names (0101). `text` alone when there are none.
pub(super) async fn prompt(
    daemon: &Daemon,
    target: RunId,
    attachments: &Attachments,
    text: &str,
) -> Result<Prompt, ErrorObject> {
    let threads = attachments.threads.as_slice();
    let merged: Vec<RunId> = store(daemon, move |db| {
        db.pending_transfer_sources(target.into())
            .map_err(|e| store_error(&e))
    })
    .await?
    .into_iter()
    .filter_map(|id| RunId::try_from(id).ok())
    .filter(|id| !threads.contains(id))
    .collect();
    let mentions = mentioned(daemon, attachments).await;
    if threads.is_empty() && merged.is_empty() && mentions.is_empty() {
        return Ok(Prompt {
            text: text.to_owned(),
            seen: Vec::new(),
        });
    }
    let mut prompt = String::new();
    let mut seen = Vec::with_capacity(threads.len() + merged.len());
    for (header, threads) in [(ATTACHED, threads), (MERGED, merged.as_slice())] {
        if threads.is_empty() {
            continue;
        }
        prompt.push_str(header);
        for &id in threads {
            let _ = writeln!(prompt, "<thread id=\"{id}\">");
            if let Some(title) = title(daemon, id).await? {
                let _ = writeln!(prompt, "Title: {title}");
            }
            let (summary, cursor) = summary(daemon, target, id).await?;
            seen.push((id.into(), cursor));
            let _ = write!(prompt, "{summary}\n</thread>\n\n");
        }
    }
    prompt.push_str(&mentions);
    let _ = write!(prompt, "The user's message:\n{text}");
    Ok(Prompt { text: prompt, seen })
}

/// What a message says about the computers and the threads on them it names, each computer by id
/// and, when the relay can say soon, by name.
async fn mentioned(daemon: &Daemon, attachments: &Attachments) -> String {
    let Attachments {
        computers,
        remote_threads,
        ..
    } = attachments;
    let mut text = String::new();
    if !computers.is_empty() {
        text.push_str(COMPUTERS);
        for id in computers {
            let name = daemon.relay_peers.name_of(daemon, id).await;
            let _ = writeln!(
                text,
                "<computer id=\"{id}\" name={} />",
                super::wake::quoted(&name)
            );
        }
        text.push('\n');
    }
    if !remote_threads.is_empty() {
        text.push_str(REMOTE_THREADS);
        for thread in remote_threads {
            let RemoteThreadRef {
                computer,
                run_id,
                title,
            } = thread;
            let name = daemon.relay_peers.name_of(daemon, computer).await;
            let _ = writeln!(
                text,
                "<thread computer=\"{computer}\" computerName={} runId=\"{run_id}\" title={} />",
                super::wake::quoted(&name),
                super::wake::quoted(title),
            );
        }
        text.push('\n');
    }
    text
}

/// What comes before the computers a message names.
const COMPUTERS: &str = "The user named these of their computers. To run work on one, pass its id as computer to \
     thread_launch or as target.computer to delegate_task; linked_computers shows if it takes \
     work now. It has only what is pushed:\n\n";

/// What comes before the threads on other computers a message names.
const REMOTE_THREADS: &str = "The user attached these threads from their other computers. Read one when you need it \
     with thread_read, passing its runId and computer:\n\n";

/// What comes before the threads attached to a message.
const ATTACHED: &str = "The user attached these Parallax threads for context. Each holds what was said in \
     it, oldest first, without tool calls:\n\n";

/// What comes before the threads that merged their context back (0063).
const MERGED: &str = "These Parallax threads merged their context back into this one: what was said in \
     each since it forked or since you last read it, oldest first, without tool calls:\n\n";

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
    let events = super::actor::logged_events(daemon, source).await?;
    let cursor = events.last().map_or(seen.unwrap_or(0), |event| event.seq);
    let budget = match seen {
        Some(seq) => Budget::Since {
            seq,
            cap: SUMMARY_BYTES,
        },
        None => Budget::Summary { cap: SUMMARY_BYTES },
    };
    Ok((handoff::handoff(&events, budget), cursor))
}
