//! The headless browser behind a thread's browser tools (PLX-639), as T3 Code runs it.
//!
//! - **Install**: the first use downloads T3's pinned Chrome for Testing headless shell for this
//!   platform with the system `curl`, checks its size and SHA-256 against the pin, unpacks it, and
//!   renames it into `<data>/tools/chrome-headless-shell/<platform>/<version>/`, as the `gh`
//!   install does ([`crate::github`]). It runs in the background: a caller waits up to [`WAIT`]
//!   and then gets a "try again in a minute", while the install keeps going.
//! - **Protocol**: the browser speaks the Chrome `DevTools` Protocol over `--remote-debugging-pipe`,
//!   NUL-delimited JSON on its descriptors 3 and 4, which the `sh` trampoline points at its stdin
//!   and stdout. No port is opened, so no other user of the machine can reach it. Windows has no
//!   descriptors 3 and 4 to hand over without Win32 pipe setup, so it isn't supported yet.
//! - **Pages**: each [`Page`] is a target attached with `flatten`, whose events arrive on its own
//!   channel. Dropping the [`Browser`] kills it and removes its temporary profile.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::backend::process::Launcher;
use crate::github::{download, last_line, tar_program};

/// Chrome for Testing's headless shell, pinned as T3 Code pins it. To bump it, pick a version from
/// <https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json>
/// and replace the version and every size and SHA-256 below. Hosts drop the old build after the
/// new one installs.
const VERSION: &str = "154.0.8037.92";

/// Chrome for Testing's name for this platform, which also names the archive's top folder, and
/// the archive's size and SHA-256. `None` where there is no headless shell, or no way yet to run
/// it (Windows).
fn archive() -> Option<(&'static str, u64, &'static str)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => (
            "linux64",
            120_477_194,
            "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            121_182_296,
            "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
        ),
        ("macos", "aarch64") => (
            "mac-arm64",
            99_221_129,
            "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
        ),
        ("macos", "x86_64") => (
            "mac-x64",
            104_748_425,
            "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
        ),
        _ => return None,
    })
}

/// How long a caller waits on an install before it's told to try again. Agents' tool calls time
/// out near a minute.
const WAIT: Duration = Duration::from_secs(45);

/// How long the archive may take to download, or to unpack.
const ARCHIVE_TIMEOUT: Duration = Duration::from_mins(15);

/// How long the browser may take to answer one command.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The install under way or done in this process, shared by every caller.
type Install = Shared<BoxFuture<'static, Result<PathBuf, String>>>;
static INSTALL: LazyLock<Mutex<Option<Install>>> = LazyLock::new(Mutex::default);

/// The headless shell's path, installing it first if need be. Waits at most [`WAIT`] for an
/// install, then fails with a message that says to try again; the install keeps going.
///
/// # Errors
///
/// When the platform has no headless shell, the install failed, or it is still going.
pub(crate) async fn executable(launcher: &Launcher) -> Result<PathBuf, String> {
    let Some((platform, bytes, sha256)) = archive() else {
        return Err(format!(
            "Parallax's headless browser isn't available on {}-{} yet.",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };
    let folder = launcher
        .data_dir()
        .tools_dir()
        .join("chrome-headless-shell")
        .join(platform);
    let installed = folder.join(VERSION).join("chrome-headless-shell");
    if installed.is_file() {
        return Ok(installed);
    }
    let install = {
        let mut slot = INSTALL.lock().unwrap_or_else(PoisonError::into_inner);
        // A failed install is tried again by the next caller.
        if slot
            .as_ref()
            .is_none_or(|done| matches!(done.peek(), Some(Err(_))))
        {
            let launcher = launcher.clone();
            let task =
                tokio::spawn(
                    async move { install(&launcher, &folder, platform, bytes, sha256).await },
                );
            *slot = Some(
                async move { task.await.unwrap_or_else(|error| Err(error.to_string())) }
                    .boxed()
                    .shared(),
            );
        }
        slot.clone().unwrap_or_else(|| unreachable!())
    };
    tokio::time::timeout(WAIT, install)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "Parallax is installing its headless browser (about {} MB). Try again in a minute.",
                bytes / 1_000_000
            ))
        })
}

/// Downloads, checks, and unpacks the headless shell into `folder/<VERSION>`, then removes any
/// other version there. Returns the executable's path.
async fn install(
    launcher: &Launcher,
    folder: &Path,
    platform: &str,
    bytes: u64,
    sha256: &str,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("Couldn't make {}: {error}.", folder.display()))?;
    // Removed on drop, with whatever is still in it.
    let temp = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(folder)
        .map_err(|error| format!("Couldn't make a temp folder: {error}."))?;
    let zip = temp.path().join("chrome-headless-shell.zip");
    let url = format!(
        "https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/{platform}/chrome-headless-shell-{platform}.zip"
    );
    download(
        launcher,
        "the headless browser",
        &url,
        &zip,
        ARCHIVE_TIMEOUT,
    )
    .await?;
    let data =
        std::fs::read(&zip).map_err(|error| format!("Couldn't read the download: {error}."))?;
    if data.len() as u64 != bytes || crate::sha256_hex(&data) != sha256 {
        return Err(
            "The downloaded headless browser doesn't match its checksum, so plxd didn't install it."
                .to_owned(),
        );
    }
    drop(data);
    unzip(launcher, &zip, temp.path()).await?;
    let unpacked = temp
        .path()
        .join(format!("chrome-headless-shell-{platform}"));
    let executable = unpacked.join("chrome-headless-shell");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // Python's zipfile, the last resort, drops the executable bit.
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("The archive has no usable headless browser: {error}."))?;
    }
    let target = folder.join(VERSION);
    // Another plxd process may have finished the same install first.
    if std::fs::rename(&unpacked, &target).is_err()
        && !target.join("chrome-headless-shell").is_file()
    {
        return Err(format!(
            "Couldn't move the headless browser into {}.",
            target.display()
        ));
    }
    for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
        let name = entry.file_name();
        if name != VERSION && !name.to_string_lossy().starts_with('.') {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(target.join("chrome-headless-shell"))
}

/// Unpacks `zip` into `into` with the first of the system's unzippers that works: `unzip`, the
/// system bsdtar (macOS), or Python's zipfile.
async fn unzip(launcher: &Launcher, zip: &Path, into: &Path) -> Result<(), String> {
    let (zip, into) = (zip.as_os_str(), into.as_os_str());
    let tries: [(String, Vec<&std::ffi::OsStr>); 3] = [
        (
            "unzip".into(),
            vec!["-q".as_ref(), zip, "-d".as_ref(), into],
        ),
        (
            tar_program(),
            vec!["-xf".as_ref(), zip, "-C".as_ref(), into],
        ),
        (
            "python3".into(),
            vec!["-m".as_ref(), "zipfile".as_ref(), "-e".as_ref(), zip, into],
        ),
    ];
    let mut why = String::new();
    for (program, args) in tries {
        let mut spec = crate::detect::probe_spec(&program);
        spec.args = args.into_iter().map(ToOwned::to_owned).collect();
        match crate::detect::run_spec(launcher, &spec, b"", ARCHIVE_TIMEOUT).await {
            Ok(ran) if ran.exit_code == Some(0) => return Ok(()),
            Ok(ran) => last_line(&ran.stderr_tail).clone_into(&mut why),
            Err(error) => why = error,
        }
    }
    Err(format!(
        "Couldn't unpack the headless browser ({why}). Install unzip and try again."
    ))
}

/// A `DevTools` event: its method and params.
#[derive(Debug)]
pub(crate) struct Event {
    pub method: String,
    pub params: Value,
}

/// A running headless browser. Cloning it shares it; it is killed once every clone, and every
/// [`Page`] of it, is dropped.
#[derive(Clone)]
pub(crate) struct Browser {
    inner: Arc<Inner>,
}

struct Inner {
    writer: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    routes: Arc<Mutex<Routes>>,
    next_id: AtomicU64,
    #[cfg(unix)]
    process: crate::backend::process::RawProcess,
    _profile: tempfile::TempDir,
}

/// Where the browser's messages go: replies to their callers, and events to their page.
#[derive(Default)]
struct Routes {
    replies: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    pages: HashMap<String, mpsc::UnboundedSender<Event>>,
    /// Why the browser is gone, once it is.
    closed: Option<String>,
}

impl Browser {
    /// Starts the headless shell at `executable` with a temporary profile, and `extra` arguments.
    ///
    /// # Errors
    ///
    /// When it can't start, or on Windows.
    pub(crate) async fn launch(
        launcher: &Launcher,
        executable: &Path,
        extra: &[&str],
    ) -> Result<Self, String> {
        let profile = tempfile::Builder::new()
            .prefix("plxd-browser-")
            .tempdir()
            .map_err(|error| format!("Couldn't make the browser's profile folder: {error}."))?;
        let mut args: Vec<String> = [
            "--remote-debugging-pipe",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--mute-audio",
        ]
        .iter()
        .chain(extra)
        .map(|arg| (*arg).to_owned())
        .collect();
        // Chrome refuses its sandbox as root, and some hosts can't give it one (no user
        // namespaces); there the operator opts out.
        if is_root() || std::env::var_os("PLXD_BROWSER_NO_SANDBOX").is_some() {
            args.push("--no-sandbox".to_owned());
        }
        args.push(format!("--user-data-dir={}", profile.path().display()));
        args.push("about:blank".to_owned());
        Self::start(launcher, executable, &args, profile).await
    }

    #[cfg(windows)]
    async fn start(
        _launcher: &Launcher,
        _executable: &Path,
        _args: &[String],
        _profile: tempfile::TempDir,
    ) -> Result<Self, String> {
        Err("Parallax's headless browser doesn't run on Windows yet.".to_owned())
    }

    #[cfg(unix)]
    async fn start(
        launcher: &Launcher,
        executable: &Path,
        args: &[String],
        profile: tempfile::TempDir,
    ) -> Result<Self, String> {
        let mut spec = crate::detect::probe_spec("/bin/sh");
        // Descriptors 3 and 4, the DevTools pipe, become plxd's stdin and stdout pipes.
        spec.args = ["-c", "exec \"$0\" \"$@\" 3<&0 4>&1 </dev/null >/dev/null"]
            .into_iter()
            .map(Into::into)
            .chain([executable.as_os_str().to_owned()])
            .chain(args.iter().map(Into::into))
            .collect();
        let mut process = launcher
            .spawn_raw(&spec)
            .map_err(|error| format!("Couldn't start the headless browser: {error}."))?;
        let (Some(stdin), Some(stdout)) = (process.stdin.take(), process.stdout.take()) else {
            return Err("The headless browser has no pipes.".to_owned());
        };
        let routes = Arc::new(Mutex::new(Routes::default()));
        let browser = Self {
            inner: Arc::new(Inner {
                writer: tokio::sync::Mutex::new(Box::new(stdin)),
                routes: Arc::clone(&routes),
                next_id: AtomicU64::new(0),
                process,
                _profile: profile,
            }),
        };
        // Holds only the routes, so the browser drops once its users do.
        let tail = Arc::downgrade(&browser.inner);
        tokio::spawn(async move {
            read(stdout, &routes).await;
            let why = tail.upgrade().map_or_else(String::new, |inner| {
                last_line(&inner.process.stderr_tail()).to_owned()
            });
            let mut routes = routes.lock().unwrap_or_else(PoisonError::into_inner);
            let why = format!("The headless browser exited. {why}")
                .trim()
                .to_owned();
            for (_, reply) in routes.replies.drain() {
                let _ = reply.send(Err(why.clone()));
            }
            routes.pages.clear();
            routes.closed = Some(why);
        });
        // Fails here, with Chrome's own words, when it can't start at all.
        browser
            .call("Browser.getVersion", json!({}), None)
            .await
            .map(|_| browser)
    }

    /// Sends `method` to the browser, or to a page's session, and waits for its result.
    ///
    /// # Errors
    ///
    /// The browser's error, or that it is gone or took longer than [`CALL_TIMEOUT`].
    pub(crate) async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut routes = self.routes();
            if let Some(why) = &routes.closed {
                return Err(why.clone());
            }
            routes.replies.insert(id, tx);
        }
        self.write(id, method, params, session).await?;
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result.map_err(|error| format!("{method} failed: {error}")),
            Ok(Err(_)) => Err("The headless browser exited.".to_owned()),
            Err(_) => {
                self.routes().replies.remove(&id);
                Err(format!(
                    "The headless browser didn't answer {method} in time."
                ))
            }
        }
    }

    /// Sends `method` without waiting for its result.
    pub(crate) async fn post(&self, method: &str, params: Value, session: &str) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = self.write(id, method, params, Some(session)).await;
    }

    async fn write(
        &self,
        id: u64,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<(), String> {
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        bytes.push(0);
        let mut writer = self.inner.writer.lock().await;
        writer
            .write_all(&bytes)
            .await
            .map_err(|_| "The headless browser exited.".to_owned())
    }

    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        self.inner
            .routes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens a blank page and attaches to it.
    ///
    /// # Errors
    ///
    /// When the browser fails or is gone.
    pub(crate) async fn page(&self) -> Result<Page, String> {
        let created = self
            .call("Target.createTarget", json!({"url": "about:blank"}), None)
            .await?;
        let target = created["targetId"].as_str().unwrap_or_default().to_owned();
        let attached = self
            .call(
                "Target.attachToTarget",
                json!({"targetId": target, "flatten": true}),
                None,
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let (tx, events) = mpsc::unbounded_channel();
        self.routes().pages.insert(session.clone(), tx);
        Ok(Page {
            browser: self.clone(),
            target,
            session,
            events,
        })
    }
}

/// One page of a [`Browser`], and its events. Dropping it closes it.
pub(crate) struct Page {
    pub browser: Browser,
    /// Its target id, which is also its main frame's id.
    pub target: String,
    pub session: String,
    pub events: mpsc::UnboundedReceiver<Event>,
}

impl Page {
    /// Sends `method` to the page and waits for its result.
    ///
    /// # Errors
    ///
    /// As [`Browser::call`].
    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.browser.call(method, params, Some(&self.session)).await
    }
}

/// Runs `work` to its end, handing each of `page`'s events that arrives meanwhile to `on`, and
/// posting the command `on` answers with, if any.
pub(crate) async fn drive<T, S>(
    page: (&Browser, &str),
    events: &mut mpsc::UnboundedReceiver<Event>,
    state: &mut S,
    work: impl Future<Output = T>,
    on: impl Fn(&mut S, &Event) -> Option<(&'static str, Value)>,
) -> T {
    let mut work = pin!(work);
    loop {
        tokio::select! {
            biased;
            event = events.recv() => match event {
                Some(event) => {
                    if let Some((method, params)) = on(state, &event) {
                        page.0.post(method, params, page.1).await;
                    }
                }
                // The browser is gone, so `work` fails on its own.
                None => return work.await,
            },
            done = &mut work => return done,
        }
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.browser.routes().pages.remove(&self.session);
        let (browser, target) = (self.browser.clone(), self.target.clone());
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = browser
                    .call("Target.closeTarget", json!({"targetId": target}), None)
                    .await;
            });
        }
    }
}

/// Reads NUL-delimited messages from the browser until it closes the pipe, and routes each.
#[cfg(unix)]
async fn read(mut stdout: impl tokio::io::AsyncRead + Unpin, routes: &Mutex<Routes>) {
    let mut buffer = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let n = match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let start = buffer.len();
        buffer.extend_from_slice(&chunk[..n]);
        let mut from = 0;
        let mut search = start;
        while let Some(end) = buffer[search..].iter().position(|&b| b == 0) {
            let end = search + end;
            route(&buffer[from..end], routes);
            from = end + 1;
            search = from;
        }
        buffer.drain(..from);
    }
}

fn route(message: &[u8], routes: &Mutex<Routes>) {
    let Ok(mut message) = serde_json::from_slice::<Value>(message) else {
        return;
    };
    let mut routes = routes.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(id) = message["id"].as_u64() {
        if let Some(reply) = routes.replies.remove(&id) {
            let result = match message["error"]["message"].as_str() {
                Some(error) => Err(error.to_owned()),
                None => Ok(message["result"].take()),
            };
            let _ = reply.send(result);
        }
    } else if let (Some(session), Some(method)) =
        (message["sessionId"].as_str(), message["method"].as_str())
        && let Some(page) = routes.pages.get(session)
    {
        let _ = page.send(Event {
            method: method.to_owned(),
            params: message["params"].take(),
        });
    }
}

#[cfg(unix)]
fn is_root() -> bool {
    rustix::process::geteuid().is_root()
}

#[cfg(windows)]
fn is_root() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::{Routes, route};

    #[test]
    fn replies_reach_their_caller_and_events_their_page() {
        let routes = Mutex::new(Routes::default());
        let (reply, mut answer) = tokio::sync::oneshot::channel();
        let (page, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut routes = routes.lock().unwrap();
            routes.replies.insert(7, reply);
            routes.pages.insert("s".into(), page);
        }
        route(br#"{"id":7,"result":{"ok":true}}"#, &routes);
        assert_eq!(answer.try_recv().unwrap().unwrap()["ok"], true);
        route(
            br#"{"sessionId":"s","method":"Page.loadEventFired","params":{}}"#,
            &routes,
        );
        assert_eq!(events.try_recv().unwrap().method, "Page.loadEventFired");
        route(br#"{"id":8,"error":{"message":"nope"}}"#, &routes);
        route(b"not json", &routes);
    }
}
