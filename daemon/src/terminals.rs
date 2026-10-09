//! Terminals plxd owns (PLX-637), as T3 Code's server does: a pseudo-terminal per thread and
//! terminal id, with its recent output kept, so a terminal outlives the app that shows it and
//! works the same on every host.
//!
//! Each terminal has three threads: one reads what it prints, one writes what's typed in the order
//! it came, and one waits for its program to exit. What it prints is appended to its history and
//! broadcast under one lock, which `terminal/open` also takes to copy the history and subscribe, so
//! a client sees each byte exactly once.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use parallax_protocol::jsonrpc::{ErrorObject, INTERNAL_ERROR, INVALID_PARAMS, Notification};
use parallax_protocol::methods::{NotificationMethod, TerminalExit, TerminalOutput};
use parallax_protocol::{
    TerminalExitParams, TerminalKey, TerminalOpenParams, TerminalOutputParams,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, mpsc};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::methods::Reply;

/// The most lines a terminal keeps, as T3 Code does.
const MAX_LINES: usize = 5_000;
/// The most bytes a terminal keeps.
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// The most text one `terminal/output` carries, so even all-escapes output stays under the frame
/// limit once JSON escapes it.
const MAX_CHUNK: usize = 512 * 1024;
/// The output chunks a slow connection may fall behind by before it gets the history again.
const LAG: usize = 256;

type Key = (String, String);
type Open = Arc<Mutex<HashMap<Key, Arc<Terminal>>>>;

/// Every running terminal, by thread and terminal id.
#[derive(Default)]
pub(crate) struct Terminals {
    open: Open,
}

struct Terminal {
    key: Key,
    /// A program the client named, such as a sign-in, which ends with its connection.
    command: bool,
    shared: Mutex<Shared>,
    output: broadcast::Sender<Output>,
    input: std_mpsc::Sender<String>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// The connections it streams to, so opening it again on one replaces that stream.
    streams: Mutex<Vec<Stream>>,
}

/// A connection a terminal streams to, and the task that streams it.
type Stream = (mpsc::Sender<Reply>, AbortHandle);

/// What the reader, `terminal/open`, and the exit share.
struct Shared {
    history: History,
    /// Dropped once its program exits, which ends a Windows pseudo-console's output.
    master: Option<Box<dyn MasterPty + Send>>,
    exit: Option<i32>,
}

#[derive(Clone, Debug)]
enum Output {
    Data(Arc<str>),
    Exit(i32),
}

impl Terminals {
    /// `terminal/open`: attaches `replies`' connection to the running terminal with this key,
    /// resized, else starts one. Its output goes to `replies` until the terminal exits, the
    /// connection detaches it, or `stopped` (the connection closing), which also ends a command
    /// terminal.
    pub(crate) fn open(
        &self,
        params: TerminalOpenParams,
        replies: &mpsc::Sender<Reply>,
        stopped: &CancellationToken,
    ) -> Result<(), ErrorObject> {
        let key = (params.thread_id.clone(), params.terminal_id.clone());
        let size = PtySize {
            rows: params.rows.max(1),
            cols: params.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let terminal = {
            let mut open = lock(&self.open);
            if let Some(terminal) = open.get(&key) {
                terminal.resize(size);
                Arc::clone(terminal)
            } else {
                let terminal = start(key.clone(), params, size, Arc::clone(&self.open))?;
                open.insert(key, Arc::clone(&terminal));
                terminal
            }
        };
        let (output, history, exit) = terminal.subscribe();
        let stream = tokio::spawn(stream(
            Arc::clone(&terminal),
            replies.clone(),
            stopped.clone(),
            output,
            history,
            exit,
        ));
        terminal
            .detach(replies)
            .push((replies.clone(), stream.abort_handle()));
        Ok(())
    }

    /// `terminal/detach`: stops the terminal's stream to `replies`' connection. It keeps running
    /// and keeping its output, for the next `terminal/open`. A command keeps its stream, which
    /// ends it with its connection, so a close racing its open can't leave it running.
    pub(crate) fn detach(
        &self,
        thread_id: String,
        terminal_id: String,
        replies: &mpsc::Sender<Reply>,
    ) {
        let terminal = lock(&self.open).get(&(thread_id, terminal_id)).cloned();
        if let Some(terminal) = terminal.filter(|terminal| !terminal.command) {
            drop(terminal.detach(replies));
        }
    }

    /// `terminal/write`: queues `data` for the terminal's program, if it runs.
    pub(crate) fn write(&self, thread_id: String, terminal_id: String, data: String) {
        if let Some(terminal) = lock(&self.open).get(&(thread_id, terminal_id)) {
            let _ = terminal.input.send(data);
        }
    }

    /// `terminal/resize`.
    pub(crate) fn resize(&self, thread_id: String, terminal_id: String, cols: u16, rows: u16) {
        if let Some(terminal) = lock(&self.open).get(&(thread_id, terminal_id)) {
            terminal.resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// `terminal/close`: kills the terminal's program. Its exit reaches its connections.
    pub(crate) fn close(&self, thread_id: String, terminal_id: String) {
        let terminal = lock(&self.open).remove(&(thread_id, terminal_id));
        if let Some(terminal) = terminal {
            terminal.kill();
        }
    }

    /// Closes thread `thread_id`'s terminals, as its archive or delete does.
    pub(crate) fn close_thread(&self, thread_id: &str) {
        let mut open = lock(&self.open);
        let closed: Vec<Key> = open.keys().filter(|k| k.0 == thread_id).cloned().collect();
        for key in closed {
            if let Some(terminal) = open.remove(&key) {
                terminal.kill();
            }
        }
    }

    /// `terminal/list`: the running terminals, or one thread's, in no particular order.
    pub(crate) fn list(&self, thread_id: Option<&str>) -> Vec<TerminalKey> {
        lock(&self.open)
            .keys()
            .filter(|(thread, _)| thread_id.is_none_or(|id| id == thread))
            .map(|(thread_id, terminal_id)| TerminalKey {
                thread_id: thread_id.clone(),
                terminal_id: terminal_id.clone(),
            })
            .collect()
    }
}

impl Terminal {
    fn resize(&self, size: PtySize) {
        if let Some(master) = &lock(&self.shared).master
            && let Err(error) = master.resize(size)
        {
            debug!(%error, "couldn't resize a terminal");
        }
    }

    fn kill(&self) {
        if let Err(error) = lock(&self.killer).kill() {
            debug!(%error, "couldn't kill a terminal's program; it may have exited");
        }
    }

    /// Stops its stream to `replies`' connection, and forgets those of closed connections.
    /// Returns its streams, still locked.
    fn detach(&self, replies: &mpsc::Sender<Reply>) -> MutexGuard<'_, Vec<Stream>> {
        let mut streams = lock(&self.streams);
        streams.retain(|(other, task)| {
            let detached = other.same_channel(replies);
            if detached {
                task.abort();
            }
            !detached && !other.is_closed()
        });
        streams
    }

    /// A receiver for what it prints from now on, what it printed until now without its queries,
    /// and its exit code if it already exited. The queries are stripped after the lock, which the
    /// reader needs, is let go.
    fn subscribe(&self) -> (broadcast::Receiver<Output>, String, Option<i32>) {
        let (output, history, exit) = {
            let mut shared = lock(&self.shared);
            (self.output.subscribe(), shared.history.text(), shared.exit)
        };
        (output, without_queries(&history), exit)
    }
}

/// Starts `params`' program, or the user's login shell (`PowerShell` on Windows), in a new
/// pseudo-terminal, with the threads that serve it.
fn start(
    key: Key,
    params: TerminalOpenParams,
    size: PtySize,
    open: Open,
) -> Result<Arc<Terminal>, ErrorObject> {
    let cwd = params.cwd.filter(|cwd| cwd != "~");
    if let Some(cwd) = &cwd
        && !(Path::new(cwd).is_absolute() && Path::new(cwd).is_dir())
    {
        return Err(ErrorObject::new(
            INVALID_PARAMS,
            format!("{cwd} isn't a folder on this host anymore."),
        ));
    }
    let failed = |error: &dyn std::fmt::Display| {
        ErrorObject::new(
            INTERNAL_ERROR,
            format!("The terminal couldn't start: {error}"),
        )
    };
    let command = params.command.is_some();
    let mut builder = match params.command {
        Some(command) => {
            let mut builder = CommandBuilder::new(command.program);
            builder.args(command.args);
            for (name, value) in command.env {
                builder.env(name, value);
            }
            builder
        }
        None if cfg!(windows) => {
            let mut builder = CommandBuilder::new("powershell.exe");
            builder.arg("-NoLogo");
            builder
        }
        None => CommandBuilder::new_default_prog(),
    };
    // Its home folder when absent.
    if let Some(cwd) = cwd {
        builder.cwd(cwd);
    }
    builder.env("TERM", "xterm-256color");
    // In the C locale, as when launchd starts plxd, zsh counts each byte of a character like a
    // prompt's U+E0A0 as a column, so its line editor draws in the wrong place.
    if ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .all(|name| builder.get_env(name).is_none_or(std::ffi::OsStr::is_empty))
    {
        builder.env("LANG", "en_US.UTF-8");
    }

    let pair = native_pty_system().openpty(size).map_err(|e| failed(&e))?;
    let mut child = pair.slave.spawn_command(builder).map_err(|e| failed(&e))?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| failed(&e))?;
    let writer = pair.master.take_writer().map_err(|e| failed(&e))?;
    let (input, typed) = std_mpsc::channel();
    let terminal = Arc::new(Terminal {
        key,
        command,
        shared: Mutex::new(Shared {
            history: History::new(MAX_LINES, MAX_BYTES),
            master: Some(pair.master),
            exit: None,
        }),
        output: broadcast::channel(LAG).0,
        input,
        killer: Mutex::new(child.clone_killer()),
        streams: Mutex::default(),
    });

    let (read_done, reading) = std_mpsc::channel::<()>();
    let printed = Arc::clone(&terminal);
    let spawned = std::thread::Builder::new()
        .name("terminal-read".to_owned())
        .spawn(move || {
            let _done = read_done;
            read(&printed, reader);
        })
        .and_then(|_| {
            std::thread::Builder::new()
                .name("terminal-write".to_owned())
                .spawn(move || write(writer, &typed))
        })
        .and_then(|_| {
            let exited = Arc::clone(&terminal);
            std::thread::Builder::new()
                .name("terminal-wait".to_owned())
                .spawn(move || {
                    let code = child
                        .wait()
                        .ok()
                        .and_then(|status| i32::try_from(status.exit_code()).ok())
                        .unwrap_or(-1);
                    // A Windows pseudo-console's output ends only once it closes. Closing it waits
                    // for the reader, which needs the lock, so it's dropped outside it.
                    let master = lock(&exited.shared).master.take();
                    drop(master);
                    // The last of its output, unless a process it left behind holds the terminal.
                    let _ = reading.recv_timeout(Duration::from_secs(2));
                    finish(&exited, code, &open);
                })
        });
    if let Err(error) = spawned {
        terminal.kill();
        return Err(failed(&error));
    }
    Ok(terminal)
}

/// Asks for the cursor's position, which a Windows pseudo-console does first, and prints nothing
/// until it's answered (portable-pty opens it with `PSEUDOCONSOLE_INHERIT_CURSOR`).
const CURSOR_QUERY: &str = "\x1b[6n";

/// Appends what the terminal prints to its history and sends it to its streams, until it ends.
fn read(terminal: &Terminal, mut reader: Box<dyn Read + Send>) {
    let mut buffer = vec![0; 64 * 1024];
    let mut pending = Vec::new();
    let mut started = !cfg!(windows);
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                let mut text = take_text(&mut pending);
                // plxd answers the pseudo-console's first query itself, at the top left of a new
                // screen, so it never waits for a client, and a replay never asks a client again.
                if !started && let Some(at) = text.find(CURSOR_QUERY) {
                    started = true;
                    text.replace_range(at..at + CURSOR_QUERY.len(), "");
                    let _ = terminal.input.send("\x1b[1;1R".to_owned());
                }
                if text.is_empty() {
                    continue;
                }
                let mut shared = lock(&terminal.shared);
                shared.history.push(&text);
                let _ = terminal.output.send(Output::Data(text.into()));
            }
        }
    }
}

/// Writes what's typed to the terminal, in order, until it closes.
fn write(mut writer: Box<dyn Write + Send>, typed: &std_mpsc::Receiver<String>) {
    for data in typed {
        if writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Records the terminal's exit, sends it to its streams, and forgets it.
fn finish(terminal: &Arc<Terminal>, code: i32, open: &Open) {
    {
        let mut shared = lock(&terminal.shared);
        shared.exit = Some(code);
        let _ = terminal.output.send(Output::Exit(code));
    }
    let mut open = lock(open);
    if open
        .get(&terminal.key)
        .is_some_and(|current| Arc::ptr_eq(current, terminal))
    {
        open.remove(&terminal.key);
    }
}

/// Sends a terminal's history, then what it prints, then its exit, to one connection. A
/// connection that falls [`LAG`] chunks behind gets the history again.
async fn stream(
    terminal: Arc<Terminal>,
    replies: mpsc::Sender<Reply>,
    stopped: CancellationToken,
    mut output: broadcast::Receiver<Output>,
    mut history: String,
    mut exit: Option<i32>,
) {
    let (thread_id, terminal_id) = terminal.key.clone();
    let send = async |message: Output, replay: bool| {
        let notification = match message {
            Output::Data(data) => notification::<TerminalOutput>(TerminalOutputParams {
                thread_id: thread_id.clone(),
                terminal_id: terminal_id.clone(),
                data: data.to_string(),
                replay,
            }),
            Output::Exit(exit_code) => notification::<TerminalExit>(TerminalExitParams {
                thread_id: thread_id.clone(),
                terminal_id: terminal_id.clone(),
                exit_code,
            }),
        };
        replies
            .send(Reply::Notification(notification))
            .await
            .is_ok()
    };
    loop {
        // Sent, and let go: a stream holds only what it's sending.
        for (i, part) in chunks(&std::mem::take(&mut history)).enumerate() {
            if !send(Output::Data(part.into()), i == 0).await {
                return;
            }
        }
        if let Some(code) = exit {
            send(Output::Exit(code), false).await;
            return;
        }
        loop {
            let next = tokio::select! {
                () = stopped.cancelled() => {
                    if terminal.command {
                        terminal.kill();
                    }
                    return;
                }
                next = output.recv() => next,
            };
            match next {
                Ok(message @ Output::Data(_)) => {
                    if !send(message, false).await {
                        return;
                    }
                }
                Ok(message @ Output::Exit(_)) => {
                    send(message, false).await;
                    return;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    (output, history, exit) = terminal.subscribe();
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

/// `text` in pieces of at most [`MAX_CHUNK`] bytes, cut between characters. At least one, so an
/// empty history still resets the client.
fn chunks(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(text);
    std::iter::from_fn(move || {
        let text = rest?;
        let end = text.floor_char_boundary(MAX_CHUNK);
        let (part, after) = text.split_at(end);
        rest = (!after.is_empty()).then_some(after);
        Some(part)
    })
}

/// The UTF-8 text at the front of `pending`, leaving a character a read split for the next one.
/// Invalid bytes become U+FFFD.
fn take_text(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                text.push_str(valid);
                pending.clear();
                return text;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[..valid]));
                let Some(invalid) = error.error_len() else {
                    pending.drain(..valid);
                    return text;
                };
                text.push(char::REPLACEMENT_CHARACTER);
                pending.drain(..valid + invalid);
            }
        }
    }
}

/// A terminal's latest output: at most `max_lines` lines, counting an unfinished last one, and
/// `max_bytes` bytes, as T3 Code's `BoundedTerminalHistory` keeps it.
struct History {
    text: VecDeque<u8>,
    newlines: usize,
    max_lines: usize,
    max_bytes: usize,
}

impl History {
    fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            text: VecDeque::new(),
            newlines: 0,
            max_lines,
            max_bytes,
        }
    }

    fn push(&mut self, data: &str) {
        self.text.extend(data.as_bytes());
        self.newlines += data.bytes().filter(|&b| b == b'\n').count();
        while self.newlines + usize::from(self.text.back() != Some(&b'\n')) > self.max_lines {
            let Some(end) = self.text.iter().position(|&b| b == b'\n') else {
                break;
            };
            self.text.drain(..=end);
            self.newlines -= 1;
        }
        if self.text.len() > self.max_bytes {
            let mut cut = self.text.len() - self.max_bytes;
            // Never half a character.
            while self.text.get(cut).is_some_and(|&b| b & 0xC0 == 0x80) {
                cut += 1;
            }
            self.newlines -= self.text.range(..cut).filter(|&&b| b == b'\n').count();
            self.text.drain(..cut);
        }
    }

    /// The kept output.
    fn text(&mut self) -> String {
        String::from_utf8_lossy(self.text.make_contiguous()).into_owned()
    }
}

/// `text` less the escape sequences that ask a terminal something or answer it, so a client that
/// replays a history doesn't answer them again and type the answers into the shell. T3 Code strips
/// the same from its history: cursor position and status reports, device attributes, mode,
/// version, and keyboard queries, color queries, and setting and capability queries.
fn without_queries(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('\x1b') {
        kept.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (len, query) = match after.as_bytes().first() {
            Some(b'[') => csi(&after[1..]).map_or((0, false), |(len, query)| (len + 1, query)),
            Some(b']') => string(&after[1..]).map_or((0, false), |(len, body)| {
                let color = ["10;", "11;", "12;"].iter().any(|p| body.starts_with(p))
                    && (body[3..].starts_with('?') || body[3..].starts_with("rgb:"));
                (len + 1, color)
            }),
            Some(b'P') => string(&after[1..]).map_or((0, false), |(len, body)| {
                let body = body.strip_prefix(['0', '1']).unwrap_or(body);
                let query = ["$q", "$r", "+q", "+r"].iter().any(|p| body.starts_with(p));
                (len + 1, query)
            }),
            _ => (0, false),
        };
        if !query {
            kept.push('\x1b');
        }
        let skip = if query { len } else { 0 };
        rest = &after[skip..];
    }
    kept.push_str(rest);
    kept
}

/// The length of a control sequence's body and final byte at the start of `text`, after `ESC [`,
/// and whether it's a query or a reply.
fn csi(text: &str) -> Option<(usize, bool)> {
    let end = text.find(|c: char| ('\x40'..='\x7e').contains(&c))?;
    let (body, last) = (&text[..end], text.as_bytes()[end]);
    if !body.bytes().all(|b| (0x20..=0x3f).contains(&b)) {
        return None;
    }
    let digits = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit() || b == b';' || b == b'?')
    };
    let query = match last {
        b'n' => true,
        b'R' => digits(body),
        b'c' => digits(body.trim_start_matches('>')),
        b'p' | b'y' => body.strip_suffix('$').is_some_and(digits),
        b'q' => body.strip_prefix('>').is_some_and(digits),
        b'u' => body.starts_with('?'),
        _ => false,
    };
    Some((end + 1, query))
}

/// The length of an OSC or DCS string at the start of `text` with its terminator (BEL or
/// `ESC \`), and its content.
fn string(text: &str) -> Option<(usize, &str)> {
    let end = text.find(['\x07', '\x1b'])?;
    let terminator = match text.as_bytes()[end] {
        0x07 => 1,
        _ if text[end..].starts_with("\x1b\\") => 2,
        _ => return None,
    };
    Some((end + terminator, &text[..end]))
}

fn notification<N: NotificationMethod>(params: N::Params) -> Notification {
    Notification {
        method: N::NAME.to_owned(),
        params: serde_json::to_value(params).ok(),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
