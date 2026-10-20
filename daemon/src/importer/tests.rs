use std::collections::HashMap;

use parallax_protocol::{AgentOutputItem, ImportSource};
use rusqlite::Connection;

use super::{
    Homes, Message, Session, claude_messages, claude_session, codex_messages, codex_session,
    codex_titles, cursor_messages, cursor_sessions, run_id, transcript,
};

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
fn a_claude_desktop_record_names_its_folder_and_cli_session() {
    let record = r#"{"sessionId":"local_1","cliSessionId":"c56a","cwd":"/src/web","title":"Fix it",
        "createdAt":1790637319905,"lastActivityAt":1790692657774}"#;
    let session = claude_session(record).unwrap();
    assert_eq!(session.id, "local_1");
    assert_eq!(session.title, "Fix it");
    assert_eq!(session.cwd.as_deref(), Some("/src/web"));
    assert_eq!(session.resume.as_deref(), Some("c56a"));
    assert_eq!(session.updated.as_millisecond(), 1_790_692_657_774);
    // With no CLI session there's no transcript to import.
    assert!(claude_session(r#"{"sessionId":"local_2","createdAt":1}"#).is_none());
}

fn meta(originator: &str, source: &str) -> String {
    format!(
        r#"{{"type":"session_meta","payload":{{"id":"01a0f32e","timestamp":"2026-09-30T16:38:23Z","cwd":"/hw2","originator":"{originator}","source":{source}}}}}"#
    )
}

const CODEX_TURNS: &str = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"AGENTS.md instructions"}]}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"do I have the HW2 pdf\n"}]}}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":"ls"}}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"Yes, in Homework/HW2."}]}}}
{"type":"event_msg","payload":{"type":"user_message","message":"Zip it"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Done."}}"#;

#[test]
fn a_codex_rollout_from_the_desktop_app_is_a_session_titled_by_the_index() {
    let rollout = format!("{}\n{CODEX_TURNS}", meta("Codex Desktop", r#""vscode""#));
    let titles = codex_titles(
        "{\"id\":\"01a0f32e\",\"thread_name\":\"Old name\"}\n{\"id\":\"01a0f32e\",\"thread_name\":\"Finish HW2\"}\n",
    );
    let session = codex_session(rollout.as_bytes(), &titles).unwrap();
    assert_eq!(session.title, "Finish HW2");
    assert_eq!(session.resume.as_deref(), Some("01a0f32e"));
    assert_eq!(session.cwd.as_deref(), Some("/hw2"));
    // Untitled, it takes its first message.
    let untitled = codex_session(rollout.as_bytes(), &HashMap::new()).unwrap();
    assert_eq!(untitled.title, "do I have the HW2 pdf");
    assert_eq!(
        codex_messages(CODEX_TURNS),
        [
            user("do I have the HW2 pdf\n"),
            agent("Yes, in Homework/HW2."),
            user("Zip it"),
            agent("Done.")
        ]
    );
}

#[test]
fn codex_sessions_from_other_apps_and_subagents_are_left_out() {
    let titles = HashMap::new();
    for first in [
        meta("codex-tui", r#""vscode""#),
        meta("plxd", r#""vscode""#),
        meta(
            "Codex Desktop",
            r#"{"subagent":{"thread_spawn":{"parent_thread_id":"01a0"}}}"#,
        ),
    ] {
        let rollout = format!("{first}\n{CODEX_TURNS}");
        assert!(
            codex_session(rollout.as_bytes(), &titles).is_none(),
            "{first}"
        );
    }
}

#[test]
fn cursor_chats_list_with_their_messages_and_without_subagents_or_empty_drafts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.vscdb");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        r#"CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
        CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, isSubagent INTEGER);
        INSERT INTO composerHeaders VALUES ('sub', 1), ('a', 0);
        INSERT INTO cursorDiskKV VALUES
          ('composerData:a', '{"createdAt":1789655298523,"lastUpdatedAt":1789744019595,
             "workspaceIdentifier":{"uri":{"fsPath":"/dotfiles"}},
             "fullConversationHeadersOnly":[{"bubbleId":"b1","type":1},{"bubbleId":"b2","type":2},
               {"bubbleId":"b3","type":2},{"bubbleId":"b4","type":1}]}'),
          ('bubbleId:a:b1', '{"type":1,"text":"Audit my setup\nbefore the upgrade"}'),
          ('bubbleId:a:b2', '{"type":2,"text":""}'),
          ('bubbleId:a:b3', '{"type":2,"text":"Everything is fine."}'),
          ('bubbleId:a:b4', '{"type":1,"text":"Thanks"}'),
          ('composerData:sub', '{"createdAt":1,"fullConversationHeadersOnly":[{"bubbleId":"x","type":1}]}'),
          ('composerData:draft', '{"createdAt":1,"fullConversationHeadersOnly":[]}');"#,
    )
    .unwrap();
    drop(db);
    let homes = Homes {
        claude_app: None,
        claude: None,
        codex: None,
        cursor: Some(path.clone()),
    };
    let sessions = cursor_sessions(&homes).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "a");
    assert_eq!(sessions[0].title, "Audit my setup");
    assert_eq!(sessions[0].cwd.as_deref(), Some("/dotfiles"));
    assert_eq!(
        cursor_messages(&path, "a").unwrap(),
        [
            user("Audit my setup\nbefore the upgrade"),
            agent("Everything is fine."),
            user("Thanks")
        ]
    );
}

#[test]
fn a_transcript_starts_with_the_first_message_and_takes_a_turn_per_follow_up() {
    let messages = [
        agent("Hello"),
        user("Fix it"),
        agent("Fixed."),
        user("Thanks"),
        agent("Sure."),
    ];
    let (prompt, events) = transcript(ImportSource::Codex, &messages).unwrap();
    assert_eq!(prompt, "Fix it");
    let items: Vec<_> = events.into_iter().flatten().collect();
    let kinds: Vec<&str> = items
        .iter()
        .map(|item| match item {
            AgentOutputItem::Notice { .. } => "notice",
            AgentOutputItem::TurnStarted { turn_id: None, .. } => "prompt",
            AgentOutputItem::TurnStarted { .. } => "follow-up",
            AgentOutputItem::Text { .. } => "text",
            AgentOutputItem::TurnFinished { .. } => "finished",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "notice",
            "prompt",
            "text",
            "finished",
            "follow-up",
            "text",
            "finished"
        ]
    );
    let AgentOutputItem::TurnStarted {
        turn_id: Some(turn),
        text,
        ..
    } = &items[4]
    else {
        panic!("not a follow-up: {:?}", items[4]);
    };
    assert_eq!(text.as_deref(), Some("Thanks"));
    assert!(
        matches!(&items[6], AgentOutputItem::TurnFinished { turn_id: Some(t), .. } if t == turn)
    );
    assert!(transcript(ImportSource::Codex, &[agent("only me")]).is_none());
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
