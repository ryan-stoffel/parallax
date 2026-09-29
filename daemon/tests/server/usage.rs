//! `usage/get` and `usage/history` against a real server: they are answered even with an empty
//! store.

use wisp_protocol::methods::{UsageGet, UsageHistory};
use wisp_protocol::{UsageGetParams, UsageHistoryParams};

use crate::support::{Client, Wispd, temp_dir};

#[tokio::test]
async fn usage_get_reports_no_accounts_when_nothing_has_been_recorded() {
    let dir = temp_dir();
    let wispd = Wispd::start(dir.path()).await;
    let mut client = Client::ready(&wispd.socket).await;

    let result = client.call::<UsageGet>(UsageGetParams {}).await.unwrap();
    assert!(result.accounts.is_empty());
}

#[tokio::test]
async fn usage_history_is_empty_when_nothing_has_been_recorded() {
    let dir = temp_dir();
    let wispd = Wispd::start(dir.path()).await;
    let mut client = Client::ready(&wispd.socket).await;

    let result = client
        .call::<UsageHistory>(UsageHistoryParams {
            since: "2020-01-01T00:00:00Z".parse().unwrap(),
        })
        .await
        .unwrap();
    assert!(result.hours.is_empty());
    assert!(result.runs.is_empty());
}
