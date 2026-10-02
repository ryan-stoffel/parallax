//! The Linux Secret Service, through `keyring-core` and its zbus store (RYA-19, 0023).
//!
//! It speaks D-Bus in pure Rust, so the static musl build links neither libdbus nor OpenSSL. A
//! key crosses the bus encrypted with the session's Diffie-Hellman key, never in the clear.

use std::collections::HashMap;
use std::panic::resume_unwind;
use std::thread;

use keyring_core::api::CredentialStoreApi;
use keyring_core::{Entry, Error};
use parallax_protocol::AccountId;
use zbus_secret_service_keyring_store::Store;
use zeroize::{Zeroize, Zeroizing};

use super::{KeyStore, KeyStoreError, SERVICE};

/// The label shown for an item in a keyring app such as Seahorse, as on macOS.
const ITEM_LABEL: &str = "Parallax API key";

impl From<Error> for KeyStoreError {
    // `NoStorageAccess` is a locked collection, a dismissed unlock prompt, or no default
    // collection. Every other error is a real failure.
    fn from(error: Error) -> Self {
        Self {
            unavailable: matches!(error, Error::NoStorageAccess(_)),
            detail: error.to_string(),
        }
    }
}

/// The user's Secret Service: one item per account in the default collection, found by its
/// `service` and `username` (the account id) attributes.
#[derive(Debug, Clone, Copy)]
pub struct SecretServiceStore {
    service: &'static str,
}

impl SecretServiceStore {
    /// The real Parallax service, [`SERVICE`].
    #[must_use]
    pub const fn new() -> Self {
        Self { service: SERVICE }
    }

    /// A store under a different service name, so a test can't disturb a real stored key.
    #[must_use]
    pub const fn with_service(service: &'static str) -> Self {
        Self { service }
    }

    /// `account`'s item. This connects on every call: key calls are rare, and a Secret Service
    /// that starts or unlocks after `serve` does is found on the next one.
    fn entry(&self, account: AccountId) -> Result<Entry, KeyStoreError> {
        // No session bus, or no Secret Service on it: the headless case (0023).
        let store = Store::new().map_err(|error| KeyStoreError::unavailable(error.to_string()))?;
        let modifiers = HashMap::from([("label", ITEM_LABEL)]);
        Ok(store.build(self.service, &account.to_string(), Some(&modifiers))?)
    }
}

impl Default for SecretServiceStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Runs `call` on its own thread. zbus's blocking API drives D-Bus on a tokio runtime of its own,
/// and entering that panics on a thread that is already in one, like the tokio tasks that read a
/// key before a run starts. A thread the OS won't create is a plain keychain failure.
fn off_runtime<T: Send>(
    call: impl FnOnce() -> Result<T, KeyStoreError> + Send,
) -> Result<T, KeyStoreError> {
    thread::scope(|scope| {
        let thread = thread::Builder::new()
            .spawn_scoped(scope, call)
            .map_err(|error| KeyStoreError {
                detail: format!("could not start a thread: {error}"),
                unavailable: false,
            })?;
        thread.join().unwrap_or_else(|panic| resume_unwind(panic))
    })
}

impl KeyStore for SecretServiceStore {
    fn set(&self, account: AccountId, key: &str) -> Result<(), KeyStoreError> {
        off_runtime(|| Ok(self.entry(account)?.set_secret(key.as_bytes())?))
    }

    fn get(&self, account: AccountId) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        off_runtime(|| match self.entry(account)?.get_secret() {
            Ok(mut bytes) => {
                let key = Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned());
                bytes.zeroize();
                Ok(Some(key))
            }
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        })
    }

    fn delete(&self, account: AccountId) -> Result<(), KeyStoreError> {
        off_runtime(|| match self.entry(account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use keyring_core::Error;
    use parallax_protocol::AccountId;

    use super::SecretServiceStore;
    use crate::keystore::{KeyStore, KeyStoreError};

    #[test]
    fn a_locked_or_refused_store_is_unavailable() {
        let failure = || Box::new(io::Error::other("failed"));
        assert!(KeyStoreError::from(Error::NoStorageAccess(failure())).is_unavailable());
        assert!(!KeyStoreError::from(Error::PlatformFailure(failure())).is_unavailable());
    }

    // Reads a random account under a throwaway service, so it changes nothing. Without a Secret
    // Service, as on CI, it fails as unavailable; with one, the account isn't there. Either way it
    // must not panic inside the test's tokio runtime.
    #[tokio::test]
    async fn a_call_from_a_tokio_task_does_not_panic() {
        let store = SecretServiceStore::with_service("io.github.ryan-stoffel.parallax.unit-test");
        match store.get(AccountId::generate()) {
            Ok(None) => {}
            Ok(Some(_)) => panic!("a random account has no key"),
            Err(error) => assert!(error.is_unavailable(), "{error}"),
        }
    }
}
