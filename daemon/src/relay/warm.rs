//! The relay connection a dial opens while its direct routes have their head start (PLX-1549).
//!
//! A dial to an account computer starts its LAN and Tailscale routes at once and its `relay:` route
//! [`crate::remote::RELAY_HEAD_START`] later (0091). Away from home the direct routes don't answer,
//! so the relay route used to start its DNS, TCP, and TLS only at its turn. [`ahead`] starts them
//! with the direct routes, and the relay route's upgrade goes over that connection. Nothing is sent
//! on it before the relay route's turn, so the relay sees a handshake and no request, and the
//! token, the relay's limits, the stream, and the pinned TLS inside it are as before.
//!
//! An early connection that broke never fails a connect. At the relay route's turn, one that
//! isn't open yet races a new connection, and one that failed gives way to a new one. One that
//! fails after its handshake, or that sends no answer to the upgrade within [`EARLY_ANSWER`], as a
//! connection left on a network the computer moved off would, also gives way to a new one, which
//! costs the connect that long. One that no relay route takes is closed when the race ends.
//!
//! Between dials, the plxd a `plxd dial` hands its dial to (PLX-1585) also keeps one such connection
//! open, so a relay route that doesn't wait, or doesn't wait long enough, finds one ready (PLX-1586).
//! It's TCP and TLS to the relay and nothing more, so it holds nothing of an account, and one serves
//! every dial to that relay with the same proxy settings. Cloudflare closes a connection that sent
//! no request 15 s after it opened, so the kept one is replaced every [`REPLACE_AFTER`], and it's
//! dropped when the computer changes networks or wakes. A relay route takes it the way it takes an
//! early connection, and a new one opens at once for the next dial. A kept connection idle for
//! seconds sometimes takes the upgrade and never answers (PLX-1602), so one with no answer within
//! [`KEPT_ANSWER`] gets a new connection asking beside it, and the first answer wins. It's kept
//! only for [`KEEP_FOR`] after the last dial that connected over the relay, and a wake ends that,
//! so a plxd whose dials don't use the relay, as at home, opens nothing.

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use futures_util::FutureExt as _;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tracing::debug;

use super::{Base, Link, Outward, Roots, Stream};
use crate::local_dial::Scope;
use crate::remote::Error;

/// How long the relay route waits for the relay to answer its upgrade over an early connection
/// before it asks again on a new one. The answer takes about 200 ms at the median on Wi-Fi
/// (PLX-1549), and a route has 10 s in all, so a slow relay is rarely asked twice and a dead
/// connection leaves time for the new one.
const EARLY_ANSWER: Duration = Duration::from_secs(3);

/// How long the relay route waits for the relay to answer its upgrade over a kept connection before
/// a new connection asks too. On staging from the Mac mini's Wi-Fi, kept connections that worked
/// answered within 1 s in 283 of 293 dials, and 6 of 300 never answered (PLX-1602). Most slow
/// answers were the Worker's own time, so the kept one keeps asking and often still wins.
const KEPT_ANSWER: Duration = Duration::from_secs(1);

/// Whether a relay route in this process took an early connection, for `plxd dial` to report.
static TOOK: AtomicBool = AtomicBool::new(false);

/// Whether a relay route in this process took an early connection.
#[must_use]
pub fn took() -> bool {
    TOOK.load(Ordering::Relaxed)
}

tokio::task_local! {
    /// The connection [`ahead`] started, for the routes of the race it runs.
    static EARLY: Early;
}

/// A connection to the relay at `url`, opening since the race started, until a relay route takes
/// it.
#[derive(Clone)]
struct Early {
    url: String,
    connecting: Arc<Mutex<Option<Connecting>>>,
}

/// The task opening an early connection. Dropping it aborts the task, or closes the connection it
/// opened.
pub(super) struct Connecting {
    task: JoinHandle<io::Result<Stream>>,
    /// Whether this plxd kept it open between dials, so it may have sat idle for seconds.
    kept: bool,
}

impl Drop for Connecting {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Connecting {
    fn new(task: JoinHandle<io::Result<Stream>>) -> Self {
        Self { task, kept: false }
    }

    /// The connection, once open: an early one.
    async fn open(mut self) -> io::Result<(Stream, bool)> {
        match (&mut self.task).await {
            Ok(opened) => opened.map(|stream| (stream, true)),
            Err(error) => Err(io::Error::other(error)),
        }
    }
}

/// Runs `race`, a race of routes whose `relay:` ones start after a head start, with a connection to
/// the signed-in relay opening beside it from now, for the first relay route to take.
pub(crate) async fn ahead<F: Future>(race: F) -> F::Output {
    let Some((url, _)) = super::client() else {
        return race.await;
    };
    let Ok(base) = Base::parse(&url) else {
        return race.await;
    };
    // The relay route takes the one this plxd keeps open instead.
    if kept_for(&KEPT, &url) {
        return race.await;
    }
    let scope = crate::local_dial::current();
    let connecting = Connecting::new(tokio::spawn(crate::local_dial::within(scope, async move {
        base.connect(Roots::WithOs).await
    })));
    let early = Early {
        url,
        connecting: Arc::new(Mutex::new(Some(connecting))),
    };
    EARLY.scope(early, race).await
}

/// The early connection to the relay at `url`, if this task's race has one no route took yet, or
/// else the one this plxd keeps open for its dials ([`take_kept`]).
pub(super) fn take(url: &str) -> Option<Connecting> {
    take_early(url).or_else(|| take_kept(&KEPT, url))
}

fn take_early(url: &str) -> Option<Connecting> {
    EARLY
        .try_with(|early| {
            let mut connecting = early
                .connecting
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if early.url == url {
                connecting.take()
            } else {
                None
            }
        })
        .ok()
        .flatten()
        .inspect(|_| match crate::local_dial::current() {
            Some(scope) => scope.took_head_start(),
            None => TOOK.store(true, Ordering::Relaxed),
        })
}

/// How long after the last dial through this plxd that connected over the relay it keeps a
/// connection to that relay open.
/// Each [`REPLACE_AFTER`] it's kept costs a TCP connection and a TLS handshake, so at most 30.
const KEEP_FOR: Duration = Duration::from_mins(5);

/// How old a kept connection gets before a new one replaces it. Cloudflare closes a connection
/// that sent no request 15 s after it opened, measured on 2026-11-17 against staging and
/// production. Its documented 400 s idle limit applies only after a request.
const REPLACE_AFTER: Duration = Duration::from_secs(10);

/// The oldest kept connection a relay route takes, should the keeper be late to replace it.
const FRESH_FOR: Duration = Duration::from_secs(12);

/// What the plxd that dials for `plxd dial` keeps for its relay dials (PLX-1586).
type Slot = Mutex<Option<Keeping>>;

static KEPT: Slot = Mutex::new(None);

/// A relay this plxd keeps a connection to, since a dial used it lately.
struct Keeping {
    url: String,
    /// What the connection opens in: the dials' proxy settings, and no sign-in or timing marks.
    scope: Arc<Scope>,
    /// When a relay dial last went through this plxd, by the wall clock, so sleep counts.
    used: SystemTime,
    kept: Option<Kept>,
    /// The task that replaces `kept` and ends the keeping ([`keep`]).
    keeper: JoinHandle<()>,
}

/// A kept connection, opening or open, with nothing sent on it.
struct Kept {
    connecting: Connecting,
    /// When it started to open, by the wall clock, so sleep counts.
    opened: SystemTime,
    /// The route to the internet then.
    outward: Outward,
}

impl Keeping {
    /// Whether this keeps a connection for a dial in `scope` to the relay at `url`.
    fn serves(&self, url: &str, scope: &Scope) -> bool {
        self.url == url && self.scope.proxy() == scope.proxy()
    }

    /// Opens a connection to keep, on the route to the internet `outward`.
    fn open(&self, outward: Outward) -> Kept {
        let (url, scope) = (self.url.clone(), Arc::clone(&self.scope));
        let connecting = Connecting::new(tokio::spawn(crate::local_dial::within(
            Some(scope),
            async move { Base::parse(&url)?.connect(Roots::WithOs).await },
        )));
        Kept {
            connecting,
            opened: SystemTime::now(),
            outward,
        }
    }
}

impl Kept {
    /// How old it is at `now`, if a relay route may still take it there: not past [`FRESH_FOR`],
    /// and on the same route to the internet, `outward`.
    fn fresh(&self, now: SystemTime, outward: Outward) -> Option<Duration> {
        let age = now.duration_since(self.opened).ok()?;
        (age < FRESH_FOR && self.outward == outward).then_some(age)
    }
}

fn lock(slot: &Slot) -> MutexGuard<'_, Option<Keeping>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Notes that the dial this task runs for `plxd dial` connected over the relay, so this plxd keeps
/// a connection to that relay for the next [`KEEP_FOR`]. A dial outside a plxd keeps none, since its
/// process ends with it.
pub(crate) fn dialed() {
    dialed_in(&KEPT);
}

fn dialed_in(slot: &'static Slot) {
    let (Some(scope), Some((url, _))) = (crate::local_dial::current(), super::client()) else {
        return;
    };
    if Base::parse(&url).is_err() {
        return;
    }
    let mut keeping = lock(slot);
    match keeping.as_mut() {
        Some(keeping) if keeping.serves(&url, &scope) => keeping.used = SystemTime::now(),
        _ => {
            if let Some(old) = keeping.take() {
                old.keeper.abort();
            }
            *keeping = Some(Keeping {
                url,
                scope: Arc::new(scope.for_keeping()),
                used: SystemTime::now(),
                kept: None,
                keeper: tokio::spawn(keep(slot)),
            });
        }
    }
}

/// Keeps a fresh connection in `slot` until [`KEEP_FOR`] after the last dial: replaces it every
/// [`REPLACE_AFTER`], and when the computer changes networks or wakes, which also ends the keeping
/// once the wake shows [`KEEP_FOR`] passed.
async fn keep(slot: &'static Slot) {
    let mut link = Link::new(Box::new(super::outward));
    loop {
        let Some(wait) = refresh(slot, link.outward) else {
            return;
        };
        tokio::select! {
            () = link.changed() => {
                if let Some(keeping) = lock(slot).as_mut() {
                    keeping.kept = None;
                }
            }
            () = tokio::time::sleep(wait) => {}
        }
    }
}

/// Ends the keeping in `slot` once [`KEEP_FOR`] passed since the last dial, or else opens a new
/// connection when the kept one is due, on the route to the internet `outward`: how long until the
/// next is due.
fn refresh(slot: &Slot, outward: Outward) -> Option<Duration> {
    let mut keeping = lock(slot);
    let now = SystemTime::now();
    let used = keeping.as_ref()?.used;
    if now.duration_since(used).unwrap_or_default() >= KEEP_FOR {
        debug!("no relay dial lately, so the kept relay connection closes");
        *keeping = None;
        return None;
    }
    let keeping = keeping.as_mut()?;
    let due = keeping
        .kept
        .as_ref()
        .and_then(|kept| kept.fresh(now, outward))
        .and_then(|age| REPLACE_AFTER.checked_sub(age))
        .filter(|due| !due.is_zero());
    if due.is_none() {
        keeping.kept = Some(keeping.open(outward));
    }
    Some(due.unwrap_or(REPLACE_AFTER))
}

/// Whether `slot` keeps a fresh connection to the relay at `url` for the dial this task runs.
fn kept_for(slot: &Slot, url: &str) -> bool {
    let Some(scope) = crate::local_dial::current() else {
        return false;
    };
    let outward = super::outward();
    lock(slot)
        .as_ref()
        .filter(|keeping| keeping.serves(url, &scope))
        .and_then(|keeping| keeping.kept.as_ref())
        .is_some_and(|kept| kept.fresh(SystemTime::now(), outward).is_some())
}

/// The connection `slot` keeps to the relay at `url`, for the dial this task runs, if it's fresh.
/// A new one opens in its place at once, so the next dial finds one too.
fn take_kept(slot: &Slot, url: &str) -> Option<Connecting> {
    let scope = crate::local_dial::current()?;
    let outward = super::outward();
    let mut keeping = lock(slot);
    let keeping = keeping
        .as_mut()
        .filter(|keeping| keeping.serves(url, &scope))?;
    let now = SystemTime::now();
    let kept = keeping
        .kept
        .take()
        .filter(|kept| kept.fresh(now, outward).is_some());
    keeping.kept = Some(keeping.open(outward));
    let mut connecting = kept?.connecting;
    connecting.kept = true;
    scope.took_kept();
    Some(connecting)
}

/// What an upgrade answers: the WebSocket, or the HTTP status the relay refused it with, if any.
type Upgraded = Result<WebSocketStream<Stream>, (Option<u16>, Error)>;

/// [`super::upgrade`] to the relay at `url`, over `early` when it's open first. A new connection
/// stands in when `early` isn't open yet and the new one opens first, and when `early` failed. It
/// also asks again when `early` fails before the relay answered the upgrade, as a connection the
/// relay closed for being idle would, or gives no answer within [`EARLY_ANSWER`], as one left on a
/// network the computer moved off would. Then the relay saw no request, or answered none this
/// route will read. A kept connection gets [`kept_or_new`] instead. `first` goes behind each
/// request, as [`super::upgrade_with`] sends it.
pub(super) async fn upgrade(
    early: Connecting,
    url: &str,
    path: &str,
    headers: &[(&'static str, &str)],
    first: &[u8],
) -> Result<WebSocketStream<Stream>, (Option<u16>, Error)> {
    let base = Base::parse(url).map_err(|e| (None, e.into()))?;
    let kept = early.kept;
    let (stream, was_early) = open(early, &base).await.map_err(|e| (None, e.into()))?;
    let upgrading = super::upgrade_over(&base, stream, path, headers, first);
    if !was_early {
        return upgrading.await;
    }
    if kept {
        return Box::pin(kept_or_new(upgrading, url, path, headers, first)).await;
    }
    match tokio::time::timeout(EARLY_ANSWER, upgrading).await {
        Ok(Err((None, error))) => {
            debug!(%error, "the early relay connection failed, so a new one asks");
            super::upgrade_with(url, path, headers, first).await
        }
        Err(_) => {
            debug!("the relay didn't answer over the early connection, so a new one asks");
            super::upgrade_with(url, path, headers, first).await
        }
        Ok(upgraded) => upgraded,
    }
}

/// `upgrading`, an upgrade over a kept connection, with a new connection asking too once it has no
/// answer within [`KEPT_ANSWER`] (PLX-1602). The first answer wins and the other is dropped, except
/// that a refusal over the new one waits for the kept one's answer. One that fails with no answer
/// leaves the other, and the kept one gets [`EARLY_ANSWER`] in all. A
/// kept connection that fails within [`KEPT_ANSWER`] gives way to a new one at once.
async fn kept_or_new(
    upgrading: impl Future<Output = Upgraded>,
    url: &str,
    path: &str,
    headers: &[(&'static str, &str)],
    first: &[u8],
) -> Upgraded {
    use futures_util::future::{Either, select};
    let silent = || {
        let error = Error::Protocol("the relay didn't answer over the kept connection".to_owned());
        (None, error)
    };
    let mut kept = std::pin::pin!(async {
        tokio::time::timeout(EARLY_ANSWER, upgrading)
            .await
            .unwrap_or_else(|_| Err(silent()))
    });
    if let Ok(answered) = tokio::time::timeout(KEPT_ANSWER, &mut kept).await {
        if !matches!(answered, Err((None, _))) {
            return answered;
        }
        debug!("the kept relay connection failed, so a new one asks");
        return super::upgrade_with(url, path, headers, first).await;
    }
    debug!("no answer over the kept relay connection yet, so a new one asks too");
    crate::connect_timing::mark("kept_raced");
    let new = Box::pin(super::upgrade_with(url, path, headers, first));
    let gave_way = || crate::connect_timing::mark("kept_gave_way");
    match select(kept, new).await {
        Either::Left((Err((None, _)), new)) => {
            gave_way();
            new.await
        }
        Either::Left((answered, _)) => answered,
        Either::Right((Err((None, _)), kept)) => kept.await,
        // A refusal, such as a 429 because the kept upgrade took the host's last open, waits for
        // the kept one, which may still connect.
        Either::Right((Err(refused), kept)) => match kept.await {
            Err((None, _)) => {
                gave_way();
                Err(refused)
            }
            answered => answered,
        },
        Either::Right((answered, _)) => {
            gave_way();
            answered
        }
    }
}

/// `early`'s connection if it opens first, else a new one to `base` if that does, and whether it
/// was `early`'s. The other is dropped. A failed `early` leaves the new one.
async fn open(early: Connecting, base: &Base) -> io::Result<(Stream, bool)> {
    let new = async { base.connect(Roots::WithOs).await.map(|s| (s, false)) };
    if early.task.is_finished() {
        // Open, so no new connection starts. One that failed costs only the new one.
        return match early.open().await {
            Ok(opened) => Ok(opened),
            Err(_) => new.await,
        };
    }
    let (opened, _) = futures_util::future::select_ok([early.open().boxed(), new.boxed()]).await?;
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::Message;

    use super::*;

    /// What a stand-in relay does with the first connection it accepts.
    #[derive(Clone, Copy, PartialEq)]
    enum First {
        /// Answers it as any other.
        Answers,
        /// Closes it without reading a byte, as Cloudflare closes a connection that sent no
        /// request in 15 s.
        Closes,
        /// Holds it and never reads, as a connection on a network the computer left looks.
        Ignores,
        /// Answers it [`SLOW`] late, and every later one [`SLOWER`] late, as a busy Worker would.
        Slow,
        /// Answers it [`SLOW`] late, and refuses every later upgrade with a 429 at once, as the
        /// relay does once the first took the host's last open.
        SlowThenRefuses,
    }

    /// How late [`First::Slow`] answers the first connection: past [`KEPT_ANSWER`].
    const SLOW: Duration = Duration::from_millis(1_300);
    /// How late [`First::Slow`] answers the rest.
    const SLOWER: Duration = Duration::from_secs(2);

    /// A relay on loopback that answers `/connect` with `ready` and echoes binary frames. Each
    /// connection it accepts counts in `accepted`. `first` says what it does with the first.
    async fn relay(first: First) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&accepted);
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                match (counted.fetch_add(1, Ordering::SeqCst), first) {
                    (0, First::Closes) => drop(tcp),
                    (0, First::Ignores) => {
                        tokio::spawn(async move {
                            let _held = tcp;
                            std::future::pending::<()>().await;
                        });
                    }
                    (0, First::SlowThenRefuses) => {
                        tokio::spawn(async move {
                            tokio::time::sleep(SLOW).await;
                            answer(tcp).await;
                        });
                    }
                    (_, First::SlowThenRefuses) => {
                        tokio::spawn(refuse(tcp));
                    }
                    (n, First::Slow) => {
                        tokio::spawn(async move {
                            tokio::time::sleep(if n == 0 { SLOW } else { SLOWER }).await;
                            answer(tcp).await;
                        });
                    }
                    _ => {
                        tokio::spawn(answer(tcp));
                    }
                }
            }
        });
        (url, accepted)
    }

    /// Reads a request's head from `tcp` and answers 429.
    async fn refuse(mut tcp: TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if tcp.read(&mut byte).await.unwrap_or(0) == 0 {
                return;
            }
            head.push(byte[0]);
        }
        let refused = b"HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n";
        let _ = tcp.write_all(refused).await;
    }

    async fn answer(tcp: TcpStream) {
        let mut socket = super::super::tests::accept(tcp).await;
        socket.send(Message::text("ready")).await.unwrap();
        while let Some(Ok(frame)) = socket.next().await {
            if frame.is_binary() {
                socket.send(frame).await.unwrap();
            }
        }
    }

    /// `relay`'s `/connect` through [`super::super::stream_at`], inside [`ahead`] as a race runs
    /// it, after `wait`, the head start. The stream echoes.
    async fn connect_after(url: &str, wait: Duration) {
        let early = Early {
            url: url.to_owned(),
            connecting: Arc::new(Mutex::new(None)),
        };
        let base = Base::parse(url).unwrap();
        *early.connecting.lock().unwrap() = Some(Connecting::new(tokio::spawn(async move {
            base.connect(Roots::WithOs).await
        })));
        EARLY
            .scope(early, async {
                tokio::time::sleep(wait).await;
                echoes(super::super::stream_at(url, "tok", "h")).await;
            })
            .await;
    }

    /// Writes to `stream` and reads the stand-in relay's echo, which needs the stream open.
    async fn echoes(mut stream: super::super::ClientStream) {
        stream.write_all(b"ping").await.unwrap();
        let mut echoed = [0; 4];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
    }

    #[tokio::test]
    async fn the_relay_route_uses_the_connection_opened_during_the_head_start() {
        let (url, accepted) = relay(First::Answers).await;
        connect_after(&url, Duration::from_millis(50)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_early_connection_the_relay_closed_gives_way_to_a_new_one() {
        let (url, accepted) = relay(First::Closes).await;
        connect_after(&url, Duration::from_millis(50)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_early_connection_that_never_answers_gives_way_to_a_new_one() {
        let (url, accepted) = relay(First::Ignores).await;
        let connected = connect_after(&url, Duration::from_millis(50));
        tokio::time::timeout(EARLY_ANSWER + Duration::from_secs(5), connected)
            .await
            .expect("a new connection asked once the early one had no answer");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_early_connection_that_failed_gives_way_to_a_new_one() {
        let (url, accepted) = relay(First::Answers).await;
        // Nothing listens there, so the early connection fails at once.
        let early = Early {
            url: url.clone(),
            connecting: Arc::new(Mutex::new(Some(Connecting::new(tokio::spawn(async {
                Err(io::Error::from(io::ErrorKind::ConnectionRefused))
            }))))),
        };
        EARLY
            .scope(early, async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                echoes(super::super::stream_at(&url, "tok", "h")).await;
            })
            .await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_early_connection_still_opening_races_a_new_one() {
        let (url, accepted) = relay(First::Answers).await;
        // An early connection whose handshake hangs, as one started on a network that went away.
        let early = Early {
            url: url.clone(),
            connecting: Arc::new(Mutex::new(Some(Connecting::new(tokio::spawn(
                std::future::pending(),
            ))))),
        };
        let connected = EARLY.scope(early, async {
            echoes(super::super::stream_at(&url, "tok", "h")).await;
        });
        tokio::time::timeout(Duration::from_secs(5), connected)
            .await
            .expect("the new connection won");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn another_relay_or_no_race_takes_nothing() {
        let early = Early {
            url: "http://127.0.0.1:1".to_owned(),
            connecting: Arc::new(Mutex::new(Some(Connecting::new(tokio::spawn(
                std::future::pending(),
            ))))),
        };
        assert!(take("http://127.0.0.1:1").is_none(), "no race runs");
        EARLY
            .scope(early, async {
                assert!(take("http://127.0.0.1:2").is_none());
                assert!(take("http://127.0.0.1:1").is_some());
                assert!(take("http://127.0.0.1:1").is_none(), "taken once");
            })
            .await;
    }

    /// Waits up to 5 s for `accepted` to reach `count`.
    async fn accepts(accepted: &AtomicUsize, count: usize) {
        for _ in 0..500 {
            if accepted.load(Ordering::SeqCst) >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "the relay accepted {} connections, not {count}",
            accepted.load(Ordering::SeqCst)
        );
    }

    /// A dial's scope inside plxd, signed in to the relay at `url`.
    fn dial_scope(url: &str) -> Arc<Scope> {
        let relay = Some((url.to_owned(), "tok".to_owned()));
        Arc::new(Scope::new(relay, Vec::new(), false))
    }

    /// A slot of its own, so tests don't share [`KEPT`].
    fn slot() -> &'static Slot {
        Box::leak(Box::new(Mutex::new(None)))
    }

    #[tokio::test]
    async fn a_relay_dial_takes_the_kept_connection_and_another_opens_for_the_next() {
        let (url, accepted) = relay(First::Answers).await;
        crate::local_dial::within(Some(dial_scope(&url)), async {
            dialed();
            accepts(&accepted, 1).await;
            let opened = |slot: &Slot| lock(slot).as_ref().unwrap().kept.as_ref().unwrap().opened;
            let before = opened(&KEPT);
            echoes(super::super::stream_at(&url, "tok", "h")).await;
            accepts(&accepted, 2).await;
            assert_ne!(
                opened(&KEPT),
                before,
                "a new one replaced the one the dial took"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                accepted.load(Ordering::SeqCst),
                2,
                "the dial went over the kept connection, not a new one"
            );
        })
        .await;
        if let Some(keeping) = lock(&KEPT).take() {
            keeping.keeper.abort();
        }
    }

    #[tokio::test]
    async fn a_kept_connection_the_relay_closed_gives_way_to_a_new_one_at_once() {
        let (url, accepted) = relay(First::Closes).await;
        let slot = slot();
        crate::local_dial::within(Some(dial_scope(&url)), async {
            dialed_in(slot);
            accepts(&accepted, 1).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            let kept = take_kept(slot, &url).expect("a fresh kept connection");
            let started = std::time::Instant::now();
            let path = "/v1/hosts/h/connect";
            upgrade(kept, &url, path, &[], &[]).await.unwrap();
            assert!(
                started.elapsed() < EARLY_ANSWER,
                "it didn't wait for an answer"
            );
        })
        .await;
        lock(slot).take().unwrap().keeper.abort();
    }

    /// Takes the connection `slot` keeps to the stand-in relay at `url`, whose connections count in
    /// `accepted`, upgrades over it, and answers how long the upgrade took.
    async fn upgrade_over_kept(slot: &'static Slot, url: &str, accepted: &AtomicUsize) -> Duration {
        dialed_in(slot);
        accepts(accepted, 1).await;
        let kept = take_kept(slot, url).expect("a fresh kept connection");
        let started = std::time::Instant::now();
        let upgraded = upgrade(kept, url, "/v1/hosts/h/connect", &[], &[]).await;
        let took = started.elapsed();
        echoes_over(upgraded.unwrap()).await;
        lock(slot).take().unwrap().keeper.abort();
        took
    }

    /// Reads `ready` from the stand-in relay's WebSocket, then checks it echoes.
    async fn echoes_over(mut socket: WebSocketStream<Stream>) {
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::text("ready")
        );
        socket.send(Message::binary(&b"ping"[..])).await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::binary(&b"ping"[..])
        );
    }

    #[tokio::test]
    async fn a_kept_connection_that_never_answers_gives_way_within_kept_answer() {
        let (url, accepted) = relay(First::Ignores).await;
        let took = crate::local_dial::within(Some(dial_scope(&url)), async {
            upgrade_over_kept(slot(), &url, &accepted).await
        })
        .await;
        assert!(took >= KEPT_ANSWER, "it asked again before {KEPT_ANSWER:?}");
        assert!(
            took < EARLY_ANSWER / 2,
            "it waited {took:?}, not {KEPT_ANSWER:?} and a new connection"
        );
        // The kept one, the one that replaced it, and the new one that asked.
        assert_eq!(accepted.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_kept_connection_that_answers_late_still_wins_the_race() {
        let (url, accepted) = relay(First::Slow).await;
        let took = crate::local_dial::within(Some(dial_scope(&url)), async {
            upgrade_over_kept(slot(), &url, &accepted).await
        })
        .await;
        assert!(
            took < KEPT_ANSWER + SLOWER,
            "it took {took:?}, so the new connection's answer won, not the kept one's"
        );
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            3,
            "a new connection asked too"
        );
    }

    #[tokio::test]
    async fn a_refusal_over_the_new_connection_waits_for_the_kept_ones_answer() {
        let (url, accepted) = relay(First::SlowThenRefuses).await;
        crate::local_dial::within(Some(dial_scope(&url)), async {
            upgrade_over_kept(slot(), &url, &accepted).await
        })
        .await;
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            3,
            "a new connection asked too"
        );
    }

    #[tokio::test]
    async fn taking_the_kept_connection_doesnt_extend_the_5_minutes() {
        let (url, accepted) = relay(First::Answers).await;
        let slot = slot();
        crate::local_dial::within(Some(dial_scope(&url)), async {
            dialed_in(slot);
            accepts(&accepted, 1).await;
            let used = SystemTime::now() - Duration::from_secs(60);
            lock(slot).as_mut().unwrap().used = used;
            take_kept(slot, &url).expect("a fresh kept connection");
            assert_eq!(
                lock(slot).as_ref().unwrap().used,
                used,
                "only a dial that connected over the relay keeps it longer"
            );
        })
        .await;
        lock(slot).take().unwrap().keeper.abort();
    }

    #[tokio::test]
    async fn a_kept_connection_too_old_or_from_another_network_isnt_taken() {
        let outward = (Some(IpAddr::from([192, 168, 1, 2])), None);
        let kept = |age: u64| Kept {
            connecting: Connecting::new(tokio::spawn(std::future::pending())),
            opened: SystemTime::now() - Duration::from_secs(age),
            outward,
        };
        let now = SystemTime::now();
        assert!(kept(9).fresh(now, outward).is_some());
        assert!(
            kept(13).fresh(now, outward).is_none(),
            "Cloudflare closes it at 15 s"
        );
        let moved = (Some(IpAddr::from([10, 0, 0, 5])), None);
        assert!(kept(1).fresh(now, moved).is_none());
    }

    #[tokio::test]
    async fn the_keeper_replaces_the_connection_at_10_s_and_stops_after_5_minutes() {
        let slot = slot();
        let outward = (Some(IpAddr::from([192, 168, 1, 2])), None);
        let ago = |secs: u64| SystemTime::now() - Duration::from_secs(secs);
        *lock(slot) = Some(Keeping {
            url: "http://127.0.0.1:1".to_owned(),
            scope: Arc::new(Scope::new(None, Vec::new(), false)),
            used: ago(60),
            kept: Some(Kept {
                connecting: Connecting::new(tokio::spawn(std::future::pending())),
                opened: ago(4),
                outward,
            }),
            keeper: tokio::spawn(async {}),
        });
        let wait = refresh(slot, outward).unwrap();
        assert!(wait <= Duration::from_secs(6), "due at 10 s, in {wait:?}");

        lock(slot).as_mut().unwrap().kept.as_mut().unwrap().opened = ago(10);
        assert_eq!(refresh(slot, outward), Some(REPLACE_AFTER));
        let opened = lock(slot).as_ref().unwrap().kept.as_ref().unwrap().opened;
        assert!(opened > ago(1), "a new one opened");

        lock(slot).as_mut().unwrap().used = ago(KEEP_FOR.as_secs());
        assert_eq!(refresh(slot, outward), None);
        assert!(
            lock(slot).is_none(),
            "nothing is kept once no dial used the relay for a while"
        );
    }
}
