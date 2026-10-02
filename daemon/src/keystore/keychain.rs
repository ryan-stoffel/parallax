//! The macOS login Keychain, through `security-framework` (#117).

use parallax_protocol::AccountId;
use security_framework::base::Error as SecurityError;
use security_framework::passwords::{
    PasswordOptions, delete_generic_password, generic_password, set_generic_password_options,
};
use zeroize::{Zeroize, Zeroizing};

use super::{KeyStore, KeyStoreError, SERVICE};

/// The label shown for an item in Keychain Access, so a real one is recognizable among a user's
/// other saved passwords.
const ITEM_LABEL: &str = "Parallax API key";

/// `security_framework_sys::base::errSecItemNotFound`, kept as a local constant so this module
/// does not need `security-framework-sys` as a direct dependency for one status code.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// `security_framework_sys::base::errSecInteractionNotAllowed`: the Keychain is locked and
/// nothing can prompt to unlock it, such as a headless session (0004, 0007, #91).
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

/// `security_framework_sys::base::errSecUserCanceled`: the user dismissed a Keychain access
/// prompt.
const ERR_SEC_USER_CANCELED: i32 = -128;

impl From<SecurityError> for KeyStoreError {
    fn from(error: SecurityError) -> Self {
        Self {
            detail: error.to_string(),
            unavailable: matches!(
                error.code(),
                ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_USER_CANCELED
            ),
        }
    }
}

/// The user's login Keychain: one generic password per account, under a service name.
///
/// # Why not the data-protection keychain
///
/// `security-framework`'s `kSecUseDataProtectionKeychain` and `kSecAttrAccessible*` only affect
/// the newer, per-app data-protection keychain, which requires a signed binary with a Keychain
/// Sharing entitlement to use meaningfully. Parallax is unsigned until it has an Apple Developer ID,
/// so this deliberately targets the older, file-based login keychain instead, which locks and
/// unlocks as a whole and needs neither. Revisit this once Parallax is signed.
///
/// [`kSecAttrSynchronizable`](https://developer.apple.com/documentation/security/ksecattrsynchronizable)
/// is left unset on purpose: an API key must never sync to iCloud Keychain and reach another of
/// the user's Macs behind their back.
#[derive(Debug, Clone, Copy)]
pub struct KeychainStore {
    service: &'static str,
}

impl KeychainStore {
    /// The real Parallax Keychain service, [`SERVICE`].
    #[must_use]
    pub const fn new() -> Self {
        Self { service: SERVICE }
    }

    /// A store under a different service name, so a test can't disturb a real stored key.
    #[must_use]
    pub const fn with_service(service: &'static str) -> Self {
        Self { service }
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStore for KeychainStore {
    fn set(&self, account: AccountId, key: &str) -> Result<(), KeyStoreError> {
        let account = account.to_string();
        let mut options = PasswordOptions::new_generic_password(self.service, &account);
        options.set_label(ITEM_LABEL);
        let mut owned = key.to_owned();
        let result = set_generic_password_options(owned.as_bytes(), options);
        owned.zeroize();
        Ok(result?)
    }

    fn get(&self, account: AccountId) -> Result<Option<Zeroizing<String>>, KeyStoreError> {
        let account = account.to_string();
        let options = PasswordOptions::new_generic_password(self.service, &account);
        match generic_password(options) {
            Ok(mut bytes) => {
                let key = Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned());
                bytes.zeroize();
                Ok(Some(key))
            }
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn delete(&self, account: AccountId) -> Result<(), KeyStoreError> {
        let account = account.to_string();
        match delete_generic_password(self.service, &account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use security_framework::base::Error as SecurityError;

    use super::{ERR_SEC_INTERACTION_NOT_ALLOWED, ERR_SEC_ITEM_NOT_FOUND, ERR_SEC_USER_CANCELED};
    use crate::keystore::KeyStoreError;

    #[test]
    fn a_locked_or_refused_keychain_is_unavailable() {
        let unavailable =
            |code: i32| KeyStoreError::from(SecurityError::from(code)).is_unavailable();
        assert!(unavailable(ERR_SEC_INTERACTION_NOT_ALLOWED));
        assert!(unavailable(ERR_SEC_USER_CANCELED));
        assert!(!unavailable(ERR_SEC_ITEM_NOT_FOUND));
    }
}
