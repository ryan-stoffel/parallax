//! Connecting to `serve` as a client (0007, 0023): a Unix socket on macOS and Linux, a named pipe
//! on Windows. [`crate::paths::DataDir::socket_path`] names either.
//!
//! On Windows any user can create a pipe under any name, so a client checks that the server runs
//! as its own user before it sends anything (`check_server`). On Unix the data folder's
//! permissions already keep other users from binding the socket.
//!
//! `serve`'s pipe is a message pipe, so that an empty message can end a client's input (see
//! [`crate::attach::bridge`]). The protocol is still NDJSON over a byte stream (0007): a client
//! writes at most [`MAX_MESSAGE_BYTES`] per message, and `serve` reads messages back to back as
//! bytes. The cap is there because mio reads a pipe through a buffer of at least 4 KiB and, when
//! a longer message is already waiting, reports the read as 0 bytes, which looks like the end of
//! the input.

use std::io;
use std::path::Path;
#[cfg(windows)]
use std::pin::Pin;
#[cfg(windows)]
use std::task::{Context, Poll};

#[cfg(windows)]
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
#[cfg(windows)]
use tokio::net::windows::named_pipe::NamedPipeClient;

/// A connection to `serve`.
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;

/// The most a client writes to `serve`'s pipe in one message: mio's smallest read buffer.
#[cfg(windows)]
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024;

/// A connection to `serve`: the pipe's client end, writing at most [`MAX_MESSAGE_BYTES`] per
/// message.
#[cfg(windows)]
#[derive(Debug)]
pub struct Stream(NamedPipeClient);

#[cfg(windows)]
impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

#[cfg(windows)]
impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let len = buf.len().min(MAX_MESSAGE_BYTES);
        Pin::new(&mut self.get_mut().0).poll_write(cx, &buf[..len])
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

/// Connects to the `serve` listening at `path`. Must be called inside a tokio runtime.
///
/// # Errors
///
/// If nothing is listening, the connection fails, or on Windows, the server runs as another user.
#[cfg(unix)]
pub async fn connect(path: &Path) -> io::Result<Stream> {
    tokio::net::UnixStream::connect(path).await
}

/// Connects to the `serve` listening at `path`. Must be called inside a tokio runtime.
///
/// # Errors
///
/// If nothing is listening, the connection fails, or the server runs as another user.
#[cfg(windows)]
pub async fn connect(path: &Path) -> io::Result<Stream> {
    // Every instance is busy only between a connection and the server's next instance, so a
    // second of retries is plenty.
    for _ in 0..100 {
        match open(path) {
            Err(error) if is_busy(&error) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            other => return other,
        }
    }
    open(path)
}

/// Opens the pipe at `path` and checks its server. Must be called inside a tokio runtime.
///
/// # Errors
///
/// As [`connect`], and `ERROR_PIPE_BUSY` when every instance is taken, which [`is_busy`] spots.
#[cfg(windows)]
pub fn open(path: &Path) -> io::Result<Stream> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new().open(path)?;
    check_server(&client)?;
    Ok(Stream(client))
}

/// Whether `error` means every instance of the pipe is taken, so a retry will likely work.
#[cfg(windows)]
#[must_use]
pub fn is_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY.cast_signed())
}

/// Checks that the server at the other end of `client` runs as this process's user.
///
/// # Errors
///
/// [`io::ErrorKind::PermissionDenied`] if it doesn't, or its user can't be read.
#[cfg(windows)]
fn check_server(client: &NamedPipeClient) -> io::Result<()> {
    let pid = crate::windows::pipe_server_pid(client)?;
    if crate::windows::runs_as_this_user(pid).unwrap_or(false) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the pipe's server (pid {pid}) doesn't run as this user"),
        ))
    }
}
