//! Manual verification of `SecretServiceStore` against the real Secret Service (PLX-19).
//!
//! Ignored by default, so `scripts/ci/check-rust`'s `cargo test --workspace` (and CI) never
//! touches a real keyring. Run it on a Linux host with an unlocked Secret Service and
//! `secret-tool` (Debian and Ubuntu: `libsecret-tools`):
//!
//! ```sh
//! cargo test -p plxd --test secret_service_manual -- --ignored --nocapture
//! ```
//!
//! It uses a throwaway, test-only service name, never `plxd::keystore::SERVICE`, so it can't
//! disturb a real stored key, and it cleans up after itself. If it panics partway through, remove
//! the leftover item by hand:
//!
//! ```sh
//! secret-tool clear service io.github.ryan-stoffel.parallax.secret-service-manual-test
//! ```

#![cfg(target_os = "linux")]

use std::process::Command;

use parallax_protocol::AccountId;
use plxd::keystore::{KeyStore, SecretServiceStore};

const TEST_SERVICE: &str = "io.github.ryan-stoffel.parallax.secret-service-manual-test";

/// What `secret-tool lookup` reads for `service`/`account`, or `None` if it finds nothing: an
/// outside check that the item really is in the Secret Service.
fn secret_tool_lookup(service: &str, account: &str) -> Option<String> {
    let output = Command::new("secret-tool")
        .args(["lookup", "service", service, "username", account])
        .output()
        .expect("run secret-tool (install libsecret-tools)");
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[test]
#[ignore = "touches the real Secret Service; run manually with --ignored"]
fn add_read_and_remove_a_throwaway_key() {
    let store = SecretServiceStore::with_service(TEST_SERVICE);
    let account = AccountId::generate();
    let account_text = account.to_string();
    let key = "sk-ant-manual-test-throwaway-key-abcd";

    assert_eq!(
        secret_tool_lookup(TEST_SERVICE, &account_text),
        None,
        "no leftover from an earlier run of this test"
    );
    assert_eq!(store.get(account).unwrap(), None);

    store.set(account, key).expect("store the throwaway key");
    assert_eq!(
        secret_tool_lookup(TEST_SERVICE, &account_text).as_deref(),
        Some(key),
        "secret-tool should read the item plxd just wrote"
    );
    assert_eq!(
        store.get(account).unwrap().as_deref().map(String::as_str),
        Some(key),
        "plxd should read back exactly what it stored"
    );

    store
        .set(account, "sk-ant-manual-test-replacement-key-wxyz")
        .expect("replace the throwaway key");
    assert_eq!(
        store.get(account).unwrap().as_deref().map(String::as_str),
        Some("sk-ant-manual-test-replacement-key-wxyz"),
        "setting again replaces the key in the same item"
    );

    store.delete(account).expect("remove the throwaway key");
    assert_eq!(
        secret_tool_lookup(TEST_SERVICE, &account_text),
        None,
        "secret-tool should no longer find it after removal"
    );
    assert_eq!(store.get(account).unwrap(), None);
    store.delete(account).expect("removing it again succeeds");
}
