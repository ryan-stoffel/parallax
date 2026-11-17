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

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_util::FutureExt as _;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tracing::debug;

use super::{Base, Roots, Stream};
use crate::remote::Error;

/// How long the relay route waits for the relay to answer its upgrade over an early connection
/// before it asks again on a new one. The answer takes about 200 ms at the median on Wi-Fi
/// (PLX-1549), and a route has 10 s in all, so a slow relay is rarely asked twice and a dead
/// connection leaves time for the new one.
const EARLY_ANSWER: Duration = Duration::from_secs(3);

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
pub(super) struct Connecting(JoinHandle<io::Result<Stream>>);

impl Drop for Connecting {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Connecting {
    /// The connection, once open: an early one.
    async fn open(mut self) -> io::Result<(Stream, bool)> {
        match (&mut self.0).await {
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
    let scope = crate::local_dial::current();
    let connecting = Connecting(tokio::spawn(crate::local_dial::within(scope, async move {
        base.connect(Roots::WithOs).await
    })));
    let early = Early {
        url,
        connecting: Arc::new(Mutex::new(Some(connecting))),
    };
    EARLY.scope(early, race).await
}

/// The early connection to the relay at `url`, if this task's race has one no route took yet.
pub(super) fn take(url: &str) -> Option<Connecting> {
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

/// [`super::upgrade`] to the relay at `url`, over `early` when it's open first. A new connection
/// stands in when `early` isn't open yet and the new one opens first, and when `early` failed. It
/// also asks again when `early` fails before the relay answered the upgrade, as a connection the
/// relay closed for being idle would, or gives no answer within [`EARLY_ANSWER`], as one left on a
/// network the computer moved off would. Then the relay saw no request, or answered none this
/// route will read. `first` goes behind each request, as [`super::upgrade_with`] sends it.
pub(super) async fn upgrade(
    early: Connecting,
    url: &str,
    path: &str,
    headers: &[(&'static str, &str)],
    first: &[u8],
) -> Result<WebSocketStream<Stream>, (Option<u16>, Error)> {
    let base = Base::parse(url).map_err(|e| (None, e.into()))?;
    let (stream, was_early) = open(early, &base).await.map_err(|e| (None, e.into()))?;
    let upgrading = super::upgrade_over(&base, stream, path, headers, first);
    if !was_early {
        return upgrading.await;
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

/// `early`'s connection if it opens first, else a new one to `base` if that does, and whether it
/// was `early`'s. The other is dropped. A failed `early` leaves the new one.
async fn open(early: Connecting, base: &Base) -> io::Result<(Stream, bool)> {
    let new = async { base.connect(Roots::WithOs).await.map(|s| (s, false)) };
    if early.0.is_finished() {
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
    }

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
                    _ => {
                        tokio::spawn(answer(tcp));
                    }
                }
            }
        });
        (url, accepted)
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
        *early.connecting.lock().unwrap() = Some(Connecting(tokio::spawn(async move {
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
            connecting: Arc::new(Mutex::new(Some(Connecting(tokio::spawn(async {
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
            connecting: Arc::new(Mutex::new(Some(Connecting(tokio::spawn(
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
            connecting: Arc::new(Mutex::new(Some(Connecting(tokio::spawn(
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
}
