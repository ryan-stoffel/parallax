//! `plxd dial` through this computer's own plxd (PLX-1585, 0091).
//!
//! A TLS session can only be resumed by the process that made it, since rustls can't save one, and
//! each `plxd dial` is a process of its own. So a dial to a paired or `account:` computer's `/ws`
//! hands its connection to the plxd running in its data folder, over that plxd's socket, and that
//! plxd dials: the route race, the relay's connection with the `ClientHello` behind its request
//! (PLX-1568), the pinned TLS, resumed with 0-RTT when it holds a ticket for that pin
//! ([`crate::remote::keep_tickets`]), and the upgrade. It then carries the WebSocket's messages as
//! lines over the socket, and `dial` copies them to and from its stdio.
//!
//! On the socket, `dial` sends [`PREFACE`]. A plxd with this answers a [`Hello`] line with its data
//! folder. A plxd from before this answers the preface with a JSON-RPC parse error, since it isn't
//! JSON, and `dial` then dials itself, as it does when nothing listens or the plxd's data folder
//! isn't its own. Only after the hello does `dial` send its [`Request`], with the relay's token.
//! plxd answers with an [`Answer`] line, then the messages, then a last line that starts with
//! [`END`], which no JSON text does, holding how it ended ([`Ended`]). The socket's own check that
//! the other end is this user is unchanged ([`crate::server`]).
//!
//! The parts of a dial that are one per process in `plxd dial` (the relay's sign-in, how its
//! stream ended, its timing marks, and whether it opened the relay's connection during the head
//! start) are a [`Scope`] of the task that runs it inside plxd.
//!
//! A dial that connected over the relay also has plxd keep a connection to the relay open for the
//! next few minutes, so the next dial skips its TCP and TLS ([`crate::relay::warm`], PLX-1586).

use std::fmt::Display;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{
    AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader,
    ReadBuf,
};
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::paths::DataDir;
use crate::remote::{self, Input};

/// What `plxd dial` sends first on plxd's socket. A JSON-RPC client's first byte is `{`.
pub(crate) const PREFACE: &[u8] = b"PLXD-DIAL/1\n";

/// The first byte of plxd's last line on a dial's socket, which no JSON text starts with.
const END: u8 = 0x01;

/// The longest line either side sends: a message, with room for the request around it.
const MAX_LINE: u64 = parallax_protocol::framing::MAX_FRAME_BYTES as u64 + 64 * 1024;

/// How long `dial` waits for plxd's socket, and then for its hello, before it dials itself.
const LOCAL_WAIT: Duration = Duration::from_secs(2);

/// plxd's answer to [`PREFACE`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    dial: u32,
    data_dir: PathBuf,
}

/// What `plxd dial` asks plxd to dial. It holds the relay's token, so it has no `Debug`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    routes: Vec<String>,
    /// An `account:` computer's relay id, which the certificate's key must have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account: Option<String>,
    /// A paired computer's certificate fingerprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote: Option<String>,
    #[serde(default)]
    in_order: bool,
    /// The relay's URL and the Clerk session `dial` got from the app, for `relay:` routes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relay: Option<(String, String)>,
    /// Whether `dial` prints timing marks.
    #[serde(default)]
    timings: bool,
    /// `dial`'s proxy settings, from [`PROXY_VARIABLES`], which its relay connections follow.
    #[serde(default)]
    proxy: Vec<(String, String)>,
    /// The lines the app had written to `dial` already, which may go behind the upgrade.
    #[serde(default)]
    lines: Vec<String>,
}

/// A timing mark: whether it's the relay's own, its name, and its milliseconds, since the dial
/// started in plxd for one of [`crate::connect_timing::mark`]'s, or as a duration for the relay's.
type Timing = (bool, String, f64);

/// How plxd's dial went.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Answer {
    Connected {
        route: String,
        head_start: bool,
        /// Whether the relay route took the connection plxd kept open (PLX-1586).
        #[serde(default)]
        kept: bool,
        timings: Vec<Timing>,
    },
    Failed {
        exit: i32,
        error: String,
        timings: Vec<Timing>,
    },
}

/// How a dial's connection ended, after [`END`].
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    exit: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relay_end: Option<String>,
}

/// The environment variables a dial's relay connections take their proxy from
/// ([`crate::relay`]), which `dial` sends, since plxd's own environment may differ.
const PROXY_VARIABLES: [&str; 4] = ["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"];

/// One dial's state inside plxd, for the task that runs it and the tasks it starts. It holds the
/// relay's token and the proxy's settings, so it has no `Debug`.
pub(crate) struct Scope {
    relay: Option<(String, String)>,
    proxy: Vec<(String, String)>,
    timings: Option<(Instant, Mutex<Vec<Timing>>)>,
    head_start: AtomicBool,
    kept: AtomicBool,
    end: crate::relay::EndSlot,
}

tokio::task_local! {
    static SCOPE: Arc<Scope>;
}

impl Scope {
    pub(crate) fn new(
        relay: Option<(String, String)>,
        proxy: Vec<(String, String)>,
        timings: bool,
    ) -> Self {
        Scope {
            relay,
            proxy,
            timings: timings.then(|| (Instant::now(), Mutex::default())),
            head_start: AtomicBool::new(false),
            kept: AtomicBool::new(false),
            end: crate::relay::EndSlot::default(),
        }
    }

    /// A scope with this dial's proxy settings alone, for the relay connection plxd keeps open
    /// after it, which outlives it and holds no sign-in.
    pub(crate) fn for_keeping(&self) -> Self {
        Scope::new(None, self.proxy.clone(), false)
    }

    /// `dial`'s proxy settings.
    pub(crate) fn proxy(&self) -> &[(String, String)] {
        &self.proxy
    }

    /// The relay and Clerk session this dial's `relay:` routes use.
    pub(crate) fn relay(&self) -> Option<(String, String)> {
        self.relay.clone()
    }

    /// `dial`'s value for the proxy setting `name`, one of [`PROXY_VARIABLES`].
    pub(crate) fn proxy_setting(&self, name: &str) -> Option<String> {
        self.proxy
            .iter()
            .find(|(set, _)| set == name)
            .map(|(_, value)| value.clone())
    }

    /// Whether `dial` prints timing marks, so the relay is asked for its own.
    pub(crate) fn timings(&self) -> bool {
        self.timings.is_some()
    }

    /// Where this dial's relay stream keeps how it ended.
    pub(crate) fn end(&self) -> crate::relay::EndSlot {
        Arc::clone(&self.end)
    }

    /// Notes that this dial's relay route took the connection opened during the head start.
    pub(crate) fn took_head_start(&self) {
        self.head_start.store(true, Ordering::Relaxed);
    }

    /// Notes that this dial's relay route took the connection plxd kept open.
    pub(crate) fn took_kept(&self) {
        self.kept.store(true, Ordering::Relaxed);
    }

    /// Keeps a timing mark, when `dial` prints them. `ms` is a duration for the relay's own.
    pub(crate) fn mark(&self, server: bool, name: &str, ms: Option<f64>) {
        if let Some((start, marks)) = &self.timings {
            let ms = ms.unwrap_or_else(|| start.elapsed().as_secs_f64() * 1000.0);
            let mut marks = marks.lock().unwrap_or_else(PoisonError::into_inner);
            if marks.len() < 64 {
                marks.push((server, name.to_owned(), ms));
            }
        }
    }

    fn take_timings(&self) -> Vec<Timing> {
        self.timings.as_ref().map_or_else(Vec::new, |(_, marks)| {
            std::mem::take(&mut *marks.lock().unwrap_or_else(PoisonError::into_inner))
        })
    }
}

/// The dial this task runs for `plxd dial`, if it is one.
pub(crate) fn current() -> Option<Arc<Scope>> {
    SCOPE.try_with(Arc::clone).ok()
}

/// Runs `future` in `scope`, for a task a dial starts.
pub(crate) async fn within<F: Future>(scope: Option<Arc<Scope>>, future: F) -> F::Output {
    match scope {
        Some(scope) => SCOPE.scope(scope, future).await,
        None => future.await,
    }
}

/// Reads the start of a connection to plxd's socket, up to [`PREFACE`]'s length or the first byte
/// that isn't it: what it read, and whether that was the preface.
///
/// # Errors
///
/// The connection's.
pub(crate) async fn sniff<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<(Vec<u8>, bool)> {
    let mut read = Vec::with_capacity(PREFACE.len());
    let mut chunk = [0; PREFACE.len()];
    while read.len() < PREFACE.len() && PREFACE.starts_with(&read) {
        let wanted = PREFACE.len() - read.len();
        let got = stream.read(&mut chunk[..wanted]).await?;
        if got == 0 {
            break;
        }
        read.extend_from_slice(&chunk[..got]);
    }
    let preface = read == PREFACE;
    Ok((read, preface))
}

/// A stream that gives `prefix` before what `inner` reads: a connection [`sniff`] read the start
/// of, for the JSON-RPC connection it was.
#[derive(Debug)]
pub(crate) struct Prefixed<S> {
    prefix: Vec<u8>,
    inner: S,
}

impl<S> Prefixed<S> {
    pub(crate) fn new(prefix: Vec<u8>, inner: S) -> Self {
        Prefixed { prefix, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.prefix.is_empty() {
            let n = this.prefix.len().min(buf.remaining());
            buf.put_slice(&this.prefix[..n]);
            this.prefix.drain(..n);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// The host's messages on their way to `dial`, a line at a time, with any line that starts with
/// [`END`] dropped, so a message can't end `dial`'s output early or name its exit. JSON-RPC
/// messages are one line and start with `{`, so a real one never is.
struct Guarded<W> {
    inner: W,
    /// What came since the last newline.
    line: Vec<u8>,
    /// Whole lines on their way to `inner`.
    out: Vec<u8>,
}

impl<W: AsyncWrite + Unpin> Guarded<W> {
    fn new(inner: W) -> Self {
        Guarded {
            inner,
            line: Vec::new(),
            out: Vec::new(),
        }
    }

    fn poll_drain(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.out.is_empty() {
            let wrote = std::task::ready!(Pin::new(&mut self.inner).poll_write(cx, &self.out))?;
            if wrote == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
            self.out.drain(..wrote);
        }
        Poll::Ready(Ok(()))
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for Guarded<W> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        // One message waits at most: `bridge` flushes after each.
        if !this.out.is_empty() {
            std::task::ready!(this.poll_drain(cx))?;
        }
        for &byte in buf {
            this.line.push(byte);
            if byte == b'\n' {
                if this.line.first() == Some(&END) {
                    debug!("dropped a host's message that would read as the end of a dial");
                } else {
                    this.out.extend_from_slice(&this.line);
                }
                this.line.clear();
            }
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        std::task::ready!(this.poll_drain(cx))?;
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        std::task::ready!(this.poll_drain(cx))?;
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

/// How `plxd dial` exits for a dial that failed with `error`.
#[must_use]
pub fn exit_code(error: &remote::Error) -> i32 {
    match error {
        remote::Error::Refused => remote::EXIT_REFUSED,
        remote::Error::Removed => remote::EXIT_REMOVED,
        _ => crate::attach::EXIT_UNAVAILABLE.into(),
    }
}

async fn write_line<W: AsyncWrite + Unpin>(out: &mut W, value: &impl Serialize) -> io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(io::Error::other)?;
    line.push(b'\n');
    out.write_all(&line).await?;
    out.flush().await
}

async fn read_line<R: AsyncRead + Unpin>(read: &mut BufReader<R>) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    (&mut *read)
        .take(MAX_LINE)
        .read_until(b'\n', &mut line)
        .await?;
    if line.last() != Some(&b'\n') {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    line.pop();
    Ok(line)
}

/// plxd's side: runs the dial `plxd dial` asks for on `stream`, which sent [`PREFACE`], and
/// carries its connection until either end closes or `stop`.
pub(crate) async fn serve<S>(stream: S, data_dir: &Path, stop: CancellationToken)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    let hello = Hello {
        dial: 1,
        data_dir: data_dir.to_owned(),
    };
    if let Err(error) = write_line(&mut write, &hello).await {
        return debug!(%error, "a dial left before plxd's hello");
    }
    let request = match read_line(&mut read).await {
        Ok(line) => serde_json::from_slice::<Request>(&line),
        // `dial` found another data folder, and dials itself.
        Err(_) => return,
    };
    let Ok(request) = request else {
        return debug!("a dial sent a request plxd can't read");
    };
    remote::keep_tickets();
    let scope = Arc::new(Scope::new(request.relay, request.proxy, request.timings));
    let mut input = Input::with_waiting(read, request.lines);
    let (routes, in_order) = (&request.routes, request.in_order);
    let dialed = within(Some(Arc::clone(&scope)), async {
        let dialed = match (&request.account, &request.remote) {
            (Some(host_id), _) => {
                remote::dial_account_with_input(routes, in_order, host_id, data_dir, &mut input)
                    .await
            }
            (None, Some(fingerprint)) => {
                remote::dial_with_input(routes, fingerprint, data_dir, &mut input).await
            }
            (None, None) => Err(remote::Error::Protocol("no computer to dial".to_owned())),
        };
        if let Ok(dialed) = &dialed
            && dialed.route.starts_with(remote::RELAY_ROUTE)
        {
            crate::relay::warm::dialed();
        }
        dialed
    });
    let dialed = tokio::select! {
        dialed = dialed => dialed,
        () = stop.cancelled() => return,
    };
    let dialed = match dialed {
        Ok(dialed) => dialed,
        Err(error) => {
            let failed = Answer::Failed {
                exit: exit_code(&error),
                error: error.to_string(),
                timings: scope.take_timings(),
            };
            let _ = write_line(&mut write, &failed).await;
            let _ = write.shutdown().await;
            return;
        }
    };
    let connected = Answer::Connected {
        route: dialed.route.clone(),
        head_start: scope.head_start.load(Ordering::Relaxed),
        kept: scope.kept.load(Ordering::Relaxed),
        timings: scope.take_timings(),
    };
    if write_line(&mut write, &connected).await.is_err() {
        return;
    }
    let bridged = tokio::select! {
        bridged = within(Some(Arc::clone(&scope)), remote::bridge(dialed.socket, input, Guarded::new(&mut write))) => bridged,
        () = stop.cancelled() => Err(io::Error::other("this computer's plxd is stopping")),
    };
    let relay_end = dialed
        .route
        .starts_with(remote::RELAY_ROUTE)
        .then(|| {
            scope
                .end
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
        .flatten();
    let ended = Ended {
        exit: i32::from(bridged.is_err()),
        error: bridged.err().map(|error| error.to_string()),
        relay_end: relay_end.map(|end| end.to_string()),
    };
    let mut last = vec![END];
    last.extend(serde_json::to_vec(&ended).unwrap_or_default());
    last.push(b'\n');
    let _ = write.write_all(&last).await;
    let _ = write.shutdown().await;
}

/// The computer `plxd dial` dials.
#[derive(Debug)]
pub struct Dial<'a> {
    /// Its routes, best first.
    pub routes: &'a [String],
    /// An `account:` computer's relay id.
    pub account: Option<&'a str>,
    /// A paired computer's certificate fingerprint.
    pub remote: Option<&'a str>,
    /// Whether the routes go in the user's order.
    pub in_order: bool,
}

/// `plxd dial`'s side: hands `dial` to the plxd running in `data_dir` and copies its connection to
/// and from stdio, with `input` read from stdin. `None` when no such plxd takes it, before anything
/// of `input` went, so `dial` dials itself. Otherwise how `dial` exits. Reports go through `report`,
/// as `dial`'s own would.
pub async fn hand_off<I: AsyncRead + Unpin>(
    data_dir: &DataDir,
    dial: &Dial<'_>,
    input: &mut Input<I>,
    report: &dyn Fn(&dyn Display),
) -> Option<i32> {
    // Starts reading stdin, so the lines the app wrote as it started this are in by the request.
    input.fill();
    let path = data_dir.socket_path().ok()?.path;
    let stream = tokio::time::timeout(LOCAL_WAIT, crate::transport::connect(&path))
        .await
        .ok()?
        .ok()?;
    let (read, mut write) = tokio::io::split(stream);
    let mut read = BufReader::new(read);
    write.write_all(PREFACE).await.ok()?;
    let hello = tokio::time::timeout(LOCAL_WAIT, read_line(&mut read))
        .await
        .ok()?
        .ok()?;
    let hello: Hello = serde_json::from_slice(&hello).ok()?;
    if hello.dial != 1 || !same_dir(&hello.data_dir, data_dir.root()) {
        return None;
    }
    let started = crate::connect_timing::elapsed_ms();
    let request = Request {
        routes: dial.routes.to_vec(),
        account: dial.account.map(str::to_owned),
        remote: dial.remote.map(str::to_owned),
        in_order: dial.in_order,
        relay: std::env::var("PLXD_RELAY_TOKEN")
            .ok()
            .map(|token| (crate::relay::url(), token)),
        timings: crate::connect_timing::enabled(),
        proxy: PROXY_VARIABLES
            .iter()
            .filter_map(|&name| Some((name.to_owned(), std::env::var(name).ok()?)))
            .collect(),
        lines: input.take_waiting(),
    };
    if let Err(error) = write_line(&mut write, &request).await {
        report(&format!("could not reach this computer's plxd: {error}"));
        return Some(crate::attach::EXIT_UNAVAILABLE.into());
    }
    // What the app writes from now on goes to plxd, which sends it once it's connected.
    let forward = async {
        while let Some(line) = input.next().await? {
            write.write_all(line.as_bytes()).await?;
            write.write_all(b"\n").await?;
        }
        // A named pipe has no half-close, so on Windows an empty message ends the input, as
        // `plxd attach` ends its own ([`crate::attach::bridge`]).
        if cfg!(windows) {
            write.write(&[]).await.map(drop)
        } else {
            write.shutdown().await
        }
    };
    let output = carry(&mut read, started, report);
    tokio::pin!(forward, output);
    let mut forwarding = true;
    loop {
        tokio::select! {
            exit = &mut output => return Some(exit),
            done = &mut forward, if forwarding => {
                forwarding = false;
                if let Err(error) = done {
                    debug!(%error, "stopped sending the app's lines to plxd");
                }
            }
        }
    }
}

/// Reads plxd's answer, reports it as `dial` would, then copies the messages to stdout until the
/// end: how `dial` exits.
async fn carry<R: AsyncRead + Unpin>(
    read: &mut BufReader<R>,
    started: Option<f64>,
    report: &dyn Fn(&dyn Display),
) -> i32 {
    let replay = |timings: Vec<Timing>| {
        for (server, name, ms) in timings {
            let ms = if server {
                ms
            } else {
                ms + started.unwrap_or_default()
            };
            crate::connect_timing::replay(server, &name, ms);
        }
    };
    let answer = match read_line(read).await {
        Ok(line) => serde_json::from_slice::<Answer>(&line).map_err(io::Error::other),
        Err(error) => Err(error),
    };
    match answer {
        Ok(Answer::Connected {
            route,
            head_start,
            kept,
            timings,
        }) => {
            replay(timings);
            // The app reads this line to know when it's on the relay, and so re-checks direct
            // routes.
            crate::connect_timing::mark("connected");
            // The relay probe reads this to tell a dial with the early connection from one
            // without (PLX-1549). The app reads only the next line.
            if route.starts_with(remote::RELAY_ROUTE) && head_start {
                report(&"opened the relay's connection during the head start");
            }
            // And this one from a dial over the connection plxd kept open (PLX-1586).
            if route.starts_with(remote::RELAY_ROUTE) && kept {
                report(&"took the relay connection this computer's plxd kept open");
            }
            report(&format!("connected over {route}"));
        }
        Ok(Answer::Failed {
            exit,
            error,
            timings,
        }) => {
            replay(timings);
            report(&format!("could not reach the paired computer: {error}"));
            return exit;
        }
        Err(error) => {
            report(&format!(
                "could not reach the paired computer: this computer's plxd stopped: {error}"
            ));
            return crate::attach::EXIT_UNAVAILABLE.into();
        }
    }
    let mut stdout = tokio::io::stdout();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = read.read_until(b'\n', &mut line).await;
        match read {
            Ok(0) | Err(_) => {
                report(&"the connection failed: this computer's plxd closed it");
                return 1;
            }
            Ok(_) if line.first() == Some(&END) => {
                let ended: Ended =
                    serde_json::from_slice(line[1..].trim_ascii()).unwrap_or_default();
                // The app logs this with the disconnect (connection.ts).
                if let Some(end) = ended.relay_end {
                    report(&format!("relay stream ended {end}"));
                }
                if let Some(error) = ended.error {
                    report(&format!("the connection failed: {error}"));
                }
                return ended.exit;
            }
            Ok(_) => {
                if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
                    return 1;
                }
            }
        }
    }
}

/// Whether `theirs` and `ours` are the same folder.
fn same_dir(theirs: &Path, ours: &Path) -> bool {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    theirs == ours || canonical(theirs) == canonical(ours)
}

#[cfg(test)]
mod tests {
    use tokio::io::duplex;

    use super::*;

    #[tokio::test]
    async fn a_hosts_message_cant_end_the_dials_output() {
        let mut out = Vec::new();
        let mut guarded = Guarded::new(&mut out);
        let forged = [&[END][..], br#"{"exit":6,"error":"forged"}"#].concat();
        for message in [&br#"{"id":1}"#[..], &forged, br#"{"id":2}"#] {
            guarded.write_all(message).await.unwrap();
            guarded.write_all(b"\n").await.unwrap();
            guarded.flush().await.unwrap();
        }
        assert_eq!(out, b"{\"id\":1}\n{\"id\":2}\n");
    }

    /// A stand-in on `data_dir`'s socket that answers the preface with `hello`, and gives back
    /// everything it read after the preface.
    #[cfg(unix)]
    fn answering(data_dir: &DataDir, hello: String) -> tokio::task::JoinHandle<Vec<u8>> {
        let path = data_dir.socket_path().unwrap().path;
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut preface = vec![0; PREFACE.len()];
            stream.read_exact(&mut preface).await.unwrap();
            assert_eq!(preface, PREFACE);
            stream.write_all(hello.as_bytes()).await.unwrap();
            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest).await;
            rest
        })
    }

    /// `dial` dials itself, having sent no request and kept the app's lines, when no plxd
    /// listens, when an older plxd answers the preface with a parse error, and when the plxd
    /// that answers runs in another data folder.
    #[cfg(unix)]
    #[tokio::test]
    async fn dial_dials_itself_without_a_plxd_of_its_own_that_takes_it() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path()).unwrap();
        let routes = ["127.0.0.1:1".to_owned()];
        let dial = Dial {
            routes: &routes,
            account: None,
            remote: Some("fingerprint"),
            in_order: false,
        };
        let report = |_: &dyn Display| {};
        let mut input = Input::new(&b"{\"id\":1}\n"[..]);
        assert_eq!(hand_off(&data_dir, &dial, &mut input, &report).await, None);

        let older =
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#;
        let other = r#"{"dial":1,"dataDir":"/somewhere/else"}"#;
        for hello in [older, other] {
            let path = data_dir.socket_path().unwrap().path;
            let _ = std::fs::remove_file(&path);
            let stand_in = answering(&data_dir, format!("{hello}\n"));
            assert_eq!(hand_off(&data_dir, &dial, &mut input, &report).await, None);
            assert!(
                stand_in.await.unwrap().is_empty(),
                "it sent its request: {hello}"
            );
        }
        assert_eq!(input.take_waiting(), ["{\"id\":1}"]);
    }

    #[tokio::test]
    async fn a_json_rpc_connection_goes_on_whole_and_a_dial_is_told_apart() {
        let initialize = br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let (mut near, mut far) = duplex(1024);
        near.write_all(initialize).await.unwrap();
        drop(near);
        let (read, dialing) = sniff(&mut far).await.unwrap();
        assert!(!dialing);
        assert!(
            read.len() <= PREFACE.len(),
            "it reads no further than the preface's length"
        );
        let mut whole = Vec::new();
        Prefixed::new(read, far)
            .read_to_end(&mut whole)
            .await
            .unwrap();
        assert_eq!(whole, initialize);

        let (mut near, mut far) = duplex(1024);
        near.write_all(PREFACE).await.unwrap();
        let (read, dialing) = sniff(&mut far).await.unwrap();
        assert!(dialing);
        assert_eq!(read, PREFACE);
    }
}
