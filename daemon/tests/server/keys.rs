//! `accounts/keys/*` on a Linux host with no Secret Service (PLX-19, 0023).
//!
//! Linux only: on a Mac the same call would reach the real login Keychain.
#![cfg(target_os = "linux")]

use parallax_protocol::methods::{AccountsKeysAdd, AccountsKeysList};
use parallax_protocol::{AccountId, AccountsKeysListParams, ErrorKind};
use serde_json::json;

use crate::support::{Client, Plxd, kind, temp_dir};

#[tokio::test]
async fn adding_a_key_without_a_secret_service_fails_and_stores_nothing() {
    let dir = temp_dir();
    // A session bus that doesn't exist, as on a headless host.
    let no_bus = [(
        "DBUS_SESSION_BUS_ADDRESS",
        "unix:path=/nonexistent/plxd-test-bus",
    )];
    let plxd = Plxd::start_with(dir.path(), &[], &no_bus).await;
    let mut client = Client::ready(&plxd.socket).await;

    let params = serde_json::from_value(json!({
        "id": AccountId::generate(),
        "provider": "anthropic",
        "label": "work",
        "key": "sk-ant-api03-headless-host-test-key",
    }))
    .unwrap();
    let error = client.call::<AccountsKeysAdd>(params).await.unwrap_err();
    assert_eq!(kind(&error), ErrorKind::KeychainUnavailable);
    assert!(
        error.message.contains("install one"),
        "the error names the fix: {}",
        error.message
    );

    let listed = client
        .call::<AccountsKeysList>(AccountsKeysListParams {})
        .await
        .unwrap();
    assert!(listed.accounts.is_empty(), "no record without a stored key");
}
