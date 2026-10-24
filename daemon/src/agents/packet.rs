//! A coordinator's rehydration packet (PLX-937, decision 0079): the first message of each new
//! session of its run, built from the Project's state as plxd keeps it, so a lost or fresh
//! session costs nothing the Project needs. Also the short note the turn after a provider
//! compaction carries.

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ProjectId, QuestionId, RunId};
use parallax_store::Store;

use super::convert::{ACCEPTED, NO_WRITE};
use super::wake::{one_line, question, task};
use super::{store, store_error};
use crate::context::memory;
use crate::methods::question::{OPEN, autonomy_of};
use crate::server::Daemon;

/// The most a packet takes, before the message that starts the session (decision 9).
pub(super) const PACKET_BYTES: usize = 24 * 1024;

/// The most the note after a compaction takes.
const NOTE_BYTES: usize = 8 * 1024;

/// How many of the user's last messages a packet quotes (decision 9).
const MESSAGES: usize = 10;

/// How much of a thread's last result its line shows.
const REPORT_BYTES: usize = 300;

/// How wake-ups and other plxd turns start, which aren't the user's messages.
const PARALLAX: &str = "Parallax, not the user";

/// The Project's state for a packet or a note, one field per section.
#[derive(Debug, Default)]
pub(super) struct State {
    pub brief: String,
    pub memory: String,
    pub board: String,
    pub checkpoint: String,
    pub threads: String,
    pub questions: String,
    pub landing: String,
    /// The user's last messages to the coordinator, oldest first.
    pub messages: Vec<String>,
}

/// The first message of coordinator `run`'s new session in `project`: the packet, then `text`,
/// the message that starts it.
pub(super) async fn packet(daemon: &Daemon, project: ProjectId, run: RunId, text: &str) -> String {
    let state = gather(daemon, project, run).await;
    format!(
        "{}\n\nThe message that starts this session:\n{text}",
        render(&state, run)
    )
}

/// The note ahead of the first turn after a provider compaction: the board, the open threads,
/// and where the checkpoint is.
pub(super) async fn after_compaction(daemon: &Daemon, project: ProjectId, run: RunId) -> String {
    let state = gather(daemon, project, run).await;
    let sections = [
        ("Board (notes.md)", state.board.as_str()),
        ("Open threads", state.threads.as_str()),
    ];
    let head = "Parallax, not the user: your conversation was just compacted, so here is the \
                Project's state again.";
    let tail = "Your progress note is checkpoint.md in your shared context: read it with \
                read_context.";
    fill(head, &sections, tail, NOTE_BYTES)
}

/// `state` as a packet for coordinator `run`, at most [`PACKET_BYTES`], in the spec's order.
pub(super) fn render(state: &State, run: RunId) -> String {
    let messages = state
        .messages
        .iter()
        .map(|message| {
            let quoted: Vec<String> = message.lines().map(|line| format!("> {line}")).collect();
            quoted.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let sections = [
        ("Brief", state.brief.as_str()),
        ("Memory", state.memory.as_str()),
        ("Board (notes.md)", state.board.as_str()),
        ("Checkpoint (checkpoint.md)", state.checkpoint.as_str()),
        ("Open threads", state.threads.as_str()),
        ("Open questions", state.questions.as_str()),
        ("Landing queue", state.landing.as_str()),
        ("The user's last messages, oldest first", messages.as_str()),
    ];
    let head = "Parallax, not the user: this is a new session of this chat. Your earlier \
                conversation isn't in it, so here is the Project's state as Parallax keeps it. \
                Treat it as orientation, and read more with read_context, memory_read, and \
                thread_list.";
    let tail = format!(
        "Older conversation: thread_search and thread_read on this thread, run {run}, have it \
         word for word."
    );
    fill(head, &sections, &tail, PACKET_BYTES)
}

/// `head`, each section that has text under its title, and `tail`, in at most `cap` bytes: the
/// section that would pass it is cut, and the ones after it are left out.
// ponytail: cuts in order, so a long early section crowds out the user's messages; give each
// section its own share if that bites.
fn fill(head: &str, sections: &[(&str, &str)], tail: &str, cap: usize) -> String {
    const CUT: &str = "\n... (cut to fit; read the rest with read_context or thread_read)";
    let mut out = format!("{head}\n");
    let room = cap.saturating_sub(tail.len() + 2);
    for (title, text) in sections {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let section = format!("\n## {title}\n{text}\n");
        if out.len() + section.len() <= room {
            out.push_str(&section);
            continue;
        }
        let mut end = room.saturating_sub(out.len() + CUT.len() + 1);
        while !section.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&section[..end]);
        out.push_str(CUT);
        out.push('\n');
        break;
    }
    out.push('\n');
    out.push_str(tail);
    out
}

/// Reads the Project's state for coordinator `run`. A part that can't be read is left empty.
async fn gather(daemon: &Daemon, project: ProjectId, run: RunId) -> State {
    let start = memory::start(daemon, project).await.unwrap_or_default();
    let dir = daemon.data_dir.context_dir(project);
    let stored = store(daemon, move |db| from_store(db, project, run)).await;
    let (mut state, threads) = stored.unwrap_or_else(|error| {
        tracing::warn!(%run, error = %error.message, "could not read a Project's state for its coordinator");
        (State::default(), Vec::new())
    });
    state.brief = start.brief.unwrap_or_default();
    state.memory = start.index;
    let read = tokio::task::spawn_blocking(move || {
        let read = |name: &str| {
            crate::context::read_file(&dir, name)
                .ok()
                .and_then(|(bytes, _)| String::from_utf8(bytes).ok())
                .unwrap_or_default()
        };
        let lines: Vec<String> = threads
            .into_iter()
            .map(|(id, line)| {
                let history = read(&format!("history/{id}.md"));
                match history
                    .lines()
                    .find_map(|l| l.strip_prefix("Last result: "))
                {
                    Some(result) => {
                        format!("{line} Last report: {}", one_line(result, REPORT_BYTES))
                    }
                    None => line,
                }
            })
            .collect();
        (read("checkpoint.md"), lines.join("\n"))
    })
    .await;
    if let Ok((checkpoint, threads)) = read {
        state.checkpoint = checkpoint;
        state.threads = threads;
    }
    state
}

/// The store's part of [`State`]: the board, the open questions, the landing queue, and the
/// user's last messages, with each open thread's run id and line, for [`gather`] to add its last
/// report to.
fn from_store(
    db: &Store,
    project: ProjectId,
    run: RunId,
) -> Result<(State, Vec<(uuid::Uuid, String)>), ErrorObject> {
    let error = |e| store_error(&e);
    let mut state = State::default();
    let items = crate::board::items(db, project)?;
    state.board = crate::board::render(&items, Timestamp::now()).0;

    let runs = db.list_runs(Some(project.into())).map_err(error)?;
    let (mut threads, mut landing) = (Vec::new(), Vec::new());
    for child in runs.iter().filter(|r| r.fields.policy != NO_WRITE) {
        let landed = db.landing(child.id).map_err(error)?;
        let thread = db.get_thread(child.id).map_err(error)?;
        let closed = child.state.status == ACCEPTED
            || landed.as_ref().is_some_and(|l| l.status == "landed")
            || thread.is_some_and(|t| t.archived || t.settled);
        if closed {
            continue;
        }
        let task = task(&child.fields.prompt);
        threads.push((
            child.id,
            format!("- Run {} ({task}): {}.", child.id, child.state.status),
        ));
        if let Some(l) = landed {
            landing.push(format!(
                "- Run {} ({task}): {}, {} conflicts, {} failed checks",
                child.id, l.status, l.conflicts, l.failures
            ));
        }
    }
    state.landing = landing.join("\n");

    let autonomy = autonomy_of(db, project.into())?;
    let mut questions = Vec::new();
    for asked in db.questions(project.into()).map_err(error)? {
        if asked.status != OPEN {
            continue;
        }
        let (Ok(child), Ok(id)) = (
            RunId::try_from(asked.run_id),
            QuestionId::try_from(asked.id),
        ) else {
            continue;
        };
        let prompt = runs
            .iter()
            .find(|r| r.id == asked.run_id)
            .map(|r| r.fields.prompt.as_str())
            .unwrap_or_default();
        questions.push(question(
            child,
            prompt,
            id,
            &asked.question,
            &asked.assumption,
            autonomy,
        ));
    }
    state.questions = questions.join("\n");

    let first = runs
        .iter()
        .find(|r| r.id == uuid::Uuid::from(run))
        .map(|r| r.fields.prompt.clone());
    let turns = db.run_turns(run.into()).map_err(error)?;
    state.messages = last_messages(first.into_iter().chain(turns.into_iter().map(|(_, t)| t)));
    Ok((state, threads))
}

/// The last [`MESSAGES`] of `sent`, a coordinator's messages oldest first, that the user wrote:
/// not a blank one, and not a wake-up or another of plxd's own.
fn last_messages(sent: impl Iterator<Item = String>) -> Vec<String> {
    let mut messages: Vec<String> = sent
        .filter(|text| !text.trim().is_empty() && !text.starts_with(PARALLAX))
        .collect();
    let skip = messages.len().saturating_sub(MESSAGES);
    messages.drain(..skip);
    messages
}

#[cfg(test)]
mod tests {
    use parallax_protocol::RunId;

    use super::{PACKET_BYTES, State, last_messages, render};

    fn state() -> State {
        State {
            brief: "Ship v2.".to_owned(),
            memory: "Memory:\n- you/preference/tabs.md: Tabs".to_owned(),
            board: "## Now\n- [ ] **Search**: one child".to_owned(),
            checkpoint: "Next: review search.".to_owned(),
            threads: "- Run a (search): running.".to_owned(),
            questions: "- Run a asked question q.".to_owned(),
            landing: "- Run a (search): queued, 0 conflicts, 0 failed checks".to_owned(),
            messages: vec!["Add search.".to_owned(), "Also tests.".to_owned()],
        }
    }

    /// The spec's order: brief, memory, board, checkpoint, threads, questions, landing queue,
    /// the user's messages, then the pointer to older history.
    #[test]
    fn a_packet_has_each_section_in_order_and_ends_with_the_pointer() {
        let run = RunId::generate();
        let packet = render(&state(), run);
        let order = [
            "## Brief\nShip v2.",
            "## Memory\n",
            "## Board (notes.md)\n## Now",
            "## Checkpoint (checkpoint.md)\nNext: review search.",
            "## Open threads\n",
            "## Open questions\n",
            "## Landing queue\n",
            "## The user's last messages, oldest first\n> Add search.\n\n> Also tests.",
            "thread_search and thread_read",
        ];
        let at: Vec<usize> = order
            .iter()
            .map(|part| {
                packet
                    .find(part)
                    .unwrap_or_else(|| panic!("{part} in {packet}"))
            })
            .collect();
        assert!(at.is_sorted(), "{packet}");
        assert!(packet.ends_with(&format!("run {run}, have it word for word.")));

        let empty = render(&State::default(), run);
        assert!(
            !empty.contains("## "),
            "empty sections are left out: {empty}"
        );
    }

    /// Decision 9: the user's last 10 messages, verbatim, without plxd's own turns.
    #[test]
    fn a_packet_quotes_the_users_last_ten_messages() {
        let sent = (1..=14).map(|n| {
            if n % 5 == 0 {
                format!("Parallax, not the user: wake-up {n}")
            } else {
                format!("Message {n}\nsecond line")
            }
        });
        let messages = last_messages(sent);
        assert_eq!(messages.len(), 10);
        assert_eq!(messages[0], "Message 3\nsecond line");
        assert_eq!(messages[9], "Message 14\nsecond line");
        assert!(messages.iter().all(|m| !m.starts_with("Parallax")));
    }

    /// Decision 9: at most 24 KiB, cut where it passes the cap, with the pointer kept.
    #[test]
    fn a_packet_over_the_cap_is_cut_and_keeps_the_pointer() {
        let run = RunId::generate();
        let big = State {
            checkpoint: "é".repeat(PACKET_BYTES),
            ..state()
        };
        let packet = render(&big, run);
        assert!(packet.len() <= PACKET_BYTES, "{}", packet.len());
        assert!(packet.contains("## Board (notes.md)"));
        assert!(packet.contains("(cut to fit"));
        assert!(
            !packet.contains("## Open threads"),
            "what follows the cut is left out"
        );
        assert!(packet.contains("thread_search and thread_read"));
    }
}
