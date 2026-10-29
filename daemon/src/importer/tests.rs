use parallax_protocol::ImportSource;

use std::fs;

use super::{Message, Session, claude_messages, claude_remote_session, clone_path, run_id};

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

#[test]
fn a_claude_code_session_lists_only_when_it_ran_with_remote_control() {
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, lines: &[&str]| {
        let path = dir.path().join(name);
        fs::write(&path, lines.join("\n")).unwrap();
        path
    };
    let start = r#"{"type":"user","entrypoint":"cli","cwd":"/src/web","timestamp":"2026-10-20T10:00:00Z","message":{"content":"Fix the login redirect\nand more"}}"#;
    let reply = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."}]}}"#;

    let bridged = write(
        "a.jsonl",
        &[
            start,
            r#"{"type":"bridge-session","sessionId":"a","bridgeSessionId":"session_01X","lastSequenceNum":3}"#,
            reply,
            r#"{"type":"ai-title","aiTitle":"Login redirect","sessionId":"a"}"#,
        ],
    );
    let session = claude_remote_session(&bridged).unwrap();
    assert_eq!(session.id, "a");
    assert_eq!(session.resume.as_deref(), Some("a"));
    assert_eq!(session.title, "Login redirect");
    assert_eq!(session.cwd.as_deref(), Some("/src/web"));
    assert_eq!(session.started, "2026-10-20T10:00:00Z".parse().unwrap());

    // Remote Control turned off before it connected names no claude.ai session.
    let cleared = write(
        "b.jsonl",
        &[
            start,
            r#"{"type":"bridge-session","sessionId":"b","bridgeSessionId":"","lastSequenceNum":0}"#,
        ],
    );
    assert_eq!(claude_remote_session(&cleared), None);
    assert_eq!(
        claude_remote_session(&write("c.jsonl", &[start, reply])),
        None
    );

    // A session `claude remote-control` served keeps its claude.ai sync point beside it, and a
    // name set with /rename wins.
    let served = write(
        "d.jsonl",
        &[
            &start.replace(r#""cli""#, r#""sdk-cli""#),
            r#"{"type":"custom-title","customTitle":"Ship it","sessionId":"d"}"#,
        ],
    );
    fs::create_dir(dir.path().join("d")).unwrap();
    fs::write(dir.path().join("d/ccr-tip.json"), r#"{"eventId":"e1"}"#).unwrap();
    assert_eq!(claude_remote_session(&served).unwrap().title, "Ship it");

    // An Agent SDK app's transcript isn't read through.
    let sdk = write(
        "e.jsonl",
        &[
            &start.replace(r#""cli""#, r#""sdk-ts""#),
            r#"{"type":"bridge-session","sessionId":"e","bridgeSessionId":"session_01Y","lastSequenceNum":1}"#,
        ],
    );
    assert_eq!(claude_remote_session(&sdk), None);
}

/// A `claude.ai` session's repository goes in the same folder under the home folder as on its
/// own computer when that folder is the repository, else straight under the home folder (PLX-1136).
#[test]
fn a_remote_sessions_repository_is_cloned_where_it_was_or_under_home() {
    let at = |cwd| clone_path("learn-rust", cwd);
    assert_eq!(
        at(Some("/Users/ryan-stoffel/Developer/personal/learn-rust")),
        "~/Developer/personal/learn-rust"
    );
    assert_eq!(
        at(Some("C:\\Users\\ryan\\life\\projects\\learn-rust")),
        "~/life/projects/learn-rust"
    );
    assert_eq!(at(Some("/home/ryan/learn-rust")), "~/learn-rust");
    // A worktree `claude remote-control --spawn worktree` made, or a folder not named for it.
    assert_eq!(
        at(Some("/Users/ryan/learn-rust/.claude/worktrees/bright-fox")),
        "~/learn-rust"
    );
    assert_eq!(at(Some("/Users/ryan/.hidden/learn-rust")), "~/learn-rust");
    assert_eq!(at(Some("/srv/learn-rust")), "~/learn-rust");
    assert_eq!(at(None), "~/learn-rust");
}
