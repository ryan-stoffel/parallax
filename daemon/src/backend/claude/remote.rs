//! Claude Remote Control runs (PLX-1140): a thread whose session is a `claude.ai` one, which
//! `claude remote-control` serves on another computer, talks to that session instead of running
//! Claude Code here.
//!
//! A run whose [`RunRequest::resume`] names a `session_` id ([`is_session`]) comes here from
//! [`ClaudeBackend::start`](super::ClaudeBackend). Each turn's message goes into the session as
//! the user's own with `claude -p --cloud <id> --output-format json`, read from stdin, which
//! prints `{"ok": true}` once `claude.ai` has it. The session's computer takes it when it serves
//! the session, at once or once it's back online. The run then follows the session's transcript
//! with a [`Control`] process, through `get_cloud_session_transcript`: it reads to the end before
//! the first message, so only what follows is new, then re-reads the last page about every
//! [`POLL`], less often while nothing changes, moving to the next page once the service names
//! one. Each new entry has a stream-json message's shape, so the [`Translator`] turns it into the
//! same events as a local Claude run's. A turn ends ([`Turn`]) after a message from the user,
//! once a read brings nothing more, on an assistant entry with a final `stop_reason`, any but
//! `tool_use`: `end_turn`, or `stop_sequence`, `max_tokens`, or `refusal` when the turn failed. One
//! that holds only thinking waits a few quiet reads for the text that follows it, as the reply's
//! thinking and text entries both carry it. An interrupt from Claude's own apps ends it too, and
//! so does the session's listed `idle` status, should none of these come.
//!
//! The session's status (`list_cloud_sessions`) is read every few polls, and reported as an
//! [`Event::RemoteControl`]: running, waiting for an answer in Claude, which only Claude's own
//! apps can give, offline when nothing answers a message and Claude isn't working, or archived.
//! New entries report it running again. A follow-up waits for the turn to end, then goes the
//! same way. Nothing here stops the session's turn: [`Run::cancel`](crate::backend::Run::cancel)
//! only stops following it, at once, mid-send or mid-read included, and the run ends cancelled
//! with a notice that Claude keeps working.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::RemoteControlState;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::ClaudeBackend;
use super::control::{Control, SIGNED_OUT, text};
use super::stream::{Step, Translator};
use crate::backend::event::{Event, Failure, FailureKind, Outcome};
use crate::backend::process::Output;
use crate::backend::{
    CancelSwitch, Credential, EVENT_BUFFER, EventSink, FollowUp, Held, RunHandle, RunRequest,
    StartError, Started, TurnId, check_argument,
};

/// How often the transcript is read while it changes.
const POLL: Duration = Duration::from_millis(1500);

/// The longest wait between reads, which a quiet session backs off to.
const MAX_POLL: Duration = Duration::from_secs(10);

/// How many reads go by between reads of the session's status.
const STATUS_EVERY: u32 = 4;

/// How long a sent message may go unanswered, with Claude not working, before the session's
/// computer is taken to be offline.
const OFFLINE_AFTER: Duration = Duration::from_secs(20);

/// How long sending one message, or one request of the control process, may take.
const LIMIT: Duration = Duration::from_secs(60);

/// The most pages one read follows, at up to a thousand entries each, and the most the first one
/// skips to reach the end.
const MAX_PAGES: usize = 200;

/// How many reads in a row may fail before the run gives up.
const MAX_ERRORS: u32 = 5;

/// How many quiet reads end a turn whose last entry was a final one with only thinking, waiting
/// for the text that usually follows it.
const THINKING_QUIET: u32 = 3;

/// Whether `session_id` is a `claude.ai` session's, which a Claude Remote Control run follows.
#[must_use]
pub(crate) fn is_session(session_id: &str) -> bool {
    session_id.starts_with("session_")
}

/// Where a session opens in Claude.
#[must_use]
pub(crate) fn url(session_id: &str) -> String {
    format!("https://claude.ai/code/{session_id}")
}

/// Starts following Remote Control session `request.resume`, sending `request.prompt` into it.
///
/// # Errors
///
/// [`StartError::Unsupported`] for what a Remote Control session can't take: a fork, a rewind,
/// images, or an API key account, which has no `claude.ai` sign-in.
pub(super) fn start(backend: &ClaudeBackend, request: RunRequest) -> Result<Started, StartError> {
    let Some(resume) = request.resume else {
        return Err(StartError::Invalid("no Remote Control session".into()));
    };
    if resume.fork {
        return Err(StartError::Unsupported(
            "a Claude Remote Control session can't be forked".into(),
        ));
    }
    if resume.at.is_some() {
        return Err(StartError::Unsupported(
            "a Claude Remote Control session can't go back to an earlier turn".into(),
        ));
    }
    if !request.images.is_empty() {
        return Err(StartError::Unsupported(IMAGES.into()));
    }
    if matches!(request.account.credential, Credential::ApiKey(_)) {
        return Err(StartError::Unsupported(
            "Claude Remote Control needs Claude Code signed in to claude.ai, not an API key".into(),
        ));
    }
    if request.prompt.trim().is_empty() {
        return Err(StartError::Invalid("the prompt is empty".into()));
    }
    check_argument("Remote Control session", &resume.session_id)?;
    let cloud = ProcessCloud {
        backend: backend.clone(),
        cwd: request.cwd,
        credential: request.account.credential,
        session_id: resume.session_id.clone(),
        control: None,
    };
    let switch = CancelSwitch::new();
    let (handle, follow_ups) = RunHandle::new(request.run_id, true, switch.clone());
    let held = handle.held();
    let (sink, events) = EventSink::channel(EVENT_BUFFER, resume.usage_totals);
    let driver = Driver::new(cloud, resume.session_id, sink, switch, follow_ups, held);
    tokio::spawn(driver.run(request.turn_id, request.prompt));
    Ok(Started {
        run: Arc::new(handle),
        events,
    })
}

/// Why a message with images can't go to a Remote Control session.
const IMAGES: &str =
    "a Claude Remote Control session takes text only, so images can't be sent to it";

/// One page of a session's transcript.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Page {
    /// Its entries, oldest first.
    pub entries: Vec<Value>,
    /// The cursor of the page after it, once there is one.
    pub next: Option<String>,
}

impl Page {
    fn of(answer: &Value) -> Self {
        Self {
            entries: answer["entries"].as_array().cloned().unwrap_or_default(),
            next: text(&answer["next_cursor"]),
        }
    }
}

/// What a Remote Control run asks of `claude.ai`, through Claude Code.
pub(super) trait Cloud: Send {
    /// Puts `text` into the session as the user's message.
    async fn send(&mut self, text: &str) -> Result<(), Failure>;
    /// The page of the session's transcript at `cursor`, the first with none.
    async fn page(&mut self, cursor: Option<&str>) -> Result<Page, String>;
    /// The session's status as `claude.ai` lists it, if it lists one.
    async fn status(&mut self) -> Result<Option<String>, String>;
}

/// [`Cloud`] through the user's `claude`: a `claude -p --cloud` per message, and one [`Control`]
/// process for reads, started on the first and again after one fails.
struct ProcessCloud {
    backend: ClaudeBackend,
    cwd: PathBuf,
    credential: Credential,
    session_id: String,
    control: Option<Control>,
}

impl ProcessCloud {
    async fn ask(&mut self, request: Value) -> Result<Value, String> {
        let control = match &mut self.control {
            Some(control) => control,
            slot @ None => {
                let process = self
                    .backend
                    .control_process(&self.cwd, &self.credential)
                    .map_err(|error| error.to_string())?;
                let mut control = Control::new(process)?;
                within(control.ask(json!({"subtype": "initialize"}))).await?;
                slot.insert(control)
            }
        };
        let answer = within(control.ask(request)).await;
        if answer.is_err() {
            self.control = None;
        }
        answer
    }
}

impl Cloud for ProcessCloud {
    async fn send(&mut self, text: &str) -> Result<(), Failure> {
        let spawn = |error: String| Failure::new(FailureKind::SpawnFailed, error);
        let (mut spec, _) = self
            .backend
            .spec(&self.cwd, &self.credential)
            .map_err(|error| spawn(error.to_string()))?;
        spec.args = ["-p", "--cloud", &self.session_id, "--output-format", "json"]
            .map(OsString::from)
            .into();
        spec.args
            .extend(self.backend.overrides.args.iter().cloned());
        let mut process = self
            .backend
            .launcher
            .spawn(&spec)
            .map_err(|error| spawn(error.to_string()))?;
        let mut stdin = process
            .take_stdin()
            .ok_or_else(|| spawn("Claude Code has no stdin".into()))?;
        // A broken pipe shows as the exit's error below.
        let _ = stdin.write_all(text.as_bytes()).await;
        drop(stdin);
        let read = async {
            let mut lines = Vec::new();
            loop {
                match process.next().await {
                    Some(Output::Line(line)) => lines.push(line),
                    Some(Output::Oversized { .. }) => {}
                    Some(Output::Exited(exit)) => return (lines, Some(exit)),
                    None => return (lines, None),
                }
            }
        };
        let Ok((lines, exit)) = tokio::time::timeout(LIMIT, read).await else {
            return Err(Failure::new(
                FailureKind::VendorError,
                "Claude Code took too long to send the message".into(),
            ));
        };
        sent(&lines, exit.as_ref().map(|exit| exit.stderr_tail.as_str()))
    }

    async fn page(&mut self, cursor: Option<&str>) -> Result<Page, String> {
        let mut request = json!({
            "subtype": "get_cloud_session_transcript",
            "session_id": self.session_id,
        });
        if let Some(cursor) = cursor {
            request["cursor"] = json!(cursor);
        }
        Ok(Page::of(&self.ask(request).await?))
    }

    async fn status(&mut self) -> Result<Option<String>, String> {
        let request = json!({"subtype": "list_cloud_sessions", "user_initiated": false});
        let listed = self.ask(request).await?;
        Ok(listed["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["id"] == self.session_id.as_str())
            .and_then(|s| text(&s["status"])))
    }
}

async fn within<T>(ask: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(LIMIT, ask)
        .await
        .unwrap_or_else(|_| Err("Claude Code took too long to read the session".into()))
}

/// What `claude -p --cloud --output-format json` printed, `lines`, says of sending: its last JSON
/// object, `{"ok": true}` or `{"ok": false, "error": ...}`, else its stderr, `stderr`.
pub(super) fn sent(lines: &[Vec<u8>], stderr: Option<&str>) -> Result<(), Failure> {
    let answer = lines
        .iter()
        .rev()
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find(|value| value.get("ok").is_some());
    let stderr = stderr.map(str::trim).filter(|tail| !tail.is_empty());
    match answer {
        Some(answer) if answer["ok"] == true => Ok(()),
        Some(answer) => {
            let error = text(&answer["error"]).unwrap_or_else(|| "it said no".into());
            Err(send_failure(&error))
        }
        None => Err(send_failure(
            stderr.unwrap_or("Claude Code printed no answer"),
        )),
    }
}

/// The failure for a message `claude -p --cloud` couldn't send, which says why in `error`.
fn send_failure(error: &str) -> Failure {
    let lower = error.to_ascii_lowercase();
    let message = if lower.contains("is archived") {
        "This Claude Remote Control session is archived, so it can't take new messages".to_owned()
    } else {
        format!("Claude Code couldn't send the message: {}", short(error))
    };
    let kind = if lower.contains("not logged in") || lower.contains("/login") {
        FailureKind::NotSignedIn
    } else {
        FailureKind::VendorError
    };
    Failure::new(kind, message)
}

fn short(text: &str) -> &str {
    let text = text.trim();
    &text[..text.floor_char_boundary(500)]
}

/// Where a run is in a session's transcript: the page it reads, and how many of its entries it
/// has taken.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Tail {
    cursor: Option<String>,
    seen: usize,
}

impl Tail {
    /// The entries of `page`, read at [`Self::cursor`], that are new, and whether a later page
    /// waits: the service names one once this page is full, which the next read starts from.
    pub fn take(&mut self, mut page: Page) -> (Vec<Value>, bool) {
        let new = page.entries.split_off(self.seen.min(page.entries.len()));
        if let Some(next) = page.next {
            self.cursor = Some(next);
            self.seen = 0;
            return (new, true);
        }
        self.seen += new.len();
        (new, false)
    }

    /// The cursor of the page to read next.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }
}

/// What a transcript entry is to a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Entry {
    /// A message from the user, which starts a turn: Parallax's, or one sent from elsewhere.
    Prompt,
    /// The user stopped the turn from Claude's own apps.
    Interrupted,
    /// The agent's work, for the translator, with how it ends the turn, if it does.
    Work { end: Option<End> },
    /// Nothing to show: Claude Code's notes, a subagent's entries, and bookkeeping.
    Skip,
}

/// How an assistant entry with a final `stop_reason` ends a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum End {
    /// It holds the reply, or an error's text.
    Reply,
    /// It holds only thinking, which the reply's text usually follows.
    Thinking,
}

/// What transcript `entry` is to a turn.
pub(super) fn entry(entry: &Value) -> Entry {
    let flag = |key: &str| entry[key].as_bool() == Some(true);
    if flag("isSidechain") || flag("isMeta") {
        return Entry::Skip;
    }
    let content = &entry["message"]["content"];
    let interrupt = |text: &str| text.starts_with("[Request interrupted by user");
    match entry["type"].as_str() {
        Some("assistant") => {
            // `tool_use` goes on, and `pause_turn` is resumed by Claude Code itself.
            let end = match entry["message"]["stop_reason"].as_str() {
                None | Some("tool_use" | "pause_turn") => None,
                Some(_) => {
                    let blocks = content.as_array().map(Vec::as_slice).unwrap_or_default();
                    let thinking = |b: &Value| {
                        matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking"))
                    };
                    Some(if !blocks.is_empty() && blocks.iter().all(thinking) {
                        End::Thinking
                    } else {
                        End::Reply
                    })
                }
            };
            Entry::Work { end }
        }
        Some("user") => match content {
            Value::String(text) if interrupt(text) => Entry::Interrupted,
            Value::String(text) if !text.trim().is_empty() => Entry::Prompt,
            Value::Array(blocks) if blocks.iter().any(|b| b["type"] == "tool_result") => {
                Entry::Work { end: None }
            }
            Value::Array(blocks)
                if blocks
                    .iter()
                    .any(|b| b["text"].as_str().is_some_and(interrupt)) =>
            {
                Entry::Interrupted
            }
            Value::Array(blocks) if blocks.iter().any(|b| b["type"] == "text") => Entry::Prompt,
            _ => Entry::Skip,
        },
        // A message sent while Claude worked, which joins its turn.
        Some("attachment")
            if entry["attachment"]["type"] == "queued_command"
                && entry["attachment"]["prompt"]
                    .as_str()
                    .is_some_and(|prompt| !prompt.starts_with('<')) =>
        {
            Entry::Prompt
        }
        _ => Entry::Skip,
    }
}

/// The session's state from its listed `status` and the turn being followed: `heard` once any
/// entry came after the message, which `waited` ago went out. An `idle` session that has heard
/// it has ended the turn ([`Turn::idle`]).
pub(super) fn state(status: Option<&str>, heard: bool, waited: Duration) -> RemoteControlState {
    match status {
        Some("archived") => RemoteControlState::Archived,
        Some("requires_action") => RemoteControlState::Waiting,
        Some("running" | "pending") => RemoteControlState::Running,
        _ if !heard && waited >= OFFLINE_AFTER => RemoteControlState::Offline,
        _ => RemoteControlState::Running,
    }
}

/// Where the turn of the message just sent is, from the transcript entries each read brings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Turn {
    /// A message from the user came after the send: the one sent, or one from elsewhere.
    prompted: bool,
    /// Any entry came after the send.
    heard: bool,
    /// How many more quiet reads end the turn, once an entry ended it.
    ending: Option<u32>,
}

impl Turn {
    /// Takes the kinds of the entries one read brought, and returns whether the turn has ended.
    pub fn read(&mut self, entries: &[Entry]) -> bool {
        if entries.is_empty() {
            let Some(left) = &mut self.ending else {
                return false;
            };
            *left = left.saturating_sub(1);
            return *left == 0;
        }
        self.heard = true;
        for entry in entries {
            match entry {
                Entry::Prompt => {
                    self.prompted = true;
                    self.ending = None;
                }
                Entry::Interrupted
                | Entry::Work {
                    end: Some(End::Reply),
                } if self.prompted => {
                    self.ending = Some(1);
                }
                Entry::Work {
                    end: Some(End::Thinking),
                } if self.prompted => {
                    self.ending = Some(THINKING_QUIET);
                }
                Entry::Work { end: None } => self.ending = None,
                _ => {}
            }
        }
        false
    }

    /// Whether the turn has ended by the session's listed `status` too: `idle` once the message
    /// reached it, for a turn that ended with no entry that says so.
    pub fn idle(&self, status: Option<&str>) -> bool {
        self.prompted && status == Some("idle")
    }

    /// Whether an entry ended the turn, and the run waits for quiet reads.
    pub fn ending(&self) -> bool {
        self.ending.is_some()
    }
}

/// The failure for a read that failed with `error`: Claude Code signed out, or, after
/// [`MAX_ERRORS`] in a row (`errors`), any. `None` while another read may work.
pub(super) fn read_failure(error: &str, errors: u32) -> Option<Failure> {
    let lower = error.to_ascii_lowercase();
    if error == SIGNED_OUT || lower.contains("not logged in") || lower.contains("/login") {
        return Some(Failure::new(
            FailureKind::NotSignedIn,
            "Claude Code is not signed in".into(),
        ));
    }
    (errors >= MAX_ERRORS).then(|| {
        Failure::new(
            FailureKind::VendorError,
            format!("Parallax couldn't read the session: {error}"),
        )
    })
}

/// `work`'s output, or `None` once `switch` is cancelled first: Stop doesn't wait for a send or a
/// read, whose process is dropped with it.
async fn unless_stopped<T>(switch: &CancelSwitch, work: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        () = switch.cancelled() => None,
        done = work => Some(done),
    }
}

/// How following one turn ended.
enum Followed {
    Done,
    Cancelled,
    Failed(Failure),
}

/// One run: sends each message, follows the transcript until its turn ends, and reports it.
pub(super) struct Driver<C> {
    cloud: C,
    session_id: String,
    sink: EventSink,
    switch: CancelSwitch,
    follow_ups: mpsc::UnboundedReceiver<FollowUp>,
    held: Held,
    translator: Translator,
    tail: Tail,
    /// Follow-ups that came while a turn ran, oldest first.
    queued: VecDeque<FollowUp>,
    /// The last state reported.
    state: Option<RemoteControlState>,
    /// The last reply's text, the turn's result.
    reply: Option<String>,
    poll: Duration,
    /// The longest wait between reads, [`MAX_POLL`] but in tests.
    max_poll: Duration,
}

impl<C: Cloud> Driver<C> {
    pub fn new(
        cloud: C,
        session_id: String,
        sink: EventSink,
        switch: CancelSwitch,
        follow_ups: mpsc::UnboundedReceiver<FollowUp>,
        held: Held,
    ) -> Self {
        Self {
            cloud,
            session_id,
            sink,
            switch,
            follow_ups,
            held,
            translator: Translator::transcript(),
            tail: Tail::default(),
            queued: VecDeque::new(),
            state: None,
            reply: None,
            poll: POLL,
            max_poll: MAX_POLL,
        }
    }

    /// Reads every `poll` instead of [`POLL`], never backing off, for tests.
    #[cfg(test)]
    pub fn with_poll(mut self, poll: Duration) -> Self {
        self.poll = poll;
        self.max_poll = poll;
        self
    }

    pub async fn run(mut self, turn_id: Option<TurnId>, prompt: String) {
        let started = Event::SessionStarted {
            session_id: self.session_id.clone(),
            model: None,
            api_key_source: None,
        };
        self.emit(started).await;
        let outcome = self.turns(turn_id, prompt).await;
        // Follow-ups taken and never sent were dropped.
        self.follow_ups.close();
        while let Ok(follow_up) = self.follow_ups.try_recv() {
            self.queued.push_back(follow_up);
        }
        for follow_up in std::mem::take(&mut self.queued) {
            let turn_id = follow_up.turn_id;
            self.emit(Event::FollowUpDropped { turn_id }).await;
        }
        let _ = self.sink.finish(outcome).await;
    }

    /// Sends each message in turn and follows it, until none is left.
    async fn turns(&mut self, mut turn_id: Option<TurnId>, mut prompt: String) -> Outcome {
        let switch = self.switch.clone();
        match unless_stopped(&switch, self.skip_to_end()).await {
            None => return Outcome::Cancelled,
            Some(Err(error)) => {
                let failure = read_failure(&error, MAX_ERRORS)
                    .unwrap_or_else(|| Failure::new(FailureKind::VendorError, error));
                return Outcome::Failed(failure);
            }
            Some(Ok(())) => {}
        }
        loop {
            self.emit(Event::TurnStarted { turn_id }).await;
            let sent = unless_stopped(&switch, self.cloud.send(&prompt)).await;
            let followed = match sent {
                None => Followed::Cancelled,
                Some(Err(failure)) => {
                    if failure.message.contains("archived") {
                        let state = RemoteControlState::Archived;
                        self.emit(Event::RemoteControl { state }).await;
                    }
                    self.finish_turn(turn_id, true).await;
                    return Outcome::Failed(failure);
                }
                Some(Ok(())) => {
                    // Each turn reports its states afresh, so plxd's view leaves the last turn's.
                    self.state = None;
                    self.report(RemoteControlState::Running).await;
                    self.follow().await
                }
            };
            match followed {
                Followed::Done => self.finish_turn(turn_id, false).await,
                Followed::Cancelled => {
                    let detail = "Parallax stopped following this turn. Claude keeps working on \
                                  it in the session."
                        .to_owned();
                    self.emit(Event::Notice { detail }).await;
                    return Outcome::Cancelled;
                }
                Followed::Failed(failure) => {
                    self.finish_turn(turn_id, true).await;
                    return Outcome::Failed(failure);
                }
            }
            let Some(next) = self.next_message().await else {
                return Outcome::Completed {
                    result: self.reply.take(),
                };
            };
            turn_id = Some(next.turn_id);
            prompt = next.text;
            if !next.images.is_empty() {
                let detail = format!("The message's images weren't sent: {IMAGES}.");
                self.emit(Event::Notice { detail }).await;
            }
        }
    }

    async fn finish_turn(&mut self, turn_id: Option<TurnId>, failed: bool) {
        let result = if failed { None } else { self.reply.clone() };
        self.emit(Event::TurnFinished {
            turn_id,
            result,
            failed,
        })
        .await;
    }

    /// The next message to send: one that came during the turn, else one that comes while plxd
    /// holds the run open ([`Run::hold`](crate::backend::Run::hold)), else none.
    async fn next_message(&mut self) -> Option<FollowUp> {
        while let Ok(follow_up) = self.follow_ups.try_recv() {
            self.queued.push_back(follow_up);
        }
        loop {
            if let Some(next) = self.queued.pop_front() {
                return Some(next);
            }
            if !self.held.now() || self.switch.is_cancelled() {
                return None;
            }
            tokio::select! {
                follow_up = self.follow_ups.recv() => self.queued.push_back(follow_up?),
                () = self.held.changed() => {}
                () = self.switch.cancelled() => return None,
            }
        }
    }

    /// Reads the transcript to its end, so the run takes only what follows.
    async fn skip_to_end(&mut self) -> Result<(), String> {
        for _ in 0..MAX_PAGES {
            let page = self.cloud.page(self.tail.cursor()).await?;
            if !self.tail.take(page).1 {
                return Ok(());
            }
        }
        Ok(())
    }

    /// The transcript's new entries, from the page the run is on and any after it.
    async fn read(&mut self) -> Result<Vec<Value>, String> {
        let mut new = Vec::new();
        for _ in 0..MAX_PAGES {
            let page = self.cloud.page(self.tail.cursor()).await?;
            let (entries, more) = self.tail.take(page);
            new.extend(entries);
            if !more {
                break;
            }
        }
        Ok(new)
    }

    /// Follows the turn of the message just sent until it ends.
    async fn follow(&mut self) -> Followed {
        let sent = Instant::now();
        let switch = self.switch.clone();
        let mut delay = self.poll;
        let mut next = sent + delay;
        let mut turn = Turn::default();
        let (mut reads, mut errors) = (0_u32, 0_u32);
        self.reply = None;
        loop {
            tokio::select! {
                biased;
                () = self.switch.cancelled() => return Followed::Cancelled,
                () = self.sink.closed() => {
                    self.switch.cancel();
                    return Followed::Cancelled;
                }
                Some(follow_up) = self.follow_ups.recv() => {
                    self.queued.push_back(follow_up);
                    continue;
                }
                () = tokio::time::sleep_until(next) => {}
            }
            let entries = match unless_stopped(&switch, self.read()).await {
                None => return Followed::Cancelled,
                Some(Ok(entries)) => entries,
                Some(Err(error)) => {
                    errors += 1;
                    if let Some(failure) = read_failure(&error, errors) {
                        return Followed::Failed(failure);
                    }
                    delay = (delay * 2).min(self.max_poll);
                    next = Instant::now() + delay;
                    continue;
                }
            };
            errors = 0;
            reads += 1;
            let mut kinds = Vec::with_capacity(entries.len());
            for value in &entries {
                let kind = entry(value);
                if let Entry::Work { .. } = kind {
                    self.work(value).await;
                }
                kinds.push(kind);
            }
            if turn.read(&kinds) {
                return Followed::Done;
            }
            // New work says Claude went on, from waiting for an answer included.
            if !entries.is_empty() && !turn.ending() {
                self.report(RemoteControlState::Running).await;
            }
            if reads % STATUS_EVERY == 0 && !turn.ending() {
                let Some(status) = unless_stopped(&switch, self.cloud.status()).await else {
                    return Followed::Cancelled;
                };
                match status {
                    Ok(status) => {
                        let state = state(status.as_deref(), turn.heard, sent.elapsed());
                        if state == RemoteControlState::Archived {
                            self.report(state).await;
                            let message = "The session was archived in Claude".to_owned();
                            return Followed::Failed(Failure::new(
                                FailureKind::VendorError,
                                message,
                            ));
                        }
                        if entries.is_empty() && turn.idle(status.as_deref()) {
                            return Followed::Done;
                        }
                        self.report(state).await;
                    }
                    Err(error) => {
                        tracing::debug!(%error, "could not read a Remote Control session's status");
                    }
                }
            }
            delay = if entries.is_empty() {
                delay.mul_f32(1.5).min(self.max_poll)
            } else {
                self.poll
            };
            next = Instant::now() + delay;
        }
    }

    /// Reports work entry `value` as the translator reads it.
    async fn work(&mut self, value: &Value) {
        let steps = self.translator.line(value.to_string().as_bytes());
        for step in steps {
            let Step::Emit(event) = step else {
                continue;
            };
            if let Event::Text { text, .. } = &event {
                self.reply = Some(text.clone());
            }
            self.emit(event).await;
        }
    }

    /// Reports `state` when it changed, with a notice in the thread when it asks something of
    /// the user.
    async fn report(&mut self, state: RemoteControlState) {
        if self.state == Some(state) {
            return;
        }
        self.state = Some(state);
        self.emit(Event::RemoteControl { state }).await;
        let detail = match state {
            RemoteControlState::Waiting => "Claude is waiting for your answer in Claude.",
            RemoteControlState::Offline => {
                "The computer serving this session is offline. Your message is queued until it's \
                 back."
            }
            _ => return,
        };
        self.emit(Event::Notice {
            detail: detail.to_owned(),
        })
        .await;
    }

    async fn emit(&mut self, event: Event) {
        if self.sink.emit(event).await.is_err() {
            self.switch.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
