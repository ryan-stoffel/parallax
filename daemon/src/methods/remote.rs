//! `remote/pair`, `remote/sessions`, and `remote/revoke` (PLX-641, 0065): pairing codes and the
//! sessions of clients paired with this host.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    RemotePairParams, RemotePairResult, RemoteRevokeParams, RemoteSessionsParams,
    RemoteSessionsResult,
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
