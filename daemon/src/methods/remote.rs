//! `remote/pair`, `remote/sessions`, and `remote/revoke` (PLX-641, 0065): pairing codes and the
//! sessions of clients paired with this host. And `relay/register`, `relay/hosts`, and
//! `relay/remove` (PLX-652, 0068).

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    RelayHostsParams, RelayHostsResult, RelayRegisterParams, RelayRemoveParams, RemotePairParams,
    RemotePairResult, RemoteRevokeParams, RemoteSessionsParams, RemoteSessionsResult,
};

use super::Context;
use crate::server::remote;

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
    crate::relay::register(&context.daemon, &params.token)
        .await
        .map_err(ErrorObject::invalid_params)?;
    sessions(context, RemoteSessionsParams {}).await
}

/// `relay/hosts`: the user's hosts on the relay.
pub(crate) async fn relay_hosts(
    context: &Context,
    params: RelayHostsParams,
) -> Result<RelayHostsResult, ErrorObject> {
    let hosts = crate::relay::hosts(&context.daemon, &params.token)
        .await
        .map_err(ErrorObject::invalid_params)?;
    Ok(RelayHostsResult { hosts })
}

/// `relay/remove`: removes one of the user's hosts from the relay, and answers with the rest.
pub(crate) async fn relay_remove(
    context: &Context,
    params: RelayRemoveParams,
) -> Result<RelayHostsResult, ErrorObject> {
    crate::relay::remove(&context.daemon, &params.token, &params.host_id)
        .await
        .map_err(ErrorObject::invalid_params)?;
    relay_hosts(
        context,
        RelayHostsParams {
            token: params.token,
        },
    )
    .await
}
