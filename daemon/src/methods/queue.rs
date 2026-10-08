//! `queue/list`, `queue/edit`, `queue/reorder`, `queue/cancel`, and `queue/steer` (PLX-370,
//! decision 0048), behind the `queue` capability. The run's actor keeps the queue
//! ([`crate::agents`]).

use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    QueueCancelParams, QueueEditParams, QueueListParams, QueueReorderParams, QueueResult,
    QueueSteerParams, RunId,
};

use super::Context;
use super::agent::check_message;
use crate::agents::{self, QueueOp};

/// Runs `op` on `run_id`'s queue, detached from the request, as `agent/send` is.
async fn queue(context: &Context, run_id: RunId, op: QueueOp) -> Result<QueueResult, ErrorObject> {
    let daemon = Arc::clone(&context.daemon);
    context
        .daemon
        .agents
        .detached(agents::queue(daemon, run_id, op, context.command_id))
        .await
}

pub(super) async fn list(
    context: &Context,
    params: QueueListParams,
) -> Result<QueueResult, ErrorObject> {
    queue(context, params.run_id, QueueOp::List).await
}

/// An edit keeps the message's images, so only its text is checked here, and the actor refuses
/// an empty one only for a message with no images.
pub(super) async fn edit(
    context: &Context,
    params: QueueEditParams,
) -> Result<QueueResult, ErrorObject> {
    let QueueEditParams { run_id, id, text } = params;
    if !text.trim().is_empty() {
        check_message("text", &text, &[])?;
    }
    queue(context, run_id, QueueOp::Edit { id, text }).await
}

pub(super) async fn reorder(
    context: &Context,
    params: QueueReorderParams,
) -> Result<QueueResult, ErrorObject> {
    let QueueReorderParams { run_id, ids } = params;
    queue(context, run_id, QueueOp::Reorder { ids }).await
}

pub(super) async fn cancel(
    context: &Context,
    params: QueueCancelParams,
) -> Result<QueueResult, ErrorObject> {
    let QueueCancelParams { run_id, id } = params;
    queue(context, run_id, QueueOp::Cancel { id }).await
}

pub(super) async fn steer(
    context: &Context,
    params: QueueSteerParams,
) -> Result<QueueResult, ErrorObject> {
    let QueueSteerParams { run_id, id } = params;
    queue(context, run_id, QueueOp::Steer { id }).await
}
