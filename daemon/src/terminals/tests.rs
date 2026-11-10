use std::time::Duration;

use parallax_protocol::methods::{NotificationMethod, TerminalExit, TerminalOutput};
use parallax_protocol::{
    TerminalCommand, TerminalExitParams, TerminalOpenParams, TerminalOutputParams,
};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
use super::{BATCH_WINDOW, PACE_BURST, PACE_BYTES_PER_SECOND, RELAY_CHUNK};
use super::{
    FLOOD_PAUSE, FLOOD_TAIL, History, QUEUE_BEHIND, Terminals, behind, flood_pause, flood_tail,
    unsent, without_queries,
};
use crate::methods::Reply;

const PATIENCE: Duration = Duration::from_secs(20);

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
        .open(open(Some(echo())), &first_tx, &stopped, false)
        .unwrap();
    // The first output is always the history, even when empty.
    let (history, replay) = next(&mut first).await.unwrap();
    assert!(replay);
    if !history.contains("ready") {
        until(&mut first, "ready").await;
    }

    // Another client attaches to the same terminal, which doesn't start again.
    let (second_tx, mut second) = mpsc::channel(256);
    terminals
        .open(open(None), &second_tx, &stopped, false)
        .unwrap();
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
async fn a_command_ends_with_the_connection_that_opened_it() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let (replies, mut output) = mpsc::channel(256);
    terminals
        .open(open(Some(echo())), &replies, &stopped, false)
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
fn a_floods_tail_starts_at_a_line_and_a_character() {
    let short = "a\nb\n";
    assert_eq!(flood_tail(short), short);

    let lines = "line\n".repeat(FLOOD_TAIL);
    let tail = flood_tail(&lines);
    assert!(tail.len() <= FLOOD_TAIL);
    assert!(tail.starts_with("line\n"));
    assert!(tail.ends_with("line\n"));

    // No line to start at, and the cut falls inside a three-byte character.
    let wide = "€".repeat(FLOOD_TAIL);
    assert!(flood_tail(&wide).len() <= FLOOD_TAIL);
    assert!(flood_tail(&wide).starts_with('€'));
}

#[test]
fn a_skip_sends_only_what_the_client_lacks() {
    let history = "seen\n".repeat(10) + "new";
    // What it's owed when that fits, and nothing it has.
    assert_eq!(unsent(&history, 3), "new");
    assert_eq!(unsent(&history, 0), "");
    // More than the history holds is all of it.
    assert_eq!(unsent(&history, 1 << 40), history);
    // More than a skip carries is the history's tail.
    let long = "line\n".repeat(FLOOD_TAIL);
    let owed = (2 * FLOOD_TAIL) as u64;
    assert_eq!(unsent(&long, owed), flood_tail(&long));
}

/// A connection's queue with `queued` messages in it.
fn queue(queued: usize) -> (mpsc::Sender<Reply>, mpsc::Receiver<Reply>) {
    let (replies, queue) = mpsc::channel(256);
    for _ in 0..queued {
        replies
            .try_send(Reply::Notification(super::notification::<TerminalExit>(
                TerminalExitParams {
                    thread_id: "t".to_owned(),
                    terminal_id: "1".to_owned(),
                    exit_code: 0,
                },
            )))
            .unwrap();
    }
    (replies, queue)
}

#[test]
fn a_connection_is_behind_past_its_queue_limit() {
    let (replies, mut queue) = queue(QUEUE_BEHIND + 1);
    assert!(behind(&replies));
    queue.try_recv().unwrap();
    assert!(!behind(&replies), "at the limit isn't behind");
    drop(queue);
    assert!(!behind(&replies), "a closed connection isn't behind");
}

#[tokio::test(start_paused = true)]
async fn a_floods_pause_ends_once_the_queue_is_back_under_its_limit_though_never_empty() {
    let (replies, mut queue) = queue(2 * QUEUE_BEHIND);
    let stopped = CancellationToken::new();
    let pause = tokio::spawn({
        let replies = replies.clone();
        async move { flood_pause(&replies, &stopped).await }
    });
    tokio::time::sleep(3 * FLOOD_PAUSE).await;
    assert!(!pause.is_finished(), "it ended while the client was behind");
    // The client reads until it isn't behind, but the queue never empties, as when another
    // terminal on the connection keeps printing.
    while behind(&replies) {
        queue.try_recv().unwrap();
    }
    assert!(replies.capacity() < replies.max_capacity());
    assert!(timeout(2 * FLOOD_PAUSE, pause).await.unwrap().unwrap());
}

/// `data` less its carriage returns. A macOS pseudo-terminal under load sometimes ends a line with
/// `\r\r\n`, writing the `\r` again when its output queue fills between the two.
#[cfg(unix)]
fn lines(data: &str) -> String {
    data.replace('\r', "")
}

/// Runs `script` in `sh`, over the relay.
#[cfg(unix)]
fn over_relay(
    terminals: &Terminals,
    script: &str,
    stopped: &CancellationToken,
) -> (mpsc::Sender<Reply>, mpsc::Receiver<Reply>) {
    let (replies, output) = mpsc::channel(256);
    let command = TerminalCommand {
        program: "sh".to_owned(),
        args: vec!["-c".to_owned(), script.to_owned()],
        env: std::collections::BTreeMap::new(),
    };
    terminals
        .open(open(Some(command)), &replies, stopped, true)
        .unwrap();
    (replies, output)
}

#[cfg(unix)]
#[tokio::test]
async fn output_over_the_relay_comes_in_batches_and_all_of_it_arrives() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let started = tokio::time::Instant::now();
    let script =
        "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; echo end; read line";
    let (_replies, mut output) = over_relay(&terminals, script, &stopped);
    let mut shown = String::new();
    let mut messages = 0_u128;
    while !shown.contains("end\n") {
        let (data, _) = next(&mut output).await.expect("it exited first");
        shown.push_str(&lines(&data));
        messages += 1;
    }
    let windows = started.elapsed().as_millis() / BATCH_WINDOW.as_millis();
    // The replay, and at most one message for each window and the one that starts them.
    assert!(messages <= windows + 3, "{messages} in {windows} windows");
    for i in 0..2000 {
        assert!(
            shown.contains(&format!("line-{i}\n")),
            "line {i} is missing"
        );
    }
    terminals.close_thread("t");
}

#[cfg(unix)]
#[tokio::test]
async fn output_over_the_relay_doesnt_pile_up_behind_a_slow_client() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let (replies, mut output) = over_relay(&terminals, "yes", &stopped);
    let waiting = || replies.max_capacity() - replies.capacity();
    // Nothing reads what's queued, as with a client slower than the pace, so it falls behind.
    let fell_behind = async {
        while !behind(&replies) {
            tokio::time::sleep(BATCH_WINDOW).await;
        }
    };
    timeout(PATIENCE, fell_behind)
        .await
        .expect("the flood never got ahead of the client");
    // What the stream was sending as the client fell behind is the last it queues: at most a
    // burst, which a busy machine's slower `yes` fits in one batch (PLX-1464), or a skip's tail.
    tokio::time::sleep(FLOOD_PAUSE).await;
    let queued = waiting();
    #[expect(clippy::cast_precision_loss, reason = "a few messages")]
    let fits = queued as f64 <= QUEUE_BEHIND as f64 + (PACE_BURST / RELAY_CHUNK as f64).ceil();
    assert!(fits, "{queued} messages queued");
    tokio::time::sleep(2 * FLOOD_PAUSE).await;
    assert_eq!(waiting(), queued, "more was queued behind a slow client");

    // It goes on once the client reads again, adding to what the client shows.
    let (_, replay) = next(&mut output).await.expect("it exited first");
    assert!(replay, "the first output is the history");
    for _ in 0..2 * queued {
        let (data, replay) = next(&mut output).await.expect("it exited first");
        assert!(!replay, "a skip replaced what the client shows");
        assert!(data.len() <= RELAY_CHUNK, "a {} byte message", data.len());
    }
    terminals.close_thread("t");
}

#[cfg(unix)]
#[tokio::test]
async fn a_flood_over_the_relay_is_skipped_and_typing_after_it_isnt() {
    let terminals = Terminals::default();
    let stopped = CancellationToken::new();
    let script = "yes | head -c 4194304; echo end; read line; echo got-$line; read line";
    let started = tokio::time::Instant::now();
    let (_replies, mut output) = over_relay(&terminals, script, &stopped);
    let mut shown = String::new();
    let mut replays = 0;
    let mut bytes = 0_usize;
    while !shown.contains("end\n") {
        let (data, replay) = next(&mut output).await.expect("it exited first");
        replays += usize::from(replay);
        bytes += data.len();
        shown.push_str(&lines(&data));
    }
    assert_eq!(replays, 1, "only the first output replays");
    // No more than the pace allows, however long a slow machine takes to print it, and the last
    // skip's tail, which it pays for after.
    let paced = PACE_BURST + PACE_BYTES_PER_SECOND * started.elapsed().as_secs_f64();
    #[expect(clippy::cast_precision_loss, reason = "a few MiB")]
    let (sent, tail) = (bytes as f64, FLOOD_TAIL as f64);
    assert!(
        sent <= paced + tail,
        "{bytes} of 4 MiB were sent in {:?}",
        started.elapsed()
    );

    // It paid for what it sent, so what's typed next goes as output, not after another skip's
    // pause.
    let typed = tokio::time::Instant::now();
    terminals.write("t".to_owned(), "1".to_owned(), "you\r".to_owned());
    let mut echoed = String::new();
    while !echoed.contains("got-you") {
        let (data, replay) = next(&mut output).await.expect("it exited first");
        assert!(!replay, "typing after a flood replayed");
        echoed.push_str(&data);
    }
    assert!(
        typed.elapsed() < FLOOD_PAUSE,
        "the echo took {:?}",
        typed.elapsed()
    );
    terminals.close_thread("t");
}
