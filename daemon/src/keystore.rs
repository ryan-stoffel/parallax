//! Where API keys live (#117, 0023): the login Keychain on macOS, the Secret Service on Linux
//! (RYA-19). Windows has no store yet (RYA-23).
//!
//! [`KeyStore`] is the interface. [`system_store`] is this OS's real one: `KeychainStore`, one
//! generic password per account under a service name via the `security-framework` crate;
//! `SecretServiceStore`, one item per account in the default collection via `keyring-core`; or
//! [`NoKeyStore`] where plxd has none. [`MemoryKeyStore`] is an in-memory mock for tests. Only
//! these ever see a key in the clear, and only for as long as it takes to hand it to the OS or a
//! caller; Parallax's project store and event log never do (0004, decision record 0009).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use parallax_protocol::AccountId;
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
mod keychain;
#[cfg(target_os = "macos")]
pub use keychain::KeychainStore;
#[cfg(target_os = "linux")]
mod secret_service;
#[cfg(target_os = "linux")]
pub use secret_service::SecretServiceStore;

/// The service name every real Parallax key account is stored under: 0006's bundle id.
pub const SERVICE: &str = "io.github.ryan-stoffel.parallax";

/// What `keychainUnavailable` tells the user: the store is locked or access was denied.
#[cfg(target_os = "macos")]
pub const UNAVAILABLE_MESSAGE: &str = "the keychain is locked or access was denied";
/// What `keychainUnavailable` tells the user: there is no Secret Service, it is locked, or access
/// was denied. A headless host has none until one is installed and unlocked (0023).
#[cfg(target_os = "linux")]
pub const UNAVAILABLE_MESSAGE: &str = "no unlocked Secret Service: install one, such as \
     gnome-keyring or KeePassXC, and unlock it, or run plxd serve in a logged-in desktop session";
/// What `keychainUnavailable` tells the user: this host has no store for API keys yet.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub const UNAVAILABLE_MESSAGE: &str =
    "this host can't store API keys yet: plxd has no Secret Service support on this OS";

/// Where API keys are stored, keyed by account id.
///
/// An implementation must never pass a key to `tracing`, or write one anywhere but the OS's
/// store (#117).
pub trait KeyStore: Send + Sync {
    /// Stores `key` for `account`, replacing any key already stored for it.
    ///
    /// # Errors
    ///
    /// If the store can't be written to.
    fn set(&self, account: AccountId, key: &str) -> Result<(), KeyStoreError>;

    /// The key stored for `account`, or `None` if there is none.
    ///
    /// # Errors
    ///
    /// If the store can't be read.
    fn get(&self, account: AccountId) -> Result<Option<Zeroizing<String>>, KeyStoreError>;

    /// Removes the key stored for `account`. Removing one that isn't there succeeds.
    ///
    /// # Errors
    ///
    /// If the store can't be written to.
    fn delete(&self, account: AccountId) -> Result<(), KeyStoreError>;
}

/// This OS's real key store: the login Keychain on macOS, the Secret Service on Linux,
/// [`NoKeyStore`] elsewhere.
#[must_use]
pub fn system_store() -> Arc<dyn KeyStore> {
    #[cfg(target_os = "macos")]
    let store = KeychainStore::new();
    #[cfg(target_os = "linux")]
    let store = SecretServiceStore::new();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let store = NoKeyStore;
    Arc::new(store)
}

/// Why a [`KeyStore`] call failed.
#[derive(Debug, thiserror::Error)]
#[error("the keychain failed: {detail}")]
pub struct KeyStoreError {
    detail: String,
    unavailable: bool,
}

impl KeyStoreError {
    /// The store is locked, denied access, or doesn't exist on this host.
    #[must_use]
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            unavailable: true,
        }
    }

    /// Whether this is the store being locked, access to an item being denied, or no store at
    /// all, rather than some other failure. plxd maps this to its own `keychainUnavailable`,
    /// distinct from a bare internal error, so the editor can tell "locked" from "broken".
    #[must_use]
    pub fn is_unavailable(&self) -> bool {
        self.unavailable
    }
}

/// The store on an OS where plxd can't keep API keys yet: every call fails as unavailable, so
/// key accounts fail with `keychainUnavailable` and a key never goes anywhere else (0023). There
/// is never a plaintext fallback.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[derive(Debug, Clone, Copy)]
pub struct NoKeyStore;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl KeyStore for NoKeyStore {
    fn set(&self, _account: AccountId, _key: &str) -> Result<(), KeyStoreError> {
        Err(KeyStoreError::unavailable(UNAVAILABLE_MESSAGE))
    }

    fn get(&self, _account: AccountId) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        Err(KeyStoreError::unavailable(UNAVAILABLE_MESSAGE))
    }

    // It holds nothing, so there is nothing to remove.
    fn delete(&self, _account: AccountId) -> Result<(), KeyStoreError> {
        Ok(())
    }
}

/// An in-memory [`KeyStore`], for tests. Holds no reference to the real Keychain.
#[derive(Debug, Default)]
pub struct MemoryKeyStore {
    keys: Mutex<HashMap<AccountId, String>>,
}

impl MemoryKeyStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryKeyStore {
    fn set(&self, account: AccountId, key: &str) -> Result<(), KeyStoreError> {
        self.keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(account, key.to_owned());
        Ok(())
    }

    fn get(&self, account: AccountId) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        Ok(self
            .keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&account)
            .cloned()
            .map(Zeroizing::new))
    }

    fn delete(&self, account: AccountId) -> Result<(), KeyStoreError> {
        self.keys
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::AccountId;

    use super::{KeyStore, MemoryKeyStore};

    fn get(store: &MemoryKeyStore, account: AccountId) -> Option<String> {
        store.get(account).unwrap().map(|key| key.to_string())
    }

    #[test]
    fn a_key_round_trips_through_the_mock_store() {
        let store = MemoryKeyStore::new();
        let account = AccountId::generate();
        assert_eq!(get(&store, account), None);

        store.set(account, "sk-ant-secret").unwrap();
        assert_eq!(get(&store, account).as_deref(), Some("sk-ant-secret"));

        store.set(account, "sk-ant-replacement").unwrap();
        assert_eq!(
            get(&store, account).as_deref(),
            Some("sk-ant-replacement"),
            "setting again replaces the stored key"
        );

        store.delete(account).unwrap();
        assert_eq!(get(&store, account), None);
    }

    #[test]
    fn deleting_a_key_that_was_never_set_succeeds() {
        let store = MemoryKeyStore::new();
        store.delete(AccountId::generate()).unwrap();
    }

    #[test]
    fn accounts_are_independent() {
        let store = MemoryKeyStore::new();
        let (a, b) = (AccountId::generate(), AccountId::generate());
        store.set(a, "key-a").unwrap();
        store.set(b, "key-b").unwrap();
        store.delete(a).unwrap();
        assert_eq!(get(&store, a), None);
        assert_eq!(get(&store, b).as_deref(), Some("key-b"));
    }
}
