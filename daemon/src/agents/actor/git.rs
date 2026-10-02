//! A run's Git menu (RYA-298): `agent/gitStatus`, `agent/commit`, and `agent/push`, which the
//! run's actor runs between its other commands, so none races a turn or its commit.
//!
//! They work in the run's folder: its worktree, or a Current checkout thread's checkout. A push
//! always runs in the user's checkout, which shares the worktree's branches.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, GitStatus};
use tracing::info;

use super::Actor;
use crate::agents::{run_accepted, store};
use crate::worktree::{RunFolder, WorktreeError};

/// What the Git menu asks a run's actor to do.
pub(crate) enum GitAction {
    /// `agent/gitStatus`: only read the status.
    Status,
    /// `agent/commit`, with its checked message.
    Commit(String),
    /// `agent/push`.
    Push,
}

/// A run's folder, owned: where its git calls run, the worktree's pinned git folder, and the
/// user's checkout, which pushes and gives the commit identity.
struct Folder {
    path: PathBuf,
    git_dir: Option<PathBuf>,
    repo: PathBuf,
}

impl Folder {
    fn run_folder(&self) -> RunFolder<'_> {
        match &self.git_dir {
            Some(git_dir) => RunFolder::Worktree {
                path: &self.path,
                git_dir,
            },
            None => RunFolder::Checkout(&self.path),
        }
    }
}

impl Actor {
    /// Runs `action` in the run's folder and returns its git status afterward. Commit and push
    /// refuse a running run (`gitRefused`).
    pub(super) async fn git(&mut self, action: GitAction) -> Result<GitStatus, ErrorObject> {
        if self.accepted() {
            return Err(run_accepted(self.id));
        }
        let refused = |why: String| ErrorObject::parallax(ErrorKind::GitRefused, why);
        if self.live.is_some() && !matches!(action, GitAction::Status) {
            return Err(refused(format!(
                "run {} is still running; try again once its turn ends",
                self.id
            )));
        }
        let folder = self.folder().await?;
        let daemon = Arc::clone(&self.daemon);
        let worktrees = &daemon.agents.worktrees;
        match action {
            GitAction::Status => {}
            GitAction::Commit(message) => {
                let committed = if folder.git_dir.is_some() {
                    // A worktree's commit is the run's, as a turn's end makes it: Accept and Open
                    // PR take it from the run.
                    let diff = self
                        .commit(&message)
                        .await
                        .map_err(|why| ErrorObject::parallax(ErrorKind::CommitFailed, why))?;
                    let committed = diff.is_some();
                    if let Some(diff) = diff {
                        self.record_diff(diff).await;
                        self.save().await;
                    }
                    committed
                } else {
                    worktrees
                        .commit(folder.run_folder(), &folder.repo, &message)
                        .await
                        .map_err(|error| {
                            ErrorObject::parallax(ErrorKind::CommitFailed, error.to_string())
                        })?
                        .is_some()
                };
                if !committed {
                    return Err(refused(format!("run {} has no changes to commit", self.id)));
                }
                info!(run = %self.id, "committed an agent run's folder");
            }
            GitAction::Push => {
                let status = worktrees
                    .status(folder.run_folder())
                    .await
                    .map_err(|error| status_failed(&error))?;
                let Some(branch) = status.branch else {
                    return Err(refused(format!(
                        "run {}'s folder has a detached HEAD; check out a branch to push",
                        self.id
                    )));
                };
                worktrees
                    .push(&folder.repo, &branch)
                    .await
                    .map_err(|error| ErrorObject::parallax(ErrorKind::PushFailed, error.0))?;
                info!(run = %self.id, branch, "pushed an agent run's branch");
            }
        }
        worktrees
            .status(folder.run_folder())
            .await
            .map_err(|error| status_failed(&error))
    }

    /// A Current checkout thread's checkout: its repo entry's path.
    pub(super) async fn checkout_path(&self) -> Result<PathBuf, ErrorObject> {
        let project = self.project;
        store(&self.daemon, move |db| {
            crate::threads::scope_path(db, project)
        })
        .await
        .map(PathBuf::from)
    }

    async fn folder(&self) -> Result<Folder, ErrorObject> {
        if self.row.fields.checkout {
            let path = self.checkout_path().await?;
            return Ok(Folder {
                repo: path.clone(),
                path,
                git_dir: None,
            });
        }
        let Some(worktree) = &self.worktree else {
            return Err(run_accepted(self.id));
        };
        if worktree.git_dir.is_empty() {
            return Err(ErrorObject::internal_error(format!(
                "run {}'s worktree has no recorded git folder, so plxd can't use it safely",
                self.id
            )));
        }
        Ok(Folder {
            path: PathBuf::from(&worktree.path),
            git_dir: Some(PathBuf::from(&worktree.git_dir)),
            repo: Path::new(&worktree.repo_path).to_owned(),
        })
    }
}

fn status_failed(error: &WorktreeError) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::WorktreeFailed,
        format!("could not read the run's git status: {error}"),
    )
}
