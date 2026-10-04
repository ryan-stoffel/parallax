//! The worker sandbox (0013): what a [`ToolPolicy::WorkspaceWrite`] run may write and read,
//! whichever backend runs it.
//!
//! A worker writes its cwd (its worktree), the project's shared context folder (0005), and its
//! own temp folder (PLX-130). Its commands can't write git metadata or read credential stores,
//! plxd's data folder, or any other run's temp. They do have network access (Ryan, #137), so the
//! read denylist is what keeps a secret from leaving the machine. Each backend turns a
//! [`WorkerSandbox`] into its own vendor's flags; plxd adds no OS sandbox of its own, because a
//! vendor's sandbox can't start inside one (0013).

use std::path::{Path, PathBuf};

use super::{Credential, RunRequest, StartError, ToolPolicy};

/// Credential stores and other secrets in the home folder that no worker's commands may read, on
/// every OS (0013). Paths are relative to the home folder, and [`UNREADABLE_IN_HOME_ON_THIS_OS`]
/// adds the ones only this OS has. The vendors' sandboxes have no built-in list, so whatever
/// isn't here is readable, and with network access a command can send it anywhere.
pub const UNREADABLE_IN_HOME: &[&str] = &[
    // Keys and signing
    ".ssh",
    ".gnupg",
    // Cloud and infrastructure
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    // Podman, Buildah, and Skopeo keep registry logins in `auth.json` here
    ".config/containers",
    ".terraform.d",
    ".vault-token",
    // Git hosts and git's own credential store
    ".git-credentials",
    ".config/git/credentials",
    ".config/gh",
    ".config/hub",
    ".config/glab-cli",
    ".config/github-copilot",
    // Package registries
    ".netrc",
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".gem/credentials",
    ".m2/settings.xml",
    ".gradle/gradle.properties",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    // Databases
    ".pgpass",
    ".my.cnf",
    // Password managers
    ".password-store",
    ".config/op",
    // Shell and REPL histories
    ".zsh_history",
    ".zsh_sessions",
    ".bash_history",
    ".bash_sessions",
    ".local/share/fish/fish_history",
    ".python_history",
    ".node_repl_history",
    ".psql_history",
    ".mysql_history",
    ".sqlite_history",
    // Agent CLIs, whose folders hold their logins
    ".claude",
    ".claude.json",
    ".codex",
    ".cursor",
];

/// macOS's additions to [`UNREADABLE_IN_HOME`]: the Keychain folder, and the password managers,
/// browsers, and agent apps that keep their data under `~/Library`.
#[cfg(target_os = "macos")]
pub const UNREADABLE_IN_HOME_ON_THIS_OS: &[&str] = &[
    "Library/Keychains",
    // Password managers
    "Library/Application Support/1Password",
    "Library/Group Containers/2BUA8C4S2C.com.1password",
    "Library/Application Support/Bitwarden",
    "Library/Application Support/Bitwarden CLI",
    // Browser profiles and cookies
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Safari",
    "Library/Containers/com.apple.Safari",
    "Library/Cookies",
    // Agent apps, whose folders hold their logins
    "Library/Application Support/Cursor",
    "Library/Application Support/Claude",
];

/// Linux's additions to [`UNREADABLE_IN_HOME`] (0013): keyrings and certificate stores, and the
/// password managers, browsers, and agent apps that keep their data under `~/.config` and friends.
/// Browsers are listed with their snap and flatpak folders too, since Ubuntu ships Firefox as a
/// snap.
#[cfg(target_os = "linux")]
pub const UNREADABLE_IN_HOME_ON_THIS_OS: &[&str] = &[
    // Keyrings (GNOME Keyring, KWallet) and NSS's certificate and key database
    ".local/share/keyrings",
    ".local/share/kwalletd",
    ".pki",
    // Password managers
    ".config/1Password",
    ".config/Bitwarden",
    ".config/Bitwarden CLI",
    // Browser profiles and cookies
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    ".mozilla",
    // Firefox 147 and later, and Thunderbird, put new profiles here
    ".config/mozilla",
    "snap/firefox",
    "snap/chromium",
    ".var/app/org.mozilla.firefox",
    ".var/app/com.google.Chrome",
    ".var/app/org.chromium.Chromium",
    ".var/app/com.brave.Browser",
    ".var/app/com.microsoft.Edge",
    // Agent apps, whose folders hold their logins
    ".config/Cursor",
    ".config/Claude",
];

/// Nothing to add on an OS where no backend sandboxes a worker yet (0023).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const UNREADABLE_IN_HOME_ON_THIS_OS: &[&str] = &[];

/// Every path in the home folder that no worker may read on this OS: [`UNREADABLE_IN_HOME`], then
/// [`UNREADABLE_IN_HOME_ON_THIS_OS`].
pub fn unreadable_in_home() -> impl Iterator<Item = &'static str> {
    UNREADABLE_IN_HOME
        .iter()
        .chain(UNREADABLE_IN_HOME_ON_THIS_OS)
        .copied()
}

/// Paths outside the home folder that no worker may read on this OS (0013). On Linux that is the
/// user's runtime folder, which can hold credentials: rootless Podman, Buildah, and Skopeo keep
/// registry logins in its `containers/auth.json` (PLX-107).
#[cfg(target_os = "linux")]
fn unreadable_outside_home() -> Vec<PathBuf> {
    runtime_dirs(
        std::env::var_os("XDG_RUNTIME_DIR"),
        rustix::process::getuid().as_raw(),
    )
}

#[cfg(not(target_os = "linux"))]
fn unreadable_outside_home() -> Vec<PathBuf> {
    Vec::new()
}

/// The runtime folders to deny:
/// - plxd's `$XDG_RUNTIME_DIR`. A value that isn't absolute is ignored, as the XDG Base
///   Directory spec says. An absolute one that isn't UTF-8 is kept, so [`worker_sandbox`] refuses
///   the run instead of leaving the folder readable.
/// - `/run/user/<uid>`, where logind makes it. Tools fall back to it when the variable is unset,
///   as it is for a worker (0014).
/// - `/run/containers/<uid>`, where Podman, Buildah, and Skopeo keep registry logins when the
///   variable is unset (`containers/image`'s `defaultPerUIDPathFormat`).
#[cfg(target_os = "linux")]
fn runtime_dirs(xdg_runtime_dir: Option<std::ffi::OsString>, uid: u32) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = xdg_runtime_dir
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .into_iter()
        .collect();
    for dir in [format!("/run/user/{uid}"), format!("/run/containers/{uid}")] {
        let dir = PathBuf::from(dir);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// The temp folder a worker's CLI uses: the `TMPDIR` it inherits from plxd (0014), or `/tmp`
/// when that is unset or empty, as Node and Bun's `os.tmpdir()` pick it.
fn worker_temp_dir(tmpdir: Option<std::ffi::OsString>) -> PathBuf {
    tmpdir
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| PathBuf::from("/tmp"), PathBuf::from)
}

/// The unreadable path of `sandbox` that `temp` is inside, if any. Claude Code puts its network
/// proxy's sockets in the temp folder, so a deny over it cuts a worker's commands off the network
/// (PLX-107). Allowing the folder instead would reopen what the deny hides.
fn hiding_temp_dir<'a>(sandbox: &'a WorkerSandbox, temp: &Path) -> Option<&'a Path> {
    sandbox
        .unreadable
        .iter()
        .map(PathBuf::as_path)
        .find(|denied| temp.starts_with(denied))
}

/// Characters the vendors' sandbox settings read as wildcards in a path. A path holding one would
/// become a pattern that may not match itself, and a deny rule would fail open.
const GLOB_CHARACTERS: &[char] = &['*', '?', '[', ']'];

/// A worker run's boundary beyond its cwd, which is always readable and writable. Build it with
/// [`WorkerSandbox::for_worktree`]; a sandbox with nothing unreadable is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerSandbox {
    /// Folders the worker may read and write besides its cwd: the project's shared context
    /// folder (0005).
    pub writable: Vec<PathBuf>,
    /// Paths inside the writable folders that commands may read but not write: the worktree's
    /// `.git` file and the repository's git folder it points into. plxd commits for every
    /// backend (0013).
    pub read_only: Vec<PathBuf>,
    /// Paths commands may not read: [`unreadable_in_home`], on Linux the user's runtime folder,
    /// plxd's data folder, the folder that holds every run's temp folder, and Claude Code's
    /// `/tmp/claude-<uid>`, which every Claude Code session of this user shares. The cwd,
    /// [`WorkerSandbox::writable`], and the commands' `TMPDIR` in [`WorkerSandbox::temp`] stay
    /// readable where they fall inside one of these.
    pub unreadable: Vec<PathBuf>,
    /// The run's own temp folder, which plxd makes before the CLI starts and removes when it
    /// exits (PLX-130). A backend points the vendor's temp setting at it (Claude Code's
    /// `CLAUDE_CODE_TMPDIR`), so its commands' `TMPDIR` is this folder or one inside it. The CLI
    /// keeps files of its own here too, so commands may use only their `TMPDIR` (for Claude Code,
    /// `<temp>/claude-<uid>`).
    pub temp: PathBuf,
}

impl WorkerSandbox {
    /// The v1 sandbox (0013) for a worker in `worktree`, a linked worktree whose `.git` file
    /// points into `git_dir`, the repository's shared git folder (`git rev-parse
    /// --git-common-dir`), and whose project's shared context folder is `context`. `home` is the
    /// user's home folder, and `data_dir` plxd's data folder, which holds both the worktree and
    /// the context folder. `temp` is the run's temp folder from [`super::run_temp::create`],
    /// `<root>/<run>`, so its parent holds every other run's.
    #[must_use]
    pub fn for_worktree(
        home: &Path,
        data_dir: &Path,
        worktree: &Path,
        git_dir: &Path,
        context: &Path,
        temp: &Path,
    ) -> Self {
        let runs = temp.parent().unwrap_or(temp);
        // Claude Code's shared folder is in `/tmp` whichever root `temp` is in.
        #[cfg(unix)]
        let claude_shared = {
            let shared = std::fs::canonicalize("/tmp").unwrap_or_else(|_| PathBuf::from("/tmp"));
            let uid = rustix::process::getuid().as_raw();
            Some(shared.join(format!("claude-{uid}")))
        };
        #[cfg(not(unix))]
        let claude_shared = None;
        let unreadable = unreadable_in_home()
            .map(|path| home.join(path))
            .chain(unreadable_outside_home())
            .chain([data_dir.to_owned(), runs.to_owned()])
            .chain(claude_shared)
            .collect();
        Self {
            writable: vec![context.to_owned()],
            read_only: vec![worktree.join(".git"), git_dir.to_owned()],
            unreadable,
            temp: temp.to_owned(),
        }
    }

    /// Every path, for checks that apply to all of them.
    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.writable
            .iter()
            .chain(&self.read_only)
            .chain(&self.unreadable)
            .chain([&self.temp])
            .map(PathBuf::as_path)
    }
}

/// The sandbox `request` runs in: `None` for a no-write run, which never writes, and the
/// request's [`WorkerSandbox`] for a worker.
///
/// # Errors
///
/// [`StartError::Invalid`] if a worker has no sandbox, which is how a caller that predates 0013
/// is refused; if its sandbox has nothing unreadable; or if any of its paths, its cwd, or its
/// account's configuration folder is relative, isn't valid UTF-8, or holds a character the
/// vendors' settings read as a wildcard (`*`, `?`, `[`, `]`); or if the temp folder a worker
/// inherits is inside one of its unreadable paths.
pub fn worker_sandbox(request: &RunRequest) -> Result<Option<&WorkerSandbox>, StartError> {
    if request.policy == ToolPolicy::NoWrite {
        return Ok(None);
    }
    let Some(sandbox) = &request.sandbox else {
        return Err(StartError::Invalid(
            "a workspace-write run needs its worker sandbox (decision 0013)".into(),
        ));
    };
    if sandbox.unreadable.is_empty() {
        return Err(StartError::Invalid(
            "a worker sandbox with nothing unreadable hides no credentials (decision 0013)".into(),
        ));
    }
    let config_home = match &request.account.credential {
        Credential::Subscription { config_home } => config_home.as_deref(),
        Credential::ApiKey(_) => None,
    };
    let mut paths = sandbox
        .paths()
        .chain([request.cwd.as_path()])
        .chain(config_home);
    if let Some(path) = paths.find(|path| !usable(path)) {
        return Err(StartError::Invalid(format!(
            "the worker path {} must be absolute UTF-8 with no *, ?, [, or ]",
            path.display()
        )));
    }
    let temp = worker_temp_dir(std::env::var_os("TMPDIR"));
    if let Some(denied) = hiding_temp_dir(sandbox, &temp) {
        return Err(StartError::Invalid(format!(
            "the worker's temp folder {} is inside {}, which its commands may not read, so they \
             would lose the sandbox's network proxy; set TMPDIR to a folder outside it (decision \
             0013)",
            temp.display(),
            denied.display()
        )));
    }
    Ok(Some(sandbox))
}

fn usable(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|text| !text.contains(GLOB_CHARACTERS))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        WorkerSandbox, hiding_temp_dir, unreadable_in_home, unreadable_outside_home,
        worker_temp_dir,
    };

    #[test]
    fn a_worktree_sandbox_writes_the_context_and_hides_secrets_and_the_data_folder() {
        let sandbox = WorkerSandbox::for_worktree(
            Path::new("/Users/u"),
            Path::new("/Users/u/Library/Application Support/parallax"),
            Path::new("/Users/u/Library/Application Support/parallax/worktrees/app-1a2b/run"),
            Path::new("/Users/u/src/app/.git"),
            Path::new("/Users/u/Library/Application Support/parallax/context/p"),
            // A fallback root in `$TMPDIR`, as when `/tmp` can't be written.
            Path::new("/private/var/folders/x/T/parallax-625c7f6d/Ab12Cd"),
        );
        assert_eq!(
            sandbox.writable,
            [Path::new(
                "/Users/u/Library/Application Support/parallax/context/p"
            )]
        );
        assert_eq!(
            sandbox.read_only,
            [
                Path::new(
                    "/Users/u/Library/Application Support/parallax/worktrees/app-1a2b/run/.git"
                ),
                Path::new("/Users/u/src/app/.git"),
            ]
        );
        assert!(sandbox.unreadable.contains(&"/Users/u/.ssh".into()));
        assert!(
            sandbox
                .unreadable
                .contains(&"/Users/u/Library/Application Support/parallax".into())
        );
        // Every other run's temp folder, and the one all of this user's Claude sessions share.
        assert!(
            sandbox
                .unreadable
                .contains(&"/private/var/folders/x/T/parallax-625c7f6d".into())
        );
        #[cfg(unix)]
        {
            let uid = rustix::process::getuid().as_raw();
            let tmp = std::fs::canonicalize("/tmp").unwrap();
            assert!(
                sandbox
                    .unreadable
                    .contains(&tmp.join(format!("claude-{uid}")))
            );
        }
        assert_eq!(
            sandbox.unreadable.len(),
            unreadable_in_home().count()
                + unreadable_outside_home().len()
                + 2
                + usize::from(cfg!(unix))
        );
        assert_eq!(
            sandbox.temp,
            Path::new("/private/var/folders/x/T/parallax-625c7f6d/Ab12Cd")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_runtime_folders_are_denied_wherever_the_variable_points() {
        use std::os::unix::ffi::OsStringExt;

        use super::{runtime_dirs, usable};

        let fallbacks = [
            Path::new("/run/user/1000"),
            Path::new("/run/containers/1000"),
        ];
        // Unset, empty, and relative values are ignored, as the XDG spec says.
        for ignored in [None, Some("".into()), Some("run".into())] {
            assert_eq!(runtime_dirs(ignored, 1000), fallbacks);
        }
        assert_eq!(
            runtime_dirs(Some("/run/user/1000/".into()), 1000),
            fallbacks
        );
        assert_eq!(
            runtime_dirs(Some("/tmp/run".into()), 1000),
            [Path::new("/tmp/run"), fallbacks[0], fallbacks[1]]
        );
        // Kept, so that `worker_sandbox` refuses the run.
        let not_utf8 = std::ffi::OsString::from_vec(b"/run/\xff".to_vec());
        let dirs = runtime_dirs(Some(not_utf8), 1000);
        assert!(!usable(&dirs[0]), "{dirs:?}");
        assert_eq!(dirs[1..], fallbacks);
    }

    #[test]
    fn a_temp_folder_inside_an_unreadable_path_is_found() {
        let mut sandbox = WorkerSandbox::for_worktree(
            Path::new("/home/u"),
            Path::new("/home/u/.local/share/parallax"),
            Path::new("/home/u/.local/share/parallax/worktrees/app-1a2b/run"),
            Path::new("/home/u/src/app/.git"),
            Path::new("/home/u/.local/share/parallax/context/p"),
            Path::new("/tmp/parallax-1a2b3c4d/Ab12Cd"),
        );
        sandbox.unreadable.push("/run/user/1000".into());
        assert_eq!(worker_temp_dir(None), Path::new("/tmp"));
        assert_eq!(worker_temp_dir(Some("".into())), Path::new("/tmp"));
        for outside in [None, Some("/tmp/".into()), Some("/run/user/10000".into())] {
            assert_eq!(hiding_temp_dir(&sandbox, &worker_temp_dir(outside)), None);
        }
        for (inside, denied) in [
            ("/run/user/1000", "/run/user/1000"),
            ("/run/user/1000/tmp", "/run/user/1000"),
            (
                "/home/u/.local/share/parallax/tmp",
                "/home/u/.local/share/parallax",
            ),
        ] {
            let temp = worker_temp_dir(Some(inside.into()));
            assert_eq!(hiding_temp_dir(&sandbox, &temp), Some(Path::new(denied)));
        }
    }

    /// Paths in the home folder this OS's denylist must hold, on top of every OS's.
    #[cfg(target_os = "macos")]
    const REQUIRED_ON_THIS_OS: &[&str] = &[
        "Library/Keychains",
        // Password managers
        "Library/Application Support/1Password",
        "Library/Application Support/Bitwarden",
        // Browsers
        "Library/Safari",
        "Library/Cookies",
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Firefox",
        "Library/Application Support/Arc",
        "Library/Application Support/BraveSoftware",
        "Library/Application Support/Microsoft Edge",
        // Agent apps
        "Library/Application Support/Cursor",
    ];

    /// Paths in the home folder this OS's denylist must hold, on top of every OS's.
    #[cfg(target_os = "linux")]
    const REQUIRED_ON_THIS_OS: &[&str] = &[
        // Keyrings
        ".local/share/keyrings",
        ".local/share/kwalletd",
        ".pki",
        // Password managers
        ".config/1Password",
        ".config/Bitwarden",
        // Browsers, including Ubuntu's snap Firefox
        ".config/google-chrome",
        ".config/chromium",
        ".config/BraveSoftware",
        ".config/microsoft-edge",
        ".mozilla",
        ".config/mozilla",
        "snap/firefox",
        ".var/app/org.mozilla.firefox",
        // Agent apps
        ".config/Cursor",
    ];

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    const REQUIRED_ON_THIS_OS: &[&str] = &[];

    #[test]
    fn the_denylist_covers_the_common_credential_stores() {
        let required = [
            // Keys, cloud, and infrastructure
            ".ssh",
            ".gnupg",
            ".aws",
            ".kube",
            ".docker",
            ".config/containers",
            ".terraform.d",
            ".vault-token",
            // Git credentials and hosts
            ".git-credentials",
            ".config/git/credentials",
            ".config/gh",
            ".config/github-copilot",
            ".config/hub",
            ".config/glab-cli",
            // Registries and databases
            ".netrc",
            ".npmrc",
            ".yarnrc.yml",
            ".pypirc",
            ".gem/credentials",
            ".m2/settings.xml",
            ".gradle/gradle.properties",
            ".pgpass",
            ".my.cnf",
            // Password managers
            ".password-store",
            ".config/op",
            // Histories
            ".zsh_history",
            ".zsh_sessions",
            ".bash_history",
            ".local/share/fish/fish_history",
            ".python_history",
            ".node_repl_history",
            ".psql_history",
            ".mysql_history",
            ".sqlite_history",
            // Agent CLIs
            ".claude",
            ".codex",
            ".cursor",
        ];
        let denied: Vec<&str> = unreadable_in_home().collect();
        let missing: Vec<&str> = required
            .iter()
            .chain(REQUIRED_ON_THIS_OS)
            .copied()
            .filter(|path| !denied.contains(path))
            .collect();
        assert!(missing.is_empty(), "not denied: {missing:?}");
    }
}
