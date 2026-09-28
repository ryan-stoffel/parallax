//! `wispd attach`: how the editor reaches wispd, on this machine or over SSH (0007, 0010, 0023).
//!
//! [`connect`] reaches wispd's socket, or its named pipe on Windows, and starts wispd first if
//! nothing accepts connections there. [`bridge`] then copies stdin to the connection and the
//! connection to stdout, byte for byte, with no framing of its own. Over SSH, stdout is the
//! protocol stream, so `attach` writes nothing else there. Its own messages go to stderr, through
//! [`report`].

use std::fmt;
use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::thread;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::launch_agent::LaunchAgent;
use crate::logging;
use crate::paths::DataDir;
use crate::server::{self, EXIT_ALREADY_RUNNING};

/// `attach` exits with this when it never reached wispd: it couldn't start wispd, the `serve` it
/// started stopped, or nothing accepted a connection before the timeout.
pub const EXIT_UNAVAILABLE: u8 = 4;

/// How long `attach` waits for wispd by default: the editor's liveness window (0007).
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The longest wait [`connect`] accepts: a day. `--connect-timeout` refuses anything longer, and
/// [`connect`] shortens it to this.
pub const MAX_CONNECT_TIMEOUT: Duration = Duration::from_hours(24);

/// The first retry comes soon, since a `serve` that is starting binds its socket in milliseconds.
const FIRST_RETRY: Duration = Duration::from_millis(10);
/// Retries double up to this, which also paces starting `serve` again while another holds the
/// lock.
const MAX_RETRY: Duration = Duration::from_millis(500);
/// An error quotes the last line from at most this much of the end of the log.
const QUOTED_LOG_BYTES: u64 = 64 * 1024;
const QUOTED_LINE_CHARS: usize = 300;

/// How [`connect`] reaches wispd.
#[derive(Clone, Debug)]
pub struct Options {
    /// The `wispd` executable that runs `serve`: the running one, except in tests.
    pub program: PathBuf,
    /// How long to wait for wispd to accept a connection, including the time to start it.
    pub connect_timeout: Duration,
    /// The service that starts wispd, if one is installed for the data folder.
    pub launch_agent: Option<LaunchAgent>,
}

/// Why [`connect`] could not reach wispd.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Unavailable {
    /// The socket's path couldn't be worked out.
    #[error("could not find wispd's socket: {0}")]
    SocketPath(#[source] io::Error),
    /// Connecting failed in a way that starting wispd can't fix, such as a permission error.
    #[error("could not connect to {}: {source}", .path.display())]
    Connect {
        /// The socket.
        path: PathBuf,
        /// The error.
        #[source]
        source: io::Error,
    },
    /// `serve` couldn't be started.
    #[error("could not start wispd: {0}")]
    Start(String),
    /// The `serve` that `attach` started stopped before it accepted a connection.
    #[error(
        "wispd serve stopped before it accepted a connection ({status}){}. Its log is {}",
        .said.as_ref().map_or_else(String::new, |said| format!(": {said}")),
        .log.display()
    )]
    Exited {
        /// How it stopped.
        status: ExitStatus,
        /// The last line it wrote to its log, if any.
        said: Option<String>,
        /// The log.
        log: PathBuf,
    },
    /// Nothing accepted a connection before the timeout.
    #[error(
        "nothing accepted a connection at {} within {timeout:?}{}. wispd's log is {}",
        .socket.display(),
        .launch_agent.as_ref().map_or_else(String::new, |command| format!(" after `{command}`")),
        .log.display()
    )]
    TimedOut {
        /// The socket.
        socket: PathBuf,
        /// How long `attach` waited.
        timeout: Duration,
        /// The command that `attach` started the service with, if it started wispd that way.
        launch_agent: Option<String>,
        /// The log.
        log: PathBuf,
    },
}

/// Writes `wispd attach: <message>` to stderr.
///
/// Unlike `eprintln!`, it doesn't panic when stderr is closed, as it is once an SSH connection
/// has dropped.
pub fn report(message: impl fmt::Display) {
    let _ = writeln!(io::stderr(), "wispd attach: {message}");
}

/// A connection [`connect`] made: a std socket on Unix, which becomes tokio's inside the runtime,
/// and a tokio pipe client on Windows.
#[cfg(unix)]
pub type Connection = std::os::unix::net::UnixStream;
/// A connection [`connect`] made: a std socket on Unix, which becomes tokio's inside the runtime,
/// and a tokio pipe client on Windows.
#[cfg(windows)]
pub type Connection = crate::transport::Stream;

/// Connects to wispd's socket for `data_dir`, and starts wispd if nothing accepts connections
/// there. On Windows, it must run inside a tokio runtime (not in `block_on`), and the pipe's
/// server must run as this user (0023).
///
/// wispd is started once. That goes through the service (the `LaunchAgent` on macOS, the systemd
/// user unit on Linux) when [`Options::launch_agent`] names one. Otherwise, or if the service
/// can't be started, it spawns `serve` detached: in a new
/// session (on Windows, a new process group outside the SSH session's job), with stdin on the
/// null device, stdout and stderr appended to its log, and no other descriptors or handles. It
/// then retries with backoff until [`Options::connect_timeout`] has passed. A `serve` that exits
/// 3, because another one holds the lock, is started again at the next retry (0009). One that
/// stops any other way ends the wait.
///
/// It never stops a wispd, including one it started.
///
/// # Errors
///
/// [`Unavailable`] when no connection was made.
pub fn connect(data_dir: &DataDir, options: &Options) -> Result<Connection, Unavailable> {
    let socket = data_dir
        .socket_path()
        .map_err(Unavailable::SocketPath)?
        .path;
    if let Some(stream) = try_connect(&socket)? {
        return Ok(stream);
    }
    let timeout = options.connect_timeout.min(MAX_CONNECT_TIMEOUT);
    let deadline = Instant::now() + timeout;
    let mut starter = Starter {
        data_dir,
        options,
        launched: None,
        spawned: None,
    };
    starter.start(deadline)?;
    let mut retry = FIRST_RETRY;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(Unavailable::TimedOut {
                socket,
                timeout,
                launch_agent: starter.launched,
                log: data_dir.log_file(),
            });
        }
        thread::sleep(retry.min(deadline - now));
        retry = (retry * 2).min(MAX_RETRY);
        if let Some(stream) = try_connect(&socket)? {
            starter.reap_later();
            return Ok(stream);
        }
        starter.check()?;
    }
}

/// A connection, or `None` when nothing accepts connections at `path` yet: no socket file, or
/// one that nothing listens on.
#[cfg(unix)]
fn try_connect(path: &Path) -> Result<Option<Connection>, Unavailable> {
    use std::os::unix::fs::FileTypeExt as _;

    match Connection::connect(path) {
        Ok(stream) => Ok(Some(stream)),
        // Linux refuses a connection to a file that isn't a socket, where macOS says `ENOTSOCK`.
        // Starting `serve` can't fix that either, so both report it the same way.
        Err(error)
            if error.kind() == io::ErrorKind::ConnectionRefused
                && std::fs::metadata(path)
                    .is_ok_and(|metadata| !metadata.file_type().is_socket()) =>
        {
            Err(Unavailable::Connect {
                path: path.to_owned(),
                source: rustix::io::Errno::NOTSOCK.into(),
            })
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::WouldBlock
            ) =>
        {
            Ok(None)
        }
        Err(source) => Err(Unavailable::Connect {
            path: path.to_owned(),
            source,
        }),
    }
}

/// A connection, or `None` when nothing accepts connections at `path` yet: no pipe
/// (`ERROR_FILE_NOT_FOUND`), or every instance busy (`ERROR_PIPE_BUSY`). A server that runs as
/// another user fails at once.
#[cfg(windows)]
fn try_connect(path: &Path) -> Result<Option<Connection>, Unavailable> {
    match crate::transport::open(path) {
        Ok(client) => Ok(Some(client)),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound || crate::transport::is_busy(&error) =>
        {
            Ok(None)
        }
        Err(source) => Err(Unavailable::Connect {
            path: path.to_owned(),
            source,
        }),
    }
}

/// Starts wispd, and watches the `serve` it spawned until a connection works.
struct Starter<'a> {
    data_dir: &'a DataDir,
    options: &'a Options,
    /// The command that started the service, if wispd was started that way.
    launched: Option<String>,
    /// The `serve` spawned last, until it exits.
    spawned: Option<Spawned>,
}

struct Spawned {
    #[cfg(unix)]
    pid: rustix::process::Pid,
    #[cfg(windows)]
    child: std::process::Child,
    /// The log's length when it started, so an error can quote what it wrote.
    log_len: u64,
}

impl Starter<'_> {
    fn start(&mut self, deadline: Instant) -> Result<(), Unavailable> {
        if let Some(agent) = &self.options.launch_agent {
            match agent.start(deadline) {
                Ok(()) => {
                    self.launched = Some(agent.to_string());
                    return Ok(());
                }
                Err(error) => report(format_args!("{error}; starting wispd serve instead")),
            }
        }
        self.spawn()
    }

    // The data folder is checked first, as `serve` would check it, so the log is never created
    // through a symlink or in a folder that belongs to someone else.
    fn spawn(&mut self) -> Result<(), Unavailable> {
        server::prepare_data_dir(self.data_dir.root())
            .map_err(|error| Unavailable::Start(error.to_string()))?;
        let log_path = self.data_dir.log_file();
        let log = logging::open_log_file(&log_path).map_err(|error| {
            Unavailable::Start(format!("could not open {}: {error}", log_path.display()))
        })?;
        let log_len = log.metadata().map_or(0, |metadata| metadata.len());
        let mut command = self.data_dir.command(&self.options.program);
        command.arg("serve");
        let spawned = detach(&mut command, &log).map_err(|error| {
            Unavailable::Start(format!(
                "could not run {} serve: {error}",
                self.options.program.display()
            ))
        })?;
        self.spawned = Some(Spawned {
            #[cfg(unix)]
            pid: spawned,
            #[cfg(windows)]
            child: spawned,
            log_len,
        });
        Ok(())
    }

    /// Once connected, waits for the `serve` spawned last on a thread of its own, so one that
    /// lost the lock to another doesn't stay a zombie for as long as `attach` runs. The thread
    /// ends with the process. Windows has no zombies, so there this only lets go of it.
    fn reap_later(&mut self) {
        #[cfg(unix)]
        if let Some(spawned) = self.spawned.take() {
            thread::spawn(move || {
                let _ = rustix::process::waitpid(
                    Some(spawned.pid),
                    rustix::process::WaitOptions::empty(),
                );
            });
        }
        #[cfg(windows)]
        drop(self.spawned.take());
    }

    /// Checks on the `serve` spawned last. One that another `serve` kept out with the lock is
    /// started again.
    fn check(&mut self) -> Result<(), Unavailable> {
        let Some(spawned) = &mut self.spawned else {
            return Ok(());
        };
        let status = match exit_status(spawned) {
            Ok(None) => return Ok(()),
            Ok(Some(status)) => status,
            Err(error) => {
                return Err(Unavailable::Start(format!(
                    "could not check on wispd serve: {error}"
                )));
            }
        };
        let log_len = spawned.log_len;
        self.spawned = None;
        if status.code() == Some(i32::from(EXIT_ALREADY_RUNNING)) {
            return self.spawn();
        }
        let log = self.data_dir.log_file();
        Err(Unavailable::Exited {
            status,
            said: last_line(&log, log_len),
            log,
        })
    }
}

/// Starts `command` detached (0010): in a new session with stdin on `/dev/null`, stdout and
/// stderr on `log`, and no other descriptors.
#[cfg(unix)]
fn detach(command: &mut std::process::Command, log: &File) -> io::Result<rustix::process::Pid> {
    use std::os::fd::AsFd as _;

    let null = File::open("/dev/null").map_err(|error| {
        io::Error::new(error.kind(), format!("could not open /dev/null: {error}"))
    })?;
    let stdio = crate::spawn::Stdio {
        stdin: null.as_fd(),
        stdout: log.as_fd(),
        stderr: log.as_fd(),
    };
    crate::spawn::spawn_detached(command, stdio)
}

/// Starts `command` detached (0023): with no console, in a new process group, and broken away
/// from the SSH session's job, which Win32-OpenSSH kills when the session ends. stdin is `NUL`,
/// and stdout and stderr are `log`. attach cleared the inherit flag on all its handles at
/// startup, so those are the only handles `serve` gets. If the job forbids breaking away, it
/// starts `serve` inside the job and warns that it ends with the session.
#[cfg(windows)]
fn detach(command: &mut std::process::Command, log: &File) -> io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;

    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    };

    command
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log.try_clone()?);
    let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    match command
        .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
    {
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED.cast_signed()) => {
            report(
                "this session's job doesn't allow breaking away, so wispd serve will stop when the session ends",
            );
            command.creation_flags(flags).spawn()
        }
        spawned => spawned,
    }
}

/// How the `serve` in `spawned` exited, or `None` while it runs.
#[cfg(unix)]
fn exit_status(spawned: &mut Spawned) -> io::Result<Option<ExitStatus>> {
    use std::os::unix::process::ExitStatusExt as _;

    Ok(
        rustix::process::waitpid(Some(spawned.pid), rustix::process::WaitOptions::NOHANG)?
            .map(|(_, status)| ExitStatus::from_raw(status.as_raw())),
    )
}

/// How the `serve` in `spawned` exited, or `None` while it runs.
#[cfg(windows)]
fn exit_status(spawned: &mut Spawned) -> io::Result<Option<ExitStatus>> {
    spawned.child.try_wait()
}

/// The last line written to the log at `path` since it was `start` bytes long, cut short.
fn last_line(path: &Path, start: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(
        start.max(len.saturating_sub(QUOTED_LOG_BYTES)),
    ))
    .ok()?;
    let mut written = Vec::new();
    file.read_to_end(&mut written).ok()?;
    let written = String::from_utf8_lossy(&written);
    let line = written
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    Some(line.chars().take(QUOTED_LINE_CHARS).collect())
}

/// Copies `input` to wispd and wispd's bytes to `output`, unchanged, until wispd closes the
/// connection or `output` closes.
///
/// When `input` ends, it shuts down the connection's write side and keeps copying, so wispd
/// answers everything it was sent before it closes (0007). A named pipe has no half-close, so on
/// Windows an empty message stands in for it: `serve`'s pipe is a message pipe, where a
/// zero-byte write arrives as a zero-byte read, and tokio reads that as the end of the input
/// (see [`crate::transport`] for how the other messages stay whole). A peer that has gone away
/// ends the bridge without an error.
///
/// # Errors
///
/// Any other I/O error.
pub async fn bridge<I, O, S>(mut input: I, mut output: O, connection: S) -> io::Result<()>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite,
{
    let (mut from_wispd, mut to_wispd) = tokio::io::split(connection);
    let upstream = async {
        let copied = tokio::io::copy(&mut input, &mut to_wispd).await;
        #[cfg(unix)]
        let shut_down = to_wispd.shutdown().await;
        #[cfg(windows)]
        let shut_down = to_wispd.write(&[]).await.map(drop);
        copied.and(shut_down)
    };
    let downstream = tokio::io::copy(&mut from_wispd, &mut output);
    tokio::pin!(upstream, downstream);
    let mut sending = true;
    loop {
        tokio::select! {
            copied = &mut downstream => return gone_is_fine(copied.map(drop)),
            copied = &mut upstream, if sending => {
                sending = false;
                gone_is_fine(copied)?;
            }
        }
    }
}

fn gone_is_fine(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::NotConnected
            ) =>
        {
            Ok(())
        }
        other => other,
    }
}

#[cfg(test)]
mod log_tests {
    use std::fs;

    use super::last_line;

    #[test]
    fn an_error_quotes_the_last_line_the_new_serve_logged() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("wispd.log");
        fs::write(&log, "an older line\n").unwrap();
        let start = fs::metadata(&log).unwrap().len();
        assert_eq!(last_line(&log, start), None);

        fs::write(
            &log,
            "an older line\nERROR could not start\nwispd: it failed\n\n",
        )
        .unwrap();
        assert_eq!(last_line(&log, start).as_deref(), Some("wispd: it failed"));
        fs::write(&log, format!("an older line\n{}\n", "x".repeat(1000))).unwrap();
        assert_eq!(last_line(&log, start).map(|line| line.len()), Some(300));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::timeout;

    use super::bridge;
    use crate::server::setup::Pipe;

    const PATIENCE: Duration = Duration::from_secs(10);

    // A pipe has no half-close, so this checks the zero-byte write that stands in for one.
    #[tokio::test]
    async fn the_end_of_stdin_ends_the_servers_input_and_the_answer_still_arrives() {
        let name = format!(r"\\.\pipe\wispd-test-bridge-{}", std::process::id());
        let mut pipe = Pipe::create(name.as_ref()).unwrap();
        let client = crate::transport::connect(name.as_ref()).await.unwrap();
        let mut wispd = pipe.accept().await.unwrap();
        let (mut stdin, input) = tokio::io::duplex(1024);
        let (output, mut stdout) = tokio::io::duplex(1024);
        let bridge = tokio::spawn(bridge(input, output, client));

        stdin.write_all(b"{\"id\":1}\n").await.unwrap();
        drop(stdin);
        let mut request = Vec::new();
        timeout(PATIENCE, wispd.read_to_end(&mut request))
            .await
            .expect("wispd reads to the end of the input")
            .unwrap();
        assert_eq!(request, b"{\"id\":1}\n");

        wispd
            .write_all(b"{\"id\":1,\"result\":{}}\n")
            .await
            .unwrap();
        drop(wispd);
        let mut answer = Vec::new();
        timeout(PATIENCE, stdout.read_to_end(&mut answer))
            .await
            .expect("the answer and the end of stdout")
            .unwrap();
        assert_eq!(answer, b"{\"id\":1,\"result\":{}}\n");
        timeout(PATIENCE, bridge)
            .await
            .expect("the bridge ends")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn large_bridge_inputs_arrive_byte_for_byte() {
        for size in [64 << 10, 1 << 20] {
            let name = format!(
                r"\\.\pipe\wispd-test-bridge-large-{}-{size}",
                std::process::id()
            );
            let mut pipe = Pipe::create(name.as_ref()).unwrap();
            let client = crate::transport::connect(name.as_ref()).await.unwrap();
            let server = pipe.accept().await.unwrap();
            let (mut stdin, input) = tokio::io::duplex(8192);
            let (output, mut stdout) = tokio::io::duplex(8192);
            let bridge = tokio::spawn(bridge(input, output, client));
            let sent: Vec<u8> = (0..size).map(|i| u8::try_from(i % 251).unwrap()).collect();
            let writing = tokio::spawn({
                let sent = sent.clone();
                async move {
                    for chunk in sent.chunks(8192) {
                        stdin.write_all(chunk).await.unwrap();
                    }
                    drop(stdin);
                }
            });
            let reading = async move {
                let mut server = server;
                let mut received = Vec::new();
                server.read_to_end(&mut received).await.unwrap();
                server.write_all(b"done").await.unwrap();
                drop(server);
                received
            };
            let received = timeout(PATIENCE, reading)
                .await
                .expect("server reads all input");
            assert_eq!(received, sent, "bridge lost bytes at {size}");
            writing.await.unwrap();
            let mut answer = Vec::new();
            timeout(PATIENCE, stdout.read_to_end(&mut answer))
                .await
                .expect("bridge returns response")
                .unwrap();
            assert_eq!(answer, b"done");
            timeout(PATIENCE, bridge)
                .await
                .expect("bridge ends")
                .unwrap()
                .unwrap();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    use tokio::net::unix::pipe;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    use super::bridge;

    const PATIENCE: Duration = Duration::from_secs(10);

    /// A bridge between two pipes, standing in for stdin and stdout, and a socket whose other
    /// end stands in for wispd.
    struct Rig {
        stdin: pipe::Sender,
        stdout: pipe::Receiver,
        wispd: UnixStream,
        bridge: JoinHandle<io::Result<()>>,
    }

    fn rig() -> Rig {
        let (stdin, input) = pipe::pipe().unwrap();
        let (output, stdout) = pipe::pipe().unwrap();
        let (socket, wispd) = UnixStream::pair().unwrap();
        Rig {
            stdin,
            stdout,
            wispd,
            bridge: tokio::spawn(bridge(input, output, socket)),
        }
    }

    async fn ended(bridge: JoinHandle<io::Result<()>>) -> io::Result<()> {
        timeout(PATIENCE, bridge)
            .await
            .expect("the bridge ends")
            .expect("the bridge task")
    }

    /// Every byte value, NUL, CR, LF, and invalid UTF-8 included, and no final newline.
    fn bytes(len: usize, step: usize) -> Vec<u8> {
        (0..len)
            .map(|i| u8::try_from(i * step % 251).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn bytes_pass_both_ways_at_once_unchanged() {
        let Rig {
            mut stdin,
            mut stdout,
            wispd,
            bridge,
        } = rig();
        // Larger than every buffer on the way, so both directions must flow at the same time.
        let up = bytes(4 << 20, 7);
        let down = bytes(4 << 20, 13);

        let editor_writes = async {
            stdin.write_all(&up).await.unwrap();
            drop(stdin);
        };
        let editor_reads = async {
            let mut got = Vec::new();
            stdout.read_to_end(&mut got).await.unwrap();
            got
        };
        let wispd_side = async {
            let (mut read, mut write) = wispd.into_split();
            let reads = async {
                let mut got = Vec::new();
                read.read_to_end(&mut got).await.unwrap();
                got
            };
            let writes = async {
                write.write_all(&down).await.unwrap();
            };
            let (got, ()) = tokio::join!(reads, writes);
            // Closing only after the end of the input arrived, as wispd does.
            drop(write);
            got
        };
        let ((), at_editor, at_wispd) = timeout(PATIENCE, async {
            tokio::join!(editor_writes, editor_reads, wispd_side)
        })
        .await
        .expect("the copies finish");

        assert!(at_wispd == up, "the bytes to wispd changed");
        assert!(at_editor == down, "the bytes from wispd changed");
        ended(bridge).await.unwrap();
    }

    #[tokio::test]
    async fn the_end_of_stdin_half_closes_and_the_answer_still_arrives() {
        let Rig {
            mut stdin,
            mut stdout,
            mut wispd,
            bridge,
        } = rig();
        stdin.write_all(b"{\"id\":1}\n").await.unwrap();
        drop(stdin);

        let mut request = Vec::new();
        timeout(PATIENCE, wispd.read_to_end(&mut request))
            .await
            .expect("wispd reads to the end of the input")
            .unwrap();
        assert_eq!(request, b"{\"id\":1}\n");

        wispd
            .write_all(b"{\"id\":1,\"result\":{}}\n")
            .await
            .unwrap();
        drop(wispd);
        let mut answer = Vec::new();
        timeout(PATIENCE, stdout.read_to_end(&mut answer))
            .await
            .expect("the answer and the end of stdout")
            .unwrap();
        assert_eq!(answer, b"{\"id\":1,\"result\":{}}\n");
        ended(bridge).await.unwrap();
    }

    #[tokio::test]
    async fn wispd_closing_ends_the_bridge_while_stdin_is_still_open() {
        let Rig {
            stdin,
            mut stdout,
            wispd,
            bridge,
        } = rig();
        drop(wispd);
        ended(bridge).await.unwrap();
        let mut rest = Vec::new();
        stdout.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        drop(stdin);
    }

    #[tokio::test]
    async fn a_closed_stdout_ends_the_bridge() {
        let Rig {
            stdin,
            stdout,
            mut wispd,
            bridge,
        } = rig();
        drop(stdout);
        // attach notices a closed stdout on its next write, so wispd keeps writing. A child that
        // another test spawns may hold the read end for a moment, and absorb a write (#86).
        let event = b"{\"jsonrpc\":\"2.0\",\"method\":\"events/event\"}\n";
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while !bridge.is_finished() {
            assert!(tokio::time::Instant::now() < deadline, "the bridge ends");
            if wispd.write_all(event).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ended(bridge).await.unwrap();
        drop(stdin);
    }
}
