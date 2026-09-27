//! `coordinator/get`, `coordinator/send`, `coordinator/cancel`, and `coordinator/events` (#196),
//! behind the `coordinator` capability. The loop itself is [`crate::agents::coordinator`].

use std::sync::Arc;

use serde_json::Value;
use wisp_protocol::jsonrpc::{ErrorObject, Request};
use wisp_protocol::methods::{
    CoordinatorCancel, CoordinatorEvents, CoordinatorGet, CoordinatorSend, RequestMethod,
};
use wisp_protocol::{
    AgentEventsResult, CoordinatorCancelParams, CoordinatorEventsParams, CoordinatorGetParams,
    CoordinatorSendParams, CoordinatorThreadResult,
};

use super::{Context, handle};
use crate::agents::coordinator;

/// Whether `method` is one of this module's.
pub(crate) fn handles(method: &str) -> bool {
    method.starts_with("coordinator/")
}

/// Answers a `coordinator/*` method.
pub(crate) async fn dispatch(context: &Context, request: &Request) -> Result<Value, ErrorObject> {
    match request.method.as_str() {
        CoordinatorGet::NAME => handle::<CoordinatorGet, _, _>(request, |p| get(context, p)).await,
        CoordinatorSend::NAME => {
            handle::<CoordinatorSend, _, _>(request, |p| send(context, p)).await
        }
        CoordinatorCancel::NAME => {
            handle::<CoordinatorCancel, _, _>(request, |p| cancel(context, p)).await
        }
        CoordinatorEvents::NAME => {
            handle::<CoordinatorEvents, _, _>(request, |p| events(context, p)).await
        }
        other => Err(ErrorObject::method_not_found(other)),
    }
}

async fn get(
    context: &Context,
    params: CoordinatorGetParams,
) -> Result<CoordinatorThreadResult, ErrorObject> {
    let thread = coordinator::get(&context.daemon, params.project).await?;
    Ok(CoordinatorThreadResult { thread })
}

// Sending and cancelling run detached from the request, as `agent/*` does, so a dropped
// connection never leaves a turn half started.

async fn send(
    context: &Context,
    params: CoordinatorSendParams,
) -> Result<CoordinatorThreadResult, ErrorObject> {
    super::agent::check_text("text", &params.text)?;
    let CoordinatorSendParams {
        project,
        turn_id,
        text,
    } = params;
    let daemon = Arc::clone(&context.daemon);
    let thread = context
        .daemon
        .agents
        .detached(coordinator::send(daemon, project, turn_id, text))
        .await?;
    Ok(CoordinatorThreadResult { thread })
}

async fn cancel(
    context: &Context,
    params: CoordinatorCancelParams,
) -> Result<CoordinatorThreadResult, ErrorObject> {
    let daemon = Arc::clone(&context.daemon);
    let thread = context
        .daemon
        .agents
        .detached(coordinator::cancel(daemon, params.project))
        .await?;
    Ok(CoordinatorThreadResult { thread })
}

async fn events(
    context: &Context,
    params: CoordinatorEventsParams,
) -> Result<AgentEventsResult, ErrorObject> {
    let Some(thread) = coordinator::existing(&context.daemon, params.project).await? else {
        return Ok(AgentEventsResult {
            events: Vec::new(),
            more: false,
        });
    };
    super::agent::page(context, thread, params.after, params.limit).await
}
