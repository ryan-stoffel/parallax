//! `remote/pair`, `remote/sessions`, and `remote/revoke` (PLX-641, 0065): pairing codes and the
//! sessions of clients paired with this host. And `relay/register`, `relay/sign` (PLX-1146),
//! `relay/hosts`, `relay/remove` (PLX-652, 0068), and `relay/pushKey` (0100). And `relay/id` and
//! `access/*` (0091): who may sign in with the account.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccessForgetHostParams, AccessGetParams, AccessMergeParams, AccessRemoveParams,
    AccessRequestParams, AccessSetupCodeParams, AccessSetupCodeResult, AccessState,
    RelayHostsParams, RelayHostsResult, RelayIdParams, RelayIdResult, RelayPushKeyParams,
    RelayPushKeyResult, RelayRegisterParams, RelayRemoveParams, RelaySignParams, RelaySignResult,
    RemotePairParams, RemotePairResult, RemoteRevokeParams, RemoteSessionsParams,
    RemoteSessionsResult,
};
use tokio_util::sync::CancellationToken;

use super::Context;
use crate::server::remote;
use crate::server::remote::access;

/// `remote/pair`: a new one-time code, which replaces any earlier one.
pub(crate) async fn pair(
    context: &Context,
    _: RemotePairParams,
) -> Result<RemotePairResult, ErrorObject> {
    let (code, expires) = remote::new_pairing(&context.daemon)
        .await
        .map_err(ErrorObject::invalid_params)?;
    Ok(RemotePairResult {
        code: crate::remote::format_code(&code),
        expires_at: expires.to_string(),
        name: remote::host_name(&context.daemon).await,
        addresses: remote::routes(&context.daemon).await,
    })
}

/// `remote/sessions`.
pub(crate) async fn sessions(
    context: &Context,
    _: RemoteSessionsParams,
) -> Result<RemoteSessionsResult, ErrorObject> {
    let sessions = remote::sessions(&context.daemon, &context.cancel).await?;
    Ok(remote::listed_with_status(&context.daemon, sessions))
}

/// `remote/revoke`.
pub(crate) async fn revoke(
    context: &Context,
    params: RemoteRevokeParams,
) -> Result<RemoteSessionsResult, ErrorObject> {
    let sessions = remote::revoke(&context.daemon, &context.cancel, params.id).await?;
    Ok(remote::listed_with_status(&context.daemon, sessions))
}

/// `relay/register`: registers this host with the relay under the token's user, and answers with
/// the status, as `remote/sessions` does.
pub(crate) async fn register_relay(
    context: &Context,
    params: RelayRegisterParams,
) -> Result<RemoteSessionsResult, ErrorObject> {
    crate::relay::register(&context.daemon, &params.token, params.signed)
        .await
        .map_err(ErrorObject::invalid_params)?;
    sessions(context, RemoteSessionsParams {}).await
}

/// `relay/sign`: this host's relay registration, signed over a token's hash (PLX-1146).
pub(crate) async fn relay_sign(
    context: &Context,
    params: RelaySignParams,
) -> Result<RelaySignResult, ErrorObject> {
    let user = params.user_id.as_deref().filter(|user| !user.is_empty());
    crate::relay::sign(&context.daemon, &params.token_hash, user)
        .await
        .map_err(ErrorObject::invalid_params)
}

/// `relay/id`: this host's relay id and its routes, as its descriptor reports them.
pub(crate) async fn relay_id(
    context: &Context,
    _: RelayIdParams,
) -> Result<RelayIdResult, ErrorObject> {
    let key = remote::host_key(&context.daemon)
        .await
        .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
    Ok(RelayIdResult {
        host_id: key.host_id(),
        routes: remote::routes(&context.daemon).await,
    })
}

/// `relay/pushKey`: this host's relay id and the key it seals pushes with (0100). A session that
/// can read threads can read what the key opens, so any session may ask.
pub(crate) async fn relay_push_key(
    context: &Context,
    _: RelayPushKeyParams,
) -> Result<RelayPushKeyResult, ErrorObject> {
    let daemon = &context.daemon;
    let internal = |e: std::io::Error| ErrorObject::internal_error(e.to_string());
    let host_key = remote::host_key(daemon).await.map_err(internal)?;
    let data_dir = daemon.data_dir.root().to_owned();
    let push_key = tokio::task::spawn_blocking(move || crate::remote::push_key(&data_dir))
        .await
        .map_err(ErrorObject::internal_error)?
        .map_err(internal)?;
    Ok(RelayPushKeyResult {
        host_id: host_key.host_id(),
        key: crate::remote::base64url(&push_key),
    })
}

/// `access/get`.
pub(crate) async fn access_get(
    context: &Context,
    params: AccessGetParams,
) -> Result<AccessState, ErrorObject> {
    access::state(&context.daemon, params.after, &context.stopped_reading).await
}

/// The state after a change, at once.
async fn access_now(context: &Context) -> Result<AccessState, ErrorObject> {
    access::state(&context.daemon, None, &CancellationToken::new()).await
}

/// `access/merge`.
pub(crate) async fn access_merge(
    context: &Context,
    params: AccessMergeParams,
) -> Result<AccessState, ErrorObject> {
    access::merge(&context.daemon, &context.cancel, params).await?;
    access_now(context).await
}

/// `access/approve`.
pub(crate) async fn access_approve(
    context: &Context,
    params: AccessRequestParams,
) -> Result<AccessState, ErrorObject> {
    access::approve(&context.daemon, &context.cancel, &params.request).await?;
    access_now(context).await
}

/// `access/deny`.
pub(crate) async fn access_deny(
    context: &Context,
    params: AccessRequestParams,
) -> Result<AccessState, ErrorObject> {
    access::deny(&context.daemon, &params.request)?;
    access_now(context).await
}

/// `access/remove`.
pub(crate) async fn access_remove(
    context: &Context,
    params: AccessRemoveParams,
) -> Result<AccessState, ErrorObject> {
    access::remove(&context.daemon, &context.cancel, params.thumbprint).await?;
    access_now(context).await
}

/// `access/forgetHost`.
pub(crate) async fn access_forget_host(
    context: &Context,
    params: AccessForgetHostParams,
) -> Result<AccessState, ErrorObject> {
    access::forget_host(&context.daemon, &context.cancel, params.host_id).await?;
    access_now(context).await
}

/// `access/setupCode`: a new computer's code, for `plx connect` or the app to show.
pub(crate) async fn access_setup_code(
    context: &Context,
    _: AccessSetupCodeParams,
) -> Result<AccessSetupCodeResult, ErrorObject> {
    let (code, expires) = remote::new_setup_code(&context.daemon)
        .await
        .map_err(ErrorObject::invalid_params)?;
    Ok(AccessSetupCodeResult {
        code,
        expires_at: expires.to_string(),
    })
}

/// `relay/hosts`: the user's hosts on the relay.
pub(crate) async fn relay_hosts(
    context: &Context,
    params: RelayHostsParams,
) -> Result<RelayHostsResult, ErrorObject> {
    crate::relay::hosts(&context.daemon, &params.token).await
}

/// `relay/remove`: removes one of the user's hosts from the relay, and answers with the rest.
pub(crate) async fn relay_remove(
    context: &Context,
    params: RelayRemoveParams,
) -> Result<RelayHostsResult, ErrorObject> {
    crate::relay::remove(&context.daemon, &params.token, &params.host_id)
        .await
        .map_err(ErrorObject::invalid_params)?;
    // It's removed by now, so failing to read the rest can't be reported as failing to remove it.
    Ok(crate::relay::hosts(&context.daemon, &params.token)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "removed a host, but couldn't read the rest");
            RelayHostsResult::default()
        }))
}
