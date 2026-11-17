//! The remote listener's TLS (PLX-1585): a stream over [`rustls::ServerConnection`] that reads a
//! resumed client's early data and answers it before the client's Finished, which tokio-rustls's
//! acceptor can't do, since it finishes the whole handshake before plxd reads anything.
//!
//! [`accept`] runs the handshake as far as the `ClientHello`. A client that resumed with early data
//! gets the stream at once: its reads give the early data, then what comes after the handshake,
//! and its first write goes out together with the server's handshake flight. Any other client gets
//! it once the handshake is done, as before.
//!
//! What the client may have sent with early data is limited by the caller: [`Stream::handshake`]
//! says whether the client's Finished checked out, and [`Stream::finish`] waits for it. A replayed
//! `ClientHello` never gets that far, since its ticket was taken on first use ([`remote::tickets`]).
//!
//! The session ticket rustls queues after the client's Finished isn't written by itself until plxd
//! has written something: on a full handshake it then leaves in the same write as the 101, not just
//! before it, where Nagle on a hop of the relay's path held it 40 ms (PLX-1512). Once plxd has
//! written, it goes as soon as it's queued.
//!
//! [`remote::tickets`]: crate::remote

use std::future::poll_fn;
use std::io::{self, Read as _, Write as _};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, ready};

use rustls::{ServerConfig, ServerConnection};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

/// Whether a connection's handshake is done, which is when the client's Finished checked out.
#[derive(Debug, Default)]
pub(crate) struct Handshake {
    done: AtomicBool,
    finished: Notify,
}

impl Handshake {
    /// Whether the client's Finished checked out.
    pub(crate) fn done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    /// Returns once the client's Finished checked out. Something must be reading the stream.
    pub(crate) async fn wait(&self) {
        loop {
            let finished = self.finished.notified();
            if self.done() {
                return;
            }
            finished.await;
        }
    }

    pub(super) fn finish(&self) {
        if !self.done.swap(true, Ordering::AcqRel) {
            self.finished.notify_waiters();
        }
    }
}

/// A server's TLS connection over `IO`, from [`accept`].
pub(crate) struct Stream<IO> {
    io: IO,
    conn: ServerConnection,
    handshake: Arc<Handshake>,
    /// plxd has written plaintext, so what rustls queues after it may go at once.
    wrote: bool,
    /// The connection's reads have ended.
    eof: bool,
    closing: bool,
}

impl<IO> std::fmt::Debug for Stream<IO> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream")
            .field("handshake", &self.handshake.done())
            .finish_non_exhaustive()
    }
}

/// Runs the server's side of TLS over `io` until the client's `ClientHello` resumed a session with
/// early data, or else until the handshake is done.
///
/// # Errors
///
/// When the handshake fails or the connection ends first.
pub(crate) async fn accept<IO>(config: Arc<ServerConfig>, io: IO) -> io::Result<Stream<IO>>
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let conn = ServerConnection::new(config).map_err(io::Error::other)?;
    let mut stream = Stream {
        io,
        conn,
        handshake: Arc::default(),
        wrote: false,
        eof: false,
        closing: false,
    };
    poll_fn(|cx| stream.poll_accept(cx)).await?;
    Ok(stream)
}

impl<IO: AsyncRead + AsyncWrite + Unpin> Stream<IO> {
    /// Whether the handshake is done, shared for whoever reads what came with early data.
    pub(crate) fn handshake(&self) -> Arc<Handshake> {
        Arc::clone(&self.handshake)
    }

    /// Finishes the handshake, keeping what the client sent meanwhile for later reads.
    ///
    /// # Errors
    ///
    /// When the handshake fails or the connection ends first.
    pub(crate) async fn finish(&mut self) -> io::Result<()> {
        poll_fn(|cx| self.poll_finish(cx)).await
    }

    fn poll_accept(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            self.check_handshake();
            // A resumed client's early data waits for no one, and the server's flight waits for
            // the first answer, so both leave in one write.
            if self.handshake.done() || self.conn.early_data().is_some() {
                return Poll::Ready(Ok(()));
            }
            ready!(self.poll_handshake_step(cx))?;
        }
    }

    fn poll_finish(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            self.check_handshake();
            if self.handshake.done() {
                return Poll::Ready(Ok(()));
            }
            ready!(self.poll_handshake_step(cx))?;
        }
    }

    /// Writes what the handshake has queued, then reads and processes more of it.
    fn poll_handshake_step(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while self.conn.wants_write() {
            if ready!(self.write_io(cx))? == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
        }
        ready!(Pin::new(&mut self.io).poll_flush(cx))?;
        if ready!(self.read_io(cx))? == 0 {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the connection ended in the TLS handshake",
            )));
        }
        Poll::Ready(Ok(()))
    }

    fn check_handshake(&self) {
        if !self.conn.is_handshaking() {
            self.handshake.finish();
        }
    }

    /// Writes what rustls queued, best effort, without waiting.
    fn try_write(&mut self, cx: &mut Context<'_>) {
        while self.conn.wants_write() {
            match self.write_io(cx) {
                Poll::Ready(Ok(n)) if n > 0 => {}
                _ => break,
            }
        }
    }

    fn read_io(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let mut reader = SyncRead {
            io: &mut self.io,
            cx,
        };
        let read = match self.conn.read_tls(&mut reader) {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Poll::Pending,
            Err(error) => return Poll::Ready(Err(error)),
        };
        if read == 0 {
            self.eof = true;
        }
        if let Err(error) = self.conn.process_new_packets() {
            // The alert, if one is queued.
            self.try_write(cx);
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, error)));
        }
        self.check_handshake();
        Poll::Ready(Ok(read))
    }

    fn write_io(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let mut writer = SyncWrite {
            io: &mut self.io,
            cx,
        };
        match self.conn.write_tls(&mut writer) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
            result => Poll::Ready(result),
        }
    }
}

impl<IO: AsyncRead + AsyncWrite + Unpin> AsyncRead for Stream<IO> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            // Early data comes before anything sent after the handshake.
            if let Some(mut early) = this.conn.early_data() {
                let read = early.read(buf.initialize_unfilled())?;
                if read > 0 {
                    buf.advance(read);
                    return Poll::Ready(Ok(()));
                }
            }
            match this.conn.reader().read(buf.initialize_unfilled()) {
                Ok(read) => {
                    buf.advance(read);
                    return Poll::Ready(Ok(()));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Poll::Ready(Err(error)),
            }
            if this.eof {
                return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
            }
            // The client waits on the handshake's flight. A ticket waits for plxd's first write,
            // unless that already went (PLX-1512).
            if this.conn.is_handshaking() || this.wrote {
                this.try_write(cx);
            }
            ready!(this.read_io(cx))?;
        }
    }
}

impl<IO: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Stream<IO> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let written = this.conn.writer().write(buf)?;
        if written > 0 {
            this.wrote = true;
        }
        let mut blocked = false;
        while this.conn.wants_write() {
            match this.write_io(cx) {
                Poll::Ready(Ok(0)) | Poll::Pending => {
                    blocked = true;
                    break;
                }
                Poll::Ready(Ok(_)) => {}
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            }
        }
        if written == 0 && blocked {
            return Poll::Pending;
        }
        Poll::Ready(Ok(written))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.conn.writer().flush()?;
        while this.conn.wants_write() {
            if ready!(this.write_io(cx))? == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
        }
        Pin::new(&mut this.io).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.closing {
            this.closing = true;
            this.conn.send_close_notify();
        }
        while this.conn.wants_write() {
            if ready!(this.write_io(cx))? == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
        }
        match ready!(Pin::new(&mut this.io).poll_shutdown(cx)) {
            Err(error) if error.kind() != io::ErrorKind::NotConnected => Poll::Ready(Err(error)),
            _ => Poll::Ready(Ok(())),
        }
    }
}

/// `io` as [`io::Read`], with a pending read as `WouldBlock`.
struct SyncRead<'a, 'b, IO> {
    io: &'a mut IO,
    cx: &'a mut Context<'b>,
}

impl<IO: AsyncRead + Unpin> io::Read for SyncRead<'_, '_, IO> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut buf = ReadBuf::new(buf);
        match Pin::new(&mut *self.io).poll_read(self.cx, &mut buf) {
            Poll::Ready(Ok(())) => Ok(buf.filled().len()),
            Poll::Ready(Err(error)) => Err(error),
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }
}

/// `io` as [`io::Write`], with a pending write as `WouldBlock`. rustls hands it every queued
/// record at once, so they go in one write where `io` takes them.
struct SyncWrite<'a, 'b, IO> {
    io: &'a mut IO,
    cx: &'a mut Context<'b>,
}

impl<IO: AsyncWrite + Unpin> io::Write for SyncWrite<'_, '_, IO> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match Pin::new(&mut *self.io).poll_write(self.cx, buf) {
            Poll::Ready(result) => result,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
        match Pin::new(&mut *self.io).poll_write_vectored(self.cx, bufs) {
            Poll::Ready(result) => result,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match Pin::new(&mut *self.io).poll_flush(self.cx) {
            Poll::Ready(result) => result,
            Poll::Pending => Err(io::ErrorKind::WouldBlock.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream, duplex};
    use tokio_rustls::TlsConnector;

    use super::*;
    use crate::remote::{self, HostKey};

    /// A connection that counts the writes that put bytes on it, and keeps a copy of them.
    struct Counted {
        inner: DuplexStream,
        writes: Arc<AtomicUsize>,
        sent: Arc<Mutex<Vec<u8>>>,
    }

    impl Counted {
        fn new(inner: DuplexStream) -> Self {
            Counted {
                inner,
                writes: Arc::default(),
                sent: Arc::default(),
            }
        }

        fn wrote(&self, bytes: &[u8]) {
            self.writes.fetch_add(1, Ordering::Relaxed);
            self.sent.lock().unwrap().extend_from_slice(bytes);
        }
    }

    impl AsyncRead for Counted {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Counted {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            let wrote = ready!(Pin::new(&mut self.inner).poll_write(cx, buf))?;
            self.wrote(&buf[..wrote]);
            Poll::Ready(Ok(wrote))
        }

        fn poll_write_vectored(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bufs: &[io::IoSlice<'_>],
        ) -> Poll<io::Result<usize>> {
            let joined: Vec<u8> = bufs.iter().flat_map(|buf| buf.iter().copied()).collect();
            self.poll_write(cx, &joined)
        }

        fn is_write_vectored(&self) -> bool {
            true
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    const REQUEST: &[u8] = b"GET /ws HTTP/1.1\r\n\r\n";
    const ANSWER: &[u8] = b"HTTP/1.1 101 Switching Protocols\r\n\r\n";

    struct Served {
        /// Whether the client's Finished had checked out when plxd read the request.
        done_at_request: bool,
        /// The writes after `accept`, up to and with the answer.
        writes_to_answer: usize,
    }

    /// The listener's side of one connection: reads [`REQUEST`] and answers [`ANSWER`].
    async fn serve(config: Arc<ServerConfig>, io: DuplexStream) -> Served {
        let counted = Counted::new(io);
        let writes = Arc::clone(&counted.writes);
        let mut stream = accept(config, counted).await.unwrap();
        let before = writes.load(Ordering::Relaxed);
        let mut request = vec![0; REQUEST.len()];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, REQUEST);
        let done_at_request = stream.handshake().done();
        stream.write_all(ANSWER).await.unwrap();
        stream.flush().await.unwrap();
        let writes_to_answer = writes.load(Ordering::Relaxed) - before;
        // Reads on, so a late Finished and the ticket after it go through.
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest).await;
        Served {
            done_at_request,
            writes_to_answer,
        }
    }

    /// A dial's side: the request as early data when a ticket allows it, then the answer. Whether
    /// the host took the early data, and every byte the client sent.
    async fn dial(pin: &remote::Pin, io: DuplexStream) -> (bool, Vec<u8>) {
        let counted = Counted::new(io);
        let sent = Arc::clone(&counted.sent);
        let config = remote::resuming_config(pin).unwrap();
        let name = ServerName::try_from("parallax").unwrap();
        let mut tls = TlsConnector::from(config)
            .early_data(true)
            .connect(name, counted)
            .await
            .unwrap();
        if !tls.get_ref().1.is_handshaking() {
            // The request on its own, after the Finished, as one over a network may come.
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tls.write_all(REQUEST).await.unwrap();
        tls.flush().await.unwrap();
        let mut answer = vec![0; ANSWER.len()];
        tls.read_exact(&mut answer).await.unwrap();
        assert_eq!(answer, ANSWER);
        // Reads the ticket that follows the answer.
        let _ = tokio::time::timeout(Duration::from_millis(100), tls.read(&mut [0; 64])).await;
        let accepted = tls.get_ref().1.is_early_data_accepted();
        tls.shutdown().await.unwrap();
        let sent = sent.lock().unwrap().clone();
        (accepted, sent)
    }

    async fn connect(config: &Arc<ServerConfig>, pin: &remote::Pin) -> (Served, bool, Vec<u8>) {
        let (near, far) = duplex(64 * 1024);
        let served = tokio::spawn(serve(Arc::clone(config), far));
        let (accepted, sent) = dial(pin, near).await;
        (served.await.unwrap(), accepted, sent)
    }

    #[tokio::test]
    async fn a_resumed_dial_is_answered_before_its_finished_and_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        let config = key.server_config().unwrap();
        let pin = remote::Pin::Fingerprint(key.fingerprint.clone());

        // A full handshake. The ticket waits for the answer and goes in the same write (PLX-1512).
        let (served, accepted, _) = connect(&config, &pin).await;
        assert!(!accepted);
        assert!(served.done_at_request);
        assert_eq!(
            served.writes_to_answer, 1,
            "the ticket went in a write of its own"
        );

        // Resumed: the request came as early data, and was answered before the Finished, with the
        // server's flight in one write.
        let (served, accepted, flight) = connect(&config, &pin).await;
        assert!(accepted, "the host took the early data");
        assert!(!served.done_at_request, "read before the client's Finished");
        assert_eq!(served.writes_to_answer, 1);

        // The same flight again, as a captured one: its ticket was taken, so no early data comes
        // out, and the handshake waits for a Finished the replay can't send.
        let (mut near, far) = duplex(64 * 1024);
        near.write_all(&flight).await.unwrap();
        let replayed =
            tokio::time::timeout(Duration::from_millis(300), accept(Arc::clone(&config), far))
                .await;
        assert!(replayed.is_err(), "a replay got as far as plxd's reads");

        // After a restart the host has no tickets: it refuses the early data, the client sends
        // it again after the handshake, and the dial goes on.
        let restarted = key.server_config().unwrap();
        let (served, accepted, _) = connect(&restarted, &pin).await;
        assert!(!accepted);
        assert!(served.done_at_request);
    }

    #[tokio::test]
    async fn a_ticket_is_only_offered_to_its_own_pin() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        let config = key.server_config().unwrap();
        let pin = remote::Pin::Fingerprint(key.fingerprint.clone());
        let other = remote::Pin::HostId(key.host_id());
        let (_, accepted, _) = connect(&config, &pin).await;
        assert!(!accepted);
        // The same host under another pin has no ticket, so it does a full handshake.
        let (_, accepted, _) = connect(&config, &other).await;
        assert!(!accepted);
        let (_, accepted, _) = connect(&config, &pin).await;
        assert!(accepted);
    }
}
