//! `thread/list`, `repo/add`, `repo/clone` (PLX-905, behind `repoClone`), `thread/start`, `thread/archive`, and `thread/delete` (#110),
//! behind the `threads` capability, `thread/fork` (0050), behind `threadFork`, `thread/update`
//! and `repo/update` (0033), behind `threadAttention` (and `threadLineage` for its title and
//! settled flag, 0041), `repo/refs`, behind `repoRefs`, and `thread/search` (PLX-372), behind
//! `threadContext`, `thread/import` (PLX-881), behind `threadImport`, and `thread/importChat` (PLX-883), behind
//! `chatImport`. The logic is [`crate::threads`]; methods that only forward to it route there
//! straight from `mod.rs`.
//! `repo/files` is `composer.rs`'s, behind `composerMenus`.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ProjectDeleteParams, ProjectDeleteResult, RepoAddResult, RepoCloneParams, ThreadDeleteParams,
    ThreadDeleteResult, ThreadForkParams, ThreadImportChatParams, ThreadImportParams,
    ThreadStartParams, ThreadStartResult,
};

use super::Context;
use crate::{agents, threads};

// Starting and deleting run detached from the request, as `agent/*` does, so a dropped
// connection never leaves a thread half created or half deleted.

pub(super) async fn start(
    context: &Context,
    mut params: ThreadStartParams,
) -> Result<ThreadStartResult, ErrorObject> {
    super::agent::check_message("prompt", &params.prompt, &params.images)?;
    params.threads = agents::attached::check(&context.daemon, params.threads).await?;
    context
        .detached(|daemon| threads::start(daemon, params))
        .await
}

/// `repo/clone` (PLX-905), run detached so a dropped connection never leaves a clone half done.
pub(super) async fn clone(
    context: &Context,
    params: RepoCloneParams,
) -> Result<RepoAddResult, ErrorObject> {
    context
        .detached(|daemon| crate::repo_clone::clone(daemon, params))
        .await
}

pub(super) async fn fork(
    context: &Context,
    params: ThreadForkParams,
) -> Result<ThreadStartResult, ErrorObject> {
    context
        .detached(|daemon| threads::fork(daemon, params))
        .await
}

pub(super) async fn import(
    context: &Context,
    params: ThreadImportParams,
) -> Result<ThreadStartResult, ErrorObject> {
    context
        .detached(|daemon| crate::importer::import(daemon, params))
        .await
}

pub(super) async fn import_chat(
    context: &Context,
    params: ThreadImportChatParams,
) -> Result<ThreadStartResult, ErrorObject> {
    context
        .detached(|daemon| crate::importer::import_chat(daemon, params))
        .await
}

pub(super) async fn delete(
    context: &Context,
    params: ThreadDeleteParams,
) -> Result<ThreadDeleteResult, ErrorObject> {
    let command_id = context.command_id;
    context
        .detached(|daemon| async move { threads::delete(&daemon, params.run_id, command_id).await })
        .await
}

pub(super) async fn project_delete(
    context: &Context,
    params: ProjectDeleteParams,
) -> Result<ProjectDeleteResult, ErrorObject> {
    context
        .detached(|daemon| async move { crate::projects::delete(&daemon, params).await })
        .await
}
