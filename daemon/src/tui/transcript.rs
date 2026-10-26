//! The open thread in `plxd tui`: its events folded into what the screen shows, as the app's
//! `transcript.ts` folds them, without images, subagents, or diffs.

use jiff::Timestamp;
use parallax_protocol::{
    AgentOutcome, AgentOutputItem, AgentToolStatus, ApprovalId, LoggedEvent, ParallaxEvent, RunId,
};
use serde_json::Value;

/// The input keys whose value says what a tool call does, most telling first.
const DETAIL_KEYS: [&str; 8] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

/// The most characters of a tool's input a row shows.
const DETAIL_CHARS: usize = 120;

/// One thing the transcript shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    /// A message to the agent.
    User(String),
    /// The agent's reply. `partial` while it still arrives as `textDelta`s.
    Assistant {
        text: String,
        message_id: Option<String>,
        partial: bool,
    },
    /// A tool call, with how it ended and the first line it returned, once it has.
    Tool {
        call_id: String,
        name: String,
        detail: String,
        status: Option<AgentToolStatus>,
        output: Option<String>,
    },
    /// A notice from the vendor, a wake-up, or a failure.
    Note(String),
    /// A turn ended: how long it took, from its start to its end as plxd logged them, and when.
    Done { secs: u64, at: Timestamp },
}

/// A permission request the thread waits on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub approval_id: ApprovalId,
    pub tool_name: String,
    pub detail: String,
    /// Whether it can be allowed for the rest of the session: its `alwaysAllow` isn't empty.
    pub always: bool,
}

/// A thread's events, and what they fold into.
#[derive(Debug, Default)]
pub struct Transcript {
    /// The thread's first message, shown first, since its turn carries no text.
    prompt: Option<String>,
    /// The events, by `seq`, after the compacted-row rule.
    events: Vec<LoggedEvent>,
    /// The turns compacted rows replaced, as (run, first `seq`, row's `seq`), so a batch from one
    /// that arrives late is dropped too.
    compacted: Vec<(RunId, u64, u64)>,
    pub entries: Vec<Entry>,
    pub pending: Vec<Pending>,
    /// The latest request's context tokens and window, when the vendor reports them.
    pub context: Option<(u64, u64)>,
    /// What the thread's turns cost, in millionths of a US dollar, as the vendor reports it.
    pub cost_micros: u64,
    /// The model the vendor's session last reported.
    pub model: Option<String>,
}

impl Transcript {
    /// An empty transcript that opens with `prompt`: the thread's first message, or `None` when
    /// older events are still on plxd and the first message isn't among them.
    pub fn new(prompt: Option<String>) -> Self {
        let mut transcript = Self {
            prompt,
            ..Self::default()
        };
        transcript.fold();
        transcript
    }

    /// Takes `events`, in any order and with repeats, then folds them again.
    // ponytail: refolds every event on each batch; fold only the new ones if long threads lag.
    pub fn apply(&mut self, events: impl IntoIterator<Item = LoggedEvent>) {
        for event in events {
            self.take(event);
        }
        self.fold();
    }

    /// A compacted row replaces any batch of its run in [`from`, its `seq`) and any event held
    /// at its `seq` (0052).
    fn take(&mut self, event: LoggedEvent) {
        let replaced = |held: &LoggedEvent, run: RunId, from: u64, seq: u64| {
            matches!(&held.event, ParallaxEvent::AgentOutput { run_id, .. } if *run_id == run)
                && (from..seq).contains(&held.seq)
        };
        if let ParallaxEvent::AgentOutput {
            run_id,
            compacted: Some(compacted),
            ..
        } = &event.event
        {
            let (run, from, seq) = (*run_id, compacted.from, event.seq);
            self.compacted.push((run, from, seq));
            self.events
                .retain(|held| held.seq != seq && !replaced(held, run, from, seq));
        } else if self.events.iter().any(|held| held.seq == event.seq)
            || self
                .compacted
                .iter()
                .any(|&(run, from, seq)| replaced(&event, run, from, seq))
        {
            return;
        }
        let at = self.events.partition_point(|held| held.seq < event.seq);
        self.events.insert(at, event);
    }

    fn fold(&mut self) {
        self.entries = self.prompt.iter().cloned().map(Entry::User).collect();
        self.pending.clear();
        self.context = None;
        self.cost_micros = 0;
        self.model = None;
        let events = std::mem::take(&mut self.events);
        let mut started = None;
        for event in &events {
            match &event.event {
                ParallaxEvent::AgentOutput { items, .. } => {
                    for item in items {
                        self.fold_item(item);
                        match item {
                            AgentOutputItem::TurnStarted { .. } => started = Some(event.time),
                            AgentOutputItem::TurnFinished { .. } => {
                                if let Some(start) = started.take() {
                                    let secs = event.time.duration_since(start).as_secs();
                                    self.entries.push(Entry::Done {
                                        secs: u64::try_from(secs).unwrap_or(0),
                                        at: event.time,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
                // A request is pending until its run's next `agent.finished`.
                ParallaxEvent::AgentFinished { outcome, .. } => {
                    self.pending.clear();
                    if let AgentOutcome::Failed { message, .. } = outcome {
                        self.entries.push(Entry::Note(format!("Failed: {message}")));
                    }
                }
                _ => {}
            }
        }
        self.events = events;
    }

    fn fold_item(&mut self, item: &AgentOutputItem) {
        let entries = &mut self.entries;
        match item {
            // The first turn has no id: its text is the prompt, already shown.
            AgentOutputItem::TurnStarted {
                turn_id: Some(_),
                text,
                wake,
                ..
            } => {
                let text = text.clone().unwrap_or_default();
                entries.push(if *wake {
                    Entry::Note(text)
                } else {
                    Entry::User(text)
                });
            }
            AgentOutputItem::TextDelta { message_id, text } => {
                if let Some(Entry::Assistant { text: held, .. }) =
                    reply(entries, message_id.as_ref())
                {
                    held.push_str(text);
                } else {
                    entries.push(Entry::Assistant {
                        text: text.clone(),
                        message_id: message_id.clone(),
                        partial: true,
                    });
                }
            }
            AgentOutputItem::Text { message_id, text } => {
                let whole = Entry::Assistant {
                    text: text.clone(),
                    message_id: message_id.clone(),
                    partial: false,
                };
                match reply(entries, message_id.as_ref()) {
                    Some(held) => *held = whole,
                    None => entries.push(whole),
                }
            }
            AgentOutputItem::ToolCall {
                call_id,
                name,
                input,
            } => tool_call(entries, call_id, name, input),
            AgentOutputItem::ToolResult {
                call_id,
                status,
                output,
                ..
            } => tool_result(entries, call_id, *status, output.as_deref()),
            AgentOutputItem::Notice { detail } => entries.push(Entry::Note(detail.clone())),
            AgentOutputItem::ApprovalRequested {
                approval_id,
                tool_name,
                input,
                always_allow,
                ..
            } => self.pending.push(Pending {
                approval_id: *approval_id,
                tool_name: tool_name.clone(),
                detail: detail(input),
                always: !always_allow.is_empty(),
            }),
            AgentOutputItem::ApprovalResolved { approval_id, .. } => {
                self.pending
                    .retain(|request| request.approval_id != *approval_id);
            }
            AgentOutputItem::RequestUsage { usage, .. } => {
                if let (Some(tokens), Some(window)) = (usage.context_tokens, usage.context_window) {
                    self.context = Some((tokens, window));
                }
            }
            AgentOutputItem::Usage {
                cost_usd_micros, ..
            } => self.cost_micros += cost_usd_micros.unwrap_or(0),
            _ => {}
        }
    }
}

/// Adds a tool call's row. Claude announces a call with a null input as its block starts, then
/// repeats it whole (PLX-714): the whole call fills in the announced row.
fn tool_call(entries: &mut Vec<Entry>, call_id: &str, name: &str, input: &Value) {
    let announced = entries.iter_mut().rev().find_map(|entry| match entry {
        Entry::Tool {
            call_id: id,
            name,
            detail,
            ..
        } if id == call_id => Some((name, detail)),
        _ => None,
    });
    match announced {
        Some((held, shown)) => {
            name.clone_into(held);
            *shown = detail(input);
        }
        None => entries.push(Entry::Tool {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            detail: detail(input),
            status: None,
            output: None,
        }),
    }
}

/// Marks a tool call's row with how it ended and the first line it returned.
fn tool_result(
    entries: &mut [Entry],
    call_id: &str,
    status: AgentToolStatus,
    output: Option<&str>,
) {
    let call = entries.iter_mut().rev().find_map(|entry| match entry {
        Entry::Tool {
            call_id: id,
            status,
            output,
            ..
        } if id == call_id => Some((status, output)),
        _ => None,
    });
    if let Some((held, shown)) = call {
        *held = Some(status);
        *shown = output.map(first_line);
    }
}

/// The reply a text item continues: the one with its vendor id, or with none, a partial one
/// just before it.
fn reply<'a>(entries: &'a mut [Entry], message_id: Option<&String>) -> Option<&'a mut Entry> {
    match message_id {
        Some(id) => entries.iter_mut().rev().find(
            |entry| matches!(entry, Entry::Assistant { message_id: Some(held), .. } if held == id),
        ),
        None => entries
            .last_mut()
            .filter(|entry| matches!(entry, Entry::Assistant { partial: true, .. })),
    }
}

/// One line of what a tool call does, from the first of [`DETAIL_KEYS`] its input has.
fn detail(input: &Value) -> String {
    first_line(
        DETAIL_KEYS
            .iter()
            .find_map(|key| input.get(key)?.as_str())
            .unwrap_or_default(),
    )
}

/// `text`'s first non-empty line, cut to [`DETAIL_CHARS`].
fn first_line(text: &str) -> String {
    let line = text.lines().find(|line| !line.trim().is_empty());
    line.unwrap_or_default()
        .trim()
        .chars()
        .take(DETAIL_CHARS)
        .collect()
}
