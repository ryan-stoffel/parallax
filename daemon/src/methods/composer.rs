//! `agent/commands` and `repo/files`, for the composer's `/` and `@` menus (PLX-359), behind the
//! `composerMenus` capability.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentCommandsParams, AgentCommandsResult, ErrorKind, RepoFilesParams, RepoFilesResult, RepoId,
    RunId,
};

use super::Context;
use crate::agents::review::run_folder;
use crate::backend::commands;
use crate::server::Daemon;
use crate::threads::start_entry;
use crate::worktree::RunFolder;

/// How long a CLI gets to list its commands. Claude Code runs the user's `SessionStart` hooks
/// first.
const LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// The most paths one `repo/files` answer lists, and the most bytes they may add up to, which
/// keeps it well inside 0007's 8 MiB frame.
const MAX_FILES: usize = 20_000;
const MAX_FILES_BYTES: usize = 4 * 1024 * 1024;

/// `agent/commands`: the backend's CLI, started in the thread's folder, else the home folder.
pub(crate) async fn list_commands(
    context: &Context,
    params: AgentCommandsParams,
) -> Result<AgentCommandsResult, ErrorObject> {
    let AgentCommandsParams {
        backend: name,
        repo,
        run_id,
    } = params;
    let (_, backend) = context
        .daemon
        .agents
        .backends()
        .by_backend_name(&name)
        .ok_or_else(|| ErrorObject::invalid_params(format!("no backend is named {name:?}")))?;
    // A folder that's gone, such as an accepted run's, only loses its project's own commands.
    let cwd = match folder(&context.daemon, repo, run_id).await {
        Ok(Some((cwd, _))) => cwd,
        _ => std::env::home_dir()
            .filter(|home| home.is_absolute())
            .ok_or_else(|| ErrorObject::internal_error("the home folder is unknown"))?,
    };
    let Some(probe) = backend
        .commands(&cwd)
        .map_err(|error| ErrorObject::internal_error(format!("{name} couldn't start: {error}")))?
    else {
        return Ok(AgentCommandsResult {
            commands: Vec::new(),
        });
    };
    let commands = commands::list(probe, LIST_TIMEOUT).await.map_err(|error| {
        ErrorObject::internal_error(format!("{name} didn't list its commands: {error}"))
    })?;
    Ok(AgentCommandsResult { commands })
}

/// `repo/files`: `git ls-files` in the thread's folder, capped.
pub(crate) async fn files(
    context: &Context,
    params: RepoFilesParams,
) -> Result<RepoFilesResult, ErrorObject> {
    let (root, git_dir) = folder(&context.daemon, params.repo, params.run_id)
        .await?
        .ok_or_else(|| ErrorObject::invalid_params("repo/files needs a repo or a runId"))?;
    let folder = match &git_dir {
        Some(git_dir) => RunFolder::Worktree {
            path: &root,
            git_dir,
        },
        None => RunFolder::Checkout(&root),
    };
    let mut files = context
        .daemon
        .agents
        .worktrees()
        .files(folder)
        .await
        .map_err(|error| ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string()))?;
    let mut bytes = 0;
    let fits = files
        .iter()
        .take(MAX_FILES)
        .take_while(|path| {
            bytes += path.len();
            bytes <= MAX_FILES_BYTES
        })
        .count();
    let truncated = files.len() > fits;
    files.truncate(fits);
    Ok(RepoFilesResult { files, truncated })
}

/// The thread's folder and its pinned git folder, if any: the run's, else the repo entry's
/// checkout. `None` for neither.
async fn folder(
    daemon: &Arc<Daemon>,
    repo: Option<RepoId>,
    run_id: Option<RunId>,
) -> Result<Option<(PathBuf, Option<PathBuf>)>, ErrorObject> {
    if let Some(run_id) = run_id {
        return run_folder(daemon, run_id).await.map(Some);
    }
    let Some(repo) = repo else {
        return Ok(None);
    };
    let entry = start_entry(daemon, Some(repo)).await?;
    Ok(Some((entry.fields.path.into(), None)))
}
