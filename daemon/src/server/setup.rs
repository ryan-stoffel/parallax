//! What `serve` does before it accepts a connection (0007, 0023): check the data folder, take the
//! lock, then clear an old socket and bind a new one, or on Windows create the named pipe.

use std::fs::{self, DirBuilder, File, OpenOptions, TryLockError};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixListener;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use rustix::fs::OFlags;
#[cfg(unix)]
use tracing::{info, warn};

use super::StartError;

#[cfg(unix)]
const LOCK_ATTEMPTS: usize = 5;

/// Creates the data folder if it is missing and checks that it is a folder, not a symlink. On
/// Unix, it must also belong to this process's effective user, and is made 0700. On Windows, it
/// must not be any reparse point, such as a junction; its ACL is left alone, since
/// `%LOCALAPPDATA%` already grants only the user, SYSTEM, and Administrators (0023).
///
/// # Errors
///
/// [`StartError::DataDir`] if the folder can't be used safely, or [`StartError::Io`].
pub fn prepare_data_dir(dir: &Path) -> Result<(), StartError> {
    let io_error = |doing: &str, error| StartError::io(format!("{doing} {}", dir.display()), error);
    match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut builder = DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            builder.mode(0o700);
            builder
                .create(dir)
                .map_err(|error| io_error("creating", error))?;
        }
        Err(error) => return Err(io_error("reading", error)),
        Ok(_) => {}
    }
    let metadata = fs::symlink_metadata(dir).map_err(|error| io_error("reading", error))?;
    let refuse = |reason: String| StartError::DataDir {
        path: dir.to_owned(),
        reason,
    };
    if metadata.file_type().is_symlink() {
        return Err(refuse("it is a symlink".to_owned()));
    }
    #[cfg(windows)]
    if is_reparse_point(&metadata) {
        return Err(refuse(
            "it is a reparse point, such as a junction".to_owned(),
        ));
    }
    if !metadata.is_dir() {
        return Err(refuse("it is not a folder".to_owned()));
    }
    #[cfg(unix)]
    {
        let euid = rustix::process::geteuid().as_raw();
        if metadata.uid() != euid {
            return Err(refuse(format!(
                "it belongs to uid {}, not {euid}",
                metadata.uid()
            )));
        }
        if metadata.mode() & 0o7777 != 0o700 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .map_err(|error| io_error("making private", error))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// The lock on `wispd.lock` that admits one `serve` per data folder: `flock` on Unix, and
/// `LockFileEx` on Windows, both through std's `File::try_lock`.
#[derive(Debug)]
pub(crate) struct InstanceLock {
    file: File,
    #[cfg(unix)]
    path: PathBuf,
}

/// Opens and locks the file at `path`, creating it if needed.
fn lock(path: &Path, data_dir: &Path) -> Result<File, StartError> {
    let io_error = |error| StartError::io(format!("locking {}", path.display()), error);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    // A symlink here fails the open, or on Windows is opened itself and refused, instead of
    // creating its target.
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(OFlags::NOFOLLOW.bits().cast_signed());
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    #[cfg_attr(
        windows,
        expect(unused_mut, reason = "only Unix reads the holder's pid")
    )]
    let mut file = options.open(path).map_err(io_error)?;
    #[cfg(windows)]
    if is_reparse_point(&file.metadata().map_err(io_error)?) {
        return Err(io_error(io::Error::other(
            "it is a reparse point, such as a symlink",
        )));
    }
    match file.try_lock() {
        Ok(()) => Ok(file),
        // Windows' lock is mandatory, so there the holder's pid can't be read (0023).
        Err(TryLockError::WouldBlock) => Err(StartError::AlreadyRunning {
            data_dir: data_dir.to_owned(),
            #[cfg(unix)]
            pid: read_pid(&mut file),
            #[cfg(windows)]
            pid: None,
        }),
        Err(TryLockError::Error(error)) => Err(io_error(error)),
    }
}

/// Writes this process's pid into the lock file it holds.
fn write_pid(mut file: File, path: &Path) -> Result<File, StartError> {
    let io_error = |error| StartError::io(format!("locking {}", path.display()), error);
    file.set_len(0).map_err(io_error)?;
    writeln!(file, "{}", std::process::id()).map_err(io_error)?;
    Ok(file)
}

impl InstanceLock {
    /// Locks the file at `path`, creating it if needed, and writes this process's pid into it.
    ///
    /// Windows can't remove an open file, and has no stable file identity in std, so there the
    /// lock file is never removed and this skips Unix's identity check (0023).
    #[cfg(windows)]
    pub fn acquire(path: &Path, data_dir: &Path) -> Result<Self, StartError> {
        Ok(Self {
            file: write_pid(lock(path, data_dir)?, path)?,
        })
    }

    /// Locks the file at `path`, creating it if needed, and writes this process's pid into it.
    #[cfg(unix)]
    pub fn acquire(path: &Path, data_dir: &Path) -> Result<Self, StartError> {
        let io_error = |error| StartError::io(format!("locking {}", path.display()), error);
        // A stopping instance removes the file before it lets go of the lock, so the file locked
        // here may no longer be the one at `path`. Locking until it is keeps a second instance
        // from holding a lock on a file nobody else can find.
        for _ in 0..LOCK_ATTEMPTS {
            let file = lock(path, data_dir)?;
            let locked = file.metadata().map_err(io_error)?;
            let current = match fs::symlink_metadata(path) {
                Ok(current) => current,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(io_error(error)),
            };
            if (locked.dev(), locked.ino()) != (current.dev(), current.ino()) {
                continue;
            }
            return Ok(Self {
                file: write_pid(file, path)?,
                path: path.to_owned(),
            });
        }
        Err(io_error(io::Error::other(
            "the lock file kept changing while wispd locked it",
        )))
    }

    /// Lets go of the lock by closing the file, which stays (0023).
    #[cfg(windows)]
    pub fn release(self) {
        drop(self.file);
    }

    /// Removes the lock file, if it is still the one this instance locked, then lets go of the
    /// lock by closing it.
    #[cfg(unix)]
    pub fn release(self) {
        let locked = self.file.metadata().map(|m| (m.dev(), m.ino()));
        match (locked, fs::symlink_metadata(&self.path)) {
            (Ok(locked), Ok(current)) if locked == (current.dev(), current.ino()) => {
                if let Err(error) = fs::remove_file(&self.path) {
                    warn!(path = %self.path.display(), %error, "could not remove the lock file");
                }
            }
            (_, Err(error)) if error.kind() == io::ErrorKind::NotFound => {}
            _ => warn!(
                path = %self.path.display(),
                "left the lock file alone: another file is there now"
            ),
        }
        drop(self.file);
    }
}

#[cfg(unix)]
fn read_pid(file: &mut File) -> Option<u32> {
    let mut text = String::new();
    io::Read::read_to_string(file, &mut text).ok()?;
    text.trim().parse().ok()
}

/// The socket this server bound, known by its inode, so wispd only ever removes its own.
#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct Socket {
    path: PathBuf,
    identity: (u64, u64),
}

#[cfg(unix)]
impl Socket {
    /// Removes an old socket at `path`, but nothing that isn't a socket, then binds a new one
    /// there and makes it 0600. Only the holder of the instance lock may call it.
    pub fn bind(path: &Path) -> Result<(Self, UnixListener), StartError> {
        let io_error = |doing: &str, error| {
            StartError::io(format!("{doing} the socket {}", path.display()), error)
        };
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                fs::remove_file(path).map_err(|error| io_error("removing the old", error))?;
                info!(path = %path.display(), "removed an old socket");
            }
            Ok(_) => {
                return Err(StartError::NotASocket {
                    path: path.to_owned(),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error("reading", error)),
        }
        let (listener, identity) = bind_at(path).map_err(|error| io_error("binding", error))?;
        let socket = Self {
            path: path.to_owned(),
            identity,
        };
        Ok((socket, listener))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Binds again if the socket file is gone. macOS deletes old files in the per-user
    /// temporary folder that the fallback path uses, logind deletes Linux's runtime folder at the
    /// last logout, and a person may delete the socket too.
    pub fn rebind_if_gone(&mut self) -> io::Result<Option<UnixListener>> {
        match fs::symlink_metadata(&self.path) {
            Ok(_) => Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let (listener, identity) = bind_at(&self.path)?;
                self.identity = identity;
                Ok(Some(listener))
            }
            Err(error) => Err(error),
        }
    }

    /// Removes the socket file, if it is still the one this server bound.
    pub fn remove(&self) {
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) if (metadata.dev(), metadata.ino()) == self.identity => {
                if let Err(error) = fs::remove_file(&self.path) {
                    warn!(path = %self.path.display(), %error, "could not remove the socket");
                }
            }
            Ok(_) => {
                warn!(path = %self.path.display(), "left the socket path alone: another file is there now");
            }
            Err(_) => {}
        }
    }
}

/// The named pipe this server listens on (0023): one instance that waits for the next client,
/// with a DACL that grants only this user. Unlike a socket, a pipe can't be deleted or replaced
/// while wispd holds an instance, so it needs no rebinding or removal.
///
/// It is a message-type pipe in byte read mode. The message type preserves the empty write
/// that ends a client's input (see [`crate::attach::bridge`]); byte read mode prevents mio from
/// mistaking a partial message read for EOF when a large write is already queued.
#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct Pipe {
    name: PathBuf,
    sddl: String,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Pipe {
    /// Creates the pipe's first instance, which fails if any process, another user's included,
    /// already created the name. Must be called inside a tokio runtime.
    pub fn create(name: &Path) -> Result<Self, StartError> {
        let io_error =
            |error| StartError::io(format!("creating the pipe {}", name.display()), error);
        let sddl = crate::windows::this_user_only_sddl().map_err(io_error)?;
        let next = crate::windows::create_pipe(&Self::options(true), name.as_os_str(), &sddl)
            .map_err(io_error)?;
        Ok(Self {
            name: name.to_owned(),
            sddl,
            next,
        })
    }

    pub fn path(&self) -> &Path {
        &self.name
    }

    /// Waits for a client, and puts a new instance in place for the one after it.
    pub async fn accept(&mut self) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        let connected = self.next.connect().await;
        // An instance whose connect failed can't be used again, so it is replaced either way.
        let options = Self::options(false);
        let next = crate::windows::create_pipe(&options, self.name.as_os_str(), &self.sddl)?;
        let current = std::mem::replace(&mut self.next, next);
        connected.map(|()| current)
    }

    fn options(first: bool) -> tokio::net::windows::named_pipe::ServerOptions {
        let mut options = tokio::net::windows::named_pipe::ServerOptions::new();
        options
            .first_pipe_instance(first)
            .pipe_mode(tokio::net::windows::named_pipe::PipeMode::Message);
        options
    }
}

// The directory is 0700 already, which keeps other users away from the socket between bind
// and chmod.
#[cfg(unix)]
fn bind_at(path: &Path) -> io::Result<(UnixListener, (u64, u64))> {
    let listener = UnixListener::bind(path)?;
    let finish = || {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let metadata = fs::symlink_metadata(path)?;
        Ok((metadata.dev(), metadata.ino()))
    };
    match finish() {
        Ok(identity) => Ok((listener, identity)),
        Err(error) => {
            let _ = fs::remove_file(path);
            Err(error)
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::fs;
    use std::process::Command;

    use futures_util::SinkExt;
    use tokio::io::AsyncReadExt;
    use tokio::time::{Duration, timeout};
    use tokio_util::codec::FramedWrite;
    use wisp_protocol::framing::FrameCodec;

    use super::{InstanceLock, Pipe, prepare_data_dir};
    use crate::server::StartError;

    #[test]
    fn a_junction_or_file_is_refused_as_the_data_folder() {
        let temp = tempfile::tempdir().unwrap();
        let fresh = temp.path().join("a").join("b");
        prepare_data_dir(&fresh).unwrap();
        assert!(fresh.is_dir());

        let link = temp.path().join("link");
        let made = Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&fresh)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        assert!(matches!(
            prepare_data_dir(&link),
            Err(StartError::DataDir { .. })
        ));

        let file = temp.path().join("file");
        fs::write(&file, "").unwrap();
        assert!(matches!(
            prepare_data_dir(&file),
            Err(StartError::DataDir { .. })
        ));
    }

    #[test]
    fn a_second_lock_is_refused_without_a_pid_and_the_file_stays() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.lock");
        let lock = InstanceLock::acquire(&path, temp.path()).unwrap();
        match InstanceLock::acquire(&path, temp.path()) {
            Err(StartError::AlreadyRunning { pid, .. }) => assert_eq!(pid, None),
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
        lock.release();
        assert_eq!(
            fs::read_to_string(&path).unwrap().trim(),
            std::process::id().to_string()
        );
        InstanceLock::acquire(&path, temp.path()).unwrap().release();
    }

    #[tokio::test]
    async fn the_pipe_takes_this_users_clients_and_its_name_only_once() {
        let name = format!(r"\\.\pipe\wispd-test-{}", std::process::id());
        let mut pipe = Pipe::create(name.as_ref()).unwrap();
        assert!(matches!(
            Pipe::create(name.as_ref()),
            Err(StartError::Io { .. })
        ));
        let client = crate::transport::connect(name.as_ref()).await.unwrap();
        let server = pipe.accept().await.unwrap();
        assert_eq!(
            crate::windows::pipe_client_pid(&server).unwrap(),
            std::process::id()
        );
        drop((client, server));
        // The next instance is in place.
        let _again = crate::transport::connect(name.as_ref()).await.unwrap();
        pipe.accept().await.unwrap();
    }

    #[tokio::test]
    async fn a_large_framed_write_arrives_without_early_eof() {
        let name = format!(r"\\.\pipe\wispd-test-framed-{}", std::process::id());
        let mut pipe = Pipe::create(name.as_ref()).unwrap();
        let client = crate::transport::connect(name.as_ref()).await.unwrap();
        let mut server = pipe.accept().await.unwrap();
        let payload = "x".repeat(32 << 10);
        let expected = format!("{{\"payload\":\"{payload}\"}}\n");
        let mut writer = FramedWrite::new(client, FrameCodec::new());
        writer
            .send(serde_json::json!({"payload": payload}))
            .await
            .unwrap();
        let mut received = vec![0; expected.len()];
        timeout(Duration::from_secs(10), server.read_exact(&mut received))
            .await
            .expect("server receives the whole frame")
            .unwrap();
        assert_eq!(received, expected.as_bytes());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;

    use super::{InstanceLock, Socket, prepare_data_dir};
    use crate::server::StartError;

    #[test]
    fn the_data_folder_is_created_private_or_made_private() {
        let temp = tempfile::tempdir().unwrap();
        let fresh = temp.path().join("a/b");
        prepare_data_dir(&fresh).unwrap();
        assert_eq!(
            fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let open = temp.path().join("open");
        fs::create_dir(&open).unwrap();
        fs::set_permissions(&open, Permissions::from_mode(0o755)).unwrap();
        prepare_data_dir(&open).unwrap();
        assert_eq!(
            fs::metadata(&open).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn a_symlinked_or_non_folder_data_folder_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = temp.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            prepare_data_dir(&link),
            Err(StartError::DataDir { .. })
        ));

        let file = temp.path().join("file");
        fs::write(&file, "").unwrap();
        assert!(matches!(
            prepare_data_dir(&file),
            Err(StartError::DataDir { .. })
        ));
    }

    #[test]
    fn a_data_folder_owned_by_another_user_is_refused() {
        // `/` belongs to root. Running as root, the check would pass and chmod `/`, so skip.
        if rustix::process::geteuid().is_root() {
            return;
        }
        match prepare_data_dir(std::path::Path::new("/")) {
            Err(StartError::DataDir { reason, .. }) => {
                assert!(reason.starts_with("it belongs to uid 0"), "{reason}");
            }
            other => panic!("expected DataDir, got {other:?}"),
        }
    }

    #[test]
    fn a_symlinked_lock_file_is_refused_and_its_target_not_created() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.lock");
        let target = temp.path().join("elsewhere");
        symlink(&target, &path).unwrap();
        assert!(matches!(
            InstanceLock::acquire(&path, temp.path()),
            Err(StartError::Io { .. })
        ));
        assert!(!target.exists());
    }

    #[test]
    fn releasing_leaves_a_lock_file_that_replaced_ours_alone() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.lock");
        let lock = InstanceLock::acquire(&path, temp.path()).unwrap();
        let other = temp.path().join("other");
        fs::write(&other, "another instance's\n").unwrap();
        fs::rename(&other, &path).unwrap();
        lock.release();
        assert_eq!(fs::read_to_string(&path).unwrap(), "another instance's\n");
    }

    #[test]
    fn a_second_lock_is_refused_with_the_holders_pid() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.lock");
        let lock = InstanceLock::acquire(&path, temp.path()).unwrap();
        match InstanceLock::acquire(&path, temp.path()) {
            Err(StartError::AlreadyRunning { pid, .. }) => {
                assert_eq!(pid, Some(std::process::id()));
            }
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
        lock.release();
        assert!(!path.exists());
        InstanceLock::acquire(&path, temp.path()).unwrap().release();
    }

    #[test]
    fn an_old_socket_is_replaced_and_anything_else_is_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.sock");
        drop(UnixListener::bind(&path).unwrap());
        let (socket, _listener) = Socket::bind(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        socket.remove();
        assert!(!path.exists());

        fs::write(&path, "not a socket").unwrap();
        assert!(matches!(
            Socket::bind(&path),
            Err(StartError::NotASocket { .. })
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "not a socket");
    }

    #[test]
    fn a_deleted_socket_is_bound_again_and_a_replaced_one_is_not_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("wispd.sock");
        let (mut socket, _listener) = Socket::bind(&path).unwrap();
        assert!(socket.rebind_if_gone().unwrap().is_none());
        fs::remove_file(&path).unwrap();
        let _rebound = socket.rebind_if_gone().unwrap().expect("bound again");
        assert!(path.exists());

        fs::remove_file(&path).unwrap();
        fs::write(&path, "someone else's").unwrap();
        socket.remove();
        assert!(path.exists());
    }
}
