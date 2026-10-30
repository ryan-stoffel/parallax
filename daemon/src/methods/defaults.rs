//! `accounts/defaults/get` and `accounts/defaults/set` (#119): the per-host default account a
//! task's role falls back to when it doesn't name one outright. [`crate::routing`] is what
//! actually reads these to route a task; this module only lets the editor see and change them.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountsDefaultsGetParams, AccountsDefaultsGetResult, AccountsDefaultsSetParams, Role,
};
use parallax_store::{Store, StoreError};
use tracing::error;

use super::Context;
use crate::store::{account_choice, role_default, role_text};

pub(crate) async fn get(
    context: &Context,
    _: AccountsDefaultsGetParams,
) -> Result<AccountsDefaultsGetResult, ErrorObject> {
    context
        .daemon
        .reader
        .run(&context.cancel, move |db_store| read_defaults(db_store))
        .await
}

/// Checks `account` before storing it: a `Key` must be a real row in `accounts` (#117), and a
/// `Subscription`'s backend must be one plxd knows. The check runs on the store's own thread, in
/// the same job that writes the default, since a `Key` check reads the `accounts` table.
pub(crate) async fn set(
    context: &Context,
    params: AccountsDefaultsSetParams,
) -> Result<AccountsDefaultsGetResult, ErrorObject> {
    let AccountsDefaultsSetParams { role, account } = params;
    context
        .daemon
        .store
        .run(&context.cancel, move |db_store| {
            let default = account
                .as_ref()
                .map(|choice| role_default(db_store, choice))
                .transpose()?;
            db_store
                .set_role_default(role_text(role), default.as_ref())
                .map_err(|error| defaults_store_error(&error))?;
            read_defaults(db_store)
        })
        .await
}

/// Both roles' defaults, as they stand in the store right now.
pub(crate) fn read_defaults(db_store: &Store) -> Result<AccountsDefaultsGetResult, ErrorObject> {
    let orchestrator = read_one(db_store, Role::Orchestrator)?;
    let worker = read_one(db_store, Role::Worker)?;
    Ok(AccountsDefaultsGetResult {
        orchestrator,
        worker,
    })
}

fn read_one(
    db_store: &Store,
    role: Role,
) -> Result<Option<parallax_protocol::AccountChoice>, ErrorObject> {
    db_store
        .get_role_default(role_text(role))
        .map_err(|error| defaults_store_error(&error))?
        .map(account_choice)
        .transpose()
}

fn defaults_store_error(error: &StoreError) -> ErrorObject {
    error!(error = %error, "the project store failed reading or writing a role default");
    ErrorObject::internal_error(format!("the project store failed: {error}"))
}
