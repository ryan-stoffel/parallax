//! `cursor/signIn`, `cursor/signInCancel`, and `cursor/signOut` (0053): a Cursor account login
//! through the SDK sidecar, gated on the `providers` capability like `providers/list`.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    CursorSignInCancelParams, CursorSignInCancelResult, CursorSignInParams, CursorSignInResult,
    CursorSignOutParams, CursorSignOutResult,
};

use super::Context;

/// Starts a browser login and returns the URL to open.
pub(crate) async fn sign_in(
    context: &Context,
    params: CursorSignInParams,
) -> Result<CursorSignInResult, ErrorObject> {
    let instance = instance_of(params.instance);
    refuse_with_api_key(
        context,
        &instance,
        "Remove CURSOR_API_KEY from this provider's environment before using browser sign-in.",
    )
    .await?;
    let url = context
        .daemon
        .cursor
        .sign_in(&instance)
        .await
        .map_err(ErrorObject::internal_error)?;
    Ok(CursorSignInResult { url })
}

/// Stops a login that is still waiting on the browser.
pub(crate) fn sign_in_cancel(
    context: &Context,
    _: CursorSignInCancelParams,
) -> CursorSignInCancelResult {
    context.daemon.cursor.cancel();
    CursorSignInCancelResult {}
}

/// Forgets the stored login.
pub(crate) async fn sign_out(
    context: &Context,
    params: CursorSignOutParams,
) -> Result<CursorSignOutResult, ErrorObject> {
    let instance = instance_of(params.instance);
    refuse_with_api_key(
        context,
        &instance,
        "Remove CURSOR_API_KEY from this provider's environment to disconnect it.",
    )
    .await?;
    context
        .daemon
        .cursor
        .sign_out(&instance)
        .await
        .map_err(ErrorObject::internal_error)?;
    context.daemon.providers.invalidate(&instance).await;
    Ok(CursorSignOutResult {})
}

fn instance_of(instance: Option<String>) -> String {
    instance.unwrap_or_else(|| "cursor".to_owned())
}

/// T3 Code's rule: an instance with its own `CURSOR_API_KEY` signs in with that key only.
async fn refuse_with_api_key(
    context: &Context,
    instance: &str,
    message: &str,
) -> Result<(), ErrorObject> {
    if context
        .daemon
        .providers
        .sets(instance, crate::backend::cursor_sdk::API_KEY)
        .await
    {
        return Err(ErrorObject::invalid_params(message));
    }
    Ok(())
}
