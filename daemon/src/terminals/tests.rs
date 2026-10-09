use std::time::Duration;

use parallax_protocol::methods::{NotificationMethod, TerminalExit, TerminalOutput};
use parallax_protocol::{
    TerminalCommand, TerminalExitParams, TerminalOpenParams, TerminalOutputParams,
};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::{History, Terminals, chunks, take_text, without_queries};
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

#[test]
fn a_replay_leaves_out_queries_and_replies_but_keeps_the_rest() {
    let output = concat!(
        "\x1b[6n\x1b[1;1R",                         // cursor position, and its reply
        "\x1b[c\x1b[>c\x1b[?1;2c",                  // device attributes
        "\x1b]11;?\x07\x1b]10;rgb:ff/ff/ff\x1b\\",  // colors
        "\x1bP$qm\x1b\\\x1b[?2026$p\x1b[>q\x1b[?u", // setting, mode, version, keyboard
        "\x1b[31mred\x1b[0m \x1b[2J\x1b[u\x1b]0;title\x07$ ",
    );
    let mut history = History::new(100, 1024);
    history.push(output);
    assert_eq!(
        without_queries(&history.text()),
        "\x1b[31mred\x1b[0m \x1b[2J\x1b[u\x1b]0;title\x07$ "
    );
    // An unfinished sequence at the end stays as it is.
    assert_eq!(without_queries("$ \x1b[6"), "$ \x1b[6");
}

/// Prints `ready`, then `got-` and the line it reads. cmd.exe expands `!line!` when it runs
/// (`/v:on`), where `%line%` would be expanded with the whole line, before `set /p` reads it.
fn echo() -> TerminalCommand {
    let args: &[&str] = if cfg!(windows) {
        &[
            "/v:on",
            "/c",
            "echo ready& set /p line=& echo got-!line!& set /p line=",
        ]
    } else {
        &["-c", "echo ready; read line; echo got-$line; read line"]
    };
    TerminalCommand {
        program: if cfg!(windows) { "cmd.exe" } else { "sh" }.to_owned(),
        args: args.iter().map(|&arg| arg.to_owned()).collect(),
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
    timeout(PATIENCE, receive(replies))
        .await
        .expect("no notification came")
}

/// [`next`] with no time limit.
async fn receive(replies: &mut mpsc::Receiver<Reply>) -> Option<(String, bool)> {
    let Some(Reply::Notification(message)) = replies.recv().await else {
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
    let read = async {
        while !shown.contains(text) {
            let (data, _) = receive(replies).await.expect("it exited first");
            shown.push_str(&data);
        }
    };
    let showed = timeout(PATIENCE, read).await.is_ok();
    assert!(showed, "{text:?} never showed; it printed {shown:?}");
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
        let mut shown = String::new();
        let read = async {
            while let Ok(Some(Reply::Notification(message))) =
                timeout(PATIENCE, replies.recv()).await
            {
                if message.method == TerminalExit::NAME {
                    return true;
                }
                shown.push_str(&message.params::<TerminalOutputParams>().unwrap().data);
            }
            false
        };
        let exited = read.await;
        let running = terminals.list(None);
        assert!(
            exited,
            "no exit after closing; it printed {shown:?}; running {running:?}"
        );
    }
    assert!(terminals.list(None).is_empty());
}

#[tokio::test]
async fn detaching_stops_one_connections_stream_and_keeps_the_terminal() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let (first_tx, mut first) = mpsc::channel(256);
    let (second_tx, mut second) = mpsc::channel(256);
    // A shell: a command can't be detached.
    terminals.open(open(None), &first_tx, &stopped).unwrap();
    assert!(next(&mut first).await.unwrap().1);
    terminals.open(open(None), &second_tx, &stopped).unwrap();
    assert!(next(&mut second).await.unwrap().1);

    terminals.detach("t".to_owned(), "1".to_owned(), &first_tx);
    terminals.write("t".to_owned(), "1".to_owned(), "echo got-you\r".to_owned());
    until(&mut second, "got-you").await;
    let mut detached = String::new();
    while let Ok(Reply::Notification(message)) = first.try_recv() {
        detached.push_str(&message.params::<TerminalOutputParams>().unwrap().data);
    }
    assert!(!detached.contains("got-you"), "{detached:?}");

    // It still runs, and opening it again replays what the detached connection missed.
    terminals.open(open(None), &first_tx, &stopped).unwrap();
    let (history, replay) = next(&mut first).await.unwrap();
    assert!(replay);
    assert!(history.contains("got-you"), "{history:?}");
    terminals.close_thread("t");
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

    // A detach leaves a command's stream, which ends it with the connection.
    terminals.detach("t".to_owned(), "1".to_owned(), &replies);
    stopped.cancel();
    timeout(PATIENCE, async {
        while !terminals.list(None).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the command ended");
}

#[test]
fn a_script_s_exit_line_is_read_once_it_ends_and_never_from_the_echo() {
    let sentinel = "__PLX_SCRIPT_DONE_abc__";
    // The shell echoes what was typed: there the sentinel is followed by a format, not digits.
    let echo = format!("$ ( false\r\n> ); printf '\\n{sentinel}%s\\n' \"$?\"\r\n");
    assert_eq!(super::script_exit(&echo, sentinel), None);
    assert_eq!(
        super::script_exit(&format!("{echo}\r\n{sentinel}1"), sentinel),
        None
    );
    assert_eq!(
        super::script_exit(&format!("{echo}\r\n{sentinel}127\r\n$ "), sentinel),
        Some(127)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_script_reports_its_exit_code_and_its_shell_stays_open() {
    let terminals = Terminals::default();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let env = [("PARALLAX_WORKTREE_PATH", cwd)];
    let ok = terminals
        .run_script(
            "t",
            "setup-ok",
            cwd,
            "echo \"$PARALLAX_WORKTREE_PATH\" > out.txt",
            &env,
        )
        .unwrap();
    assert_eq!(timeout(PATIENCE, ok).await.unwrap(), Some(0));
    let written = std::fs::read_to_string(dir.path().join("out.txt")).unwrap();
    assert_eq!(written.trim(), cwd);

    let failed = terminals
        .run_script("t", "setup-fail", cwd, "echo failing\nexit 3", &[])
        .unwrap();
    assert_eq!(timeout(PATIENCE, failed).await.unwrap(), Some(3));
    // The shell outlives the script, for a look at what failed.
    assert_eq!(terminals.list(Some("t")).len(), 2);
    terminals.close_thread("t");
}

#[test]
fn a_script_is_wrapped_for_the_shell_the_terminal_runs() {
    let posix = super::wrap_script("make\nmake test", "S", "/bin/zsh");
    assert_eq!(posix, "( make\rmake test\r); printf '\\nS%s\\n' \"$?\"");
    let fish = super::wrap_script("make", "S", "/opt/homebrew/bin/fish");
    assert_eq!(fish, "begin\rmake\rend; printf '\\nS%s\\n' $status");
    for shell in [
        "powershell.exe",
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        "/usr/bin/pwsh",
    ] {
        let wrapped = super::wrap_script("exit 3", "S", shell);
        assert!(wrapped.contains("& {\rexit 3\r};"), "{wrapped}");
        assert!(wrapped.ends_with("Write-Host \"S$__plxc\""), "{wrapped}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_clean_exit_keeps_a_terminal_where_something_it_started_still_runs() {
    let terminals = Terminals::default();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let server = terminals
        .run_script("t", "setup-server", cwd, "sleep 30 > /dev/null 2>&1 &", &[])
        .unwrap();
    assert_eq!(timeout(PATIENCE, server).await.unwrap(), Some(0));
    terminals.close_idle("t", "setup-server");
    assert_eq!(terminals.list(Some("t")).len(), 1, "the server still runs");
    terminals.close_thread("t");
}
