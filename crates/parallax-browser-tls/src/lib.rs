//! plxd's pinned TLS 1.3 client, compiled to WebAssembly for the hosted browser client (0108).
//!
//! JavaScript owns the WebSocket: it feeds the relay stream's bytes in with [`TlsClient::feed`],
//! sends what [`TlsClient::take`] returns, and reads and writes plaintext. packages/relay-tls wraps
//! this as `RelayTls`.
//!
//! - The certificate must pass plxd's own pin check ([`parallax_pin::Pin`]): its key's JWK
//!   thumbprint is the host id, or its SHA-256 is a LAN pin. Nothing is written before it does.
//! - ALPN offers `plxd-early-ws`, then `http/1.1`, as `plxd dial` does (0091).
//! - Each pin has one configuration for the page's life, holding only that pin's session tickets
//!   ([`tickets`]), so a reconnect within an hour resumes with 0-RTT on PLX-1585's terms, and a
//!   reload forgets them.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{self, Read as _, Write as _};
use std::sync::Arc;

use parallax_pin::Pin;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, KeyProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::sign::SigningKey;
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, HandshakeKind,
    SignatureScheme,
};
use wasm_bindgen::prelude::*;

mod tickets;

/// The ALPN protocol of a listener that takes WebSocket frames behind the `/ws` upgrade (0091).
pub const EARLY_WS: &[u8] = b"plxd-early-ws";

/// What the client offers, most wanted first, as `plxd dial` does.
fn alpn_protocols() -> Vec<Vec<u8>> {
    vec![EARLY_WS.to_vec(), b"http/1.1".to_vec()]
}

/// The name in the `ClientHello`. plxd's certificate isn't checked against it, only the pin.
const SERVER_NAME: &str = "parallax";

/// Accepts only the certificate its pin names, with plxd's own check.
struct Pinned {
    pin: Pin,
    algorithms: WebPkiSupportedAlgorithms,
}

// rustls wants `Debug`. A derived one would print the pin and the algorithms, and its code would
// ship to every browser for nothing.
impl std::fmt::Debug for Pinned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pinned")
    }
}

/// The browser has no private key to load: it sends no client certificate. In place of ring's,
/// whose RSA, ECDSA and Ed25519 signing code would otherwise ship with the module (0108).
#[derive(Debug)]
struct NoKeys;

impl KeyProvider for NoKeys {
    fn load_private_key(
        &self,
        _: PrivateKeyDer<'static>,
    ) -> Result<Arc<dyn SigningKey>, rustls::Error> {
        Err(rustls::Error::General("no client keys".into()))
    }
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if !self.pin.accepts(end_entity) {
            return Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.3 only".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

thread_local! {
    /// Each pin's configuration, made on its first connect and kept for the page's life. Its
    /// ticket store is the only one that pin's connects use, so a ticket never goes to another
    /// host, and only a session that passed the pin made one.
    static CONFIGS: RefCell<HashMap<Pin, Arc<ClientConfig>>> = RefCell::default();
}

/// `pin`'s configuration: ring's default provider's suites, key exchanges and signature checks, as
/// plxd's listener has, so both prefer AES-256-GCM, TLS 1.3 only, the pin check, ALPN, and 0-RTT
/// from its own tickets.
fn config(pin: &Pin) -> Result<Arc<ClientConfig>, Error> {
    if let Some(config) = CONFIGS.with_borrow(|configs| configs.get(pin).cloned()) {
        return Ok(config);
    }
    let provider = Arc::new(CryptoProvider {
        key_provider: &NoKeys,
        ..rustls::crypto::ring::default_provider()
    });
    let verifier = Pinned {
        pin: pin.clone(),
        algorithms: provider.signature_verification_algorithms,
    };
    let mut config =
        ClientConfig::builder_with_provider(Arc::clone(&provider) as Arc<CryptoProvider>)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|error| describe(&error))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
    config.alpn_protocols = alpn_protocols();
    config.enable_early_data = true;
    config.resumption = rustls::client::Resumption::store(Arc::new(tickets::Held::default()));
    let config = Arc::new(config);
    CONFIGS.with_borrow_mut(|configs| configs.insert(pin.clone(), Arc::clone(&config)));
    Ok(config)
}

/// Why a connection failed, for the page: a few words rather than rustls's own text, whose
/// formatting would add to what a browser downloads (0108).
pub type Error = &'static str;

const BROKE: Error = "the TLS connection broke";

fn describe(error: &rustls::Error) -> Error {
    match error {
        rustls::Error::InvalidCertificate(_) => "the host's key isn't the pinned one",
        rustls::Error::AlertReceived(_) => "the host ended the TLS connection",
        rustls::Error::PeerIncompatible(_) | rustls::Error::NoApplicationProtocol => {
            "the host's TLS doesn't match this client's"
        }
        _ => BROKE,
    }
}

/// One connection's TLS, without I/O.
pub struct Client {
    tls: ClientConnection,
    /// What the caller gave to go first, until the handshake says whether the host took the part
    /// that went as early data.
    first: Vec<u8>,
    /// How much of `first` went as early data.
    sent_early: usize,
    /// Plaintext read and not yet taken.
    plaintext: Vec<u8>,
    peer_closed: bool,
}

impl Client {
    /// A connection to the host `pin` names, with `first` to send once the host proved its key.
    /// When the pin has a ticket that allows it, as much of `first` as fits goes as early data.
    /// `pin` can't be [`Pin::Any`].
    ///
    /// # Errors
    ///
    /// If `pin` is [`Pin::Any`] or rustls refuses the configuration.
    pub fn new(pin: &Pin, first: &[u8]) -> Result<Self, Error> {
        if *pin == Pin::Any {
            return Err("a browser connects only to a pinned host");
        }
        let name = ServerName::try_from(SERVER_NAME).map_err(|_| BROKE)?;
        let mut tls =
            ClientConnection::new(config(pin)?, name).map_err(|error| describe(&error))?;
        let sent_early = match tls.early_data() {
            Some(mut early) if !first.is_empty() => early.write(first).unwrap_or(0),
            _ => 0,
        };
        Ok(Self {
            tls,
            first: first.to_vec(),
            sent_early,
            plaintext: Vec::new(),
            peer_closed: false,
        })
    }

    /// Takes TLS bytes from the host.
    ///
    /// # Errors
    ///
    /// If they break TLS, or the certificate fails the pin. [`Self::take`] then has the alert.
    pub fn feed(&mut self, mut bytes: &[u8]) -> Result<(), Error> {
        while !bytes.is_empty() {
            let handshaking = self.tls.is_handshaking();
            self.tls.read_tls(&mut bytes).map_err(|_| BROKE)?;
            let state = self
                .tls
                .process_new_packets()
                .map_err(|error| describe(&error))?;
            if handshaking && !self.tls.is_handshaking() {
                self.handshake_done();
            }
            let mut reader = self.tls.reader();
            loop {
                let mut chunk = [0; 4096];
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => self.plaintext.extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(_) => return Err(BROKE),
                }
            }
            self.peer_closed |= state.peer_has_closed();
        }
        Ok(())
    }

    /// Sends what was to go first: all of it when the host refused the early data, after the
    /// handshake as 0091 has it, or just the rest when it took it.
    fn handshake_done(&mut self) {
        let first = std::mem::take(&mut self.first);
        let sent = if self.tls.is_early_data_accepted() {
            self.sent_early
        } else {
            0
        };
        // The writer buffers without limit while the handshake has just finished.
        let _ = self.tls.writer().write_all(&first[sent..]);
    }

    /// TLS bytes to send to the host.
    #[must_use]
    pub fn take(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while self.tls.wants_write() {
            if self.tls.write_tls(&mut out).is_err() {
                break;
            }
        }
        out
    }

    /// Writes plaintext to the host, which [`Self::take`] then has.
    ///
    /// # Errors
    ///
    /// While the handshake runs, since the host hasn't proved its key yet.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if self.tls.is_handshaking() {
            return Err("the host hasn't proved its key yet");
        }
        self.tls.writer().write_all(bytes).map_err(|_| BROKE)
    }

    /// The plaintext read since the last call.
    pub fn read(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.plaintext)
    }

    /// Ends the connection with a `close_notify`, which [`Self::take`] then has.
    pub fn close(&mut self) {
        self.tls.send_close_notify();
    }

    #[must_use]
    pub fn handshaking(&self) -> bool {
        self.tls.is_handshaking()
    }

    /// The ALPN protocol the host picked.
    #[must_use]
    pub fn alpn(&self) -> Option<String> {
        self.tls
            .alpn_protocol()
            .map(|name| String::from_utf8_lossy(name).into_owned())
    }

    /// Whether the handshake resumed a session from one of the pin's tickets.
    #[must_use]
    pub fn resumed(&self) -> bool {
        self.tls.handshake_kind() == Some(HandshakeKind::Resumed)
    }

    /// Whether the host took what went as early data.
    #[must_use]
    pub fn early_accepted(&self) -> bool {
        self.sent_early > 0 && self.tls.is_early_data_accepted()
    }

    /// Whether the host sent its `close_notify`.
    #[must_use]
    pub fn peer_closed(&self) -> bool {
        self.peer_closed
    }
}

/// [`Client`] for JavaScript.
#[wasm_bindgen]
pub struct TlsClient(Client);

#[wasm_bindgen]
impl TlsClient {
    /// A connection pinned to the host whose key's JWK thumbprint is `host_id`.
    ///
    /// # Errors
    ///
    /// If rustls refuses the configuration.
    #[wasm_bindgen(js_name = toHost)]
    pub fn to_host(host_id: String, first: &[u8]) -> Result<TlsClient, JsError> {
        Client::new(&Pin::HostId(host_id), first)
            .map(Self)
            .map_err(JsError::new)
    }

    /// A connection pinned to the certificate whose SHA-256, in lowercase hex, is `fingerprint`.
    ///
    /// # Errors
    ///
    /// If rustls refuses the configuration.
    #[wasm_bindgen(js_name = toFingerprint)]
    pub fn to_fingerprint(fingerprint: String, first: &[u8]) -> Result<TlsClient, JsError> {
        Client::new(&Pin::Fingerprint(fingerprint), first)
            .map(Self)
            .map_err(JsError::new)
    }

    /// # Errors
    ///
    /// As [`Client::feed`].
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.0.feed(bytes).map_err(JsError::new)
    }

    pub fn take(&mut self) -> Vec<u8> {
        self.0.take()
    }

    /// # Errors
    ///
    /// As [`Client::write`].
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.0.write(bytes).map_err(JsError::new)
    }

    pub fn read(&mut self) -> Vec<u8> {
        self.0.read()
    }

    pub fn close(&mut self) {
        self.0.close();
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handshaking(&self) -> bool {
        self.0.handshaking()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn alpn(&self) -> Option<String> {
        self.0.alpn()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn resumed(&self) -> bool {
        self.0.resumed()
    }

    #[wasm_bindgen(getter, js_name = earlyAccepted)]
    #[must_use]
    pub fn early_accepted(&self) -> bool {
        self.0.early_accepted()
    }

    #[wasm_bindgen(getter, js_name = peerClosed)]
    #[must_use]
    pub fn peer_closed(&self) -> bool {
        self.0.peer_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::ServerConnection;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    /// A listener configured as plxd's is: tickets, 0-RTT, and its ALPN list.
    fn server() -> (Arc<rustls::ServerConfig>, Vec<u8>) {
        let made = rcgen::generate_simple_self_signed([SERVER_NAME.to_owned()]).unwrap();
        let certificate = made.cert.der().to_vec();
        let key = PrivatePkcs8KeyDer::from(made.signing_key.serialize_der());
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone().into()], PrivateKeyDer::Pkcs8(key))
        .unwrap();
        config.session_storage = rustls::server::ServerSessionMemoryCache::new(16);
        config.send_tls13_tickets = 1;
        config.max_early_data_size = 16 * 1024;
        config.alpn_protocols = alpn_protocols();
        (Arc::new(config), certificate)
    }

    /// Runs the handshake, and what follows, until neither end has anything to send. Returns what
    /// the server read, early data included, and the client's error, if any.
    fn pump(client: &mut Client, server: &mut ServerConnection) -> (Vec<u8>, Option<Error>) {
        let mut read = Vec::new();
        for _ in 0..16 {
            let out = client.take();
            if !out.is_empty() {
                server.read_tls(&mut out.as_slice()).unwrap();
                if server.process_new_packets().is_err() {
                    return (read, None);
                }
                if let Some(mut early) = server.early_data() {
                    early.read_to_end(&mut read).unwrap();
                }
                let _ = server.reader().read_to_end(&mut read);
            }
            let mut back = Vec::new();
            while server.wants_write() {
                server.write_tls(&mut back).unwrap();
            }
            if out.is_empty() && back.is_empty() {
                break;
            }
            if let Err(error) = client.feed(&back) {
                return (read, Some(error));
            }
        }
        (read, None)
    }

    fn host_id(certificate: &[u8]) -> Pin {
        Pin::HostId(parallax_pin::key_id(certificate).unwrap())
    }

    #[test]
    fn offers_early_ws_then_http_and_only_to_a_pin() {
        let config = config(&Pin::HostId("h".repeat(43))).unwrap();
        assert_eq!(
            config.alpn_protocols,
            [b"plxd-early-ws".to_vec(), b"http/1.1".to_vec()]
        );
        assert!(Client::new(&Pin::Any, b"").is_err());
    }

    #[test]
    fn a_pinned_host_answers_and_another_key_gets_nothing() {
        let (config, certificate) = server();
        let mut client = Client::new(&host_id(&certificate), b"").unwrap();
        assert!(client.write(b"GET / HTTP/1.1\r\n\r\n").is_err());
        let mut host = ServerConnection::new(Arc::clone(&config)).unwrap();
        let (_, error) = pump(&mut client, &mut host);
        assert_eq!(error, None);
        assert_eq!(client.alpn().as_deref(), Some("plxd-early-ws"));
        client.write(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let (read, _) = pump(&mut client, &mut host);
        assert_eq!(read, b"GET / HTTP/1.1\r\n\r\n");

        let (_, other) = server();
        let mut client = Client::new(&host_id(&other), b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut host = ServerConnection::new(config).unwrap();
        let (read, error) = pump(&mut client, &mut host);
        assert_eq!(error, Some("the host's key isn't the pinned one"));
        assert!(read.is_empty());
        assert!(client.write(b"GET / HTTP/1.1\r\n\r\n").is_err());
    }

    #[test]
    fn a_second_connect_resumes_with_early_data_only_for_its_pin() {
        let (config, certificate) = server();
        let pin = host_id(&certificate);
        let mut first = Client::new(&pin, b"one").unwrap();
        let mut host = ServerConnection::new(Arc::clone(&config)).unwrap();
        let (read, _) = pump(&mut first, &mut host);
        assert_eq!(
            (read.as_slice(), first.resumed()),
            (b"one".as_slice(), false)
        );

        let mut second = Client::new(&pin, b"two").unwrap();
        let mut host = ServerConnection::new(Arc::clone(&config)).unwrap();
        let (read, _) = pump(&mut second, &mut host);
        assert_eq!(read, b"two");
        assert!(second.resumed() && second.early_accepted());

        let fingerprint = Pin::Fingerprint(parallax_pin::fingerprint(&certificate));
        let mut other = Client::new(&fingerprint, b"three").unwrap();
        let mut host = ServerConnection::new(config).unwrap();
        let (read, _) = pump(&mut other, &mut host);
        assert_eq!(read, b"three");
        assert!(!other.resumed() && !other.early_accepted());
    }
}
