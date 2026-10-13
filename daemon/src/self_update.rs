//! `host/update` (PLX-700, decision record 0066): plxd updates itself to the app's version, so a
//! computer the app reaches only through plxd's own protocol (a LAN-paired computer, a Parallax
//! Connect device) never stays on an old plxd.
//!
//! - **Download**: the release's `parallax-plxd-<version>-<os>-<arch>` and its `.sha256` from
//!   GitHub Releases, with the system `curl` as `github/install` does, into a temp folder beside
//!   where it goes. It checks the SHA-256, writes `plxd.version` beside it (0030), and proves it
//!   runs (`--version` names the version) before replacing anything.
//! - **Where**: a plxd inside an app bundle (`Resources/` on macOS, `resources/` on Linux), or one
//!   already in `~/.parallax-plxd`, installs to `~/.parallax-plxd/plxd`, where the app's SSH
//!   install (`INSTALL_SCRIPT` in the app's installPlxd.ts) puts it and `LOCATE_PLXD` looks first.
//!   A standalone plxd, such as the `~/.local/bin/plxd` plx-connect installs on Linux, is replaced
//!   in place, falling back to `~/.parallax-plxd` when its folder isn't writable. A cargo build
//!   (`target/debug`, `target/release`) refuses.
//! - **Handover**: plxd answers first, then restarts into the new binary once no agent's turn is
//!   running, or at once when asked `now` (PLX-746). With its login service installed, it runs the new plxd's
//!   `service install --replace`, detached, which points the service at it and restarts it. When
//!   that fails and the service manager runs this plxd, plxd exits with [`EXIT_RESTART`], so the
//!   manager starts its program again, now the new binary for an in-place update; a `serve` it
//!   started itself would die with the service's cgroup on Linux. Without a service, plxd shuts
//!   down and its last act starts the new `serve`.
//! - It never downgrades, and on Windows it refuses: Parallax's installer owns plxd there.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, HostUpdateParams, HostUpdateRestart, HostUpdateResult};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::backend::process::Launcher;
use crate::server::Daemon;

/// Where each release `v<version>` keeps plxd for each macOS and Linux target, with its `.sha256`
/// (`package-app`).
pub(crate) const RELEASES: &str = "https://github.com/ryan-stoffel/parallax/releases/download";

/// The folder in the home folder that an installed plxd goes in, as the app's SSH install does.
pub(crate) const SHARED_DIR: &str = ".parallax-plxd";

/// How long the checksum may take to download.
const SMALL_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// How long plxd itself (about 30 MB) may take to download.
const BINARY_TIMEOUT: Duration = Duration::from_secs(600);

/// How long the new plxd's `--version` may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long plxd waits after answering before it restarts, so the answer reaches the client.
const ANSWER_GRACE: Duration = Duration::from_secs(1);

/// How often a restart waiting for running agents checks on them.
const RUNS_POLL: Duration = Duration::from_secs(5);

/// The environment variable that points `host/update` at another releases folder, which may be a
/// `file://` URL. Only tests should set it.
pub const RELEASES_ENV: &str = "PLXD_RELEASES_URL";

/// The exit status that asks the service manager running plxd to start it again: any non-zero
/// status does, under `Restart=on-failure` and `KeepAlive.SuccessfulExit=false`. 75 is
/// `EX_TEMPFAIL`.
pub const EXIT_RESTART: u8 = 75;

/// What `main` does once `serve` has stopped for a handover.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Handover {
    /// Starts this plxd's `serve`, detached: nothing else would start it.
    Spawn(PathBuf),
    /// Exits with [`EXIT_RESTART`], so the service manager running this plxd restarts it.
    Exit,
}

/// What `main` does once `serve` has stopped, when a handover shut it down.
static HANDOVER: Mutex<Option<Handover>> = Mutex::new(None);

/// What to do once `serve` stops, when `host/update` shut it down to hand over to the plxd it
/// installed. `main` takes it after the server stops, when the lock is free for the new `serve`.
#[must_use]
pub fn take_handover() -> Option<Handover> {
    lock(&HANDOVER).take()
}

/// How plxd restarts into `program` when its login service didn't take it over: when the service
/// manager runs this plxd (`managed`), by exiting so that it restarts it, since a `serve` started
/// from inside the service's cgroup dies with it; otherwise by starting `program serve` itself.
#[must_use]
pub fn fallback(program: PathBuf, managed: bool) -> Handover {
    if managed {
        Handover::Exit
    } else {
        Handover::Spawn(program)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The host's self-update: the release it installs from, and an update in progress.
#[derive(Debug)]
pub(crate) struct SelfUpdate {
    launcher: Launcher,
    /// [`RELEASES`], except in tests.
    releases: String,
    /// The URL schemes the download may use, as curl's `--proto` takes them: HTTPS, and `file`
    /// for tests' releases.
    protocols: &'static str,
    /// The running plxd, symlinks resolved, and the home folder. `None` when unknown.
    exe: Option<PathBuf>,
    home: Option<PathBuf>,
    /// The version plxd reports.
    current: String,
    state: Mutex<State>,
    /// Cancelled to shut `serve` down for a handover; `Server::run` watches it.
    pub restart: CancellationToken,
    /// Whether plxd restarts after installing. Off in tests, which never restart anything.
    handover: bool,
}

#[derive(Debug, Default)]
struct State {
    /// An install is downloading.
    busy: bool,
    /// The version installed and waiting for the handover, and where.
    installed: Option<(String, PathBuf)>,
    /// A handover is scheduled, so a second `host/update` doesn't schedule another.
    handing_over: bool,
    /// A `host/update` asked for the handover `now`, so it doesn't wait for running agents.
    now: bool,
}

impl SelfUpdate {
    /// The running plxd's self-update, installing from [`RELEASES`].
    pub(crate) fn new(launcher: Launcher) -> Self {
        let exe = std::env::current_exe()
            .ok()
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe));
        let (releases, protocols) = match std::env::var(RELEASES_ENV) {
            Ok(releases) if !releases.is_empty() => (releases, "=https,file"),
            _ => (RELEASES.to_owned(), crate::github::DOWNLOAD_PROTOCOLS),
        };
        Self {
            launcher,
            releases,
            protocols,
            exe,
            home: std::env::home_dir().filter(|home| home.is_absolute()),
            current: crate::version().to_owned(),
            state: Mutex::default(),
            restart: CancellationToken::new(),
            handover: true,
        }
    }

    /// A self-update that installs from `releases` for the plxd at `exe` running `current`, in
    /// `home`, and never restarts.
    #[cfg(all(test, unix))]
    pub(crate) fn for_tests(
        launcher: Launcher,
        releases: &str,
        exe: &Path,
        home: &Path,
        current: &str,
    ) -> Self {
        Self {
            launcher,
            releases: releases.to_owned(),
            protocols: "=https,file",
            exe: Some(exe.to_owned()),
            home: Some(home.to_owned()),
            current: current.to_owned(),
            state: Mutex::default(),
            restart: CancellationToken::new(),
            handover: false,
        }
    }

    /// `host/update`: installs `version` and schedules the handover, or says why not.
    pub(crate) async fn update(
        &self,
        daemon: &Arc<Daemon>,
        params: HostUpdateParams,
    ) -> Result<HostUpdateResult, ErrorObject> {
        let running = daemon.agents.running();
        let result = self.install(&params.version, running, params.now).await?;
        if params.now && result.restart == HostUpdateRestart::Now {
            lock(&self.state).now = true;
        }
        if self.handover && result.restart != HostUpdateRestart::UpToDate && self.claim_handover() {
            let daemon = Arc::clone(daemon);
            tokio::spawn(async move { handover_when_idle(daemon).await });
        }
        Ok(result)
    }

    /// Installs `version` unless plxd can't or needn't, and answers as `host/update` does with
    /// `running` agents, restarting at once if `now`.
    async fn install(
        &self,
        version: &str,
        running: u32,
        now: bool,
    ) -> Result<HostUpdateResult, ErrorObject> {
        let failed = |message: String| ErrorObject::parallax(ErrorKind::HostUpdateFailed, message);
        if cfg!(windows) {
            return Err(failed(
                "plxd can't update itself on Windows. Update Parallax on that computer.".to_owned(),
            ));
        }
        let wanted = parse_version(version)
            .ok_or_else(|| failed(format!("{version:?} isn't a Parallax release version.")))?;
        match parse_version(&self.current).map(|current| compare(&wanted, &current)) {
            Some(Ordering::Less) => {
                return Err(failed(format!(
                    "plxd {} is newer than {version}, and it never downgrades.",
                    self.current
                )));
            }
            Some(Ordering::Equal) => {
                return Ok(answer(
                    &self.current,
                    HostUpdateRestart::UpToDate,
                    running,
                    format!("plxd {} is already up to date.", self.current),
                ));
            }
            _ => {}
        }
        let (Some(exe), Some(home)) = (&self.exe, &self.home) else {
            return Err(failed(
                "plxd can't find its own path or the home folder, so it can't update itself."
                    .to_owned(),
            ));
        };
        let placement = placement(exe, home).map_err(failed)?;
        {
            let mut state = lock(&self.state);
            if let Some((installed, _)) = &state.installed
                && parse_version(installed).is_some_and(|got| compare(&got, &wanted).is_ge())
            {
                return Ok(restart_answer(installed, running, now));
            }
            if state.busy {
                return Err(failed(
                    "plxd is already updating. Try again in a minute.".to_owned(),
                ));
            }
            state.busy = true;
        }
        // Clears `busy` however this ends, even when the request is dropped mid-download.
        let busy = Busy(Some(&self.state));
        let installed = install_release(
            &self.launcher,
            &self.releases,
            self.protocols,
            version,
            &placement,
            home,
        )
        .await;
        // `busy` clears with `installed` set, under one lock, so no second call sees neither.
        let mut state = busy.finish();
        let program = installed.map_err(failed)?;
        info!(version, program = %program.display(), "installed a plxd update");
        state.installed = Some((version.to_owned(), program));
        Ok(restart_answer(version, running, now))
    }

    /// Whether this call schedules the handover: true only the first time.
    fn claim_handover(&self) -> bool {
        !std::mem::replace(&mut lock(&self.state).handing_over, true)
    }

    /// Whether the handover waits: for running agents unless a `host/update` asked `now`, and
    /// for a download in progress, which may be a newer release to hand over to.
    fn waits(&self, running: u32) -> bool {
        let state = lock(&self.state);
        state.busy || (running > 0 && !state.now)
    }

    /// The program waiting for the handover, if an update was installed.
    fn installed(&self) -> Option<PathBuf> {
        lock(&self.state).installed.as_ref().map(|(_, p)| p.clone())
    }
}

/// Clears [`State::busy`] when dropped, or when [`Busy::finish`] locks the state.
struct Busy<'a>(Option<&'a Mutex<State>>);

impl<'a> Busy<'a> {
    /// The state, locked, with `busy` cleared.
    fn finish(mut self) -> MutexGuard<'a, State> {
        let mut state = lock(
            self.0
                .take()
                .unwrap_or_else(|| unreachable!("finished twice")),
        );
        state.busy = false;
        state
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.0 {
            lock(state).busy = false;
        }
    }
}

fn answer(
    version: &str,
    restart: HostUpdateRestart,
    running: u32,
    message: String,
) -> HostUpdateResult {
    HostUpdateResult {
        version: version.to_owned(),
        restart,
        running_agents: running,
        message,
    }
}

fn restart_answer(version: &str, running: u32, now: bool) -> HostUpdateResult {
    let agents = if running == 1 { "agent" } else { "agents" };
    if running == 0 {
        answer(
            version,
            HostUpdateRestart::Now,
            running,
            format!("Installed plxd {version}. plxd restarts into it now."),
        )
    } else if now {
        answer(
            version,
            HostUpdateRestart::Now,
            running,
            format!(
                "Installed plxd {version}. plxd restarts into it now, interrupting its {running} running {agents}."
            ),
        )
    } else {
        answer(
            version,
            HostUpdateRestart::AfterRuns,
            running,
            format!(
                "Installed plxd {version}. plxd restarts into it once its {running} running {agents} finish."
            ),
        )
    }
}

/// A release version's numbers: `2610.10912.13045` for `2610.10912.13045-nightly` (0030), and
/// `0.1.0` for a cargo build's placeholder. The channel doesn't count, so a nightly and the
/// standard release of one commit are the same plxd. `None` for anything else.
pub(crate) fn parse_version(version: &str) -> Option<Vec<u64>> {
    let (numbers, channel) = version.split_once('-').unwrap_or((version, ""));
    if !channel
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.')
    {
        return None;
    }
    numbers
        .split('.')
        .map(|part| {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse().ok())
                .flatten()
        })
        .collect()
}

/// Compares two versions' numbers, a missing one counting as 0.
pub(crate) fn compare(a: &[u64], b: &[u64]) -> Ordering {
    let len = a.len().max(b.len());
    let at = |v: &[u64], i: usize| v.get(i).copied().unwrap_or(0);
    (0..len)
        .map(|i| at(a, i).cmp(&at(b, i)))
        .find(|order| order.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// plxd's file in release `version` for `os` and `arch` as Rust names them, such as
/// `parallax-plxd-2610.10912.13045-linux-x64`. Parallax builds plxd for Apple silicon Macs and
/// for Linux on x64 and arm64.
pub(crate) fn asset_name(version: &str, os: &str, arch: &str) -> Result<String, String> {
    let os = match os {
        "macos" => "mac",
        "linux" => "linux",
        other => return Err(format!("Parallax has no plxd release for {other}.")),
    };
    let arch = match arch {
        "aarch64" => "arm64",
        "x86_64" if os == "linux" => "x64",
        "x86_64" => return Err("Parallax has no plxd for Intel Macs.".to_owned()),
        other => return Err(format!("Parallax has no plxd release for {other}.")),
    };
    Ok(format!("parallax-plxd-{version}-{os}-{arch}"))
}

/// Where an update goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Placement {
    /// `plxd` and `plxd.version` in this folder, `~/.parallax-plxd`.
    Shared(PathBuf),
    /// Over this plxd, with `plxd.version` beside it.
    InPlace(PathBuf),
}

/// Where the update of the plxd at `exe` goes, for a user whose home is `home`, or why plxd
/// won't update itself.
pub(crate) fn placement(exe: &Path, home: &Path) -> Result<Placement, String> {
    let shared = home.join(SHARED_DIR);
    let dir = exe.parent().unwrap_or(Path::new("/"));
    let named = |path: &Path, names: &[&str]| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| names.contains(&name))
    };
    // Cargo's `target/<profile>/`, `target/<triple>/<profile>/`, or a test's `deps/` in one.
    let cargo_build = exe.ancestors().any(|a| {
        named(a, &["debug", "release"])
            && a.ancestors()
                .skip(1)
                .take(2)
                .any(|up| named(up, &["target"]))
    });
    if cargo_build {
        return Err(format!(
            "plxd at {} is a development build, so it doesn't update itself. Rebuild it instead.",
            exe.display()
        ));
    }
    if dir == shared || named(dir, &["Resources", "resources"]) {
        Ok(Placement::Shared(shared))
    } else {
        Ok(Placement::InPlace(exe.to_owned()))
    }
}

/// Downloads, checks, and installs plxd `version` from `releases`, over the URL schemes in
/// `protocols`, where `placement` says, and returns where it went. An in-place install whose
/// folder plxd can't write goes to `~/.parallax-plxd` instead. Returns what went wrong, for
/// people.
pub(crate) async fn install_release(
    launcher: &Launcher,
    releases: &str,
    protocols: &str,
    version: &str,
    placement: &Placement,
    home: &Path,
) -> Result<PathBuf, String> {
    let name = asset_name(version, std::env::consts::OS, std::env::consts::ARCH)?;
    let shared = home.join(SHARED_DIR);
    let temp_in = |dir: &Path| {
        tempfile::Builder::new()
            .prefix(".plxd-update-")
            .tempdir_in(dir)
    };
    let (temp, program) = match placement {
        Placement::InPlace(exe) => match exe.parent().map(&temp_in) {
            Some(Ok(temp)) => (temp, exe.clone()),
            _ => (shared_temp(&shared, temp_in)?, shared.join("plxd")),
        },
        Placement::Shared(dir) => (shared_temp(dir, temp_in)?, dir.join("plxd")),
    };
    let dir = temp.path();
    let url = |file: &str| format!("{releases}/v{version}/{file}");
    let new = dir.join("plxd");
    crate::github::download_with(
        launcher,
        &format!("{name}.sha256"),
        &url(&format!("{name}.sha256")),
        &dir.join("plxd.sha256"),
        SMALL_DOWNLOAD_TIMEOUT,
        protocols,
    )
    .await?;
    crate::github::download_with(
        launcher,
        &name,
        &url(&name),
        &new,
        BINARY_TIMEOUT,
        protocols,
    )
    .await?;
    let sums = std::fs::read_to_string(dir.join("plxd.sha256")).unwrap_or_default();
    let expected = sums
        .lines()
        .find_map(|line| {
            let (hash, file) = line.split_once(char::is_whitespace)?;
            (file.trim().trim_start_matches('*') == name).then(|| hash.to_ascii_lowercase())
        })
        .ok_or_else(|| format!("The release's {name}.sha256 doesn't list {name}."))?;
    let bytes = std::fs::read(&new)
        .map_err(|error| format!("Couldn't read the downloaded {name}: {error}."))?;
    if crate::sha256_hex(&bytes) != expected {
        return Err(format!(
            "The downloaded {name} doesn't match the release's SHA-256, so plxd didn't install it."
        ));
    }
    drop(bytes);
    make_executable(&new)?;
    let version_file = dir.join(crate::VERSION_FILE);
    std::fs::write(&version_file, format!("{version}\n"))
        .map_err(|error| format!("Couldn't write {}: {error}.", version_file.display()))?;
    let new_text = new.to_string_lossy();
    let ran = crate::detect::run(launcher, &new_text, &["--version"], PROBE_TIMEOUT)
        .await
        .map_err(|error| format!("plxd {version} doesn't run on this computer: {error}."))?;
    if ran.exit_code != Some(0) || !ran.stdout.contains(version) {
        return Err(format!(
            "plxd {version} doesn't run on this computer: {}",
            crate::github::last_line(&ran.stderr_tail)
        ));
    }
    let move_to = |from: &Path, to: &Path| {
        std::fs::rename(from, to)
            .map_err(|error| format!("Couldn't move plxd into {}: {error}.", to.display()))
    };
    // plxd first, then its version: if the second move fails, the new plxd reports the old
    // version, which only makes the app try again, never the old plxd claiming the new one.
    move_to(&new, &program)?;
    move_to(&version_file, &program.with_file_name(crate::VERSION_FILE))?;
    Ok(program)
}

/// A temp folder in `dir`, which is made first.
fn shared_temp(
    dir: &Path,
    temp_in: impl Fn(&Path) -> std::io::Result<tempfile::TempDir>,
) -> Result<tempfile::TempDir, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Couldn't make {}: {error}.", dir.display()))?;
    temp_in(dir)
        .map_err(|error| format!("Couldn't make a temp folder in {}: {error}.", dir.display()))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("Couldn't make plxd executable: {error}."))
}

#[cfg(not(unix))]
#[expect(clippy::unnecessary_wraps, reason = "matches the Unix signature")]
fn make_executable(_: &Path) -> Result<(), String> {
    Ok(())
}

/// Waits for the answer to go out, for every running agent's turn to end unless a `host/update`
/// asked for `now`, and for any download in progress, then hands over to the newest install.
async fn handover_when_idle(daemon: Arc<Daemon>) {
    tokio::time::sleep(ANSWER_GRACE).await;
    while daemon.self_update.waits(daemon.agents.running()) {
        tokio::time::sleep(RUNS_POLL).await;
    }
    let Some(program) = daemon.self_update.installed() else {
        return;
    };
    hand_over(&daemon, program).await;
}

/// Restarts into `program`: through the login service when it's installed and moving it works;
/// else by shutting down, after which `main` either exits for the service manager to restart it
/// or starts `program serve` itself ([`take_handover`], [`fallback`]).
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux")),
    expect(
        clippy::unused_async,
        reason = "awaits the service handover on macOS and Linux"
    )
)]
async fn hand_over(daemon: &Arc<Daemon>, program: PathBuf) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let handover = match service_handover(daemon, &program).await {
        // The service manager stops this plxd now.
        ServiceHandover::Replaced => return,
        ServiceHandover::NoService => Handover::Spawn(program),
        ServiceHandover::Failed { error, managed } => {
            tracing::warn!(%error, managed, "couldn't hand plxd over to its login service; restarting it instead");
            fallback(program, managed)
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let handover = Handover::Spawn(program);
    info!(?handover, "shutting down to restart into the plxd update");
    *lock(&HANDOVER) = Some(handover);
    daemon.self_update.restart.cancel();
}

/// How handing plxd over to its login service went.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug)]
enum ServiceHandover {
    /// `service install --replace` moved the service to the new plxd, and restarts it.
    Replaced,
    /// No service is installed, and none runs this plxd.
    NoService,
    /// It didn't work. `managed` when the service manager runs this plxd.
    Failed { error: String, managed: bool },
}

/// Hands plxd over to its login service, when one is installed or runs this plxd.
#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn service_handover(daemon: &Arc<Daemon>, program: &Path) -> ServiceHandover {
    let data_dir = daemon.data_dir.clone();
    let label = std::env::var(crate::service::SERVICE_LABEL_ENV)
        .unwrap_or_else(|_| crate::service::DEFAULT_LABEL.to_owned());
    let checked = (label.clone(), data_dir.clone());
    let status =
        tokio::task::spawn_blocking(move || crate::service::status(&checked.0, &checked.1))
            .await
            .map_err(|e| e.to_string())
            .and_then(|status| status.map_err(|e| e.to_string()));
    let managed = run_by_service(
        status.as_ref().ok().and_then(|status| status.state.pid()),
        std::process::id(),
        service_hint(&label),
    );
    match status {
        Ok(status) if status.installed => match replace_service(&data_dir, program).await {
            Ok(()) => ServiceHandover::Replaced,
            Err(error) => ServiceHandover::Failed { error, managed },
        },
        _ if !managed => ServiceHandover::NoService,
        Ok(_) => ServiceHandover::Failed {
            error: "the service that runs plxd has no file to replace".to_owned(),
            managed,
        },
        Err(error) => ServiceHandover::Failed { error, managed },
    }
}

/// Whether a service manager runs this plxd, whose pid is `own`: its service's main pid is
/// `service_pid`, or `hint` says so when the manager couldn't be asked.
#[must_use]
pub fn run_by_service(service_pid: Option<u32>, own: u32, hint: bool) -> bool {
    service_pid == Some(own) || hint
}

/// Whether this process runs in `label`'s systemd unit, by its cgroup.
#[cfg(target_os = "linux")]
fn service_hint(label: &str) -> bool {
    std::fs::read_to_string("/proc/self/cgroup")
        .is_ok_and(|cgroup| in_unit_cgroup(&cgroup, &crate::service::systemd::unit_name(label)))
}

/// Whether launchd started this process as `label`'s job, which it names in `XPC_SERVICE_NAME`.
#[cfg(target_os = "macos")]
fn service_hint(label: &str) -> bool {
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == label)
}

/// Whether `/proc/self/cgroup`'s text puts the process in systemd unit `unit`: a line whose path
/// ends in it, such as `0::/user.slice/user-1000.slice/user@1000.service/app.slice/<unit>`.
#[must_use]
pub fn in_unit_cgroup(cgroup: &str, unit: &str) -> bool {
    cgroup
        .lines()
        .filter_map(|line| line.rsplit_once(':').map(|(_, path)| path))
        .any(|path| path.rsplit('/').next() == Some(unit))
}

/// Runs `program service install --replace`, detached, so it outlives this plxd, which the
/// service manager stops. Waits for it on a thread of its own, which never holds up the
/// process's exit, since only a failure comes back.
#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn replace_service(data_dir: &crate::paths::DataDir, program: &Path) -> Result<(), String> {
    use std::os::fd::AsFd as _;

    let log = crate::logging::open_log_file(&data_dir.log_file()).map_err(|e| e.to_string())?;
    let null = std::fs::File::open("/dev/null").map_err(|e| e.to_string())?;
    let mut command = data_dir.command(program);
    command.args(["service", "install", "--replace"]);
    let stdio = crate::spawn::Stdio {
        stdin: null.as_fd(),
        stdout: log.as_fd(),
        stderr: log.as_fd(),
    };
    info!(program = %program.display(), "handing plxd over to its login service");
    let pid = crate::spawn::spawn_detached(&command, stdio).map_err(|e| e.to_string())?;
    let (done, exited) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let waited = rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::empty());
        let _ = done.send(waited.map(|w| w.and_then(|(_, status)| status.exit_status())));
    });
    match exited.await {
        Ok(Ok(Some(0))) => Ok(()),
        Ok(Ok(code)) => Err(format!(
            "`plxd service install --replace` exited with {code:?}"
        )),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("lost track of `plxd service install --replace`".to_owned()),
    }
}

/// Starts `program serve` detached on `data_dir`, as `attach` starts one, after a handover shut
/// this one down.
///
/// # Errors
///
/// When the log can't be opened or the process can't start.
#[cfg(unix)]
pub fn start_serve(program: &Path, data_dir: &crate::paths::DataDir) -> std::io::Result<()> {
    use std::os::fd::AsFd as _;

    let log = crate::logging::open_log_file(&data_dir.log_file())?;
    let null = std::fs::File::open("/dev/null")?;
    let mut command = data_dir.command(program);
    command.arg("serve");
    let stdio = crate::spawn::Stdio {
        stdin: null.as_fd(),
        stdout: log.as_fd(),
        stderr: log.as_fd(),
    };
    crate::spawn::spawn_detached(&command, stdio).map(drop)
}

#[cfg(all(test, unix))]
mod tests;
