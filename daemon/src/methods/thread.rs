//! `thread/list`, `repo/add`, `thread/start`, `thread/archive`, and `thread/delete` (#110),
//! behind the `threads` capability, `thread/fork` (0050), behind `threadFork`, `thread/update`
//! and `repo/update` (0033), behind `threadAttention` (and `threadLineage` for its title and
//! settled flag, 0041), `repo/refs`, behind `repoRefs`, and `thread/search` (PLX-372), behind
//! `threadContext`. The logic is [`crate::threads`]; methods that only forward to it route there
//! straight from `mod.rs`.
//! `repo/files` is `composer.rs`'s, behind `composerMenus`.

use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ThreadDeleteParams, ThreadDeleteResult, ThreadForkParams, ThreadStartParams, ThreadStartResult,
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
    let daemon = Arc::clone(&context.daemon);
    context
        .daemon
        .agents
        .detached(threads::start(daemon, params))
        .await
}

pub(super) async fn fork(
    context: &Context,
    params: ThreadForkParams,
) -> Result<ThreadStartResult, ErrorObject> {
    let daemon = Arc::clone(&context.daemon);
    context
        .daemon
        .agents
        .detached(threads::fork(daemon, params))
        .await
}

pub(super) async fn delete(
    context: &Context,
    params: ThreadDeleteParams,
) -> Result<ThreadDeleteResult, ErrorObject> {
    let daemon = Arc::clone(&context.daemon);
    let command_id = context.command_id;
    context
        .daemon
        .agents
        .detached(async move { threads::delete(&daemon, params.run_id, command_id).await })
        .await
}
