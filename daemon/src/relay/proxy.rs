//! The proxy plxd reaches the relay and Clerk through (PLX-1363, 0091): `HTTPS_PROXY`, unless
//! `NO_PROXY` names the host.
//!
//! plxd asks an HTTP proxy for a tunnel with `CONNECT` and runs its TLS through it. The proxy's URL
//! may hold a password, so [`Proxy`] has no `Debug`, and no error or log line quotes the URL.

use std::io;
use std::time::Duration;

use data_encoding::BASE64;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

/// How long a proxy has to connect and answer a `CONNECT`.
const ANSWER: Duration = crate::remote::REQUEST_TIMEOUT;

/// The most of a proxy's answer plxd reads.
const MAX_ANSWER: usize = 16 * 1024;

/// An HTTP proxy from the environment.
pub(super) struct Proxy {
    host: String,
    port: u16,
    /// The `Proxy-Authorization` value, when the URL holds credentials.
    authorization: Option<String>,
}

impl Proxy {
    /// The proxy for `host:port` this process's environment names, if any.
    ///
    /// # Errors
    ///
    /// When the variable is set but plxd can't use it. plxd doesn't go direct then, since a proxy
    /// is usually a network's policy.
    pub(super) fn from_env(host: &str, port: u16) -> io::Result<Option<Self>> {
        Self::choose(host, port, |name| std::env::var(name).ok())
    }

    /// [`Proxy::from_env`] with the environment in `var`. The lowercase name wins, as in curl, and
    /// an empty value counts as unset.
    fn choose(
        host: &str,
        port: u16,
        var: impl Fn(&str) -> Option<String>,
    ) -> io::Result<Option<Self>> {
        let either = |lower: &str, upper: &str| {
            var(lower)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| var(upper).filter(|value| !value.trim().is_empty()))
        };
        let Some(url) = either("https_proxy", "HTTPS_PROXY") else {
            return Ok(None);
        };
        if either("no_proxy", "NO_PROXY").is_some_and(|list| excluded(&list, host, port)) {
            return Ok(None);
        }
        Self::parse(url.trim()).map(Some)
    }

    /// `[http://][user[:password]@]host[:port]`. A port left out is HTTP's.
    fn parse(url: &str) -> io::Result<Self> {
        let bad = |why: &str| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the HTTPS_PROXY setting {why}"),
            )
        };
        let rest = match url.split_once("://") {
            Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") => rest,
            Some(_) => return Err(bad("isn't an http:// proxy")),
            None => url,
        };
        // Credentials end at the last `@`, since a password left unescaped may hold a `/`, and any
        // of it read as a host would land in an error.
        let (credentials, address) = match rest.rsplit_once('@') {
            Some((credentials, address)) => (Some(credentials), address),
            None => (None, rest),
        };
        let address = address.split(['/', '?', '#']).next().unwrap_or_default();
        let (host, port) = match address.strip_prefix('[') {
            Some(rest) => {
                let (host, after) = rest.split_once(']').ok_or_else(|| bad("has a bad host"))?;
                (host, after.strip_prefix(':'))
            }
            None => match address.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (address, None),
            },
        };
        if host.is_empty() {
            return Err(bad("has no host"));
        }
        let port = match port {
            Some(port) => port.parse().map_err(|_| bad("has a bad port"))?,
            None => 80,
        };
        Ok(Self {
            host: host.to_owned(),
            port,
            authorization: credentials.map(basic),
        })
    }

    /// A connection to `host:port` through this proxy, ready for TLS. Errors say the proxy's host
    /// and port, never its credentials.
    pub(super) async fn tunnel(&self, host: &str, port: u16) -> io::Result<TcpStream> {
        let late = || {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "the proxy at {}:{} didn't answer in time",
                    self.host, self.port
                ),
            )
        };
        tokio::time::timeout(ANSWER, self.connect(host, port))
            .await
            .map_err(|_| late())?
    }

    async fn connect(&self, host: &str, port: u16) -> io::Result<TcpStream> {
        let mut tcp = TcpStream::connect((self.host.as_str(), self.port))
            .await
            .map_err(|error| {
                let at = format!("the proxy at {}:{}: {error}", self.host, self.port);
                io::Error::new(error.kind(), at)
            })?;
        let _ = tcp.set_nodelay(true);
        let authorization = self
            .authorization
            .as_ref()
            .map(|value| format!("Proxy-Authorization: Basic {value}\r\n"))
            .unwrap_or_default();
        let request =
            format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{authorization}\r\n");
        tcp.write_all(request.as_bytes()).await?;
        let status = answer(&mut tcp).await?;
        match status {
            200..=299 => Ok(tcp),
            407 => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the proxy refused the HTTPS_PROXY setting's credentials",
            )),
            _ => Err(io::Error::other(format!(
                "the proxy answered {status} when asked for a tunnel to {host}:{port}"
            ))),
        }
    }
}

/// The status of the proxy's answer. One byte at a time, since what follows its head is TLS.
async fn answer(tcp: &mut TcpStream) -> io::Result<u16> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "the proxy's answer isn't HTTP");
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() == MAX_ANSWER {
            return Err(bad());
        }
        head.push(tcp.read_u8().await?);
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    response.parse(&head).map_err(|_| bad())?;
    response.code.ok_or_else(bad)
}

/// Whether `NO_PROXY`'s `list` names `host:port`: `*`, or a host or domain, with or without a
/// leading `.` or `*.`, and with or without a port. A name counts for its subdomains too. plxd
/// never resolves a host to choose, so a CIDR entry matches nothing.
fn excluded(list: &str, host: &str, port: u16) -> bool {
    let host = host.to_ascii_lowercase();
    list.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let (name, only_port) = match entry.rsplit_once(':') {
                Some((name, only)) => (name, only.parse::<u16>().ok()),
                None => (entry, None),
            };
            let name = name.strip_prefix("*.").unwrap_or(name);
            let name = name.strip_prefix('.').unwrap_or(name).to_ascii_lowercase();
            only_port.is_none_or(|only| only == port)
                && (host == name || host.ends_with(&format!(".{name}")))
        })
}

/// The `Basic` credentials of a URL's percent-encoded `user[:password]`.
fn basic(credentials: &str) -> String {
    let (user, password) = credentials.split_once(':').unwrap_or((credentials, ""));
    let mut plain = percent_decoded(user);
    plain.push(b':');
    plain.extend(percent_decoded(password));
    BASE64.encode(&plain)
}

fn percent_decoded(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut plain = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let escape = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = escape {
            plain.push(byte);
            at += 3;
        } else {
            plain.push(bytes[at]);
            at += 1;
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use tokio::net::TcpListener;

    use super::*;

    fn chosen(env: &[(&str, &str)], host: &str, port: u16) -> io::Result<Option<Proxy>> {
        Proxy::choose(host, port, |name| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    /// The host and port of the proxy `env` chooses for the relay.
    fn address(env: &[(&str, &str)]) -> Option<(String, u16)> {
        let proxy = chosen(env, "relay.parallax.codes", 443).unwrap();
        proxy.map(|proxy| (proxy.host, proxy.port))
    }

    #[test]
    fn either_name_counts_the_lowercase_one_first_and_empty_is_unset() {
        let at = |host: &str, port| Some((host.to_owned(), port));
        assert_eq!(address(&[]), None);
        assert_eq!(address(&[("HTTPS_PROXY", " ")]), None);
        assert_eq!(address(&[("HTTPS_PROXY", "proxy:3128")]), at("proxy", 3128));
        assert_eq!(
            address(&[("https_proxy", "http://proxy/")]),
            at("proxy", 80)
        );
        assert_eq!(
            address(&[
                ("https_proxy", "http://low:1"),
                ("HTTPS_PROXY", "http://up:2")
            ]),
            at("low", 1)
        );
        assert_eq!(
            address(&[("https_proxy", ""), ("HTTPS_PROXY", "http://up:2")]),
            at("up", 2)
        );
        assert_eq!(
            address(&[("HTTPS_PROXY", "http://[::1]:3128")]),
            at("::1", 3128)
        );
        assert_eq!(
            address(&[("HTTPS_PROXY", "http://user:12/ss@proxy:3128/")]),
            at("proxy", 3128)
        );
    }

    #[test]
    fn no_proxy_names_hosts_domains_and_ports() {
        let direct = |list: &str| {
            let env = [("HTTPS_PROXY", "http://proxy:3128"), ("no_proxy", list)];
            address(&env).is_none()
        };
        for list in [
            "*",
            "relay.parallax.codes",
            "RELAY.parallax.codes",
            "example.com, relay.parallax.codes",
            "parallax.codes",
            ".parallax.codes",
            "*.parallax.codes",
            "relay.parallax.codes:443",
        ] {
            assert!(direct(list), "{list}");
        }
        for list in [
            "",
            "example.com",
            "allax.codes",
            "relay.parallax.codes:8443",
            "10.0.0.0/8",
        ] {
            assert!(!direct(list), "{list}");
        }
    }

    #[test]
    fn a_setting_it_cant_use_fails_without_quoting_it() {
        for url in [
            "socks5://user:hunter2@proxy:1080",
            "https://user:hunter2@proxy:443",
            "http://user:hunter2@proxy:port",
            "http://user:hunter2@",
        ] {
            let error = chosen(&[("HTTPS_PROXY", url)], "relay.parallax.codes", 443)
                .err()
                .unwrap_or_else(|| panic!("{url} was accepted"));
            assert!(!error.to_string().contains("hunter2"), "{error}");
        }
    }

    /// A proxy answering `status` to one `CONNECT`, then `tunnel`, and handing back what it was
    /// asked.
    async fn proxy_answering(status: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(tcp.read_u8().await.unwrap());
            }
            tcp.write_all(format!("HTTP/1.1 {status}\r\n\r\ntunnel").as_bytes())
                .await
                .unwrap();
            String::from_utf8(head).unwrap()
        });
        (port, asked)
    }

    #[tokio::test]
    async fn a_tunnel_sends_decoded_credentials_and_leaves_what_follows_unread() {
        let (port, asked) = proxy_answering("200 Connection established").await;
        let url = format!("http://us%40er:p%3Ass@127.0.0.1:{port}");
        let proxy = Proxy::parse(&url).unwrap();
        let mut tcp = proxy.tunnel("relay.parallax.codes", 443).await.unwrap();
        let mut tunnel = [0; 6];
        tcp.read_exact(&mut tunnel).await.unwrap();
        assert_eq!(&tunnel, b"tunnel");
        let credentials = BASE64.encode(b"us@er:p:ss");
        assert_eq!(
            asked.await.unwrap(),
            format!(
                "CONNECT relay.parallax.codes:443 HTTP/1.1\r\nHost: relay.parallax.codes:443\r\n\
                 Proxy-Authorization: Basic {credentials}\r\n\r\n"
            )
        );
    }

    #[tokio::test]
    async fn a_refused_tunnel_says_so_without_the_credentials() {
        for (status, says) in [
            ("407 Proxy Authentication Required", "refused"),
            ("403 Forbidden", "403"),
        ] {
            let (port, _) = proxy_answering(status).await;
            let proxy = Proxy::parse(&format!("http://user:hunter2@127.0.0.1:{port}")).unwrap();
            let error = proxy.tunnel("relay.parallax.codes", 443).await.unwrap_err();
            let text = error.to_string();
            assert!(text.contains(says), "{text}");
            assert!(!text.contains("hunter2"), "{text}");
        }
    }
}
