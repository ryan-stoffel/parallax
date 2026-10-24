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
    let room = NOTE_BYTES.saturating_sub(head.len() + tail.len() + 2);
    format!("{head}\n{}\n{tail}", fill(&sections, room))
}

/// `state` as a packet for coordinator `run`, at most [`PACKET_BYTES`], in the spec's order. The
/// user's last messages take their room first, so the other sections never crowd them out.
pub(super) fn render(state: &State, run: RunId) -> String {
    let sections = [
        ("Brief", state.brief.as_str()),
        ("Memory", state.memory.as_str()),
        ("Board (notes.md)", state.board.as_str()),
        ("Checkpoint (checkpoint.md)", state.checkpoint.as_str()),
        ("Open threads", state.threads.as_str()),
        ("Open questions", state.questions.as_str()),
        ("Landing queue", state.landing.as_str()),
    ];
    let head = "Parallax, not the user: this is a new session of this chat. Your earlier \
                conversation isn't in it, so here is the Project's state as Parallax keeps it. \
                Treat it as orientation, and read more with read_context, memory_read, and \
                thread_list.";
    let tail = format!(
        "Older conversation: thread_search and thread_read on this thread, run {run}, have it \
         word for word."
    );
    let room = PACKET_BYTES.saturating_sub(head.len() + tail.len() + 2);
    let messages = quoted(&state.messages, room);
    let rest = fill(&sections, room - messages.len());
    format!("{head}\n{rest}{messages}\n{tail}")
}

/// `text` under `title`, or nothing when it has no text.
fn section(title: &str, text: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    format!("\n## {title}\n{text}\n")
}

/// The section of `messages`, oldest first, each whole and quoted, in at most `room` bytes: the
/// newest that fit, never part of one.
fn quoted(messages: &[String], room: usize) -> String {
    const TITLE: &str = "The user's last messages, oldest first";
    let quote = |message: &String| {
        let lines: Vec<String> = message.lines().map(|line| format!("> {line}")).collect();
        lines.join("\n")
    };
    let mut kept = String::new();
    for message in messages.iter().rev() {
        let joined = if kept.is_empty() {
            quote(message)
        } else {
            format!("{}\n\n{kept}", quote(message))
        };
        if section(TITLE, &joined).len() > room {
            break;
        }
        kept = joined;
    }
    section(TITLE, &kept)
}

/// Each of `sections` that has text, under its title, in at most `room` bytes: the one that would
/// pass it is cut, and the ones after it are left out.
fn fill(sections: &[(&str, &str)], room: usize) -> String {
    const CUT: &str = "\n... (cut to fit; read the rest with read_context or thread_read)\n";
    let mut out = String::new();
    for (title, text) in sections {
        let section = section(title, text);
        if out.len() + section.len() <= room {
            out.push_str(&section);
            continue;
        }
        if let Some(left) = room.checked_sub(out.len() + CUT.len()) {
            let mut end = left;
            while !section.is_char_boundary(end) {
                end -= 1;
            }
            out.push_str(&section[..end]);
            out.push_str(CUT);
        }
        break;
    }
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
    let turns = db.user_turns(run.into(), MESSAGES).map_err(error)?;
    state.messages = last_messages(first.into_iter().chain(turns));
    Ok((state, threads))
}

/// The last [`MESSAGES`] of `sent`, the user's messages to a coordinator oldest first, that
/// aren't blank.
fn last_messages(sent: impl Iterator<Item = String>) -> Vec<String> {
    let mut messages: Vec<String> = sent.filter(|text| !text.trim().is_empty()).collect();
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

    /// Decision 9: the user's last 10 messages, not a blank one.
    #[test]
    fn a_packet_takes_the_users_last_ten_messages() {
        let sent = (1..=14).map(|n| {
            if n % 5 == 0 {
                " \n".to_owned()
            } else {
                format!("Message {n}\nsecond line")
            }
        });
        let messages = last_messages(sent);
        assert_eq!(messages.len(), 10);
        assert_eq!(messages[0], "Message 3\nsecond line");
        assert_eq!(messages[9], "Message 14\nsecond line");
    }

    /// Decision 9: at most 24 KiB. The user's last 10 messages keep their room, whole, however
    /// large the board and checkpoint, which are cut instead, with the order and pointer kept.
    #[test]
    fn a_full_packet_keeps_all_ten_messages_whole_and_cuts_the_other_sections() {
        let run = RunId::generate();
        let messages: Vec<String> = (1..=10)
            .map(|n| format!("Message {n}: {}\nits last line", "word ".repeat(80)))
            .collect();
        let big = State {
            board: "- [ ] item\n".repeat(3000),
            checkpoint: "é".repeat(PACKET_BYTES),
            messages: messages.clone(),
            ..state()
        };
        let packet = render(&big, run);
        assert!(packet.len() <= PACKET_BYTES, "{}", packet.len());
        for message in &messages {
            let quoted = message
                .lines()
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>();
            assert!(packet.contains(&quoted.join("\n")), "{message} is whole");
        }
        assert!(packet.contains("(cut to fit"));
        assert!(
            !packet.contains("## Checkpoint"),
            "what follows the cut is left out"
        );
        let board = packet.find("## Board").unwrap();
        let said = packet.find("## The user's last messages").unwrap();
        assert!(board < said, "the spec's order");
        assert!(packet.contains("thread_search and thread_read"));
    }

    /// Messages that alone pass the cap lose the oldest, whole, never part of one.
    #[test]
    fn messages_over_the_cap_drop_the_oldest_whole() {
        let messages: Vec<String> = (1..=10)
            .map(|n| format!("Message {n} {}", "x".repeat(3 * 1024)))
            .collect();
        let packet = render(
            &State {
                messages: messages.clone(),
                ..state()
            },
            RunId::generate(),
        );
        assert!(packet.len() <= PACKET_BYTES, "{}", packet.len());
        let kept: Vec<&String> = messages
            .iter()
            .filter(|m| packet.contains(m.as_str()))
            .collect();
        assert!(kept.len() < 10 && !kept.is_empty(), "{}", kept.len());
        assert_eq!(
            kept.last().unwrap().as_str(),
            messages[9],
            "the newest stay"
        );
        for n in 1..=10 {
            let start = format!("Message {n} ");
            assert_eq!(
                packet.contains(&start),
                kept.iter().any(|m| m.starts_with(&start)),
                "message {n} is whole or left out"
            );
        }
    }
}
