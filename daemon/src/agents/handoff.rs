//! Handoff of a run's conversation to another session or an attached thread (0052, PLX-486).
//!
//! [`handoff`] keeps the run's first message (its task) and the newest turns that fit the budget.
//! Older turns shrink to their first and last lines, then the oldest shortened turns go. There is
//! no uncapped full transcript: a summary that fits is the whole conversation.

use parallax_protocol::{AgentOutputItem, ParallaxEvent};

use crate::event_log::Entry;

/// About the most of a conversation a move or a fork's new session is told, in bytes.
pub const HANDOFF_BYTES: usize = 64 * 1024;

/// What a [`handoff`] that dropped turns puts between the task and what it kept.
pub const LEFT_OUT: &str = "(Earlier messages are left out.)";

/// One logged event as [`handoff`] reads it.
#[derive(Clone, Debug)]
pub struct HandoffEvent {
    pub seq: u64,
    pub event: ParallaxEvent,
    /// A compacted turn's first `seq` (`compacted.from`), when the payload has one (PLX-491).
    pub compacted_from: Option<u64>,
}

impl HandoffEvent {
    pub fn from_entry(entry: &Entry) -> Self {
        Self {
            seq: entry.seq,
            event: entry.event().into_owned(),
            compacted_from: entry.compacted_from,
        }
    }
}

/// How much of the conversation to keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Budget {
    /// The whole conversation when it fits `cap`, otherwise the task and newest turns.
    Summary { cap: usize },
    /// Only events after `seq`, as [`Budget::Summary`] within `cap`. A `seq` inside a compacted
    /// turn starts at that turn's `from`.
    Since { seq: u64, cap: usize },
}

/// A run's conversation as `events` logged it: the user's messages, Parallax's wake-ups, and the
/// agent's replies, oldest first, without its tool calls. [`Budget::Summary`] keeps the whole
/// conversation when it fits. Otherwise the run's first message (its task) stays, newest turns stay
/// whole while they fit, older turns shrink to their first and last lines, and the oldest
/// shortened turns go. A task over half the cap is cut to half the cap, keeping its start.
#[must_use]
pub fn handoff(events: &[HandoffEvent], budget: Budget) -> String {
    let (selected, cap) = match budget {
        Budget::Summary { cap } => (events.iter().collect::<Vec<_>>(), cap),
        Budget::Since { seq, cap } => (since(events, seq), cap),
    };
    summarize(&extract(selected.iter().map(|event| &event.event)), cap)
}

/// Events after `seq`, or from a compacted turn's `from` when `seq` falls inside that turn.
fn since(events: &[HandoffEvent], seq: u64) -> Vec<&HandoffEvent> {
    let after = events
        .iter()
        .filter_map(|event| {
            let from = event.compacted_from?;
            (from <= seq && seq < event.seq).then_some(from)
        })
        .min()
        .map_or(seq, |from| from.saturating_sub(1));
    events.iter().filter(|event| event.seq > after).collect()
}

fn extract<'a>(events: impl IntoIterator<Item = &'a ParallaxEvent>) -> Vec<String> {
    let mut said = Vec::new();
    let mut last_reply = String::new();
    for event in events {
        match event {
            ParallaxEvent::AgentStarted { run: Some(run), .. } => {
                said.push(format!("User:\n{}", run.prompt.trim()));
            }
            ParallaxEvent::AgentOutput { items, .. } => {
                for item in items {
                    match item {
                        AgentOutputItem::TurnStarted {
                            text: Some(text),
                            wake,
                            from,
                            ..
                        } => {
                            let who = match from {
                                _ if *wake => "Parallax".to_owned(),
                                Some(from) => format!("Thread {from}"),
                                None => "User".to_owned(),
                            };
                            said.push(format!("{who}:\n{}", text.trim()));
                        }
                        AgentOutputItem::Text { text, .. } if !text.trim().is_empty() => {
                            text.trim().clone_into(&mut last_reply);
                            said.push(format!("Agent:\n{last_reply}"));
                        }
                        AgentOutputItem::TurnFinished {
                            result: Some(result),
                            ..
                        } if !result.trim().is_empty() && result.trim() != last_reply => {
                            result.trim().clone_into(&mut last_reply);
                            said.push(format!("Agent:\n{last_reply}"));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    said
}

fn summarize(messages: &[String], cap: usize) -> String {
    if messages.is_empty() {
        return String::new();
    }
    if joined_len(messages.iter().map(String::as_str)) <= cap {
        return messages.join("\n\n");
    }
    let task = if messages[0].len() > cap / 2 {
        cut_to(&messages[0], cap / 2)
    } else {
        messages[0].clone()
    };
    let rest = &messages[1..];
    let mut whole_from = rest.len();
    while whole_from > 0 {
        let candidate =
            std::iter::once(task.as_str()).chain(rest[whole_from - 1..].iter().map(String::as_str));
        if !fits(candidate, cap) {
            break;
        }
        whole_from -= 1;
    }
    let whole = &rest[whole_from..];
    let older = &rest[..whole_from];
    let mut shorts = Vec::new();
    for turn in older.iter().rev() {
        let short = shorten(turn);
        let candidate = std::iter::once(task.as_str())
            .chain(std::iter::once(short.as_str()))
            .chain(shorts.iter().rev().map(String::as_str))
            .chain(whole.iter().map(String::as_str));
        if !fits(candidate, cap) {
            break;
        }
        shorts.push(short);
    }
    shorts.reverse();
    let dropped = shorts.len() < older.len();
    let mut parts = vec![task.as_str()];
    if dropped {
        let with_gap = std::iter::once(task.as_str())
            .chain(std::iter::once(LEFT_OUT))
            .chain(shorts.iter().map(String::as_str))
            .chain(whole.iter().map(String::as_str));
        if fits(with_gap, cap) {
            parts.push(LEFT_OUT);
        }
    }
    parts.extend(shorts.iter().map(String::as_str));
    parts.extend(whole.iter().map(String::as_str));
    parts.join("\n\n")
}

fn shorten(turn: &str) -> String {
    let lines: Vec<&str> = turn.lines().collect();
    match lines.len() {
        0 => String::new(),
        1 => lines[0].to_owned(),
        2 => format!("{}\n{}", lines[0], lines[1]),
        _ => format!("{}\n...\n{}", lines[0], lines[lines.len() - 1]),
    }
}

fn cut_to(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn fits<'a>(parts: impl IntoIterator<Item = &'a str>, cap: usize) -> bool {
    joined_len(parts) <= cap
}

fn joined_len<'a>(parts: impl IntoIterator<Item = &'a str>) -> usize {
    let mut n = 0_usize;
    let mut sep = false;
    for part in parts {
        if sep {
            n = n.saturating_add(2);
        }
        sep = true;
        n = n.saturating_add(part.len());
    }
    n
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{AgentOutputItem, AgentRun, ParallaxEvent, RunId, TurnId};

    use parallax_protocol::{AgentPolicy, AgentStatus, ProjectId};

    use super::{Budget, HANDOFF_BYTES, HandoffEvent, LEFT_OUT, handoff};
    use crate::agents::attached::SUMMARY_BYTES;

    fn event(seq: u64, event: ParallaxEvent) -> HandoffEvent {
        HandoffEvent {
            seq,
            event,
            compacted_from: None,
        }
    }

    fn output(seq: u64, items: Vec<AgentOutputItem>) -> HandoffEvent {
        event(
            seq,
            ParallaxEvent::AgentOutput {
                run_id: RunId::generate(),
                items,
                compacted: None,
            },
        )
    }

    fn started(seq: u64, prompt: &str) -> HandoffEvent {
        let now = "2026-01-01T00:00:00Z".parse().unwrap();
        event(
            seq,
            ParallaxEvent::AgentStarted {
                run_id: RunId::generate(),
                run: Some(AgentRun {
                    id: RunId::generate(),
                    project: ProjectId::generate(),
                    prompt: prompt.to_owned(),
                    policy: AgentPolicy::WorkspaceWrite,
                    status: AgentStatus::Running,
                    backend: "fake".to_owned(),
                    account_id: "fake".to_owned(),
                    branch: None,
                    worktree_path: None,
                    base_dirty: false,
                    session_id: None,
                    error: None,
                    diff: None,
                    coordinator_thread: None,
                    model: None,
                    effort: None,
                    context_window: None,
                    fast: None,
                    permission: None,
                    approvals: false,
                    checkout: false,
                    explore: false,
                    pull_requests: Vec::new(),
                    resume_at: None,
                    auto_resume: None,
                    created_at: now,
                    updated_at: now,
                }),
            },
        )
    }

    fn turn(text: &str, wake: bool) -> AgentOutputItem {
        AgentOutputItem::TurnStarted {
            turn_id: Some(TurnId::generate()),
            text: Some(text.to_owned()),
            wake,
            from: None,
            images: Vec::new(),
            threads: Vec::new(),
        }
    }

    fn finished(result: &str) -> AgentOutputItem {
        AgentOutputItem::TurnFinished {
            turn_id: None,
            result: Some(result.to_owned()),
        }
    }

    /// A run's turns as a new session is told them: the user's messages, Parallax's wake-ups,
    /// and the agent's replies, with a turn's result only where it adds to what the agent said.
    #[test]
    fn a_handoff_that_fits_is_the_whole_conversation() {
        let events = [
            started(1, "flood"),
            output(
                2,
                vec![
                    AgentOutputItem::TurnStarted {
                        turn_id: None,
                        text: None,
                        wake: false,
                        from: None,
                        images: Vec::new(),
                        threads: Vec::new(),
                    },
                    AgentOutputItem::ToolCall {
                        call_id: "call-1".to_owned(),
                        name: "Read".to_owned(),
                        input: serde_json::json!({"file_path": "README.md"}),
                    },
                    AgentOutputItem::Text {
                        message_id: None,
                        text: "Read it.\n".to_owned(),
                    },
                    finished("Read it."),
                ],
            ),
            output(3, vec![turn(" And now? ", false), finished("All done.")]),
            output(4, vec![turn("Subagents finished", true)]),
        ];
        assert_eq!(
            handoff(&events, Budget::Summary { cap: HANDOFF_BYTES }),
            "User:\nflood\n\nAgent:\nRead it.\n\nUser:\nAnd now?\n\nAgent:\nAll done.\n\n\
             Parallax:\nSubagents finished"
        );
    }

    /// A long conversation keeps the first task and recent turns and stays under the cap.
    #[test]
    fn a_long_conversation_keeps_the_task_and_recent_turns() {
        let mut events = vec![started(1, "flood")];
        events.extend((0..20).map(|i| {
            output(
                u64::try_from(i + 2).unwrap(),
                vec![turn(&format!("{i}{}", "x".repeat(8 * 1024)), false)],
            )
        }));
        let kept = handoff(&events, Budget::Summary { cap: HANDOFF_BYTES });
        assert!(kept.starts_with("User:\nflood"), "{kept}");
        assert!(kept.contains(LEFT_OUT), "{kept}");
        assert!(
            kept.ends_with(&format!("19{}", "x".repeat(8 * 1024))),
            "{kept}"
        );
        assert!(kept.len() <= HANDOFF_BYTES, "{}", kept.len());
        let summary = handoff(&events, Budget::Summary { cap: SUMMARY_BYTES });
        assert!(summary.starts_with("User:\nflood"), "{summary}");
        assert!(
            summary.ends_with(&format!("19{}", "x".repeat(8 * 1024))),
            "{summary}"
        );
        assert!(summary.len() <= SUMMARY_BYTES, "{}", summary.len());
        assert!(summary.len() < kept.len());
    }

    /// A task longer than half the cap is cut to half, start kept.
    #[test]
    fn a_task_over_half_the_cap_is_cut_to_half() {
        let events = [started(1, &"x".repeat(200))];
        let cap = 40;
        let kept = handoff(&events, Budget::Summary { cap });
        assert!(kept.starts_with("User:\nxxx"), "{kept}");
        assert_eq!(kept.len(), cap / 2);
        assert!(!kept.contains('y'));
    }

    /// `since` omits older events.
    #[test]
    fn since_omits_older_events() {
        let events = [
            started(1, "flood"),
            output(2, vec![turn("first follow-up", false)]),
            output(3, vec![turn("latest", false)]),
        ];
        assert_eq!(
            handoff(
                &events,
                Budget::Since {
                    seq: 1,
                    cap: HANDOFF_BYTES
                }
            ),
            "User:\nfirst follow-up\n\nUser:\nlatest"
        );
        assert_eq!(
            handoff(
                &events,
                Budget::Since {
                    seq: 2,
                    cap: HANDOFF_BYTES
                }
            ),
            "User:\nlatest"
        );
    }

    /// A `seq` inside a compacted turn starts at that turn's `from`.
    #[test]
    fn since_a_seq_inside_a_compacted_turn_starts_at_from() {
        let run_id = RunId::generate();
        let compacted = HandoffEvent {
            seq: 20,
            event: ParallaxEvent::AgentOutput {
                run_id,
                items: vec![turn("the whole turn", false)],
                compacted: Some(parallax_protocol::Compacted { from: 12 }),
            },
            compacted_from: Some(12),
        };
        let later = output(30, vec![turn("after", false)]);
        let events = [started(1, "flood"), compacted, later];
        assert_eq!(
            handoff(
                &events,
                Budget::Since {
                    seq: 15,
                    cap: HANDOFF_BYTES
                }
            ),
            "User:\nthe whole turn\n\nUser:\nafter"
        );
        assert_eq!(
            handoff(
                &events,
                Budget::Since {
                    seq: 20,
                    cap: HANDOFF_BYTES
                }
            ),
            "User:\nafter"
        );
    }
}
