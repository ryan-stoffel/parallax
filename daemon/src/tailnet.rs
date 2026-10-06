//! Tailscale, as Parallax Connect sees it (decision 0056): this node and its peers from
//! `tailscale status --json`, who is behind an address from `tailscale whois --json`, and which
//! peers [`admit`] lets reach plxd.
//!
//! [`Tailnet`] puts both commands behind a trait, so tests use a fake. [`TailscaleCli`] runs the
//! real CLI, found on the agent environment's `PATH` or in the folders each OS installs it in.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::Deserialize;

use crate::backend::process::Launcher;
use crate::detect;

/// How long a `tailscale` command may take.
const CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// Where Tailscale's installers put the CLI, checked after `PATH`.
#[cfg(target_os = "macos")]
const INSTALLED_AT: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
];
#[cfg(target_os = "linux")]
const INSTALLED_AT: &[&str] = &["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
#[cfg(windows)]
const INSTALLED_AT: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
const INSTALLED_AT: &[&str] = &[];

/// This node's tailnet, through `tailscale status` and `tailscale whois`.
pub trait Tailnet: Send + Sync + fmt::Debug {
    /// This node and its peers, while Tailscale is running.
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>>;
    /// Who is at `peer`, a tailnet address and port.
    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, Result<Whois, String>>;
}

/// Why there is no tailnet to use.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum NotRunning {
    /// No Tailscale CLI was found.
    #[error("the Tailscale CLI isn't installed")]
    Missing,
    /// Tailscale isn't connected, or the CLI failed.
    #[error("Tailscale isn't running: {0}")]
    Stopped(String),
}

/// This node and its peers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    /// This node.
    pub this: Node,
    /// Every other node this one sees, of any user.
    pub peers: Vec<Node>,
}

/// A node on the tailnet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    /// The stable ID, such as `nZi1Lj6Rrb11CNTRL`.
    pub id: String,
    /// The host name.
    pub host_name: String,
    /// The `MagicDNS` name, without its trailing dot.
    pub dns_name: String,
    /// The OS as Tailscale names it, such as `macOS`.
    pub os: String,
    /// The node's user. Tagged nodes all belong to one user of their own.
    pub user_id: u64,
    /// The node's Tailscale addresses, IPv4 first.
    pub ips: Vec<IpAddr>,
    /// Whether Tailscale sees it online.
    pub online: bool,
}

impl Node {
    /// The node's first Tailscale IPv4 address.
    #[must_use]
    pub fn ipv4(&self) -> Option<IpAddr> {
        self.ips.iter().copied().find(IpAddr::is_ipv4)
    }
}

/// Who is behind a tailnet address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Whois {
    /// The user the node belongs to.
    pub user_id: u64,
    /// The node's `MagicDNS` name, for the log.
    pub node: String,
}

/// The peers this node lets in: its own user's, from any address but its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    /// This node's user.
    pub user_id: u64,
    /// This node's Tailscale addresses.
    pub own_ips: Vec<IpAddr>,
}

impl Owner {
    /// The owner `status` describes.
    #[must_use]
    pub fn of(status: &Status) -> Self {
        Self {
            user_id: status.this.user_id,
            own_ips: status.this.ips.clone(),
        }
    }
}

/// Whether a connection from `peer`, whom `whois` names, may reach plxd: only from another node
/// of the owner's user. `Err` says why not.
///
/// # Errors
///
/// The reason the peer is refused.
pub fn admit(owner: &Owner, peer: IpAddr, whois: Result<Whois, String>) -> Result<Whois, String> {
    let whois = whois.map_err(|error| format!("whois failed: {error}"))?;
    if owner.own_ips.contains(&peer.to_canonical()) {
        return Err(format!(
            "it comes from {}, this node's own address",
            whois.node
        ));
    }
    if whois.user_id != owner.user_id {
        return Err(format!(
            "{} belongs to user {}, not this node's user {}",
            whois.node, whois.user_id, owner.user_id
        ));
    }
    Ok(whois)
}

/// The real `tailscale` CLI, run through plxd's launcher.
#[derive(Debug)]
pub struct TailscaleCli {
    launcher: Launcher,
}

impl TailscaleCli {
    /// A tailnet that runs the CLI found on `launcher`'s `PATH`, or where an installer put it.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self { launcher }
    }

    fn program(&self) -> Option<PathBuf> {
        detect::resolve(&self.launcher, "tailscale").or_else(|| {
            INSTALLED_AT
                .iter()
                .map(Path::new)
                .find(|path| path.is_file())
                .map(Path::to_owned)
        })
    }

    /// Runs `tailscale args` and returns its stdout, or why it failed.
    async fn run(&self, program: &Path, args: &[&str]) -> Result<String, String> {
        let mut spec = detect::probe_spec(&program.to_string_lossy());
        spec.args = args.iter().map(|arg| (*arg).into()).collect();
        let ran = detect::run_spec(&self.launcher, &spec, b"", CLI_TIMEOUT).await?;
        if ran.exit_code == Some(0) {
            Ok(ran.stdout)
        } else {
            let said = ran.stderr_tail.trim();
            Err(if said.is_empty() {
                format!("it exited with {:?}", ran.exit_code)
            } else {
                said.to_owned()
            })
        }
    }
}

impl Tailnet for TailscaleCli {
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>> {
        Box::pin(async move {
            let program = self.program().ok_or(NotRunning::Missing)?;
            let json = self
                .run(&program, &["status", "--json"])
                .await
                .map_err(NotRunning::Stopped)?;
            parse_status(&json)
        })
    }

    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, Result<Whois, String>> {
        Box::pin(async move {
            let program = self
                .program()
                .ok_or_else(|| NotRunning::Missing.to_string())?;
            let json = self
                .run(&program, &["whois", "--json", &peer.to_string()])
                .await?;
            parse_whois(&json)
        })
    }
}

/// A host with no Tailscale, for unit tests.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct Absent;

#[cfg(test)]
impl Tailnet for Absent {
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>> {
        Box::pin(async { Err(NotRunning::Missing) })
    }

    fn whois(&self, _: SocketAddr) -> BoxFuture<'_, Result<Whois, String>> {
        Box::pin(async { Err(NotRunning::Missing.to_string()) })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStatus {
    #[serde(default)]
    backend_state: String,
    #[serde(rename = "Self")]
    this: Option<RawNode>,
    #[serde(default)]
    peer: Option<std::collections::HashMap<String, RawNode>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct RawNode {
    #[serde(rename = "ID")]
    id: String,
    host_name: String,
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "OS")]
    os: String,
    #[serde(rename = "UserID")]
    user_id: u64,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<IpAddr>>,
    online: bool,
}

impl From<RawNode> for Node {
    fn from(raw: RawNode) -> Self {
        let mut ips = raw.tailscale_ips.unwrap_or_default();
        ips.sort_by_key(IpAddr::is_ipv6);
        Self {
            id: raw.id,
            host_name: raw.host_name,
            dns_name: raw.dns_name.trim_end_matches('.').to_owned(),
            os: raw.os,
            user_id: raw.user_id,
            ips,
            online: raw.online,
        }
    }
}

/// Reads `tailscale status --json`. Anything but a running backend is [`NotRunning::Stopped`].
fn parse_status(json: &str) -> Result<Status, NotRunning> {
    let raw: RawStatus = serde_json::from_str(json)
        .map_err(|error| NotRunning::Stopped(format!("unreadable status: {error}")))?;
    if raw.backend_state != "Running" {
        return Err(NotRunning::Stopped(format!(
            "its state is {:?}",
            raw.backend_state
        )));
    }
    let this = raw
        .this
        .ok_or_else(|| NotRunning::Stopped("its status has no Self".to_owned()))?;
    Ok(Status {
        this: this.into(),
        peers: raw
            .peer
            .unwrap_or_default()
            .into_values()
            .map(Node::from)
            .collect(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawWhois {
    node: RawWhoisNode,
    user_profile: RawUserProfile,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawWhoisNode {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawUserProfile {
    #[serde(rename = "ID")]
    id: u64,
}

/// Reads `tailscale whois --json`.
fn parse_whois(json: &str) -> Result<Whois, String> {
    let raw: RawWhois =
        serde_json::from_str(json).map_err(|error| format!("unreadable whois: {error}"))?;
    Ok(Whois {
        user_id: raw.user_profile.id,
        node: raw.node.name.trim_end_matches('.').to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::{NotRunning, Owner, Whois, admit, parse_status, parse_whois};

    const ME: u64 = 526_036_588_648_688;
    const TAGGED: u64 = 662_125_110_488_743;

    /// Trimmed from a real `tailscale status --json`: this node, another of its user's, and a
    /// tagged node shared from another tailnet.
    const STATUS: &str = r#"{
      "Version": "1.102.4-t3caf7d9e7-g084ee3b64",
      "BackendState": "Running",
      "TailscaleIPs": ["100.74.190.83", "fd7a:115c:a1e0::fc2a:be54"],
      "Self": {
        "ID": "nZi1Lj6Rrb11CNTRL", "NodeID": 4463253412029858,
        "HostName": "Ryan’s Mac Mini", "DNSName": "ryans-mac-mini.tail53cf78.ts.net.",
        "OS": "macOS", "UserID": 526036588648688,
        "TailscaleIPs": ["fd7a:115c:a1e0::fc2a:be54", "100.74.190.83"], "Online": true
      },
      "Peer": {
        "nodekey:7b8d": {
          "ID": "ntpwoKNMLJ11CNTRL", "HostName": "macbook",
          "DNSName": "ryans-macbook.tail53cf78.ts.net.", "OS": "macOS",
          "UserID": 526036588648688, "TailscaleIPs": ["100.87.92.42", "fd7a:115c:a1e0::d533:5c2c"],
          "Online": false, "KeyExpiry": "2027-01-06T14:17:56Z"
        },
        "nodekey:0820": {
          "ID": "nkxiuZ8Lu911CNTRL", "HostName": "hv-worker-1",
          "DNSName": "hv-worker-1.tail470a31.ts.net.", "OS": "linux",
          "UserID": 662125110488743, "AltSharerUserID": 7312656834859973,
          "TailscaleIPs": ["100.66.59.107"], "Tags": ["tag:k3s"], "Online": true
        }
      },
      "User": {}
    }"#;

    #[test]
    fn status_reads_this_node_and_its_peers() {
        let status = parse_status(STATUS).unwrap();
        assert_eq!(status.this.id, "nZi1Lj6Rrb11CNTRL");
        assert_eq!(status.this.host_name, "Ryan’s Mac Mini");
        assert_eq!(status.this.dns_name, "ryans-mac-mini.tail53cf78.ts.net");
        assert_eq!(status.this.user_id, ME);
        assert_eq!(
            status.this.ipv4(),
            Some("100.74.190.83".parse().unwrap()),
            "IPv4 first, whatever the order"
        );
        let mut peers = status.peers;
        peers.sort_by(|a, b| a.host_name.cmp(&b.host_name));
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].user_id, TAGGED);
        assert_eq!(peers[1].host_name, "macbook");
        assert_eq!(peers[1].os, "macOS");
        assert!(!peers[1].online);
    }

    #[test]
    fn status_without_a_running_backend_or_peers() {
        let stopped = r#"{"BackendState": "Stopped", "Self": null, "Peer": null}"#;
        assert!(matches!(parse_status(stopped), Err(NotRunning::Stopped(_))));
        assert!(matches!(
            parse_status("not json"),
            Err(NotRunning::Stopped(_))
        ));
        let alone = r#"{"BackendState": "Running", "Self": {"UserID": 1, "TailscaleIPs": null}, "Peer": null}"#;
        let status = parse_status(alone).unwrap();
        assert!(status.peers.is_empty());
        assert_eq!(status.this.ipv4(), None);
    }

    #[test]
    fn whois_reads_the_user_and_node() {
        // Trimmed from a real `tailscale whois --json 100.87.92.42`.
        let json = r#"{
          "Node": {"ID": 2219799458589281, "StableID": "ntpwoKNMLJ11CNTRL",
                   "Name": "ryans-macbook.tail53cf78.ts.net.", "User": 526036588648688,
                   "Addresses": ["100.87.92.42/32"]},
          "UserProfile": {"ID": 526036588648688, "LoginName": "ryan-stoffel@github"},
          "CapMap": null
        }"#;
        assert_eq!(
            parse_whois(json).unwrap(),
            Whois {
                user_id: ME,
                node: "ryans-macbook.tail53cf78.ts.net".to_owned()
            }
        );
        assert!(parse_whois("peer not found").is_err());
    }

    #[test]
    fn only_another_node_of_the_same_user_is_admitted() {
        let owner = Owner {
            user_id: ME,
            own_ips: vec!["100.74.190.83".parse().unwrap()],
        };
        let peer: IpAddr = "100.87.92.42".parse().unwrap();
        let whois = |user_id| {
            Ok(Whois {
                user_id,
                node: "node".to_owned(),
            })
        };
        assert!(admit(&owner, peer, whois(ME)).is_ok(), "same user");
        assert!(admit(&owner, peer, whois(7)).is_err(), "another user");
        assert!(admit(&owner, peer, whois(TAGGED)).is_err(), "a tagged node");
        assert!(
            admit(&owner, peer, Err("peer not found".to_owned())).is_err(),
            "whois failed"
        );
        let own: IpAddr = "100.74.190.83".parse().unwrap();
        assert!(
            admit(&owner, own, whois(ME)).is_err(),
            "this node's own address"
        );
        let mapped: IpAddr = "::ffff:100.74.190.83".parse().unwrap();
        assert!(
            admit(&owner, mapped, whois(ME)).is_err(),
            "its own address, IPv4-mapped"
        );
    }
}
