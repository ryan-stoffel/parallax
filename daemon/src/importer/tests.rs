use parallax_protocol::ImportSource;

use super::{Message, Session, claude_messages, run_id};

fn user(text: &str) -> Message {
    Message::User(text.to_owned())
}

fn agent(text: &str) -> Message {
    Message::Agent(text.to_owned())
}

#[test]
fn a_claude_transcript_keeps_the_conversation_and_drops_tools_notes_and_subagents() {
    let jsonl = [
        r#"{"type":"queue-operation"}"#,
        r#"{"type":"user","message":{"content":"Fix the login redirect"}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1"}]}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#,
        r#"{"type":"user","isMeta":true,"message":{"content":"Another session sent a message"}}"#,
        r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"}]}}"#,
        r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
        "not json",
        r#"{"type":"user","message":{"content":[{"type":"text","text":"Now add a test"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Added."}]}}"#,
    ]
    .join("\n");
    assert_eq!(
        claude_messages(&jsonl),
        [
            user("Fix the login redirect"),
            agent("Looking."),
            user("Now add a test"),
            agent("Added.")
        ]
    );
}

#[test]
fn a_session_imports_under_one_run_id() {
    let session = |id: &str| Session {
        source: ImportSource::Claude,
        id: id.to_owned(),
        title: String::new(),
        cwd: None,
        started: jiff::Timestamp::from_millisecond(1_790_637_319_905).unwrap(),
        updated: jiff::Timestamp::UNIX_EPOCH,
        resume: None,
    };
    let id = run_id(&session("local_1")).unwrap();
    assert_eq!(run_id(&session("local_1")), Some(id));
    assert_ne!(run_id(&session("local_2")), Some(id));
    let other_app = Session {
        source: ImportSource::Codex,
        ..session("local_1")
    };
    assert_ne!(run_id(&other_app), Some(id));
}
