//! Git worktrees for agent runs (#154, plan #67): each subagent works in its own worktree of the
//! project's repo on the host, never in the user's own checkout.
//!
//! [`WorktreeManager`] runs every git command through [`Launcher`], the same process supervisor
//! backends use: an explicit, scrubbed environment and a timeout per call, so a hung or
//! credential-prompting git can never block plxd. Only two calls change the project repo's own
//! working tree: [`WorktreeManager::accept`] (#157), when the user accepts a run, and it refuses
//! rather than touch uncommitted changes (see `review`), and [`WorktreeManager::switch`], when a
//! Current checkout thread starts on a ref the user picked, which git refuses likewise (see
//! `refs`). Otherwise `worktree add`, `worktree
//! remove`, `worktree prune`, and the `branch -m` that names a thread's branch (0058) only touch
//! `.git/worktrees` metadata and refs, and `status`, `rev-parse`, and `diff` are read-only.
//!
//! The runner (`crate::agents`, #156) is its caller: `agent/start` creates a run's worktree here
//! and stores its row, including [`CreatedWorktree::git_dir`], in `parallax-store`'s `worktrees`
//! table, and a finished run is committed with [`WorktreeManager::commit_all`] and measured with
//! [`WorktreeManager::diff_stat`]. A client reviews the commit through
//! [`WorktreeManager::diff_commits`] and [`WorktreeManager::read_blob`] (#157), and
//! [`WorktreeManager::open_pr`] pushes its branch and opens a pull request for it (PLX-168).
//! `folder` has the git calls a run's Git menu makes, in its worktree or checkout (PLX-298).
//! `integration` keeps each Project's integration branch and its worktree (PLX-409, 0045),
//! `coordinator` its coordinator's detached worktree at that branch's tip (PLX-397, 0042), and
//! `landing` merges its children onto it (PLX-410).
//!
//! # Layout and naming
//!
//! A worktree lives at `<data dir>/worktrees/<repo slug>/<run id>`, where `<repo slug>` is the
//! repo's directory name plus a short hash of its canonical path (so two repos named the same
//! thing never collide, and the folder stays readable). Its branch is `parallax/<short run id>`
//! (or `parallax/<slug>` for a named one, which [`WorktreeManager::rename_branch`] can rename to
//! once a thread is named),
//! `<short run id>` being the first 8 hex digits of the SHA-256 of the run id — the same
//! short-hash idea [`crate::paths::DataDir`] uses for its socket fallback, and collision-free in
//! the way a prefix of the run id's own (time-ordered) `UUIDv7` bytes would not be.
//!
//! # Base and identity
//!
//! [`WorktreeManager::create_named`] resolves `base` to a concrete commit once, at creation, so a
//! later [`WorktreeManager::diff_stat`] is never compared against a ref that has since moved.
//! When the caller leaves `base` unset (the repo's current branch `HEAD`), creation never refuses
//! over the repo's own working tree (#257): an untracked file was never going to be in a
//! fresh worktree anyway, and a tracked, uncommitted change simply isn't included either, the same
//! as checking out any other commit. [`CreatedWorktree::base_dirty`] flags the latter case — the
//! repo's tracked files had uncommitted changes at that moment — so a caller can tell the user
//! those edits aren't in the run; an explicit `base` is never flagged, since the caller chose it on
//! purpose. [`WorktreeManager::commit_all`]
//! resolves `user.name`/`user.email` itself, from the repository the user actually works in
//! (`repo_root`, see [`WorktreeManager::resolve_identity`]), and scrubs every environment
//! variable that could override them anyway (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `EMAIL`), so a
//! commit is always attributed to whatever the repo itself says, never to whatever plxd
//! inherited.
//!
//! # A worker's worktree is hostile input (#166)
//!
//! An agent run (#137, decision 0013) can write every file in its worktree. `commit_all`,
//! `diff_stat`, and `diff_commits` run git there on the worker's behalf, so the worktree's own
//! tracked content and git state must never be able to make that git process run the worker's
//! code: a hook, a repository-configured `core.hooksPath` pointing at a tracked folder (as husky
//! does), a `.gitattributes` diff or filter driver, or a `.git` file rewritten to point somewhere
//! else entirely.
//!
//! [`WorktreeManager::create_named`] resolves the linked worktree's own private git directory once,
//! right after `git worktree add`, the one moment its `.git` file is still trustworthy (nothing
//! has run in the new worktree yet). [`CreatedWorktree::git_dir`] carries that path, and every
//! later call that touches the worktree (`diff_stat`, `diff_commits`, `commit_all`) takes it and pins
//! `--git-dir`/`--work-tree` explicitly, so a `.git` file the worker rewrites afterward is never
//! consulted again. Those calls also run with hooks, the pager, external diff and textconv
//! drivers, and remote helper protocols disabled by `-c`, and with `GIT_CONFIG_NOSYSTEM`, a
//! `/dev/null` `GIT_CONFIG_GLOBAL`, and a scrubbed, dedicated `HOME`, so the only config git can
//! still read is the pinned repository's own local config, which the worker cannot write.
//!
//! [`WorktreeManager::create_named`] and [`WorktreeManager::remove`] are not scoped this way: their git
//! commands run against `repo_root`, the user's own checkout, which a sandboxed worker never
//! writes, so there is no `.git` file or repo-local config of the worker's to distrust there. A
//! coordinator or a worker in Bypass Permissions can write it, but either can already run any
//! command as the user (0027). They still run
//! with hooks off, like every git call plxd makes (#157, #191): once a run is accepted, the
//! checkout's hooks can include files the worker wrote.
//!
//! **Known gap (#175):** a `-c` override wins over a config value no matter how that value was
//! set, including through an `include`/`includeIf`, so hooks and hooksPath stay closed either
//! way. Filter drivers (`filter.<name>.clean`/`.smudge`) don't have that `-c` escape hatch, and if
//! the pinned repository's own local config contains an *absolute* `include.path` pointing into
//! the worktree, the included file can still define one, for a worker's `.gitattributes` to
//! trigger. A *relative* `include.path` doesn't reach the worktree — it resolves against the
//! repository's git folder — so this needs an unusual repository configuration to matter; #175
//! tracks closing it.

mod checkpoint;
mod checks;
mod coordinator;
mod folder;
mod integration;
mod landing;
mod pull_request;
mod refs;
mod review;
mod scratch;
#[cfg(all(test, unix))]
mod tests;
#[cfg(all(test, windows))]
mod windows_tests;

pub use checkpoint::{DiffFormat, parse_numstat_z};
pub use checks::{CHECKS_TIMEOUT, Checked};
pub use folder::RunFolder;
pub use landing::Merged;
pub use pull_request::{PrError, github_pr_urls};
pub use review::{AcceptError, MAX_BLOB_BYTES, MergeHow, validate_repo_path};

use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::Duration;

use parallax_protocol::RunId;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;
use tracing::warn;

use crate::backend::process::{
    Environment, Exit, Launcher, Output, Process, ProcessSpec, SpawnError, StdinMode,
};

/// How long a single git invocation may run before plxd gives up on it and kills its process
/// group. A hung `git` (an unexpected credential prompt, a stuck hook) must never block plxd.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest line a git call whose whole output is read may write (PLX-143). A `-z` output has
/// no newline, so it is one line: 64 MiB holds about 800k paths. A longer line fails the call.
// ponytail: past this, Accept and `agent/diff` fail loudly; read `-z` output split on NUL, with a
// total cap, if a real repository gets there.
const DEFAULT_MAX_GIT_LINE_BYTES: usize = 64 * 1024 * 1024;

const WORKTREES_DIR: &str = "worktrees";

/// The folder under the data directory holding each Project's integration worktree (0045).
const INTEGRATION_DIR: &str = "integration";

/// The folder under the data directory holding each Project's coordinator's worktree (0042).
const COORDINATORS_DIR: &str = "coordinators";

/// Environment variables scrubbed from every git invocation, on top of
/// [`crate::backend::process::ALWAYS_SCRUBBED`]: anything that could redirect git to a different
/// repository or config, prompt for credentials, or override the commit identity we want to come
/// from the repo's own configuration.
const GIT_SCRUBBED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "EMAIL",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
];

/// Extra environment variables scrubbed from a call scoped to a worker's worktree (#166), on top
/// of [`GIT_SCRUBBED`]: `XDG_CONFIG_HOME` could otherwise point git at a config file outside the
/// dedicated, empty `HOME` these calls inject.
const WORKTREE_GIT_EXTRA_SCRUBBED: &[&str] = &["XDG_CONFIG_HOME"];

/// The names, from `base`, of any `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pair (git's way of
/// setting config from the environment, indexed rather than named, so [`GIT_SCRUBBED`] can't list
/// them). [`GIT_SCRUBBED`] already removes `GIT_CONFIG_COUNT`, without which git ignores every
/// indexed pair regardless of index, so this is defense in depth for a worktree-scoped call
/// (#166): scrubbed by name too, in case something downstream ever sets its own count.
fn indexed_git_config_vars(base: &Environment) -> Vec<OsString> {
    base.names()
        .filter(|name| {
            let name = name.to_string_lossy();
            name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_")
        })
        .map(OsString::from)
        .collect()
}

/// The folder under a manager's data directory used as `HOME` for every git command scoped to a
/// worker's worktree (#166): empty, so there is no `~/.gitconfig`, `~/.git-credentials`, or
/// `~/.ssh` for a worker's tracked files, or an inherited ambient environment, to route git
/// through.
const GIT_SAFE_HOME_DIR: &str = "git-safe-home";

/// The null device as git is given it, for `core.hooksPath` and `GIT_CONFIG_GLOBAL` (0023).
/// Git for Windows reads `/dev/null` in `core.hooksPath` as `C:\dev\null`, a folder any user of
/// the machine may create, so Windows uses `NUL`, a reserved name no checkout can create.
pub(crate) const NULL_DEVICE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// `-c` with [`NULL_DEVICE`] as `core.hooksPath`: no hooks run.
pub(crate) const NO_HOOKS: &str = if cfg!(windows) {
    "core.hooksPath=NUL"
} else {
    "core.hooksPath=/dev/null"
};

/// `-c` overrides applied to every git command scoped to a worker's worktree (#166), neutralizing
/// what repo-local config and tracked files can otherwise make git execute:
///
/// - `core.hooksPath=/dev/null` ([`NO_HOOKS`], `NUL` on Windows) — no hooks run, wherever
///   `core.hooksPath` points, including a tracked folder such as husky's `.husky/_`.
///   `--no-verify` alone only skips `pre-commit` and `commit-msg`; `post-commit` and (on
///   `git add`) `post-index-change` still run without this.
/// - `core.fsmonitor=false` — no filesystem monitor hook.
/// - `core.pager=cat`, `diff.external=` — no pager or external diff tool.
/// - `core.sshCommand=false` — if anything ever triggered a transport, no attacker-chosen SSH
///   command.
/// - `protocol.allow=never` — no remote helper protocol (for example `ext::`) runs.
///
/// Filter drivers (`filter.<name>.clean`/`.smudge`) can't be neutralized this way, because `-c`
/// needs the filter's name and `man git-config` gives no wildcard form. Instead, worktree-scoped
/// calls run with `GIT_CONFIG_NOSYSTEM=1`, a `/dev/null` `GIT_CONFIG_GLOBAL`, and a dedicated,
/// empty `HOME` (see [`GIT_SAFE_HOME_DIR`]), so the pinned repository's own local config — never
/// worker-writable — is the only place left a filter, or a diff or merge driver, could be
/// configured.
const WORKTREE_GIT_CONFIG: &[(&str, &str)] = &[
    ("core.hooksPath", NULL_DEVICE),
    ("core.fsmonitor", "false"),
    ("core.pager", "cat"),
    ("core.sshCommand", "false"),
    ("diff.external", ""),
    ("protocol.allow", "never"),
];

/// Extra flags for a diff-family subcommand (`diff`, `show`, `log`) scoped to a worker's worktree
/// (#166): a `.gitattributes` `diff=` driver's `textconv`, or `GIT_EXTERNAL_DIFF`-style external
/// diff, must not run either.
const NO_DIFF_DRIVERS: &[&str] = &["--no-ext-diff", "--no-textconv"];

/// Why a worktree operation failed.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum WorktreeError {
    /// `repo_path` doesn't exist or isn't inside a git repository.
    #[error("{} is not a git repository: {detail}", .path.display())]
    NotAGitRepo {
        /// The path as given.
        path: PathBuf,
        /// What git or the filesystem said.
        detail: String,
    },
    /// `base` didn't resolve to a commit.
    #[error("could not resolve {reference:?} to a commit in {}: {detail}", .repo.display())]
    UnknownRevision {
        /// The repository.
        repo: PathBuf,
        /// The reference as given.
        reference: String,
        /// What git said.
        detail: String,
    },
    /// [`WorktreeManager::commit_all`] found changes to commit, but the repository has no
    /// `user.name` or `user.email` configured.
    #[error(
        "{} has no git identity configured (user.name and user.email); set one before an agent can commit there",
        .repo.display()
    )]
    MissingIdentity {
        /// The repository (or worktree) that lacks an identity.
        repo: PathBuf,
    },
    /// A git command exited with a non-zero status, or wrote a line too long to read (PLX-143).
    #[error("`git {}` in {} failed: {detail}", .args.join(" "), .cwd.display())]
    GitFailed {
        /// Where it ran.
        cwd: PathBuf,
        /// The arguments after `git`.
        args: Vec<String>,
        /// The end of its stderr, or a description of its exit if stderr was empty.
        detail: String,
    },
    /// A git command did not finish within [`WorktreeManager`]'s timeout, and its process group
    /// was killed.
    #[error("`git {}` in {} timed out after {timeout:?}", .args.join(" "), .cwd.display())]
    Timeout {
        /// Where it ran.
        cwd: PathBuf,
        /// The arguments after `git`.
        args: Vec<String>,
        /// The timeout that elapsed.
        timeout: Duration,
    },
    /// git could not be started.
    #[error(transparent)]
    Spawn(#[from] SpawnError),
    /// A filesystem operation other than running git failed.
    #[error("could not use {}: {source}", .path.display())]
    Io {
        /// The path involved.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: io::Error,
    },
}

/// A newly created worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedWorktree {
    /// Its absolute path, under the parallax-owned worktrees folder.
    pub path: PathBuf,
    /// Its branch, `parallax/<short run id>`.
    pub branch: String,
    /// The concrete commit it was created from, resolved once so it never moves under it.
    pub base: String,
    /// The linked worktree's own private git directory (`<repo>/.git/worktrees/<name>`),
    /// resolved once at creation from the `.git` file `git worktree add` just wrote, before any
    /// worker code has run. Every later call passes this back so it never has to trust that
    /// `.git` file again (#166): the worktree it names is worker-writable, and a worker could
    /// rewrite it to point anywhere.
    pub git_dir: PathBuf,
    /// Whether the repository's tracked files had uncommitted changes when `base` was resolved
    /// from `HEAD` (#257): those changes aren't in this worktree. Always `false` when the caller
    /// passed an explicit `base`.
    pub base_dirty: bool,
}

/// How a changed file differs from the base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    /// Added since the base.
    Added,
    /// Modified since the base.
    Modified,
    /// Deleted since the base.
    Deleted,
    /// Renamed, with [`ChangedFile::old_path`] set.
    Renamed,
    /// Copied from another file, with [`ChangedFile::old_path`] set.
    Copied,
    /// Its type changed, for example a file became a symlink.
    TypeChanged,
    /// It has an unresolved merge conflict.
    Unmerged,
    /// A status letter this build doesn't recognize.
    Unknown(String),
}

/// One file that differs from the base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedFile {
    /// How it changed.
    pub status: ChangeStatus,
    /// Its current path, relative to the worktree root.
    pub path: String,
    /// Its path before a rename or copy.
    pub old_path: Option<String>,
}

/// How much a worktree differs from its base, from [`WorktreeManager::diff_stat`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiffStat {
    /// Files changed.
    pub files: u64,
    /// Lines added.
    pub insertions: u64,
    /// Lines removed.
    pub deletions: u64,
}

/// The commit [`WorktreeManager::commit_all`] made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    /// Its full sha.
    pub sha: String,
}

/// Creates, inspects, and removes the worktrees agent runs use.
///
/// Cheap to clone: it shares its [`Launcher`] and its per-repository lock table.
#[derive(Clone)]
pub struct WorktreeManager {
    launcher: Launcher,
    root: PathBuf,
    integration_root: PathBuf,
    coordinator_root: PathBuf,
    git_safe_home: PathBuf,
    max_git_line_bytes: usize,
    merge_timeout: Duration,
    repo_locks: Arc<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>>,
}

impl WorktreeManager {
    /// A manager whose worktrees live under `data_dir_root`'s `worktrees` folder, and whose git
    /// commands run through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher, data_dir_root: &Path) -> Self {
        Self {
            launcher,
            root: data_dir_root.join(WORKTREES_DIR),
            integration_root: data_dir_root.join(INTEGRATION_DIR),
            coordinator_root: data_dir_root.join(COORDINATORS_DIR),
            git_safe_home: data_dir_root.join(GIT_SAFE_HOME_DIR),
            max_git_line_bytes: DEFAULT_MAX_GIT_LINE_BYTES,
            merge_timeout: review::MERGE_TIMEOUT,
            repo_locks: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Overrides how long Accept's checkout may run, 300 s by default.
    #[must_use]
    pub fn with_merge_timeout(mut self, merge_timeout: Duration) -> Self {
        self.merge_timeout = merge_timeout;
        self
    }

    /// Overrides the longest line a git call read whole may write, 64 MiB by default.
    #[must_use]
    pub fn with_max_git_line_bytes(mut self, max_git_line_bytes: usize) -> Self {
        self.max_git_line_bytes = max_git_line_bytes;
        self
    }

    /// Creates a worktree of `repo_path` for `run_id`, on a new branch starting from `base` (a
    /// commit-ish git can resolve), or the repo's current branch `HEAD` when `base` is `None`. The
    /// branch is `parallax/<slug>` when `slug` is given ([`valid_branch_slug`]), with the short
    /// run id after it when a branch already has that name, or else `parallax/<short run id>`.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`] if `repo_path` isn't a git repository,
    /// [`WorktreeError::UnknownRevision`] if `base` doesn't resolve, or
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`] from
    /// running git.
    pub async fn create_named(
        &self,
        repo_path: &Path,
        run_id: RunId,
        base: Option<&str>,
        slug: Option<&str>,
    ) -> Result<CreatedWorktree, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let (resolved_base, base_dirty) = if let Some(reference) = base {
            (self.resolve_commit(&repo_root, reference).await?, false)
        } else {
            let dirty = self.tracked_dirty(&repo_root).await?;
            (self.resolve_commit(&repo_root, "HEAD").await?, dirty)
        };

        // The repo lock covers only naming the branch and adding the worktree's metadata: git
        // reads every worktree's metadata while adding one, so two adds at once can fail on each
        // other's half-written files. The checkout, the slow part, runs after it, so many
        // threads in one repo start in parallel.
        let guard = self.lock_repo(&repo_root).await;
        let branch = self.free_branch(&repo_root, run_id, slug).await?;
        let path = self
            .root
            .join(project_dir_name(&repo_root))
            .join(run_id.to_string());
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|source| WorktreeError::Io {
                    path: parent.to_owned(),
                    source,
                })?;
        }

        let path_arg = path.to_string_lossy().into_owned();
        self.run_git_ok(
            &repo_root,
            &[
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                &branch,
                &path_arg,
                &resolved_base,
            ],
        )
        .await?;
        drop(guard);
        if let Err(error) = self
            .run_git_ok(&path, &["reset", "--hard", "--quiet"])
            .await
        {
            if let Err(cleanup) = self.remove(&repo_root, &path, &branch).await {
                warn!(path = %path.display(), %cleanup, "could not remove a worktree whose checkout failed");
            }
            return Err(error);
        }

        // The one moment the new worktree's `.git` file is trusted: git just wrote it, and no
        // worker has run yet. Every later call pins this path explicitly instead (#166).
        let git_dir_output = self
            .run_git_ok(&path, &["rev-parse", "--absolute-git-dir"])
            .await?;
        let git_dir = PathBuf::from(git_dir_output.trim());

        Ok(CreatedWorktree {
            path,
            branch,
            base: resolved_base,
            git_dir,
            base_dirty,
        })
    }

    /// The branch run `run_id` gets in `repo_root`: `parallax/<slug>` for a valid `slug`, with the
    /// short run id after it when a branch already has that name, or else `parallax/<short run
    /// id>`. The caller holds the repo's lock.
    async fn free_branch(
        &self,
        repo_root: &Path,
        run_id: RunId,
        slug: Option<&str>,
    ) -> Result<String, WorktreeError> {
        let short = short_hash(&run_id.to_string());
        let Some(slug) = slug.filter(|slug| valid_branch_slug(slug)) else {
            return Ok(format!("parallax/{short}"));
        };
        let named = format!("parallax/{slug}");
        let taken = self
            .run_git(
                repo_root,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{named}"),
                ],
            )
            .await?
            .success();
        Ok(if taken {
            format!("{named}-{short}")
        } else {
            named
        })
    }

    /// Renames run `run_id`'s branch `branch` in `repo_path` to the name [`Self::create_named`]
    /// would give it for `slug` (0058), and a worktree that has it out follows. Returns the new
    /// name, or `None` when the branch keeps its own: it has an upstream, so its name is on a
    /// remote too, it already has that name, or `slug` isn't a valid one.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], or [`WorktreeError::GitFailed`],
    /// [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`] from running git, as for a branch
    /// that no longer exists.
    pub async fn rename_branch(
        &self,
        repo_path: &Path,
        run_id: RunId,
        branch: &str,
        slug: &str,
    ) -> Result<Option<String>, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let _guard = self.lock_repo(&repo_root).await;
        let upstream = self
            .run_git(
                &repo_root,
                &["config", "--get", &format!("branch.{branch}.merge")],
            )
            .await?
            .success();
        if upstream || !valid_branch_slug(slug) || branch == format!("parallax/{slug}") {
            return Ok(None);
        }
        let renamed = self.free_branch(&repo_root, run_id, Some(slug)).await?;
        if renamed == branch {
            return Ok(None);
        }
        self.run_git_ok(&repo_root, &["branch", "-m", "--", branch, &renamed])
            .await?;
        Ok(Some(renamed))
    }

    /// Renames branch `from` in `repo_path` back to `to`, for a [`Self::rename_branch`] whose
    /// new name plxd couldn't record.
    ///
    /// # Errors
    ///
    /// As [`Self::rename_branch`].
    pub async fn rename_back(
        &self,
        repo_path: &Path,
        from: &str,
        to: &str,
    ) -> Result<(), WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let _guard = self.lock_repo(&repo_root).await;
        self.run_git_ok(&repo_root, &["branch", "-m", "--", from, to])
            .await
            .map(drop)
    }

    /// How many files and lines differ between `base` and the worktree's current state, committed
    /// or not: `git diff --numstat`, pinned and hardened (#166). A binary
    /// file counts as a changed file with no lines.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn diff_stat(
        &self,
        worktree_path: &Path,
        git_dir: &Path,
        base: &str,
    ) -> Result<DiffStat, WorktreeError> {
        self.stage_all(worktree_path, git_dir).await?;
        let mut args = vec!["diff", "--cached", "--no-color", "--find-renames"];
        args.extend_from_slice(NO_DIFF_DRIVERS);
        args.extend_from_slice(&["--numstat", base]);
        let output = self
            .run_worktree_git_ok(worktree_path, git_dir, &args)
            .await?;
        Ok(parse_numstat(&output))
    }

    /// The shared git folder of the repository at `repo_path` (`git rev-parse --git-common-dir`),
    /// as an absolute path. It runs in the user's own checkout, never in a worker's worktree, so
    /// no worker-written file decides the answer. The worker sandbox (0013) makes it read-only.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], or [`WorktreeError::GitFailed`],
    /// [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn git_common_dir(&self, repo_path: &Path) -> Result<PathBuf, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let output = self
            .run_git_ok(
                &repo_root,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .await?;
        Ok(PathBuf::from(output.trim()))
    }

    /// Stages every change in the worktree and commits it with `message`, using the repository's
    /// own configured `user.name`/`user.email`, resolved from `repo_root` (see
    /// [`WorktreeManager::resolve_identity`]). Returns `None`, committing nothing, if there is
    /// nothing to commit.
    ///
    /// Runs with `--no-verify` and `--no-gpg-sign`: hooks and interactive signing assume a person
    /// is at the keyboard, and a headless commit that triggers either must not hang plxd.
    /// `--no-verify` alone only skips the `pre-commit` and `commit-msg` hooks; `git_dir` must be
    /// [`CreatedWorktree::git_dir`] for `worktree_path`, which additionally disables every other
    /// hook and execution vector a worker's worktree could reach (#166); see the module
    /// documentation.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::MissingIdentity`] if there is something to commit but `repo_root` has no
    /// configured identity, or [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or
    /// [`WorktreeError::Spawn`].
    pub async fn commit_all(
        &self,
        worktree_path: &Path,
        git_dir: &Path,
        repo_root: &Path,
        message: &str,
    ) -> Result<Option<Commit>, WorktreeError> {
        let folder = RunFolder::Worktree {
            path: worktree_path,
            git_dir,
        };
        self.commit(folder, repo_root, message).await
    }

    /// Removes `worktree_path` and its `branch` from `repo_path`'s repository.
    ///
    /// Branch deletion is best-effort: the worktree is gone either way, and a branch that is
    /// already gone, or that git otherwise refuses to delete, only produces a log warning.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], or [`WorktreeError::GitFailed`],
    /// [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`] removing the worktree itself.
    pub async fn remove(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
    ) -> Result<(), WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let _guard = self.lock_repo(&repo_root).await;

        let path_arg = worktree_path.to_string_lossy().into_owned();
        self.run_git_ok(&repo_root, &["worktree", "remove", "--force", &path_arg])
            .await?;

        match self.run_git(&repo_root, &["branch", "-D", branch]).await {
            Ok(output) if output.success() => {}
            Ok(output) => warn!(
                branch,
                repo = %repo_root.display(),
                stderr = %output.exit.stderr_tail,
                "could not delete a removed worktree's branch"
            ),
            Err(error) => {
                warn!(branch, repo = %repo_root.display(), %error, "could not delete a removed worktree's branch");
            }
        }
        let _ = self.run_git(&repo_root, &["worktree", "prune"]).await;
        Ok(())
    }

    /// Removes a folder plxd owns directly, with no git command, so nothing here may discover a
    /// repository from, or trust, whatever `path`'s own `.git` file says (#166, #171). `path`
    /// itself must be a real directory, never a symlink planted to route this removal elsewhere.
    async fn remove_orphan(&self, path: &Path) -> Result<(), WorktreeError> {
        if !is_real_dir(path).await {
            return Err(WorktreeError::Io {
                path: path.to_owned(),
                source: io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "refusing to remove an orphan entry that is not a plain directory",
                ),
            });
        }
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|source| WorktreeError::Io {
                path: path.to_owned(),
                source,
            })
    }

    /// `repo_path`'s repository root, and confirmation that it is one.
    async fn repo_root(&self, repo_path: &Path) -> Result<PathBuf, WorktreeError> {
        let not_a_repo = |detail: String| WorktreeError::NotAGitRepo {
            path: repo_path.to_owned(),
            detail,
        };
        let canonical = tokio::fs::canonicalize(repo_path)
            .await
            .map_err(|source| not_a_repo(source.to_string()))?;
        let output = self
            .run_git(&canonical, &["rev-parse", "--show-toplevel"])
            .await?;
        if !output.success() {
            return Err(not_a_repo(describe_failure(&output)));
        }
        Ok(PathBuf::from(output.stdout.trim().to_owned()))
    }

    async fn resolve_commit(
        &self,
        repo_root: &Path,
        reference: &str,
    ) -> Result<String, WorktreeError> {
        let commit_ish = format!("{reference}^{{commit}}");
        let output = self
            .run_git(
                repo_root,
                &["rev-parse", "--verify", "--quiet", &commit_ish],
            )
            .await?;
        let sha = output.stdout.trim();
        if !output.success() || sha.is_empty() {
            return Err(WorktreeError::UnknownRevision {
                repo: repo_root.to_owned(),
                reference: reference.to_owned(),
                detail: describe_failure(&output),
            });
        }
        Ok(sha.to_owned())
    }

    /// Stages every change in the worktree, including untracked files: plain `git diff <base>`
    /// never shows an untracked file, so [`WorktreeManager::diff_stat`] and
    /// [`WorktreeManager::commit_all`] compare `base` against the index (`--cached`) after
    /// staging, rather than the working tree directly. That gives the
    /// same answer before and after a run's changes are committed: once committed, staging finds
    /// nothing new, and the index already matches `HEAD`.
    async fn stage_all(&self, worktree_path: &Path, git_dir: &Path) -> Result<(), WorktreeError> {
        self.run_worktree_git_ok(worktree_path, git_dir, &["add", "-A"])
            .await?;
        Ok(())
    }

    /// Whether the repository's tracked files have uncommitted changes, staged or unstaged (#257).
    /// Untracked files are excluded (`--untracked-files=no`): they were never part of any commit,
    /// so a worktree cut fresh from `HEAD` doesn't lack anything of theirs a clean `HEAD` wouldn't
    /// also lack, and they don't warrant flagging [`CreatedWorktree::base_dirty`].
    async fn tracked_dirty(&self, repo_root: &Path) -> Result<bool, WorktreeError> {
        let status = self
            .run_git_ok(
                repo_root,
                // Many starts check one repo at once, so none takes the index lock to refresh
                // it.
                &[
                    "--no-optional-locks",
                    "status",
                    "--porcelain",
                    "--untracked-files=no",
                ],
            )
            .await?;
        Ok(!status.trim().is_empty())
    }

    /// The repository's configured `user.name`/`user.email`, or `None` if either is unset.
    ///
    /// Resolved against `repo_root` (the user's own checkout) through the ordinary,
    /// unrestricted [`WorktreeManager::run_git`], not the locked-down
    /// [`WorktreeManager::run_worktree_git`] a worker's worktree calls go through: `repo_root`
    /// isn't worker-writable (#137, decision 0013), so there is nothing to harden here, and an
    /// identity configured only in `~/.gitconfig` — true for most users — must still resolve.
    /// [`WorktreeManager::commit_all`] passes the result back into the worktree-scoped commit
    /// explicitly, with `-c user.name=`/`-c user.email=`, since that call's own environment
    /// can't see it.
    async fn resolve_identity(
        &self,
        repo_root: &Path,
    ) -> Result<Option<(String, String)>, WorktreeError> {
        let configured = |output: GitOutput| -> Option<String> {
            if !output.success() {
                return None;
            }
            let value = output.stdout.trim();
            (!value.is_empty()).then(|| value.to_owned())
        };
        let name = self
            .run_git(repo_root, &["config", "--get", "user.name"])
            .await?;
        let email = self
            .run_git(repo_root, &["config", "--get", "user.email"])
            .await?;
        Ok(match (configured(name), configured(email)) {
            (Some(name), Some(email)) => Some((name, email)),
            _ => None,
        })
    }

    async fn lock_repo(&self, repo_root: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let mutex = {
            let mut locks = self
                .repo_locks
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            Arc::clone(
                locks
                    .entry(repo_root.to_owned())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
            )
        };
        mutex.lock_owned().await
    }

    /// Runs `git args` in `cwd` and returns its output, whatever its exit status. Only
    /// [`WorktreeError::Spawn`], [`WorktreeError::Timeout`], and [`WorktreeError::GitFailed`] for
    /// a line too long to read (see [`collect`]) are possible failures here; callers that want a
    /// non-zero exit turned into an error use [`WorktreeManager::run_git_ok`].
    ///
    /// Every call runs with `core.hooksPath=/dev/null` (#157, #191): no git command plxd runs
    /// in the user's checkout ever runs a repository hook. Once a run is accepted, the
    /// repository's hooks can include files the agent wrote (a tracked `core.hooksPath` such as
    /// husky's `.husky/`), and `worktree add` (`post-checkout`) or `branch -D`
    /// (`reference-transaction`) would otherwise run them, headless and unsandboxed, in plxd.
    async fn run_git(&self, cwd: &Path, args: &[&str]) -> Result<GitOutput, WorktreeError> {
        self.run_git_for(cwd, args, DEFAULT_TIMEOUT).await
    }

    /// [`WorktreeManager::run_git`] with its own timeout, for the one call that may take long.
    async fn run_git_for(
        &self,
        cwd: &Path,
        args: &[&str],
        limit: Duration,
    ) -> Result<GitOutput, WorktreeError> {
        let (stdout, exit) = self
            .exec(&self.git_spec(cwd, args), cwd, args, limit)
            .await?;
        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            exit,
        })
    }

    /// Runs `spec`, `git args` in `cwd`, and reads all of its stdout, killing it after `limit`.
    async fn exec(
        &self,
        spec: &ProcessSpec,
        cwd: &Path,
        args: &[&str],
        limit: Duration,
    ) -> Result<(Vec<u8>, Exit), WorktreeError> {
        let process = self.launcher.spawn(spec)?;
        timeout(limit, collect(process, cwd, args))
            .await
            .map_err(|_| WorktreeError::Timeout {
                cwd: cwd.to_owned(),
                args: owned_args(args),
                timeout: limit,
            })?
    }

    /// The process spec [`WorktreeManager::run_git`] runs.
    fn git_spec(&self, cwd: &Path, args: &[&str]) -> ProcessSpec {
        let mut spec = ProcessSpec::new("git", cwd);
        spec.args = ["-c", NO_HOOKS]
            .iter()
            .chain(args)
            .map(|arg| OsString::from(*arg))
            .collect();
        spec.scrub = GIT_SCRUBBED
            .iter()
            .map(|name| OsString::from(*name))
            .collect();
        spec.inject.set("GIT_TERMINAL_PROMPT", "0");
        spec.stdin = StdinMode::Null;
        spec.limits.max_line_bytes = self.max_git_line_bytes;
        spec
    }

    /// Like [`WorktreeManager::run_git`], but a non-zero exit becomes [`WorktreeError::GitFailed`]
    /// and only stdout is returned.
    async fn run_git_ok(&self, cwd: &Path, args: &[&str]) -> Result<String, WorktreeError> {
        self.run_git(cwd, args).await?.ok(cwd, args)
    }

    /// Runs `git args` against `work_tree`, with the git directory pinned to `git_dir` and every
    /// execution vector `work_tree`'s tracked files or repo-local config could reach neutralized
    /// (#166): see the module documentation and [`WORKTREE_GIT_CONFIG`]. It fails like
    /// [`Self::run_git`], and with [`WorktreeError::Io`] when preparing the dedicated `HOME`
    /// fails; [`Self::run_worktree_git_ok`] also turns a non-zero exit into an error.
    async fn run_worktree_git(
        &self,
        work_tree: &Path,
        git_dir: &Path,
        args: &[&str],
    ) -> Result<GitOutput, WorktreeError> {
        let mut spec = self.worktree_spec(work_tree, git_dir, args).await?;
        spec.limits.max_line_bytes = self.max_git_line_bytes;
        let (stdout, exit) = self.exec(&spec, work_tree, args, DEFAULT_TIMEOUT).await?;
        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            exit,
        })
    }

    /// The process spec for `git args` scoped to a worker's worktree: see
    /// [`Self::run_worktree_git`].
    async fn worktree_spec(
        &self,
        work_tree: &Path,
        git_dir: &Path,
        args: &[&str],
    ) -> Result<ProcessSpec, WorktreeError> {
        tokio::fs::create_dir_all(&self.git_safe_home)
            .await
            .map_err(|source| WorktreeError::Io {
                path: self.git_safe_home.clone(),
                source,
            })?;

        let mut spec = ProcessSpec::new("git", work_tree);
        spec.args = worktree_argv(work_tree, git_dir, args);
        spec.scrub = GIT_SCRUBBED
            .iter()
            .chain(WORKTREE_GIT_EXTRA_SCRUBBED)
            .map(|name| OsString::from(*name))
            .chain(indexed_git_config_vars(self.launcher.base()))
            .collect();
        spec.inject.set("GIT_TERMINAL_PROMPT", "0");
        spec.inject.set("GIT_CONFIG_NOSYSTEM", "1");
        spec.inject.set("GIT_CONFIG_GLOBAL", NULL_DEVICE);
        spec.inject
            .set("HOME", self.git_safe_home.to_string_lossy().into_owned());
        spec.stdin = StdinMode::Null;
        Ok(spec)
    }

    /// Like [`WorktreeManager::run_worktree_git`], but a non-zero exit becomes
    /// [`WorktreeError::GitFailed`] and only stdout is returned.
    async fn run_worktree_git_ok(
        &self,
        work_tree: &Path,
        git_dir: &Path,
        args: &[&str],
    ) -> Result<String, WorktreeError> {
        self.run_worktree_git(work_tree, git_dir, args)
            .await?
            .ok(work_tree, args)
    }
}

/// Builds the full argument list for a git command scoped to a worker's worktree (#166):
/// `--git-dir`/`--work-tree` pinned explicitly, ahead of any auto-discovery from a `.git` file,
/// then [`WORKTREE_GIT_CONFIG`]'s `-c` overrides, then `args` as the caller gave them.
fn worktree_argv(work_tree: &Path, git_dir: &Path, args: &[&str]) -> Vec<OsString> {
    let mut full_args = Vec::with_capacity(2 + WORKTREE_GIT_CONFIG.len() * 2 + args.len());
    full_args.push(OsString::from(format!("--git-dir={}", git_dir.display())));
    full_args.push(OsString::from(format!(
        "--work-tree={}",
        work_tree.display()
    )));
    for (key, value) in WORKTREE_GIT_CONFIG {
        full_args.push(OsString::from("-c"));
        full_args.push(OsString::from(format!("{key}={value}")));
    }
    full_args.extend(args.iter().map(|arg| OsString::from(*arg)));
    full_args
}

/// The result of running one git command to completion.
struct GitOutput {
    stdout: String,
    exit: Exit,
}

impl GitOutput {
    fn success(&self) -> bool {
        self.exit.info.success()
    }

    /// [`WorktreeError::GitFailed`] for this, the output of `git args` in `cwd`.
    fn failure(&self, cwd: &Path, args: &[&str]) -> WorktreeError {
        WorktreeError::GitFailed {
            cwd: cwd.to_owned(),
            args: owned_args(args),
            detail: describe_failure(self),
        }
    }

    /// Its stdout, or [`Self::failure`] for a non-zero exit.
    fn ok(self, cwd: &Path, args: &[&str]) -> Result<String, WorktreeError> {
        if self.success() {
            Ok(self.stdout)
        } else {
            Err(self.failure(cwd, args))
        }
    }
}

fn describe_failure(output: &GitOutput) -> String {
    if output.exit.stderr_tail.is_empty() {
        format!("exited {:?} with no stderr", output.exit.info)
    } else {
        output.exit.stderr_tail.clone()
    }
}

fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// Reads every line of `process`'s stdout until it exits, joining lines back with `\n`. The exact
/// framing of the original bytes doesn't matter here: every caller either parses the result line
/// by line or trims it as one block of text.
///
/// A line over the process's limit fails `git args` in `cwd` with [`WorktreeError::GitFailed`]
/// rather than being skipped (PLX-143): a `-z` output is one line, so skipping it would read as
/// no output at all, such as a commit with no changed files.
async fn collect(
    mut process: Process,
    cwd: &Path,
    args: &[&str],
) -> Result<(Vec<u8>, Exit), WorktreeError> {
    let mut stdout = Vec::new();
    loop {
        match process.next().await {
            Some(Output::Line(line)) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
            }
            Some(Output::Oversized { bytes }) => {
                return Err(WorktreeError::GitFailed {
                    cwd: cwd.to_owned(),
                    args: owned_args(args),
                    detail: format!("it wrote a {bytes}-byte line, too long for plxd to read"),
                });
            }
            Some(Output::Exited(exit)) => return Ok((stdout, exit)),
            None => unreachable!("Output::Exited always comes last"),
        }
    }
}

/// [`collect`], stopping once stdout passes `max_bytes`: the process is killed, and the output is
/// cut there. Returns its exit when it ran to the end, and whether the output was cut.
async fn collect_capped(
    mut process: Process,
    cwd: &Path,
    args: &[&str],
    max_bytes: usize,
) -> Result<(Vec<u8>, Option<Exit>, bool), WorktreeError> {
    let mut stdout = Vec::new();
    loop {
        match process.next().await {
            Some(Output::Line(line)) => {
                stdout.extend_from_slice(&line);
                stdout.push(b'\n');
                if stdout.len() > max_bytes {
                    stdout.truncate(max_bytes);
                    return Ok((stdout, None, true));
                }
            }
            Some(Output::Oversized { bytes }) => {
                return Err(WorktreeError::GitFailed {
                    cwd: cwd.to_owned(),
                    args: owned_args(args),
                    detail: format!("it wrote a {bytes}-byte line, too long for plxd to read"),
                });
            }
            Some(Output::Exited(exit)) => return Ok((stdout, Some(exit), false)),
            None => unreachable!("Output::Exited always comes last"),
        }
    }
}

/// Whether `slug` can follow `parallax/` in a branch name: 1 to 40 lowercase letters, digits, and
/// hyphens, none leading or trailing.
#[must_use]
pub fn valid_branch_slug(slug: &str) -> bool {
    (1..=40).contains(&slug.len())
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The first 8 hex digits of the SHA-256 of `text`. Used for both the short run id in a branch
/// name and the repository hash in a worktree folder's name; a prefix of a `UUIDv7` would cluster
/// collisions in time, since most of a `UUIDv7`'s own bits are a timestamp.
fn short_hash(text: &str) -> String {
    crate::sha256_hex(text.as_bytes())[..8].to_owned()
}

/// The `<repo slug>` folder name for `repo_root`: its own directory name, sanitized, plus a short
/// hash of its full path, so differently located repos that share a name never collide.
fn project_dir_name(repo_root: &Path) -> String {
    let basename = repo_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sanitized: String = basename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('-');
    let sanitized = if sanitized.is_empty() {
        "repo"
    } else {
        sanitized
    };
    format!("{sanitized}-{}", short_hash(&repo_root.to_string_lossy()))
}

/// One `--name-status` entry: its status letters and one path, or two for a rename or copy.
fn changed_file(code: &str, first: String, second: Option<String>) -> ChangedFile {
    let status = match code.as_bytes().first() {
        Some(b'A') => ChangeStatus::Added,
        Some(b'M') => ChangeStatus::Modified,
        Some(b'D') => ChangeStatus::Deleted,
        Some(b'R') => ChangeStatus::Renamed,
        Some(b'C') => ChangeStatus::Copied,
        Some(b'T') => ChangeStatus::TypeChanged,
        Some(b'U') => ChangeStatus::Unmerged,
        _ => ChangeStatus::Unknown(code.to_owned()),
    };
    match (&status, second) {
        (ChangeStatus::Renamed | ChangeStatus::Copied, Some(new_path)) => ChangedFile {
            status,
            path: new_path,
            old_path: Some(first),
        },
        _ => ChangedFile {
            status,
            path: first,
            old_path: None,
        },
    }
}

/// Sums `git diff --numstat`'s output: `added\tdeleted\tpath` per file, with `-` for both counts
/// of a binary file.
fn parse_numstat(output: &str) -> DiffStat {
    let mut stat = DiffStat::default();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let mut fields = line.split('\t');
        let mut count = || {
            fields
                .next()
                .and_then(|field| field.parse::<u64>().ok())
                .unwrap_or(0)
        };
        stat.insertions += count();
        stat.deletions += count();
        stat.files += 1;
    }
    stat
}

/// Whether `path` itself is a plain directory, checked with `lstat` rather than `stat` (#171): a
/// symlink to a directory is not a directory here, so a symlink a worker plants is never
/// followed.
async fn is_real_dir(path: &Path) -> bool {
    matches!(
        tokio::fs::symlink_metadata(path).await,
        Ok(meta) if meta.is_dir()
    )
}
