//! The worker sandbox (0013): what a [`ToolPolicy::WorkspaceWrite`] run may write and read,
//! whichever backend runs it.
//!
//! A worker writes its cwd (its worktree), the project's shared context folder (0005), and its
//! own temp folder. Its commands can't write git metadata or read credential stores or wispd's
//! data folder. They do have network access (Ryan, #137), so the read denylist is what keeps a
//! secret from leaving the machine. Each backend turns a [`WorkerSandbox`] into its own vendor's
//! flags; wispd adds no OS sandbox of its own, because a vendor's sandbox can't start inside one
//! (0013).

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
    /// `.git` file and the repository's git folder it points into. wispd commits for every
    /// backend (0013).
    pub read_only: Vec<PathBuf>,
    /// Paths commands may not read: [`unreadable_in_home`] and wispd's data folder. The cwd and
    /// [`WorkerSandbox::writable`] stay readable where they fall inside one of these.
    pub unreadable: Vec<PathBuf>,
}

impl WorkerSandbox {
    /// The v1 sandbox (0013) for a worker in `worktree`, a linked worktree whose `.git` file
    /// points into `git_dir`, the repository's shared git folder (`git rev-parse
    /// --git-common-dir`), and whose project's shared context folder is `context`. `home` is the
    /// user's home folder, and `data_dir` wispd's data folder, which holds both the worktree and
    /// the context folder.
    #[must_use]
    pub fn for_worktree(
        home: &Path,
        data_dir: &Path,
        worktree: &Path,
        git_dir: &Path,
        context: &Path,
    ) -> Self {
        let unreadable = unreadable_in_home()
            .map(|path| home.join(path))
            .chain([data_dir.to_owned()])
            .collect();
        Self {
            writable: vec![context.to_owned()],
            read_only: vec![worktree.join(".git"), git_dir.to_owned()],
            unreadable,
        }
    }

    /// Every path, for checks that apply to all of them.
    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.writable
            .iter()
            .chain(&self.read_only)
            .chain(&self.unreadable)
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
/// vendors' settings read as a wildcard (`*`, `?`, `[`, `]`).
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

    use super::{WorkerSandbox, unreadable_in_home};

    #[test]
    fn a_worktree_sandbox_writes_the_context_and_hides_secrets_and_the_data_folder() {
        let sandbox = WorkerSandbox::for_worktree(
            Path::new("/Users/u"),
            Path::new("/Users/u/Library/Application Support/wisp"),
            Path::new("/Users/u/Library/Application Support/wisp/worktrees/app-1a2b/run"),
            Path::new("/Users/u/src/app/.git"),
            Path::new("/Users/u/Library/Application Support/wisp/context/p"),
        );
        assert_eq!(
            sandbox.writable,
            [Path::new(
                "/Users/u/Library/Application Support/wisp/context/p"
            )]
        );
        assert_eq!(
            sandbox.read_only,
            [
                Path::new("/Users/u/Library/Application Support/wisp/worktrees/app-1a2b/run/.git"),
                Path::new("/Users/u/src/app/.git"),
            ]
        );
        assert!(sandbox.unreadable.contains(&"/Users/u/.ssh".into()));
        assert!(
            sandbox
                .unreadable
                .contains(&"/Users/u/Library/Application Support/wisp".into())
        );
        assert_eq!(sandbox.unreadable.len(), unreadable_in_home().count() + 1);
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
