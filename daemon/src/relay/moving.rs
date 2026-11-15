//! `relay/move` (PLX-1465): moves this computer from its user's account on Clerk's development
//! instance to their production account, so nobody has to set it up again. The desktop app, which
//! holds both sessions, asks each computer it reaches.
//!
//! plxd checks the production token against production's keys itself, then trusts that account
//! beside the one it's on, so the user's devices signed in to production can sign in here. Then it
//! asks the relay to move its registration (`POST /v1/hosts/<id>/move`), proven by both tokens and
//! its host key. Once the relay has, production is the account it registered under, and the
//! development one stays trusted for the devices that haven't signed in again. Approvals, read-only
//! marks, and removals are the account's lists, which a move doesn't touch.

use parallax_protocol::ErrorKind;
use parallax_protocol::jsonrpc::ErrorObject;
use serde_json::json;
use tracing::info;

use super::{SIGN_IN_REFUSED, cant_reach, http, register_message, signer};
use crate::remote;
use crate::server::Daemon;
use crate::server::remote::access;

/// Moves this computer to the production account of `token`, from the account of `from`, which
/// the relay checks owns it. Answers why it couldn't. A relay that can't move hosts yet, or can't
/// be reached, answers [`ErrorKind::RelayUnreachable`], so the app tries again later.
pub(crate) async fn run(daemon: &Daemon, token: &str, from: &str) -> Result<(), ErrorObject> {
    let invalid = ErrorObject::invalid_params;
    let verified = daemon
        .clerk
        .verify(token, crate::clerk::now())
        .await
        .map_err(|why| invalid(format!("This computer didn't accept that sign-in: {why}.")))?;
    if verified.issuer != daemon.clerk.issuer() {
        return Err(ErrorObject::invalid_params(
            "That sign-in isn't a production account's.",
        ));
    }
    let account = (verified.issuer, verified.user_id);
    if access::accounts(daemon).await.first() == Some(&account) {
        return Ok(());
    }
    access::trust_account(daemon, account.clone())
        .await
        .map_err(invalid)?;

    let key = signer(daemon)
        .await
        .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
    let host_id = key.thumbprint();
    let (x, y) = key.coordinates();
    let token_hash = remote::base64url(&remote::sha256(token.as_bytes()));
    let signature = key.sign(register_message(&host_id, &token_hash).as_bytes());
    let body = json!({
        "hostId": host_id,
        "jwk": { "kty": "EC", "crv": "P-256", "x": x, "y": y },
        "name": crate::server::remote::host_name(daemon).await,
        "signature": remote::base64url(&signature),
        "from": from,
    });
    let path = format!("/v1/hosts/{host_id}/move");
    let unreachable = |why: String| ErrorObject::parallax(ErrorKind::RelayUnreachable, why);
    match http(&daemon.relay.url, "POST", &path, Some(token), Some(&body)).await {
        Ok((200, _)) => {
            let (issuer, user) = &account;
            access::record_account(daemon, user, issuer)
                .await
                .map_err(invalid)?;
            info!(%host_id, "moved to the production account");
            Ok(())
        }
        // A relay from before PLX-1465 has no such route.
        Ok((404, _)) => Err(unreachable(
            "The relay can't move computers yet.".to_owned(),
        )),
        Ok((401, _)) => Err(ErrorObject::invalid_params(SIGN_IN_REFUSED)),
        Ok((status @ 500.., _)) => Err(unreachable(format!("The relay answered {status}."))),
        Ok((status, body)) => Err(invalid(format!(
            "The relay answered {status}: {}",
            body["error"].as_str().unwrap_or("no reason")
        ))),
        Err(error) => Err(unreachable(cant_reach(&error))),
    }
}
