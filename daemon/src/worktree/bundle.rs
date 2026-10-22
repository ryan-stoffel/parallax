//! The git side of moving commits between two plxds as bundle files (0057). The `bundle/*`
//! methods are [`crate::methods::bundle`], and the home plxd's transfer is in [`crate::peer`].
//!
//! Every ref name and argument is built by plxd: a caller passes a full ref name it made and
//! object ids it checked are hex, so nothing here starts with `-` or names a ref it didn't mean.
//! A bundle is applied with `git bundle unbundle` and `update-ref`, so the bundle's own ref name
//! is never used and the one ref written is the target the caller names.

use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, BufReader};

use super::{WorktreeError, WorktreeManager, describe_failure};

/// How long creating or unbundling a bundle may take: up to 64 MiB of objects.
const BUNDLE_TIMEOUT: Duration = Duration::from_mins(2);

/// What [`WorktreeManager::create_bundle`] made.
#[derive(Debug, PartialEq, Eq)]
pub struct Bundled {
    /// The commit the bundle's ref points at, or the ref's commit when nothing was written.
    pub tip: String,
    /// Whether a bundle file was written. `false` when the excluded commits already have `tip`.
    pub written: bool,
}

impl WorktreeManager {
    /// Writes a bundle of `reference`, a full ref name, in `repo_path`'s repository to `file`,
    /// leaving out the history of `exclude`'s commits. The bundle holds the ref's commit at that
    /// moment, which [`Bundled::tip`] names, so a ref that moves later never changes it.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::UnknownRevision`] when `reference` names
    /// nothing, or a git failure, as for an excluded commit the repository lacks.
    pub async fn create_bundle(
        &self,
        repo_path: &Path,
        reference: &str,
        exclude: &[String],
        file: &Path,
    ) -> Result<Bundled, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let tip = self.resolve_commit(&repo_root, reference).await?;
        let mut count = vec!["rev-list", "--count", tip.as_str(), "--not"];
        count.extend(exclude.iter().map(String::as_str));
        // git refuses to write a bundle with no commits in it.
        if self.run_git_ok(&repo_root, &count).await?.trim() == "0" {
            return Ok(Bundled {
                tip,
                written: false,
            });
        }
        let file_arg = file.to_string_lossy();
        let mut args = vec!["bundle", "create", &*file_arg, reference, "--not"];
        args.extend(exclude.iter().map(String::as_str));
        self.run_git_for(&repo_root, &args, BUNDLE_TIMEOUT)
            .await?
            .ok(&repo_root, &args)?;
        Ok(Bundled {
            tip: self.bundle_tip(&repo_root, file).await?,
            written: true,
        })
    }

    /// Checks that `repo_path`'s repository has every commit the bundle at `file` needs, then the
    /// bundle with `git bundle verify`, and that its one ref points at `tip`, a commit, and adds
    /// its objects to the repository with `target`, a full ref name, pointing at `tip`. `target`
    /// is the only ref written.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::MissingCommits`] when the repository
    /// lacks a commit the bundle needs, [`WorktreeError::BadBundle`] when verifying fails or the
    /// bundle holds anything but one ref at `tip`, or another git failure.
    pub async fn apply_bundle(
        &self,
        repo_path: &Path,
        file: &Path,
        target: &str,
        tip: &str,
    ) -> Result<(), WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let file_arg = file.to_string_lossy();
        // Read from the header, so a missing commit is told apart without git's localized text.
        let mut missing = Vec::new();
        for commit in prerequisites(file).await? {
            let object = format!("{commit}^{{commit}}");
            let args = ["cat-file", "-e", &object];
            if !self.run_git(&repo_root, &args).await?.success() {
                missing.push(commit);
            }
        }
        if !missing.is_empty() {
            return Err(WorktreeError::MissingCommits(missing));
        }
        let verified = self
            .run_git(&repo_root, &["bundle", "verify", &file_arg])
            .await?;
        if !verified.success() {
            return Err(WorktreeError::BadBundle(format!(
                "the repository can't take the bundle: {}",
                describe_failure(&verified)
            )));
        }
        let found = self.bundle_tip(&repo_root, file).await?;
        if found != tip {
            return Err(WorktreeError::BadBundle(format!(
                "the bundle's ref is at {found}, not {tip}"
            )));
        }
        let args = ["bundle", "unbundle", &*file_arg];
        self.run_git_for(&repo_root, &args, BUNDLE_TIMEOUT)
            .await?
            .ok(&repo_root, &args)?;
        if self.resolve_commit(&repo_root, tip).await? != tip {
            return Err(WorktreeError::BadBundle(format!("{tip} isn't a commit")));
        }
        self.run_git_ok(&repo_root, &["update-ref", target, tip])
            .await?;
        Ok(())
    }

    /// The commit the bundle at `file` has its one ref at.
    async fn bundle_tip(&self, repo_root: &Path, file: &Path) -> Result<String, WorktreeError> {
        let file_arg = file.to_string_lossy();
        let heads = self
            .run_git_ok(repo_root, &["bundle", "list-heads", &file_arg])
            .await?;
        let tips: Vec<&str> = heads
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .collect();
        match tips.as_slice() {
            [tip] => Ok((*tip).to_owned()),
            _ => Err(WorktreeError::BadBundle(format!(
                "the bundle has {} refs, not one",
                tips.len()
            ))),
        }
    }
}

/// The most header a bundle may have: its prerequisite and ref lines, about 80 bytes each.
const MAX_HEADER_BYTES: u64 = 1024 * 1024;

/// The commits the bundle at `file` needs a repository to have: the `-<object id>` lines of its
/// header, which ends at the first empty line.
async fn prerequisites(file: &Path) -> Result<Vec<String>, WorktreeError> {
    let io = |source| WorktreeError::Io {
        path: file.to_owned(),
        source,
    };
    let opened = tokio::fs::File::open(file).await.map_err(io)?;
    let mut header = BufReader::new(opened.take(MAX_HEADER_BYTES));
    let mut commits = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        header.read_until(b'\n', &mut line).await.map_err(io)?;
        let Some(text) = line.strip_suffix(b"\n") else {
            return Err(WorktreeError::BadBundle(
                "the bundle's header doesn't end".to_owned(),
            ));
        };
        if text.is_empty() {
            return Ok(commits);
        }
        let Some(rest) = text.strip_prefix(b"-") else {
            continue;
        };
        let commit = rest.split(|&b| b == b' ').next().unwrap_or_default();
        let hex = commit.iter().all(u8::is_ascii_hexdigit);
        if !hex || !matches!(commit.len(), 40 | 64) {
            return Err(WorktreeError::BadBundle(
                "the bundle names a prerequisite that isn't an object id".to_owned(),
            ));
        }
        commits.push(String::from_utf8_lossy(commit).to_ascii_lowercase());
    }
}
