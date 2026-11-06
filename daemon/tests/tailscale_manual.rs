//! Manual verification of `TailscaleCli` against the real `tailscale` CLI (0056).
//!
//! Ignored by default, since CI has no tailnet. Run it on a machine where Tailscale is running:
//!
//! ```sh
//! cargo test -p plxd --test tailscale_manual -- --ignored --nocapture
//! ```
//!
//! It only reads: `tailscale status --json`, and `tailscale whois --json` on this node's own
//! address.

use std::net::SocketAddr;

use plxd::backend::process::{Environment, Launcher};
use plxd::paths::DataDir;
use plxd::tailnet::{Owner, Tailnet, TailscaleCli, admit};

#[tokio::test]
#[ignore = "needs Tailscale running on this machine"]
async fn status_and_whois_read_this_node_and_its_own_address_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let launcher = Launcher::new(DataDir::new(dir.path()).unwrap(), Environment::inherited());
    let tailnet = TailscaleCli::new(launcher);

    let status = tailnet.status().await.expect("Tailscale is running");
    let ip = status.this.ipv4().expect("this node has a Tailscale IPv4");
    println!("this node: {} at {ip}", status.this.dns_name);
    let whois = tailnet
        .whois(SocketAddr::new(ip, 7340))
        .await
        .expect("whois answers for this node");
    println!("whois: {whois:?}");
    assert_eq!(whois.user_id, status.this.user_id);

    let refused = admit(&Owner::of(&status), ip, Ok(whois)).unwrap_err();
    println!("refused: {refused}");
}
