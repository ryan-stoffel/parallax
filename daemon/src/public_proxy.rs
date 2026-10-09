//! The headless browser's only way out (PLX-639): a SOCKS5 proxy on loopback, as T3 Code's
//! `publicProxy.ts`, that connects only to public addresses. It resolves each name itself and
//! connects only to the addresses it checked, so a name that resolves elsewhere a second time
//! (DNS rebinding) changes nothing. It refuses this machine (its loopback and every address its
//! interfaces hold), private and shared networks, link-local addresses such as cloud metadata
//! (169.254.169.254), multicast, and the IPv6 forms that carry one of those IPv4 addresses. A
//! preview tab may reach loopback too, for the thread's own dev servers, but only by an IP
//! literal or a `localhost` name: a public name that resolves to loopback (`localtest.me`, or a
//! page rebinding its own name) is refused. A public page can still send blind requests to an
//! allowed loopback address, as any browser's pages can, but can't read the answers across
//! origins. It carries bytes only, so
//! HTTP, TLS, and `WebSocket`s pass through unchanged.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::AbortHandle;

/// How long resolving a name, or connecting to it, may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// A running proxy. Dropping it stops taking connections.
pub(crate) struct PublicProxy {
    /// The loopback port it listens on.
    pub port: u16,
    accepting: AbortHandle,
}

impl Drop for PublicProxy {
    fn drop(&mut self) {
        self.accepting.abort();
    }
}

/// Starts a proxy on a free loopback port. With `loopback`, it reaches this machine's loopback
/// addresses too.
///
/// # Errors
///
/// When it can't listen.
pub(crate) async fn start(loopback: bool) -> io::Result<PublicProxy> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let accepting = tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = serve(client, loopback).await;
            });
        }
    })
    .abort_handle();
    Ok(PublicProxy { port, accepting })
}

// SOCKS5 (RFC 1928) replies: success, not allowed by rule, host unreachable, refused, and
// command not supported.
const SUCCEEDED: u8 = 0;
const NOT_ALLOWED: u8 = 2;
const UNREACHABLE: u8 = 4;
const REFUSED: u8 = 5;
const UNSUPPORTED: u8 = 7;

async fn reply(client: &mut TcpStream, code: u8) -> io::Result<()> {
    client.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

/// One client: its greeting and CONNECT request, then the tunnel.
async fn serve(mut client: TcpStream, loopback: bool) -> io::Result<()> {
    let mut head = [0; 2];
    client.read_exact(&mut head).await?;
    let mut methods = vec![0; usize::from(head[1])];
    client.read_exact(&mut methods).await?;
    // Version 5, offering "no authentication".
    if head[0] != 5 || !methods.contains(&0) {
        return client.write_all(&[5, 0xff]).await;
    }
    client.write_all(&[5, 0]).await?;
    let mut request = [0; 4];
    client.read_exact(&mut request).await?;
    let host = match request[3] {
        1 => {
            let mut ip = [0; 4];
            client.read_exact(&mut ip).await?;
            Host::Ip(Ipv4Addr::from(ip).into())
        }
        3 => {
            let mut len = [0; 1];
            client.read_exact(&mut len).await?;
            let mut name = vec![0; usize::from(len[0])];
            client.read_exact(&mut name).await?;
            Host::Name(String::from_utf8_lossy(&name).into_owned())
        }
        4 => {
            let mut ip = [0; 16];
            client.read_exact(&mut ip).await?;
            Host::Ip(Ipv6Addr::from(ip).into())
        }
        _ => return reply(&mut client, UNSUPPORTED).await,
    };
    let mut port = [0; 2];
    client.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    // Version 5, CONNECT, the reserved byte, and a real port.
    if request[0] != 5 || request[1] != 1 || request[2] != 0 || port == 0 {
        return reply(&mut client, UNSUPPORTED).await;
    }
    // Loopback only by an address or a `localhost` name, never by a name that resolves there. A
    // `localhost` name is loopback without DNS, as browsers treat it.
    let localhost = matches!(&host, Host::Name(name)
        if { let name = name.trim_end_matches('.').to_ascii_lowercase(); name == "localhost" || name.ends_with(".localhost") });
    let loopback = loopback && (localhost || matches!(host, Host::Ip(_)));
    let addresses: Vec<SocketAddr> = match host {
        Host::Ip(ip) => vec![SocketAddr::new(ip, port)],
        Host::Name(_) if localhost => vec![
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port),
            SocketAddr::new(Ipv6Addr::LOCALHOST.into(), port),
        ],
        Host::Name(name) => {
            match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((name, port))).await
            {
                Ok(Ok(found)) => found.collect(),
                _ => Vec::new(),
            }
        }
    };
    if addresses.is_empty() {
        return reply(&mut client, UNREACHABLE).await;
    }
    let own = own_addresses();
    if addresses
        .iter()
        .any(|address| refused(address.ip(), loopback, &own))
    {
        return reply(&mut client, NOT_ALLOWED).await;
    }
    for address in addresses {
        if let Ok(Ok(mut upstream)) =
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await
        {
            reply(&mut client, SUCCEEDED).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
            return Ok(());
        }
    }
    reply(&mut client, REFUSED).await
}

enum Host {
    Ip(IpAddr),
    Name(String),
}

/// Whether the proxy refuses `ip`: a local network's, or this machine's own unless `loopback`
/// lets its loopback through. `own` are the addresses its interfaces hold.
fn refused(ip: IpAddr, loopback: bool, own: &[IpAddr]) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    };
    if loopback && ip.is_loopback() {
        return false;
    }
    if own.contains(&ip) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => local_v4(v4),
        IpAddr::V6(v6) => {
            local_v6(v6) || embedded_v4(v6).is_some_and(|v4| refused(v4.into(), false, own))
        }
    }
}

/// This machine and the local networks, as T3 lists them: this network, private, shared (CGNAT),
/// loopback, link-local, benchmarking, and multicast with everything above it.
fn local_v4(ip: Ipv4Addr) -> bool {
    let ip = u32::from(ip);
    [
        ([0, 0, 0, 0], 8),
        ([10, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([127, 0, 0, 0], 8),
        ([169, 254, 0, 0], 16),
        ([172, 16, 0, 0], 12),
        ([192, 168, 0, 0], 16),
        ([198, 18, 0, 0], 15),
        ([224, 0, 0, 0], 3),
    ]
    .iter()
    .any(|&(network, prefix)| ip >> (32 - prefix) == u32::from_be_bytes(network) >> (32 - prefix))
}

/// The local IPv6 ranges, and those that carry an IPv4 address a translator may route without
/// checking it, as T3 lists them: IPv4-compatible (with `::` and `::1`), local-use NAT64, Teredo,
/// unique local, link-local, and multicast.
fn local_v6(ip: Ipv6Addr) -> bool {
    let ip = u128::from(ip);
    [
        (0_u128, 96),
        (0x0064_ff9b_0001 << 80, 48),
        (0x2001 << 112, 32),
        (0xfc00 << 112, 7),
        (0xfe80 << 112, 10),
        (0xff00 << 112, 8),
    ]
    .iter()
    .any(|&(network, prefix)| ip >> (128 - prefix) == network >> (128 - prefix))
}

/// The IPv4 address a NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address stands for, which a
/// translator routes to.
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let bits = u128::from(ip);
    if bits >> 32 == 0x0064_ff9b_u128 << 64 {
        return Some(Ipv4Addr::from(
            ip.octets()[12..16].try_into().unwrap_or([0; 4]),
        ));
    }
    if bits >> 112 == 0x2002 {
        return Some(Ipv4Addr::from(
            ip.octets()[2..6].try_into().unwrap_or([0; 4]),
        ));
    }
    None
}

/// The addresses this machine's interfaces hold now.
fn own_addresses() -> Vec<IpAddr> {
    let Ok(interfaces) = nix::ifaddrs::getifaddrs() else {
        return Vec::new();
    };
    interfaces
        .filter_map(|interface| {
            let address = interface.address?;
            address
                .as_sockaddr_in()
                .map(|v4| IpAddr::V4(v4.ip()))
                .or_else(|| address.as_sockaddr_in6().map(|v6| IpAddr::V6(v6.ip())))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::{refused, start};

    #[test]
    fn local_networks_and_their_ipv6_forms_are_refused() {
        let own: Vec<IpAddr> = vec!["203.0.113.7".parse().unwrap()];
        let check = |ip: &str, loopback| refused(ip.parse().unwrap(), loopback, &own);
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:0101::1",
            "fd00::1",
            "fe80::1",
            "2001:0:1::1",
            "203.0.113.7",
        ] {
            assert!(check(ip, false), "{ip} should be refused");
        }
        for ip in [
            "93.184.216.34",
            "2606:2800:220:1::1",
            "64:ff9b::5db8:d822",
            "::ffff:8.8.8.8",
        ] {
            assert!(!check(ip, false), "{ip} should be allowed");
        }
        assert!(!check("127.0.0.1", true));
        assert!(!check("::1", true));
        assert!(check("10.0.0.1", true));
    }

    /// Asks the proxy to CONNECT to `host:port` by name, and returns its reply code.
    async fn connect(proxy: u16, host: &str, port: u16) -> u8 {
        let mut client = TcpStream::connect(("127.0.0.1", proxy)).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut greeting = [0; 2];
        client.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 0]);
        let mut request = vec![5, 1, 0, 3, u8::try_from(host.len()).unwrap()];
        request.extend_from_slice(host.as_bytes());
        request.extend_from_slice(&port.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0; 10];
        client.read_exact(&mut reply).await.unwrap();
        reply[1]
    }

    #[tokio::test]
    async fn localhost_is_refused_unless_loopback_is_allowed() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        let public = start(false).await.unwrap();
        assert_eq!(connect(public.port, "localhost", port).await, 2);
        let with_loopback = start(true).await.unwrap();
        assert_eq!(connect(with_loopback.port, "localhost", port).await, 0);
        assert_eq!(connect(with_loopback.port, "app.localhost", port).await, 0);
        // A public name that resolves to loopback, as `localtest.me` does, is refused.
        assert_ne!(connect(with_loopback.port, "localtest.me", port).await, 0);
    }
}
