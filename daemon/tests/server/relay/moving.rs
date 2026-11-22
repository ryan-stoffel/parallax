//! The move to production (PLX-1465) under `wrangler dev`: two computers set up on the development
//! account, one offline while the app moves the other, then moved once it's back.
//! `relay/scripts/e2e.mjs` gives the relay a second, local Clerk instance standing in for
//! production, whose JWKS plxd reads to check the production token itself. Runs only when it passes
//! `PLXD_TEST_RELAY_MOVE_*`.

use parallax_protocol::methods::{AccessGet, RelayHosts, RelayMove, RelayRegister};
use parallax_protocol::{AccessGetParams, RelayHostsParams, RelayMoveParams, RelayRegisterParams};

use super::{relay_status, set_relay};
use crate::connect::free_port;
use crate::remote::{set_remote, wait_listening};
use crate::support::{Client, InProcess, temp_dir};

/// A computer on the account of the development `token`, connected to the relay at `url`, taking
/// tokens from `production` and the development instance: the server, a client, and its host id.
async fn on_development(
    dir: &std::path::Path,
    url: &str,
    production: &str,
    token: &str,
) -> (InProcess, Client, String) {
    let port = free_port();
    let mut config = crate::account::config(dir, production, url, port);
    config.clerk_legacy = Some(plxd::clerk::Config {
        issuer: plxd::clerk::issuer_of(token).unwrap(),
        client_ids: Vec::new(),
        hosted_client_ids: Vec::new(),
        authorized_parties: Vec::new(),
    });
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let registered = client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.to_owned(),
            signed: None,
        })
        .await;
    assert!(registered.is_ok(), "{registered:?}");
    let status = relay_status(&mut client, |s| s.connected).await;
    let host_id = status
        .hook_url
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    (server, client, host_id)
}

/// The host ids the account of `token` has on the relay, each with whether it's online, sorted.
async fn listed(client: &mut Client, token: &str) -> Vec<(String, bool)> {
    let params = RelayHostsParams {
        token: token.to_owned(),
    };
    let list = client.call::<RelayHosts>(params).await.unwrap();
    assert_eq!(
        list.removed.unwrap_or_default(),
        Vec::<String>::new(),
        "a move removes nothing"
    );
    let mut hosts: Vec<_> = list
        .hosts
        .into_iter()
        .map(|h| (h.host_id, h.online))
        .collect();
    hosts.sort();
    hosts
}

async fn account(client: &mut Client) -> Option<String> {
    let state = client.call::<AccessGet>(AccessGetParams::default()).await;
    state.unwrap().account
}

#[tokio::test]
async fn two_computers_move_to_production_one_after_it_was_offline() {
    let (Ok(url), Ok(dev), Ok(prod)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_MOVE_FROM_TOKEN"),
        std::env::var("PLXD_TEST_RELAY_MOVE_TOKEN"),
    ) else {
        return;
    };
    let production = plxd::clerk::issuer_of(&prod).unwrap();
    let (dir_a, dir_b) = (temp_dir(), temp_dir());
    let (_a_server, mut a, a_id) = on_development(dir_a.path(), &url, &production, &dev).await;
    let (_b_server, mut b, b_id) = on_development(dir_b.path(), &url, &production, &dev).await;
    let dev_user = plxd::clerk::subject(&dev);
    let prod_user = plxd::clerk::subject(&prod);
    assert_eq!(account(&mut a).await, dev_user);
    let both = {
        let mut both = vec![(a_id.clone(), true), (b_id.clone(), true)];
        both.sort();
        both
    };
    assert_eq!(listed(&mut a, &dev).await, both);
    assert_eq!(listed(&mut a, &prod).await, []);

    // B goes offline, so the app reaches only A, which moves without dropping its connection.
    set_relay(&mut b, false).await;
    relay_status(&mut b, |s| !s.connected).await;
    let params = RelayMoveParams {
        token: prod.clone(),
        from: dev.clone(),
    };
    a.call::<RelayMove>(params.clone()).await.unwrap();
    assert_eq!(account(&mut a).await, prod_user);
    assert!(relay_status(&mut a, |s| s.connected).await.connected);
    assert_eq!(listed(&mut a, &prod).await, [(a_id.clone(), true)]);
    assert_eq!(listed(&mut a, &dev).await, [(b_id.clone(), false)]);
    a.call::<RelayMove>(params.clone()).await.unwrap();

    // B is back, still on development, which keeps working for it, and moves now.
    set_relay(&mut b, true).await;
    relay_status(&mut b, |s| s.connected).await;
    assert_eq!(account(&mut b).await, dev_user);
    assert_eq!(listed(&mut b, &dev).await, [(b_id.clone(), true)]);
    b.call::<RelayMove>(params).await.unwrap();
    assert_eq!(account(&mut b).await, prod_user);
    assert_eq!(listed(&mut b, &dev).await, []);
    assert_eq!(listed(&mut b, &prod).await, both);
}
