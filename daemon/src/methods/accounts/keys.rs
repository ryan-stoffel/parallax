//! `accounts/keys/add`, `accounts/keys/list`, and `accounts/keys/remove` (#117).
//!
//! The key itself is never logged and never reaches the project store or the event log: only
//! [`crate::keystore::KeyStore`] sees it, and [`mask_key`] turns it into the display form
//! (`sk-ant-...abcd`) that everything else, including this module's own logging, works with.

use std::sync::{Arc, Mutex, PoisonError};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountId, AccountsKeysAddParams, AccountsKeysAddResult, AccountsKeysListParams,
    AccountsKeysListResult, AccountsKeysRemoveParams, AccountsKeysRemoveResult, ErrorKind,
    Provider,
};
use parallax_store::StoreError;
use tracing::{error, info};

use crate::keystore::{KeyStore, KeyStoreError, UNAVAILABLE_MESSAGE};
use crate::methods::Context;
use crate::store::{self, StoreHandle, account_store_error};

/// The fewest bytes plxd accepts for a key. Every real Anthropic, `OpenAI`, or Cursor key is far
/// longer; this also keeps [`mask_key`] from having only a sliver of a short, possibly-fragment
/// key to work with.
const MIN_KEY_BYTES: usize = 20;

/// The longest `label` plxd accepts, in bytes.
const MAX_LABEL_BYTES: usize = 256;

/// The longest `key` plxd accepts, in bytes.
const MAX_KEY_BYTES: usize = 4096;

pub(crate) async fn add(
    context: &Context,
    params: AccountsKeysAddParams,
) -> Result<AccountsKeysAddResult, ErrorObject> {
    check(&params)?;
    let AccountsKeysAddParams {
        id,
        provider,
        label,
        key,
    } = params;
    let daemon = Arc::clone(&context.daemon);
    // A blocking task, which runs to the end even if the request is dropped, so a key is never
    // left without its row. The Keychain calls stay off the store's thread, which every run's
    // output goes through.
    tokio::task::spawn_blocking(move || {
        add_account(
            &daemon.store,
            daemon.keys.as_ref(),
            id,
            provider,
            label,
            key.expose(),
        )
    })
    .await
    .map_err(|error| ErrorObject::internal_error(format!("adding a key account failed: {error}")))?
}

/// Held for the whole of an add or a remove, so two of them on one id can't interleave their
/// Keychain and store steps.
// ponytail: one lock for every key account, since they change rarely.
static CHANGING: Mutex<()> = Mutex::new(());

/// The logic behind `accounts/keys/add`, on a blocking thread, so a test can run it directly and
/// capture what it logs.
///
/// Idempotent on `id`: if a row already exists with the same `provider`, `label`, and masked key,
/// its *stored* key is also checked against `key` before this is treated as a retry, since a mask
/// is a lossy display form and two different keys can share one. Anything else with an existing
/// row is `idConflict`. A new row's key is stored in the Keychain first, so a row is never created
/// for a key that failed to save; if the store job then fails, its commit included, the key is
/// deleted again, best effort: a failed delete is logged, and only then can a key outlive its
/// add.
fn add_account(
    store: &StoreHandle,
    keys: &dyn KeyStore,
    id: AccountId,
    provider: Provider,
    label: String,
    key: &str,
) -> Result<AccountsKeysAddResult, ErrorObject> {
    let _changing = CHANGING.lock().unwrap_or_else(PoisonError::into_inner);
    let masked_key = mask_key(key);
    let fields = store::account_fields(provider, label, masked_key);
    let uuid = id.into();
    let existing = store.run_blocking(move |db| {
        db.get_account(uuid)
            .map_err(|error| account_store_error(&error))
    })?;
    if let Some(existing) = existing {
        let same_fields = existing.provider == fields.provider
            && existing.label == fields.label
            && existing.masked_key == fields.masked_key;
        if same_fields {
            let stored = keys
                .get(id)
                .map_err(keychain_failed("read a key from the keychain"))?;
            if stored.as_deref().map(String::as_str) == Some(key) {
                return Ok(AccountsKeysAddResult {
                    account: store::key_account(existing)?,
                });
            }
        }
        return Err(account_store_error(&StoreError::IdConflict { id: uuid }));
    }
    keys.set(id, key)
        .map_err(keychain_failed("store a key in the keychain"))?;
    let created = store.run_blocking(move |db| {
        db.create_account(uuid, &fields)
            .map_err(|error| account_store_error(&error))
    });
    let row = match created {
        Ok(row) => row,
        Err(error) => {
            // The job rolled back, or never committed, so the Keychain holds a key with no row.
            // Best-effort clean that up so a failed add never leaves a key that the protocol can
            // no longer see or remove.
            if let Err(cleanup_error) = keys.delete(id) {
                error!(
                    account = %id,
                    error = %cleanup_error,
                    "could not roll back a keychain write after the store failed"
                );
            }
            return Err(error);
        }
    };
    let account = store::key_account(row)?;
    info!(account = %account.id, provider = ?account.provider, "added a key account");
    Ok(AccountsKeysAddResult { account })
}

pub(crate) async fn list(
    context: &Context,
    _: AccountsKeysListParams,
) -> Result<AccountsKeysListResult, ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |db_store| {
            let rows = db_store
                .list_accounts()
                .map_err(|error| account_store_error(&error))?;
            let accounts = rows
                .into_iter()
                .map(store::key_account)
                .collect::<Result<_, _>>()?;
            Ok(AccountsKeysListResult { accounts })
        })
        .await
}

pub(crate) async fn remove(
    context: &Context,
    params: AccountsKeysRemoveParams,
) -> Result<AccountsKeysRemoveResult, ErrorObject> {
    let AccountsKeysRemoveParams { id } = params;
    let daemon = Arc::clone(&context.daemon);
    // As `add`: a blocking task that runs to the end, with the Keychain off the store's thread.
    tokio::task::spawn_blocking(move || remove_account(&daemon.store, daemon.keys.as_ref(), id))
        .await
        .map_err(|error| {
            ErrorObject::internal_error(format!("removing a key account failed: {error}"))
        })?
}

/// The logic behind `accounts/keys/remove`, on a blocking thread, so a test can run it directly
/// against a mock `KeyStore`.
fn remove_account(
    store: &StoreHandle,
    keys: &dyn KeyStore,
    id: AccountId,
) -> Result<AccountsKeysRemoveResult, ErrorObject> {
    let _changing = CHANGING.lock().unwrap_or_else(PoisonError::into_inner);
    let uuid = id.into();
    let found = store.run_blocking(move |db| {
        db.get_account(uuid)
            .map_err(|error| account_store_error(&error))
    })?;
    if found.is_none() {
        return Err(account_store_error(&StoreError::NotFound { id: uuid }));
    }
    // The Keychain first, so a failed removal never leaves an account with no record but a key
    // that is still stored.
    keys.delete(id)
        .map_err(keychain_failed("remove a key from the keychain"))?;
    store.run_blocking(move |db| {
        db.delete_account(uuid)
            .map_err(|error| account_store_error(&error))
    })?;
    info!(account = %id, "removed a key account");
    Ok(AccountsKeysRemoveResult {})
}

/// The protocol error for a failed `KeyStore` call: `keychainUnavailable` when the Keychain is
/// locked, access was denied, or this OS has no store yet, so the editor can tell that apart from
/// a bare internal error; anything else stays a plain internal error, since its detail is not
/// something to show.
pub(crate) fn map_keychain_error(error: &KeyStoreError) -> ErrorObject {
    if error.is_unavailable() {
        ErrorObject::parallax(ErrorKind::KeychainUnavailable, UNAVAILABLE_MESSAGE)
    } else {
        ErrorObject::internal_error("the keychain failed")
    }
}

/// Logs a failed `KeyStore` call that tried to `doing`, then maps it with [`map_keychain_error`].
fn keychain_failed(doing: &'static str) -> impl Fn(KeyStoreError) -> ErrorObject {
    move |error| {
        error!(%error, "could not {doing}");
        map_keychain_error(&error)
    }
}

fn check(params: &AccountsKeysAddParams) -> Result<(), ErrorObject> {
    let AccountsKeysAddParams {
        provider,
        label,
        key,
        ..
    } = params;
    if matches!(provider, Provider::Unknown) {
        return Err(ErrorObject::invalid_params(
            "provider must be anthropic, openai, or cursor",
        ));
    }
    if label.trim().is_empty() {
        return Err(ErrorObject::invalid_params("label must not be empty"));
    }
    if label.len() > MAX_LABEL_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "label must be at most {MAX_LABEL_BYTES} bytes"
        )));
    }
    if label.contains('\0') {
        return Err(ErrorObject::invalid_params("label must not contain NUL"));
    }
    let key = key.expose();
    if key.len() < MIN_KEY_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "key must be at least {MIN_KEY_BYTES} bytes"
        )));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "key must be at most {MAX_KEY_BYTES} bytes"
        )));
    }
    if key.contains('\0') {
        return Err(ErrorObject::invalid_params("key must not contain NUL"));
    }
    Ok(())
}

/// Known vendor key prefixes, checked longest first when more than one matches (`sk-ant-api03-`
/// before `sk-ant-` before `sk-`). A key whose start is not on this list shows no prefix at all:
/// [`mask_key`] never guesses at a prefix from a key's own bytes, since those bytes might be
/// secret material rather than a real vendor marker (for example a base64url key legitimately
/// contains `-`).
const KNOWN_KEY_PREFIXES: &[&str] = &[
    "sk-ant-api03-",
    "sk-ant-admin01-",
    "sk-ant-",
    "sk-proj-",
    "sk-svcacct-",
    "sk-admin-",
    "sk-",
    "key_",
];

/// The fewest characters that must remain after a recognized prefix (or from the start, when none
/// matches) before [`mask_key`] shows the key's last 4 characters. Below this, only the prefix (or
/// nothing) is shown, so a short key, or one barely longer than its own prefix, can't have most or
/// all of itself echoed back.
const MIN_CHARS_TO_REVEAL_SUFFIX: usize = 16;

/// Masks a key for display: a recognized vendor prefix, if any, plus the key's last 4 characters
/// once there is enough left unrevealed by that prefix to make that safe — for example
/// `sk-ant-api03-...abcd`. Otherwise it is `prefix...`, or `...` alone with no recognized prefix.
///
/// This never reveals more than 4 characters of a key beyond a known public prefix, and never the
/// whole key, regardless of the key's shape or length. plxd's own `check` already rejects a key
/// shorter than [`MIN_KEY_BYTES`], but this function makes no assumption about that.
pub(crate) fn mask_key(key: &str) -> String {
    let prefix = KNOWN_KEY_PREFIXES
        .iter()
        .copied()
        .filter(|candidate| key.starts_with(candidate))
        .max_by_key(|candidate| candidate.len())
        .unwrap_or("");
    let remaining = key[prefix.len()..].chars().count();
    if remaining < MIN_CHARS_TO_REVEAL_SUFFIX {
        return format!("{prefix}...");
    }
    let last4: String = {
        let mut chars: Vec<char> = key.chars().rev().take(4).collect();
        chars.reverse();
        chars.into_iter().collect()
    };
    format!("{prefix}...{last4}")
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex, PoisonError};

    use parallax_protocol::jsonrpc::ErrorObject;
    use parallax_protocol::{AccountId, AccountsKeysAddResult, ErrorKind, Provider};
    use tracing_subscriber::fmt::MakeWriter;

    use super::{add_account, mask_key};
    use crate::keystore::{KeyStore, MemoryKeyStore};
    use crate::store::StoreHandle;

    fn temp_store() -> (tempfile::TempDir, StoreHandle) {
        let dir = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(&dir.path().join("plxd.sqlite3"), 10, usize::MAX, usize::MAX);
        (dir, store)
    }

    /// Adds an Anthropic key account `id`, labeled `label`, as `accounts/keys/add` would.
    fn add(
        store: &StoreHandle,
        keys: &MemoryKeyStore,
        id: AccountId,
        label: &str,
        key: &str,
    ) -> Result<AccountsKeysAddResult, ErrorObject> {
        add_account(store, keys, id, Provider::Anthropic, label.to_owned(), key)
    }

    #[test]
    fn masks_reveal_at_most_4_characters_beyond_a_known_prefix_and_never_the_whole_key() {
        // From the review of this table: nothing here may show more than a known public prefix
        // plus 4 trailing characters, and a short key must not come back nearly whole.
        let cases = [
            ("", "..."),
            ("abcd", "..."),
            ("abcde", "..."),
            ("abcdefghij", "..."),
            ("sk-ant-1234", "sk-ant-..."),
            ("sk-ab", "sk-..."),
            ("sk-ant-12345678", "sk-ant-..."),
            ("ghijklmnopqrstuvwxyz0123", "...0123"),
            (
                "sk-ant-api03-thisisathrowawaytestkeyabcd",
                "sk-ant-api03-...abcd",
            ),
            ("sk-proj-averylongopenaikeywxyz", "sk-proj-...wxyz"),
            ("sk-svcacct-averylongservicekey1234", "sk-svcacct-...1234"),
            (
                "sk-admin-averylongadminkeyforanthropic5678",
                "sk-admin-...5678",
            ),
            ("key_anunknownvendorbutknownprefixwxyz", "key_...wxyz"),
            ("cursor_live_abcdefghijklmnopqrstuvwxyz", "...wxyz"),
            // base64url keys contain '-', which must not be echoed back as a vendor prefix.
            ("Ab3xY-9kQ-randomBase64urlLookingSecretValue", "...alue"),
        ];
        for (input, expected) in cases {
            assert_eq!(mask_key(input), expected, "input {input:?}");
        }
    }

    /// Regression test: two different keys can share a mask (same recognized prefix and last 4
    /// characters), so idempotency must not trust the mask alone.
    #[test]
    fn a_retry_with_a_different_key_that_shares_a_mask_is_an_id_conflict() {
        let (_dir, db_store) = temp_store();
        let keys = MemoryKeyStore::new();
        let id = AccountId::generate();
        let first_key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAabcd";
        let second_key = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBabcd";
        assert_eq!(
            mask_key(first_key),
            mask_key(second_key),
            "the test setup should give both keys the same mask"
        );
        assert_ne!(first_key, second_key);

        add(&db_store, &keys, id, "Personal", first_key).unwrap();

        let error = add(&db_store, &keys, id, "Personal", second_key).unwrap_err();
        assert_eq!(error.parallax_data().unwrap().kind, ErrorKind::IdConflict);
        assert_eq!(
            keys.get(id).unwrap().as_deref().map(String::as_str),
            Some(first_key),
            "the original key must be left untouched"
        );
    }

    #[derive(Clone)]
    struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

    impl io::Write for SharedBuffer {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for SharedBuffer {
        type Writer = Self;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// Adding a key must never write it, in the clear, anywhere `tracing` can see: not in an
    /// `info!`, not in an `error!`, not in a `Debug` of the params.
    #[test]
    fn adding_a_key_never_logs_it() {
        let secret = "sk-ant-api03-thisisaveryrealsecretvalueabcd";
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(SharedBuffer(Arc::clone(&buffer)))
            .with_ansi(false)
            .finish();

        let (_dir, db_store) = temp_store();
        let keys = MemoryKeyStore::new();

        tracing::subscriber::with_default(subscriber, || {
            // A parallel test can replace the global callsite interest just after a rebuild.
            // Retry until this scoped subscriber actually sees the add, then check its output.
            for _ in 0..20 {
                tracing::callsite::rebuild_interest_cache();
                add(&db_store, &keys, AccountId::generate(), "Personal", secret)
                    .expect("add should succeed");
                if buffer
                    .lock()
                    .unwrap()
                    .windows("added a key account".len())
                    .any(|window| window == b"added a key account")
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        let logged = String::from_utf8(buffer.lock().unwrap().clone()).unwrap();
        assert!(
            !logged.contains(secret),
            "logged output must never contain the raw key: {logged}"
        );
        assert!(
            logged.contains("added a key account"),
            "sanity check that the add was actually logged: {logged}"
        );
    }
}
