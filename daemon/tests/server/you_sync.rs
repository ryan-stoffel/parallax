//! You memory between two of the user's Connect devices (0082, PLX-946): two plxds on loopback,
//! each with a fake tailnet that shows the other, pulling every 100 ms.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use parallax_protocol::methods::{MemoryDelete, MemoryList, MemoryRead, MemoryWrite};
use parallax_protocol::{
    MemoryDeleteParams, MemoryFile, MemoryListParams, MemoryReadParams, MemoryScope,
    MemoryWriteParams,
};
use plxd::tailnet::{Node, NotRunning, Status, Tailnet, Whois};
use tokio::time::{Instant, sleep};

use crate::connect::{ME, free_port, set_connect, whois};
use crate::support::{Client, InProcess, PATIENCE, temp_dir};

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const EVERY: Duration = Duration::from_millis(100);

/// A tailnet where this node is `me` and its one device is `peer`, online while `online` is set.
#[derive(Debug)]
struct Pair {
    me: &'static str,
    peer: &'static str,
    online: Arc<AtomicBool>,
}

fn node(id: &str, ip: IpAddr, online: bool) -> Node {
    Node {
        id: id.to_owned(),
        host_name: format!("{id}-host"),
        dns_name: format!("{id}.example.ts.net"),
        os: "linux".to_owned(),
        user_id: ME,
        tags: Vec::new(),
        ips: vec![ip],
        online,
    }
}

impl Tailnet for Pair {
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>> {
        let online = self.online.load(Ordering::Relaxed);
        // The peer answers on loopback, where its listener is. This node's own address is
        // elsewhere, since a node turns away connections from its own addresses.
        let own = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1));
        Box::pin(async move {
            Ok(Status {
                this: node(self.me, own, true),
                peers: vec![node(self.peer, LOOPBACK, online)],
            })
        })
    }

    fn whois(&self, _: SocketAddr) -> BoxFuture<'_, Result<Whois, String>> {
        Box::pin(async { Ok(whois(ME)) })
    }
}

/// One of the two hosts.
struct Host {
    dir: tempfile::TempDir,
    me: &'static str,
    peer: &'static str,
    port: u16,
    peer_port: u16,
    online: Arc<AtomicBool>,
    server: Option<InProcess>,
}

impl Host {
    fn new(
        me: &'static str,
        peer: &'static str,
        ports: (u16, u16),
        online: &Arc<AtomicBool>,
    ) -> Self {
        Self {
            dir: temp_dir(),
            me,
            peer,
            port: ports.0,
            peer_port: ports.1,
            online: Arc::clone(online),
            server: None,
        }
    }

    /// Starts plxd on this host's data folder, with `connect` on.
    async fn start(&mut self) -> Client {
        let mut config = InProcess::config(self.dir.path());
        config.tailnet = Some(Arc::new(Pair {
            me: self.me,
            peer: self.peer,
            online: Arc::clone(&self.online),
        }));
        config.connect_address = Some(LOOPBACK);
        config.connect_port = self.port;
        config.connect_check_interval = Duration::from_hours(1);
        config.you_sync_interval = EVERY;
        config.you_sync_port = Some(self.peer_port);
        let server = InProcess::start(config);
        let mut client = Client::ready(&server.socket).await;
        set_connect(&mut client, true).await;
        self.server = Some(server);
        client
    }

    async fn stop(&mut self) {
        self.server.take().unwrap().stop().await;
    }
}

/// Two hosts, `a` and `b`, that see each other while `online` is set.
fn pair() -> (Host, Host, Arc<AtomicBool>) {
    let online = Arc::new(AtomicBool::new(true));
    let ports = (free_port(), free_port());
    let a = Host::new("a", "b", ports, &online);
    let b = Host::new("b", "a", (ports.1, ports.0), &online);
    (a, b, online)
}

async fn write(client: &mut Client, path: &str, title: &str, content: &str) {
    let params = MemoryWriteParams {
        scope: MemoryScope::You,
        path: path.to_owned(),
        content: content.to_owned(),
        title: Some(title.to_owned()),
        source: None,
        from: None,
    };
    client.call::<MemoryWrite>(params).await.unwrap();
}

async fn list(client: &mut Client) -> Vec<MemoryFile> {
    let params = MemoryListParams {
        scope: MemoryScope::You,
    };
    client.call::<MemoryList>(params).await.unwrap().files
}

async fn body(client: &mut Client, path: &str) -> Option<String> {
    let params = MemoryReadParams {
        scope: MemoryScope::You,
        path: path.to_owned(),
        from: None,
    };
    client
        .call::<MemoryRead>(params)
        .await
        .ok()
        .map(|read| read.content)
}

/// Each listed path, its body, and the machine that wrote it.
async fn state(client: &mut Client) -> Vec<(String, String, Option<String>)> {
    let mut state = Vec::new();
    for file in list(client).await {
        let text = body(client, &file.path).await.unwrap_or_default();
        state.push((file.path, text, file.machine.map(|machine| machine.id)));
    }
    state
}

/// Waits until `check` holds.
async fn until(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !check().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        sleep(Duration::from_millis(50)).await;
    }
}

const TABS: &str = "memory/preference/tabs.md";

#[tokio::test]
async fn concurrent_edits_keep_the_later_one_everywhere_and_the_other_as_a_proposal() {
    let (mut a, mut b, online) = pair();
    let mut on_a = a.start().await;
    let mut on_b = b.start().await;

    write(&mut on_a, TABS, "Tabs", "Use tabs.").await;
    until("the entry to reach b, written on a", async || {
        state(&mut on_b).await
            == [(
                TABS.to_owned(),
                "Use tabs.".to_owned(),
                Some("a".to_owned()),
            )]
    })
    .await;

    // Apart, both edit it, b later.
    online.store(false, Ordering::Relaxed);
    sleep(EVERY * 3).await;
    write(&mut on_a, TABS, "Tabs", "Use tabs, width 4.").await;
    sleep(Duration::from_millis(50)).await;
    write(&mut on_b, TABS, "Tabs", "Use spaces.").await;
    online.store(true, Ordering::Relaxed);

    until("both to keep b's edit", async || {
        body(&mut on_a, TABS).await.as_deref() == Some("Use spaces.")
            && body(&mut on_b, TABS).await.as_deref() == Some("Use spaces.")
    })
    .await;
    // The host that saw both versions keeps a's as a proposal that replaces the entry.
    let mut proposals = Vec::new();
    for client in [&mut on_a, &mut on_b] {
        for file in list(client).await {
            if file.path.starts_with("proposals/") {
                assert_eq!(file.replaces.as_deref(), Some(TABS));
                proposals.push(body(client, &file.path).await.unwrap());
            }
        }
    }
    assert!(!proposals.is_empty());
    assert!(
        proposals.iter().all(|text| text == "Use tabs, width 4."),
        "{proposals:?}"
    );
    let written_on = |files: Vec<MemoryFile>| {
        files
            .into_iter()
            .find(|file| file.path == TABS)
            .and_then(|file| file.machine)
            .map(|machine| (machine.id, machine.name))
    };
    let b_host = Some(("b".to_owned(), "b-host".to_owned()));
    assert_eq!(written_on(list(&mut on_a).await), b_host);
    assert_eq!(written_on(list(&mut on_b).await), b_host);

    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_host_that_was_offline_catches_up_deletions_included() {
    let (mut a, mut b, _online) = pair();
    let mut on_a = a.start().await;
    let mut on_b = b.start().await;
    write(&mut on_a, TABS, "Tabs", "Use tabs.").await;
    write(
        &mut on_a,
        "memory/gotcha/ci.md",
        "CI",
        "CI is slow on Mondays.",
    )
    .await;
    until("both entries to reach b", async || {
        state(&mut on_b).await.len() == 2
    })
    .await;

    b.stop().await;
    write(&mut on_a, TABS, "Tabs", "Use spaces.").await;
    write(
        &mut on_a,
        "memory/decision/vitest.md",
        "Vitest",
        "Use Vitest.",
    )
    .await;
    let gone = MemoryDeleteParams {
        scope: MemoryScope::You,
        path: "memory/gotcha/ci.md".to_owned(),
    };
    on_a.call::<MemoryDelete>(gone).await.unwrap();

    // a records its own changes at its next scan.
    until("a to record its changes", async || {
        let state = state(&mut on_a).await;
        state.len() == 2
            && state
                .iter()
                .all(|(_, _, machine)| machine.as_deref() == Some("a"))
    })
    .await;
    let expected = state(&mut on_a).await;
    let mut on_b = b.start().await;
    until("b to match a", async || state(&mut on_b).await == expected).await;

    a.stop().await;
    b.stop().await;
}
