use std::time::Duration;

use parallax_protocol::methods::{NotificationMethod, TerminalExit, TerminalOutput};
use parallax_protocol::{
    TerminalCommand, TerminalExitParams, TerminalOpenParams, TerminalOutputParams,
};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::{History, Terminals, chunks, take_text};
use crate::methods::Reply;

const PATIENCE: Duration = Duration::from_secs(20);

#[test]
fn history_keeps_the_last_lines_and_bytes_whole() {
    let mut lines = History::new(3, 1024);
    lines.push("one\ntwo\nthree\nfour\nfi");
    // The unfinished line counts, as in T3 Code.
    assert_eq!(lines.text(), "three\nfour\nfi");
    lines.push("ve\n");
    assert_eq!(lines.text(), "three\nfour\nfive\n");

    let mut bytes = History::new(100, 2);
    // Two bytes would start inside "é", so the cut moves past it, and past the line it ends.
    bytes.push("\néb");
    assert_eq!(bytes.text(), "b");
    assert_eq!(bytes.newlines, 0);
    bytes.push("\n");
    assert_eq!(bytes.text(), "b\n");
    assert_eq!(bytes.newlines, 1);
}

#[test]
fn text_waits_for_a_character_split_across_reads() {
    let mut pending = "aé".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "a");
    pending.extend_from_slice(&"é".as_bytes()[1..]);
    pending.extend_from_slice(b"\xffb");
    assert_eq!(take_text(&mut pending), "é\u{fffd}b");
    assert!(pending.is_empty());
}

#[test]
fn a_replay_is_cut_between_characters_and_never_empty() {
    assert_eq!(chunks("").collect::<Vec<_>>(), [""]);
    let long = "é".repeat(super::MAX_CHUNK);
    let parts: Vec<_> = chunks(&long).collect();
    assert_eq!(parts.concat(), long);
    assert!(parts.iter().all(|part| part.len() <= super::MAX_CHUNK));
}

/// Prints `ready`, then `got-` and the line it reads.
fn echo() -> TerminalCommand {
    let (program, script) = if cfg!(windows) {
        (
            "cmd.exe",
            "echo ready& set /p line=& echo got-%line%& set /p line=",
        )
    } else {
        ("sh", "echo ready; read line; echo got-$line; read line")
    };
    let flag = if cfg!(windows) { "/c" } else { "-c" };
    TerminalCommand {
        program: program.to_owned(),
        args: vec![flag.to_owned(), script.to_owned()],
        env: std::collections::BTreeMap::new(),
    }
}

fn open(command: Option<TerminalCommand>) -> TerminalOpenParams {
    TerminalOpenParams {
        thread_id: "t".to_owned(),
        terminal_id: "1".to_owned(),
        cwd: None,
        command,
        cols: 80,
        rows: 24,
    }
}

/// The next `terminal/output` (its text and whether it's a replay) or `terminal/exit` (`None`).
async fn next(replies: &mut mpsc::Receiver<Reply>) -> Option<(String, bool)> {
    let Some(Reply::Notification(message)) = timeout(PATIENCE, replies.recv()).await.unwrap()
    else {
        panic!("expected a notification");
    };
    if message.method == TerminalExit::NAME {
        message.params::<TerminalExitParams>().unwrap();
        return None;
    }
    assert_eq!(message.method, TerminalOutput::NAME);
    let output: TerminalOutputParams = message.params().unwrap();
    Some((output.data, output.replay))
}

/// Reads output until it has shown `text`.
async fn until(replies: &mut mpsc::Receiver<Reply>, text: &str) {
    let mut shown = String::new();
    while !shown.contains(text) {
        let (data, _) = next(replies).await.expect("it exited first");
        shown.push_str(&data);
    }
}

#[tokio::test]
async fn opening_again_replays_the_history_then_streams_to_both() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let (first_tx, mut first) = mpsc::channel(256);
    terminals
        .open(open(Some(echo())), &first_tx, &stopped)
        .unwrap();
    // The first output is always the history, even when empty.
    let (history, replay) = next(&mut first).await.unwrap();
    assert!(replay);
    if !history.contains("ready") {
        until(&mut first, "ready").await;
    }

    // Another client attaches to the same terminal, which doesn't start again.
    let (second_tx, mut second) = mpsc::channel(256);
    terminals.open(open(None), &second_tx, &stopped).unwrap();
    let (history, replay) = next(&mut second).await.unwrap();
    assert!(replay);
    assert!(history.contains("ready"), "{history:?}");

    terminals.write("t".to_owned(), "1".to_owned(), "you\r".to_owned());
    until(&mut first, "got-you").await;
    until(&mut second, "got-you").await;
    assert_eq!(terminals.list(Some("t")).len(), 1);

    // Archiving its thread closes it, and both see it exit.
    terminals.close_thread("t");
    for replies in [&mut first, &mut second] {
        while next(replies).await.is_some() {}
    }
    assert!(terminals.list(None).is_empty());
}

#[tokio::test]
async fn a_command_ends_with_the_connection_that_opened_it() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let (replies, mut output) = mpsc::channel(256);
    terminals
        .open(open(Some(echo())), &replies, &stopped)
        .unwrap();
    until(&mut output, "ready").await;

    stopped.cancel();
    timeout(PATIENCE, async {
        while !terminals.list(None).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the command ended");
}
