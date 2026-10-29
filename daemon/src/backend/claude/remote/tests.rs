use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::RemoteControlState;
use serde_json::{Value, json};

use super::{Cloud, Driver, End, Entry, Page, Tail, Turn, entry, read_failure, sent, state};
use crate::backend::claude::control::SIGNED_OUT;
use crate::backend::event::{Event, Failure, FailureKind, Outcome, ToolStatus};
use crate::backend::{CancelSwitch, EventSink, FollowUp, Run as _, RunHandle, RunId, TurnId};

fn user(text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": text}})
}

fn assistant(id: &str, block: &Value, stop: &str) -> Value {
    json!({"type": "assistant", "message": {
        "id": id, "role": "assistant", "content": [block], "stop_reason": stop,
    }})
}

fn reply(text: &str) -> Value {
    assistant(
        "msg_reply",
        &json!({"type": "text", "text": text}),
        "end_turn",
    )
}

fn page(entries: &[Value], next: Option<&str>) -> Page {
    Page {
        entries: entries.to_vec(),
        next: next.map(str::to_owned),
    }
}

#[test]
fn the_tail_takes_only_new_entries_and_moves_to_the_next_page() {
    let (a, b, c, d) = (user("a"), user("b"), user("c"), user("d"));
    let mut tail = Tail::default();
    assert_eq!(
        tail.take(page(std::slice::from_ref(&a), None)),
        (vec![a.clone()], false)
    );
    assert_eq!(tail.cursor(), None);
    // The same page read again, with one more entry.
    let (new, more) = tail.take(page(&[a.clone(), b.clone()], None));
    assert_eq!((new, more), (vec![b.clone()], false));
    // Full now, it names the next page: what's left of it is new, and the next read starts there.
    let (new, more) = tail.take(page(&[a.clone(), b.clone(), c.clone()], Some("p2")));
    assert_eq!((new, more), (vec![c], true));
    assert_eq!(tail.cursor(), Some("p2"));
    assert_eq!(
        tail.take(page(std::slice::from_ref(&d), None)),
        (vec![d], false)
    );
    assert_eq!(tail.take(page(&[], None)).0, Vec::<Value>::new());
}

#[test]
fn entries_are_prompts_work_or_skipped() {
    assert_eq!(entry(&user("Fix the test")), Entry::Prompt);
    let text_blocks =
        json!({"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}});
    assert_eq!(entry(&text_blocks), Entry::Prompt);
    let result = json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
    ]}});
    assert_eq!(entry(&result), Entry::Work { end: None });
    let call = assistant(
        "m",
        &json!({"type": "tool_use", "id": "t1", "name": "Bash"}),
        "tool_use",
    );
    assert_eq!(entry(&call), Entry::Work { end: None });
    assert_eq!(
        entry(&reply("Done.")),
        Entry::Work {
            end: Some(End::Reply)
        }
    );
    let queued = json!({"type": "attachment", "attachment": {"type": "queued_command", "prompt": "and the docs"}});
    assert_eq!(entry(&queued), Entry::Prompt);
    let notification = json!({"type": "attachment", "attachment": {
        "type": "queued_command", "prompt": "<task-notification>done</task-notification>",
    }});
    assert_eq!(entry(&notification), Entry::Skip);
    let mut meta = user("Another Claude session sent a message");
    meta["isMeta"] = true.into();
    assert_eq!(entry(&meta), Entry::Skip);
    let mut subagent = reply("from a subagent");
    subagent["isSidechain"] = true.into();
    assert_eq!(entry(&subagent), Entry::Skip);
    assert_eq!(entry(&json!({"type": "queue-operation"})), Entry::Skip);
}

#[test]
fn the_state_comes_from_the_status_and_whether_anything_answered() {
    let long = Duration::from_secs(60);
    let short = Duration::from_secs(2);
    assert_eq!(
        state(Some("archived"), true, short),
        RemoteControlState::Archived
    );
    assert_eq!(
        state(Some("requires_action"), true, short),
        RemoteControlState::Waiting
    );
    assert_eq!(
        state(Some("running"), false, long),
        RemoteControlState::Running
    );
    assert_eq!(
        state(Some("idle"), false, long),
        RemoteControlState::Offline
    );
    assert_eq!(state(None, false, long), RemoteControlState::Offline);
    assert_eq!(
        state(Some("idle"), false, short),
        RemoteControlState::Running
    );
    assert_eq!(state(Some("idle"), true, long), RemoteControlState::Running);
}

#[test]
fn sending_fails_with_what_claude_code_said() {
    let line = |value: Value| value.to_string().into_bytes();
    assert_eq!(
        sent(
            &[line(json!({"ok": true, "session_id": "session_1"}))],
            None
        ),
        Ok(())
    );
    let archived = json!({"ok": false, "error": "cloud session session_1 is archived and cannot accept new messages"});
    let failure = sent(&[line(archived)], None).unwrap_err();
    assert_eq!(failure.failure, FailureKind::VendorError);
    assert_eq!(
        failure.message,
        "This Claude Remote Control session is archived, so it can't take new messages"
    );
    let refused = json!({"ok": false, "error": "failed to send"});
    assert_eq!(
        sent(&[line(refused)], None).unwrap_err().message,
        "Claude Code couldn't send the message: failed to send"
    );
    let signed_out = sent(&[], Some("Not logged in · Please run /login")).unwrap_err();
    assert_eq!(signed_out.failure, FailureKind::NotSignedIn);
    assert_eq!(
        sent(&[b"not json".to_vec()], Some("")).unwrap_err().message,
        "Claude Code couldn't send the message: Claude Code printed no answer"
    );
}

/// A session's transcript in pages of [`FAKE_PAGE`] entries, which each message sent adds the
/// next scripted turn to.
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<FakeState>>);

#[derive(Default)]
struct FakeState {
    entries: Vec<Value>,
    /// What each message sent adds after itself, in order.
    turns: Vec<Vec<Value>>,
    sent: Vec<String>,
    refuse: Option<Failure>,
    status: Option<String>,
    /// What each page read adds to the transcript first, one item per read: nothing for `None`.
    drip: VecDeque<Option<Value>>,
    /// Sending never ends.
    hang: bool,
    /// Every page read fails with this.
    unreadable: Option<String>,
    /// How many times the status was read.
    statuses: usize,
}

const FAKE_PAGE: usize = 2;

impl Cloud for Fake {
    async fn send(&mut self, text: &str) -> Result<(), Failure> {
        if self.0.lock().unwrap().hang {
            std::future::pending::<()>().await;
        }
        let mut state = self.0.lock().unwrap();
        if let Some(failure) = state.refuse.clone() {
            return Err(failure);
        }
        state.sent.push(text.to_owned());
        if !state.turns.is_empty() {
            let turn = state.turns.remove(0);
            state.entries.extend(turn);
        }
        Ok(())
    }

    #[expect(clippy::unused_async_trait_impl, reason = "the fake answers at once")]
    async fn page(&mut self, cursor: Option<&str>) -> Result<Page, String> {
        let mut state = self.0.lock().unwrap();
        if let Some(error) = state.unreadable.clone() {
            return Err(error);
        }
        if let Some(Some(entry)) = state.drip.pop_front() {
            state.entries.push(entry);
        }
        let index: usize = cursor.map_or(0, |cursor| cursor.parse().unwrap());
        let start = (index * FAKE_PAGE).min(state.entries.len());
        let end = (start + FAKE_PAGE).min(state.entries.len());
        let next = (state.entries.len() > end).then(|| (index + 1).to_string());
        Ok(Page {
            entries: state.entries[start..end].to_vec(),
            next,
        })
    }

    #[expect(clippy::unused_async_trait_impl, reason = "the fake answers at once")]
    async fn status(&mut self) -> Result<Option<String>, String> {
        let mut state = self.0.lock().unwrap();
        state.statuses += 1;
        Ok(state.status.clone())
    }
}

/// Runs a driver on `fake` with `prompt`, after `before` is done to its handle, to its end.
async fn run(fake: &Fake, prompt: &str, before: impl FnOnce(&RunHandle)) -> Vec<Event> {
    let switch = CancelSwitch::new();
    let (handle, follow_ups) = RunHandle::new(RunId::generate(), true, switch.clone());
    before(&handle);
    let (sink, mut stream) = EventSink::channel(64, Vec::new());
    let driver = Driver::new(
        fake.clone(),
        "session_1".into(),
        sink,
        switch,
        follow_ups,
        handle.held(),
    )
    .with_poll(Duration::from_millis(5));
    let task = tokio::spawn(driver.run(Some(TurnId::generate()), prompt.to_owned()));
    let mut events = Vec::new();
    let collect = async {
        while let Some(event) = stream.next().await {
            events.push(event);
        }
    };
    tokio::time::timeout(Duration::from_secs(10), collect)
        .await
        .expect("the run ended");
    task.await.unwrap();
    drop(handle);
    events
}

fn follow_up(text: &str) -> FollowUp {
    FollowUp {
        turn_id: TurnId::generate(),
        text: text.to_owned(),
        images: Vec::new(),
        steer: false,
        model: None,
        permission: None,
    }
}

#[tokio::test]
async fn a_turn_shows_only_what_follows_the_message_and_ends_on_end_turn() {
    let fake = Fake::default();
    {
        let mut state = fake.0.lock().unwrap();
        // Three entries from before, over two pages, which the run skips.
        state.entries = vec![user("earlier"), reply("Earlier reply."), user("later")];
        state.status = Some("running".into());
        state.turns = vec![vec![
            user("Run the tests"),
            assistant(
                "msg_1",
                &json!({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cargo test"}}),
                "tool_use",
            ),
            json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
            ]}}),
            assistant(
                "msg_2",
                &json!({"type": "thinking", "thinking": "They pass."}),
                "end_turn",
            ),
            assistant(
                "msg_2",
                &json!({"type": "text", "text": "All pass."}),
                "end_turn",
            ),
        ]];
    }
    let events = run(&fake, "Run the tests", |_| {}).await;
    assert_eq!(fake.0.lock().unwrap().sent, ["Run the tests"]);
    let shown: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            Event::SessionStarted { session_id, .. } => Some(format!("session {session_id}")),
            Event::TurnStarted { .. } => Some("turn".into()),
            Event::ToolCall { name, .. } => Some(format!("call {name}")),
            Event::ToolResult { status, output, .. } => {
                assert_eq!(*status, ToolStatus::Ok);
                Some(format!("result {}", output.as_deref().unwrap_or_default()))
            }
            Event::Reasoning { text, .. } => Some(format!("thinking {text}")),
            Event::Text { text, .. } => Some(format!("text {text}")),
            Event::TurnFinished { result, failed, .. } => {
                assert!(!failed);
                Some(format!("done {}", result.as_deref().unwrap_or_default()))
            }
            Event::Finished { outcome, .. } => Some(format!("finished {outcome:?}")),
            _ => None,
        })
        .collect();
    assert_eq!(
        shown,
        [
            "session session_1",
            "turn",
            "call Bash",
            "result ok",
            "thinking They pass.",
            "text All pass.",
            "done All pass.",
            "finished Completed { result: Some(\"All pass.\") }",
        ]
    );
}

#[tokio::test]
async fn an_earlier_turn_ending_after_the_message_went_does_not_end_its_turn() {
    let fake = Fake::default();
    fake.0.lock().unwrap().turns = vec![vec![
        reply("The earlier turn's end."),
        user("Now the docs"),
        reply("Docs done."),
    ]];
    let events = run(&fake, "Now the docs", |_| {}).await;
    let results: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::TurnFinished { result, .. } => Some(result.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(results, [Some("Docs done.".to_owned())]);
}

#[tokio::test]
async fn a_follow_up_goes_once_the_turn_ends() {
    let fake = Fake::default();
    fake.0.lock().unwrap().turns = vec![
        vec![user("one"), reply("First.")],
        vec![user("two"), reply("Second.")],
    ];
    let events = run(&fake, "one", |handle| {
        handle.send(follow_up("two")).unwrap();
    })
    .await;
    assert_eq!(fake.0.lock().unwrap().sent, ["one", "two"]);
    let finished = events
        .iter()
        .filter(|event| matches!(event, Event::TurnFinished { .. }))
        .count();
    assert_eq!(finished, 2);
}

#[tokio::test]
async fn an_archived_session_fails_the_turn_and_says_so() {
    let fake = Fake::default();
    fake.0.lock().unwrap().refuse = Some(Failure::new(
        FailureKind::VendorError,
        "This Claude Remote Control session is archived, so it can't take new messages".into(),
    ));
    let events = run(&fake, "hello", |_| {}).await;
    assert!(events.contains(&Event::RemoteControl {
        state: RemoteControlState::Archived
    }));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::TurnFinished { failed: true, .. }))
    );
    let Some(Event::Finished {
        outcome: Outcome::Failed(failure),
        ..
    }) = events.last()
    else {
        panic!("expected a failure: {events:?}");
    };
    assert!(failure.message.contains("archived"));
}

#[tokio::test]
async fn stop_only_stops_following_the_turn() {
    let fake = Fake::default();
    let switch = CancelSwitch::new();
    let (handle, follow_ups) = RunHandle::new(RunId::generate(), true, switch.clone());
    let (sink, mut stream) = EventSink::channel(64, Vec::new());
    let driver = Driver::new(
        fake.clone(),
        "session_1".into(),
        sink,
        switch,
        follow_ups,
        handle.held(),
    )
    .with_poll(Duration::from_millis(5));
    tokio::spawn(driver.run(None, "never answered".to_owned()));
    // Its turn started, and nothing answers it.
    while !matches!(stream.next().await, Some(Event::TurnStarted { .. })) {}
    handle.cancel();
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event);
    }
    assert!(events.iter().any(
        |event| matches!(event, Event::Notice { detail } if detail.contains("keeps working"))
    ));
    assert!(matches!(
        events.last(),
        Some(Event::Finished {
            outcome: Outcome::Cancelled,
            ..
        })
    ));
}

fn thinking(text: &str, stop: &str) -> Value {
    assistant(
        "msg_end",
        &json!({"type": "thinking", "thinking": text}),
        stop,
    )
}

#[test]
fn any_final_stop_reason_ends_a_turn_and_thinking_alone_waits_for_its_text() {
    for stop in ["end_turn", "stop_sequence", "max_tokens", "refusal"] {
        let text = assistant("m", &json!({"type": "text", "text": "x"}), stop);
        assert_eq!(
            entry(&text),
            Entry::Work {
                end: Some(End::Reply)
            },
            "{stop}"
        );
    }
    for stop in ["tool_use", "pause_turn"] {
        let call = assistant(
            "m",
            &json!({"type": "tool_use", "id": "t", "name": "Bash"}),
            stop,
        );
        assert_eq!(entry(&call), Entry::Work { end: None }, "{stop}");
    }
    let streaming =
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}});
    assert_eq!(entry(&streaming), Entry::Work { end: None });
    assert_eq!(
        entry(&thinking("Done.", "end_turn")),
        Entry::Work {
            end: Some(End::Thinking)
        }
    );
    assert_eq!(
        entry(&user("[Request interrupted by user]")),
        Entry::Interrupted
    );
    let tool_interrupt = json!({"type": "user", "message": {"content": [
        {"type": "text", "text": "[Request interrupted by user for tool use]"},
    ]}});
    assert_eq!(entry(&tool_interrupt), Entry::Interrupted);
}

#[test]
fn a_turn_ends_after_its_message_on_a_reply_an_interrupt_or_idle() {
    let reply = Entry::Work {
        end: Some(End::Reply),
    };
    let thinking = Entry::Work {
        end: Some(End::Thinking),
    };
    // An earlier turn's end, before the message, ends nothing.
    let mut turn = Turn::default();
    assert!(!turn.read(&[reply, Entry::Prompt]));
    assert!(!turn.read(&[]));
    // A reply ends it on the next quiet read.
    assert!(!turn.read(&[Entry::Work { end: None }, reply]));
    assert!(turn.read(&[]));

    // Thinking alone waits three quiet reads, and its text, coming late, ends it on one.
    let mut turn = Turn::default();
    assert!(!turn.read(&[Entry::Prompt, thinking]));
    assert!(!turn.read(&[]));
    assert!(!turn.read(&[reply]));
    assert!(turn.read(&[]));
    let mut turn = Turn::default();
    turn.read(&[Entry::Prompt, thinking]);
    assert!(!turn.read(&[]));
    assert!(!turn.read(&[]));
    assert!(turn.read(&[]));

    let mut turn = Turn::default();
    turn.read(&[Entry::Prompt, Entry::Work { end: None }, Entry::Interrupted]);
    assert!(turn.read(&[]));

    // `idle` ends it only once the message reached the session.
    let mut turn = Turn::default();
    assert!(!turn.idle(Some("idle")));
    turn.read(&[Entry::Prompt]);
    assert!(turn.idle(Some("idle")));
    assert!(!turn.idle(Some("running")));
}

#[test]
fn a_signed_out_read_fails_at_once_and_others_after_five() {
    let signed_out = read_failure(SIGNED_OUT, 1).unwrap();
    assert_eq!(signed_out.failure, FailureKind::NotSignedIn);
    assert_eq!(
        read_failure("Claude Code stopped: Not logged in · Please run /login", 1)
            .unwrap()
            .failure,
        FailureKind::NotSignedIn
    );
    assert_eq!(read_failure("timed out", 4), None);
    assert_eq!(
        read_failure("timed out", 5).unwrap().failure,
        FailureKind::VendorError
    );
}

#[tokio::test]
async fn a_reply_whose_text_lands_a_read_after_its_thinking_keeps_the_text() {
    let fake = Fake::default();
    {
        let mut state = fake.0.lock().unwrap();
        state.turns = vec![vec![user("Wrap up"), thinking("Nothing left.", "end_turn")]];
        // The read before the send, then two reads, then the text.
        state.drip = [None, None, None, Some(reply("All done."))].into();
    }
    let events = run(&fake, "Wrap up", |_| {}).await;
    let results: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::TurnFinished { result, .. } => Some(result.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(results, [Some("All done.".to_owned())]);
}

#[tokio::test]
async fn a_turn_that_fails_on_max_tokens_or_goes_idle_with_no_end_still_ends() {
    let fake = Fake::default();
    fake.0.lock().unwrap().turns = vec![vec![
        user("Write it all"),
        assistant(
            "m",
            &json!({"type": "text", "text": "Cut off"}),
            "max_tokens",
        ),
    ]];
    let events = run(&fake, "Write it all", |_| {}).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::TurnFinished { failed: false, .. }))
    );

    // Interrupted from the Claude app with no entry that ends it: the session goes idle.
    let fake = Fake::default();
    {
        let mut state = fake.0.lock().unwrap();
        state.turns = vec![vec![user("Long job")]];
        state.status = Some("idle".into());
    }
    let events = run(&fake, "Long job", |_| {}).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::TurnFinished { failed: false, .. }))
    );
    assert!(matches!(
        events.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { .. },
            ..
        })
    ));
}

#[tokio::test]
async fn waiting_for_an_answer_stays_put_and_says_so_once() {
    let fake = Fake::default();
    {
        let mut state = fake.0.lock().unwrap();
        state.turns = vec![vec![
            user("Bump clap"),
            assistant(
                "m",
                &json!({"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}),
                "tool_use",
            ),
        ]];
        state.status = Some("requires_action".into());
    }
    let switch = CancelSwitch::new();
    let (handle, follow_ups) = RunHandle::new(RunId::generate(), true, switch.clone());
    let (sink, mut stream) = EventSink::channel(256, Vec::new());
    let driver = Driver::new(
        fake.clone(),
        "session_1".into(),
        sink,
        switch,
        follow_ups,
        handle.held(),
    )
    .with_poll(Duration::from_millis(2));
    tokio::spawn(driver.run(None, "Bump clap".to_owned()));
    let mut events = Vec::new();
    // Three status reads, each saying it waits, with no event between them once it waits.
    while fake.0.lock().unwrap().statuses < 3 {
        if let Ok(event) = tokio::time::timeout(Duration::from_millis(5), stream.next()).await {
            let event = event.unwrap();
            assert!(!matches!(event, Event::Finished { .. }), "ended early");
            events.push(event);
        }
    }
    handle.cancel();
    while let Some(event) = stream.next().await {
        events.push(event);
    }
    let states: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::RemoteControl { state } => Some(*state),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        [RemoteControlState::Running, RemoteControlState::Waiting]
    );
    let notices = events
        .iter()
        .filter(
            |e| matches!(e, Event::Notice { detail } if detail.contains("waiting for your answer")),
        )
        .count();
    assert_eq!(notices, 1);
}

#[tokio::test]
async fn stop_ends_a_send_that_hangs_at_once() {
    let fake = Fake::default();
    fake.0.lock().unwrap().hang = true;
    let switch = CancelSwitch::new();
    let (handle, follow_ups) = RunHandle::new(RunId::generate(), true, switch.clone());
    let (sink, mut stream) = EventSink::channel(64, Vec::new());
    let driver = Driver::new(
        fake.clone(),
        "session_1".into(),
        sink,
        switch,
        follow_ups,
        handle.held(),
    );
    tokio::spawn(driver.run(None, "hello".to_owned()));
    while !matches!(stream.next().await, Some(Event::TurnStarted { .. })) {}
    handle.cancel();
    let end = tokio::time::timeout(Duration::from_secs(2), async {
        let mut last = None;
        while let Some(event) = stream.next().await {
            last = Some(event);
        }
        last
    })
    .await
    .expect("Stop didn't wait for the send");
    assert!(matches!(
        end,
        Some(Event::Finished {
            outcome: Outcome::Cancelled,
            ..
        })
    ));
}

#[tokio::test]
async fn a_signed_out_claude_code_fails_the_run_as_not_signed_in() {
    let fake = Fake::default();
    fake.0.lock().unwrap().unreadable = Some(SIGNED_OUT.to_owned());
    let events = run(&fake, "hello", |_| {}).await;
    let Some(Event::Finished {
        outcome: Outcome::Failed(failure),
        ..
    }) = events.last()
    else {
        panic!("expected a failure: {events:?}");
    };
    assert_eq!(failure.failure, FailureKind::NotSignedIn);
    assert!(fake.0.lock().unwrap().sent.is_empty());
}
