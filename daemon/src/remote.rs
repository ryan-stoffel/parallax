//! Remote access on the LAN (PLX-641, decision 0065): what plxd's HTTPS listener and its clients
//! share, and the client side `plxd dial` runs.
//!
//! - Each plxd has one self-signed ECDSA P-256 certificate, its [`HostKey`]. A paired client
//!   pins its SHA-256 fingerprint and sends nothing to a host that presents another one.
//! - Pairing needs no fingerprint on screen. The host shows a short one-time code and, while it
//!   waits, advertises itself over mDNS by name only ([`discover`]). The client runs SPAKE2 with
//!   the code, over TLS to whatever certificate the host presents, with that certificate's
//!   fingerprint as the host's identity in the exchange. Each side then proves it holds the
//!   shared key ([`confirmation`]), so a client that knows the code learns the right
//!   fingerprint, and a machine in the middle gets one guess per try and no fingerprint. The
//!   host locks the code after a few wrong tries.
//! - Pairing ends with a session token bound to the client's [`DpopKey`], as T3 Code's `DPoP`
//!   sessions are, so a stolen token is useless without the key.
//! - A paired client gets a 30 s ticket at `/api/auth/websocket-ticket` with the token and a
//!   `DPoP` proof, then opens `/ws` with it, which carries 0007's JSON-RPC, one message per frame.
//!
//! [`dial`] tries a host's routes in order, as T3's connection driver does, and [`bridge`] joins
//! the WebSocket to `plxd dial`'s stdio. Its credential stays in its data folder, readable only by
//! this user.

use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data_encoding::BASE64URL_NOPAD;
use futures_util::{SinkExt as _, StreamExt as _};
use ring::rand::SystemRandom;
use ring::signature::{self, EcdsaKeyPair, KeyPair as _};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio::io::{
    AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _,
};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// The TCP port plxd listens on while `remote` is on (decision 0065).
pub const PORT: u16 = 7341;

/// How long one route may take to answer, and the server one request.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// `plxd dial` exits with this when the host refused it: the code was wrong, used, locked, or
/// expired, or this computer's session was revoked. Retrying won't help.
pub const EXIT_REFUSED: i32 = 5;

/// A pairing code's alphabet: no 0, 1, I, or O, as T3 Code's.
const CODE_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// How many characters a pairing code has: 30 bits, which the host's lockout after
/// [`MAX_WRONG_CODES`] tries keeps out of reach online, and SPAKE2 keeps out of reach offline.
pub const CODE_LENGTH: usize = 6;

/// How many wrong codes lock a pairing code for good.
pub const MAX_WRONG_CODES: u32 = 5;

/// The mDNS service a host advertises while it waits for a pairing.
pub const SERVICE_TYPE: &str = "_parallax._tcp.local.";

/// The environment variable `plxd dial --pair` reads the code from, so it's never on a command
/// line other users can see.
pub const CODE_ENV: &str = "PLXD_PAIRING_CODE";

/// The client's identity in SPAKE2. The host's is its certificate fingerprint.
const PAKE_CLIENT: &[u8] = b"parallax pairing client";

/// How far a `DPoP` proof's `iat` may be from now, as T3's.
pub const PROOF_WINDOW_SECONDS: i64 = 300;

/// The largest JSON-RPC message a WebSocket carries: 0007's frame limit.
#[must_use]
pub fn websocket_config() -> WebSocketConfig {
    let max = parallax_protocol::framing::MAX_FRAME_BYTES;
    WebSocketConfig::default()
        .max_message_size(Some(max))
        .max_frame_size(Some(max))
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// `bytes` in base64url without padding, as JWTs and `DPoP` use.
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    BASE64URL_NOPAD.encode(bytes)
}

/// `bytes` in lowercase hex.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, b| {
        let _ = write!(text, "{b:02x}");
        text
    })
}

/// SHA-256 of `bytes`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// A certificate's fingerprint: the SHA-256 of its DER, in hex.
#[must_use]
pub fn fingerprint(certificate: &[u8]) -> String {
    hex(&sha256(certificate))
}

/// `length` random bytes in base64url, for tokens and tickets.
///
/// # Panics
///
/// If the OS has no random numbers.
#[must_use]
pub fn random_token(length: usize) -> String {
    let mut bytes = vec![0; length];
    getrandom::fill(&mut bytes).expect("the OS's random numbers");
    base64url(&bytes)
}

/// A new pairing code: [`CODE_LENGTH`] characters of [`CODE_ALPHABET`].
///
/// # Panics
///
/// If the OS has no random numbers.
#[must_use]
pub fn new_code() -> String {
    let mut bytes = [0_u8; CODE_LENGTH];
    getrandom::fill(&mut bytes).expect("the OS's random numbers");
    // 256 is a multiple of 32, so every character is equally likely.
    bytes
        .iter()
        .map(|b| char::from(CODE_ALPHABET[usize::from(b % 32)]))
        .collect()
}

/// A code as typed, without spaces or dashes, in capitals: `7kq-4m2` is `7KQ4M2`.
#[must_use]
pub fn normalize_code(typed: &str) -> String {
    typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// A code as people read it: `7KQ-4M2`.
#[must_use]
pub fn format_code(code: &str) -> String {
    let (first, second) = code.split_at(code.len() / 2);
    format!("{first}-{second}")
}

type Spake = spake2::Spake2<spake2::Ed25519Group>;

/// Starts the client's side of SPAKE2 with `code`, for the host whose certificate has
/// `fingerprint`: its state and first message.
#[must_use]
pub fn pake_client(code: &str, fingerprint: &str) -> (Spake, Vec<u8>) {
    Spake::start_a(
        &spake2::Password::new(normalize_code(code).as_bytes()),
        &spake2::Identity::new(PAKE_CLIENT),
        &spake2::Identity::new(fingerprint.as_bytes()),
    )
}

/// The host's side of SPAKE2 with `code` and its own `fingerprint`, given the client's
/// message: its answer and the shared key.
///
/// # Errors
///
/// When the client's message isn't SPAKE2.
pub fn pake_host(
    code: &str,
    fingerprint: &str,
    client: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), Error> {
    let (state, answer) = Spake::start_b(
        &spake2::Password::new(code.as_bytes()),
        &spake2::Identity::new(PAKE_CLIENT),
        &spake2::Identity::new(fingerprint.as_bytes()),
    );
    let key = state
        .finish(client)
        .map_err(|e| Error::Protocol(format!("a bad SPAKE2 message: {e:?}")))?;
    Ok((answer, key))
}

fn confirmation_message(role: &[u8], fingerprint: &str, thumbprint: &str) -> Vec<u8> {
    [
        role,
        b"\0",
        fingerprint.as_bytes(),
        b"\0",
        thumbprint.as_bytes(),
    ]
    .concat()
}

/// Proof that `role` (`b"client"` or `b"host"`) holds the SPAKE2 `key`, over the certificate
/// `fingerprint` it saw and the client's `DPoP` key `thumbprint`: an HMAC-SHA256.
#[must_use]
pub fn confirmation(key: &[u8], role: &[u8], fingerprint: &str, thumbprint: &str) -> Vec<u8> {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let message = confirmation_message(role, fingerprint, thumbprint);
    ring::hmac::sign(&key, &message).as_ref().to_vec()
}

/// Whether `mac` is [`confirmation`]'s, compared in constant time.
#[must_use]
pub fn confirms(key: &[u8], role: &[u8], fingerprint: &str, thumbprint: &str, mac: &[u8]) -> bool {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let message = confirmation_message(role, fingerprint, thumbprint);
    ring::hmac::verify(&key, &message, mac).is_ok()
}

/// Writes `bytes` to `path` readable only by this user, unless the file exists: then the one
/// there wins, so two processes creating it at once keep the same. Answers with the file's
/// bytes.
fn create_once(path: &Path, bytes: &[u8]) -> io::Result<Vec<u8>> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    // A link fails when the file exists, so the first one written is the one both keep.
    let linked = written.and_then(|()| fs::hard_link(&temporary, path));
    let _ = fs::remove_file(&temporary);
    match linked {
        Ok(()) => Ok(bytes.to_vec()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => fs::read(path),
        Err(error) => Err(error),
    }
}

/// A plxd's self-signed certificate and its key, made when `remote` is first turned on.
pub struct HostKey {
    /// The certificate, in DER.
    pub certificate: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
    /// The certificate's fingerprint, which a paired client pins and which names the host.
    pub fingerprint: String,
}

impl std::fmt::Debug for HostKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostKey")
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

impl HostKey {
    /// The key at `path`: a 4-byte big-endian certificate length, the certificate, then the
    /// PKCS #8 key. Made when there's none.
    ///
    /// # Errors
    ///
    /// If the file can't be read or written, or isn't a key.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let made = rcgen::generate_simple_self_signed(["parallax".to_owned()])
                    .map_err(io::Error::other)?;
                let certificate = made.cert.der();
                let mut bytes = u32::try_from(certificate.len())
                    .map_err(io::Error::other)?
                    .to_be_bytes()
                    .to_vec();
                bytes.extend_from_slice(certificate);
                bytes.extend_from_slice(&made.signing_key.serialize_der());
                create_once(path, &bytes)?
            }
            Err(error) => return Err(error),
        };
        let bad = || io::Error::new(io::ErrorKind::InvalidData, "the remote key file is damaged");
        let (length, rest) = bytes.split_first_chunk::<4>().ok_or_else(bad)?;
        let length = usize::try_from(u32::from_be_bytes(*length)).map_err(|_| bad())?;
        if rest.len() <= length {
            return Err(bad());
        }
        let (certificate, key) = rest.split_at(length);
        Ok(Self {
            fingerprint: fingerprint(certificate),
            certificate: CertificateDer::from(certificate.to_vec()),
            key: PrivatePkcs8KeyDer::from(key.to_vec()),
        })
    }

    /// The TLS server's configuration: this certificate, TLS 1.3 (the only version built), no
    /// client certificates.
    ///
    /// # Errors
    ///
    /// If rustls refuses the key.
    pub fn server_config(&self) -> io::Result<Arc<rustls::ServerConfig>> {
        let config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .and_then(|builder| {
                builder.with_no_client_auth().with_single_cert(
                    vec![self.certificate.clone()],
                    PrivateKeyDer::Pkcs8(self.key.clone_key()),
                )
            })
            .map_err(io::Error::other)?;
        Ok(Arc::new(config))
    }
}

/// Accepts only the certificate with one fingerprint, the one the client paired with. Without
/// one, while pairing, it accepts any and keeps its fingerprint in `seen`, for SPAKE2 to vouch for.
#[derive(Debug)]
struct Pinned {
    fingerprint: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    algorithms: WebPkiSupportedAlgorithms,
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
        let presented = fingerprint(end_entity);
        if self
            .fingerprint
            .as_ref()
            .is_some_and(|pinned| *pinned != presented)
        {
            return Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            ));
        }
        *self.seen.lock().unwrap_or_else(PoisonError::into_inner) = Some(presented);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
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

/// A client's ES256 key for `DPoP` proofs (RFC 9449).
pub struct DpopKey {
    pair: EcdsaKeyPair,
    pkcs8: Vec<u8>,
}

impl DpopKey {
    /// A new random key.
    ///
    /// # Panics
    ///
    /// If the OS has no random numbers.
    #[must_use]
    pub fn generate() -> Self {
        let algorithm = &signature::ECDSA_P256_SHA256_FIXED_SIGNING;
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(algorithm, &SystemRandom::new())
            .expect("the OS's random numbers");
        Self::from_pkcs8(pkcs8.as_ref()).expect("a key ring made")
    }

    /// The key in PKCS #8 `pkcs8`.
    #[must_use]
    pub fn from_pkcs8(pkcs8: &[u8]) -> Option<Self> {
        let algorithm = &signature::ECDSA_P256_SHA256_FIXED_SIGNING;
        let pair = EcdsaKeyPair::from_pkcs8(algorithm, pkcs8, &SystemRandom::new()).ok()?;
        Some(Self {
            pair,
            pkcs8: pkcs8.to_vec(),
        })
    }

    /// The public key's `x` and `y`, in base64url.
    fn coordinates(&self) -> (String, String) {
        // An uncompressed point: 0x04, then 32 bytes of x and 32 of y.
        let point = self.pair.public_key().as_ref();
        (base64url(&point[1..33]), base64url(&point[33..]))
    }

    /// The public key's JWK thumbprint (RFC 7638), which a session is bound to.
    #[must_use]
    pub fn thumbprint(&self) -> String {
        let (x, y) = self.coordinates();
        thumbprint(&x, &y)
    }

    /// A proof for a `method` request to `url`, carrying the hash of `access_token` when given.
    ///
    /// # Panics
    ///
    /// If signing fails, which ring does only without random numbers.
    #[must_use]
    pub fn proof(&self, method: &str, url: &str, access_token: Option<&str>) -> String {
        let (x, y) = self.coordinates();
        let header = json!({
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": { "kty": "EC", "crv": "P-256", "x": x, "y": y },
        });
        let mut claims = json!({
            "htm": method,
            "htu": url,
            "jti": random_token(16),
            "iat": now_seconds(),
        });
        if let Some(token) = access_token {
            claims["ath"] = base64url(&sha256(token.as_bytes())).into();
        }
        let input = format!(
            "{}.{}",
            base64url(header.to_string().as_bytes()),
            base64url(claims.to_string().as_bytes())
        );
        let signature = self
            .pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .expect("signing with the OS's random numbers");
        format!("{input}.{}", base64url(signature.as_ref()))
    }
}

/// The JWK thumbprint of a P-256 key with base64url `x` and `y`: the SHA-256 of its required
/// members in lexical order.
fn thumbprint(x: &str, y: &str) -> String {
    let members = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    base64url(&sha256(members.as_bytes()))
}

/// Seconds since the Unix epoch.
#[must_use]
pub fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// A `DPoP` proof that checked out: its key's thumbprint and its `jti`, for replay checks.
#[derive(Debug, PartialEq, Eq)]
pub struct Proven {
    /// The JWK thumbprint of the proof's key.
    pub thumbprint: String,
    /// The proof's unique id.
    pub jti: String,
}

/// Checks a `DPoP` proof for a `method` request to `url` at `now` (RFC 9449, as T3's
/// `verifyDpopProof`): an ES256 JWT of type `dpop+jwt` signed by the P-256 key in its header,
/// for this method and URL, issued within [`PROOF_WINDOW_SECONDS`], and with `access_token`'s
/// hash when one is given. Replays are the caller's to catch, by `jti`.
///
/// # Errors
///
/// Why it doesn't check out, for the log.
pub fn verify_proof(
    proof: &str,
    method: &str,
    url: &str,
    now: i64,
    access_token: Option<&str>,
) -> Result<Proven, &'static str> {
    #[derive(Deserialize)]
    struct Header {
        typ: String,
        alg: String,
        jwk: Jwk,
    }
    #[derive(Deserialize)]
    struct Jwk {
        kty: String,
        crv: String,
        x: String,
        y: String,
        d: Option<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct Claims {
        htm: String,
        htu: String,
        jti: String,
        iat: i64,
        ath: Option<String>,
    }
    let decode = |part: &str| BASE64URL_NOPAD.decode(part.as_bytes()).ok();
    let mut parts = proof.split('.');
    let (Some(header), Some(claims), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("not a compact JWT");
    };
    let parsed: Header = decode(header)
        .and_then(|h| serde_json::from_slice(&h).ok())
        .ok_or("a bad JWT header")?;
    let claimed: Claims = decode(claims)
        .and_then(|c| serde_json::from_slice(&c).ok())
        .ok_or("bad JWT claims")?;
    let jwk = &parsed.jwk;
    if parsed.typ != "dpop+jwt" || parsed.alg != "ES256" || jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err("not an ES256 DPoP proof");
    }
    if jwk.d.is_some() {
        return Err("a private key in the header");
    }
    if !claimed.htm.eq_ignore_ascii_case(method) || claimed.htu != url {
        return Err("a proof for another request");
    }
    if (claimed.iat - now).abs() > PROOF_WINDOW_SECONDS {
        return Err("a proof outside its time window");
    }
    let expected_ath = access_token.map(|token| base64url(&sha256(token.as_bytes())));
    if claimed.ath != expected_ath {
        return Err("a proof for another access token");
    }
    let (Some(x), Some(y)) = (decode(&jwk.x), decode(&jwk.y)) else {
        return Err("a bad public key");
    };
    if x.len() != 32 || y.len() != 32 || claimed.jti.is_empty() {
        return Err("a bad public key");
    }
    let point = [&[4][..], &x, &y].concat();
    let signature = decode(signature).ok_or("a bad signature")?;
    let input = &proof[..header.len() + 1 + claims.len()];
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
        .verify(input.as_bytes(), &signature)
        .map_err(|_| "a bad signature")?;
    Ok(Proven {
        thumbprint: thumbprint(&jwk.x, &jwk.y),
        jti: claimed.jti,
    })
}

/// Whether `text` is a route: an IP or host name, with a port or not, that no command line can
/// read as an option.
#[must_use]
pub fn is_route(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 253
        && !text.starts_with('-')
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._:[]%".contains(&b))
}

/// A route as `connect` takes it: an address or host name with a port, [`PORT`] unless one is
/// given.
#[must_use]
pub fn with_port(route: &str) -> String {
    if route.parse::<SocketAddr>().is_ok() {
        return route.to_owned();
    }
    if let Ok(ip) = route.trim_matches(['[', ']']).parse::<IpAddr>() {
        return SocketAddr::new(ip, PORT).to_string();
    }
    if route.matches(':').count() == 1 {
        return route.to_owned();
    }
    format!("{route}:{PORT}")
}

/// Whether plxd lets a connection from `ip` in: from a private, link-local, loopback, or
/// carrier-grade NAT address (Tailscale's), never from the internet.
#[must_use]
pub fn is_local_network(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || (a == 100 && b & 0xc0 == 64)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_local_network(IpAddr::V4(v4)),
            None => v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local(),
        },
    }
}

/// What `/.well-known/parallax` answers, before any credential: who the host is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    /// The host's certificate fingerprint.
    pub host_id: String,
    /// The host's name.
    pub name: String,
    /// plxd's version.
    pub plxd: String,
    /// Where the host can be reached, best first.
    pub routes: Vec<String>,
}

/// What `plxd dial --pair` prints: the host the app keeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paired {
    /// The host's certificate fingerprint, which `plxd dial --remote` pins.
    pub fingerprint: String,
    /// The host's name.
    pub name: String,
    /// Where the host can be reached, best first: the route it paired over, then any more it reports.
    pub routes: Vec<String>,
}

/// Why a remote connection failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The network failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The host refused this client: a wrong, used, locked, or expired code, or a revoked session.
    #[error(
        "the computer refused this one: the code is wrong, used, or expired, or this computer isn't paired anymore"
    )]
    Refused,
    /// The host's certificate isn't the pinned one, or a host couldn't vouch for it while pairing.
    #[error("another computer answered at this address")]
    WrongHost,
    /// An answer that isn't what plxd sends.
    #[error("{0}")]
    Protocol(String),
}

/// The token a paired client keeps for a host, with its `DPoP` key.
#[derive(Serialize, Deserialize)]
struct Credential {
    token: String,
    /// The `DPoP` key, PKCS #8 in base64url.
    key: String,
}

/// Where a client keeps its credential for the host with `fingerprint`.
fn credential_path(data_dir: &Path, fingerprint: &str) -> PathBuf {
    data_dir.join("remote-hosts").join(fingerprint)
}

/// A TLS connection to `route` that presents the certificate with fingerprint `pin`, or any
/// certificate without one, and the fingerprint it presented.
async fn open(route: &str, pin: Option<&str>) -> Result<(TlsStream<TcpStream>, String), Error> {
    let provider = provider();
    let seen = Arc::new(Mutex::new(None));
    let verifier = Pinned {
        fingerprint: pin.map(str::to_owned),
        seen: Arc::clone(&seen),
        algorithms: provider.signature_verification_algorithms,
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let tcp = TcpStream::connect(with_port(route)).await?;
    let _ = tcp.set_nodelay(true);
    let name = ServerName::try_from("parallax").expect("a DNS name");
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|error| {
            let pinned = error
                .get_ref()
                .and_then(|inner| inner.downcast_ref::<rustls::Error>())
                .is_some_and(|e| matches!(e, rustls::Error::InvalidCertificate(_)));
            if pinned {
                Error::WrongHost
            } else {
                Error::Io(error)
            }
        })?;
    let presented = seen
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .unwrap_or_default();
    Ok((tls, presented))
}

/// One HTTPS request to `route`, on a connection of its own: its status and body.
async fn request(
    route: &str,
    pin: Option<&str>,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&serde_json::Value>,
) -> Result<(u16, Vec<u8>), Error> {
    let (mut tls, _) = open(route, pin).await?;
    let body = body.map(ToString::to_string).unwrap_or_default();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        with_port(route),
        body.len()
    );
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    head.push_str("\r\n");
    tls.write_all(head.as_bytes()).await?;
    tls.write_all(body.as_bytes()).await?;
    tls.flush().await?;
    let mut answer = Vec::new();
    match tls.read_to_end(&mut answer).await {
        Ok(_) => {}
        // A peer that closes without TLS's close_notify still sent the whole answer.
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
        Err(error) => return Err(error.into()),
    }
    let mut headers = [httparse::EMPTY_HEADER; 16];
    let mut response = httparse::Response::new(&mut headers);
    match response.parse(&answer) {
        Ok(httparse::Status::Complete(length)) => {
            Ok((response.code.unwrap_or(0), answer[length..].to_vec()))
        }
        _ => Err(Error::Protocol(
            "plxd sent an answer that isn't HTTP".to_owned(),
        )),
    }
}

/// The URL a `DPoP` proof names for `path` on `route`.
fn url(route: &str, path: &str) -> String {
    format!("https://{}{path}", with_port(route))
}

fn json<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Error> {
    serde_json::from_slice(body).map_err(|e| Error::Protocol(format!("plxd sent bad JSON: {e}")))
}

/// Pairs with the host at the first of `routes` that answers, in order, using the `code` it shows,
/// as `name`: runs SPAKE2 over TLS to the certificate it presents, confirms both sides hold the
/// key over that certificate's fingerprint, and keeps the session token and a new `DPoP` key in
/// `data_dir` for it. The answer's routes start with the one that answered.
///
/// # Errors
///
/// [`Error::Refused`] for a wrong, used, locked, or expired code, [`Error::WrongHost`] when the
/// host can't vouch for its certificate, and the last route's error when none answered.
pub async fn pair(
    routes: &[String],
    code: &str,
    name: &str,
    data_dir: &Path,
) -> Result<Paired, Error> {
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let attempt = tokio::time::timeout(REQUEST_TIMEOUT, pair_at(route, code, name, data_dir));
        match attempt.await {
            Ok(Ok(mut paired)) => {
                let mut all = vec![route.clone()];
                all.extend(
                    paired
                        .routes
                        .drain(..)
                        .filter(|r| r != route && is_route(r)),
                );
                paired.routes = all;
                return Ok(paired);
            }
            Ok(Err(error @ (Error::Refused | Error::WrongHost))) => return Err(error),
            Ok(Err(error)) => last = error,
            Err(_) => last = timed_out(route),
        }
    }
    Err(last)
}

fn timed_out(route: &str) -> Error {
    Error::Io(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("{route} didn't answer within {REQUEST_TIMEOUT:?}"),
    ))
}

/// The base64url field `name` of an answer.
fn field(body: &serde_json::Value, name: &str) -> Result<Vec<u8>, Error> {
    body[name]
        .as_str()
        .and_then(|text| BASE64URL_NOPAD.decode(text.as_bytes()).ok())
        .ok_or_else(|| Error::Protocol(format!("plxd's answer has no {name}")))
}

/// One POST of a pairing step, pinned to the certificate the first connection saw.
async fn pairing_step(
    route: &str,
    fp: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let (status, answer) = request(route, Some(fp), "POST", path, headers, Some(body)).await?;
    match status {
        200 => json(&answer),
        401 => Err(Error::Refused),
        _ => Err(Error::Protocol(format!("{path} answered {status}"))),
    }
}

async fn pair_at(route: &str, code: &str, name: &str, data_dir: &Path) -> Result<Paired, Error> {
    // The first connection learns which certificate answers; the later ones must present it.
    let (_, fp) = open(route, None).await?;
    let (state, first) = pake_client(code, &fp);
    let start = json!({ "pake": base64url(&first) });
    let started = pairing_step(route, &fp, "/api/pair/start", &[], &start).await?;
    let shared = state
        .finish(&field(&started, "pake")?)
        .map_err(|e| Error::Protocol(format!("a bad SPAKE2 answer: {e:?}")))?;

    let key = DpopKey::generate();
    let thumbprint = key.thumbprint();
    let path = "/api/pair/finish";
    let proof = key.proof("POST", &url(route, path), None);
    let finish = json!({
        "pairing": started["pairing"],
        "confirm": base64url(&confirmation(&shared, b"client", &fp, &thumbprint)),
        "clientLabel": name,
    });
    let finished = pairing_step(route, &fp, path, &[("DPoP", proof.as_str())], &finish).await?;
    // Only a host that knows the code can vouch for the certificate this client saw.
    if !confirms(
        &shared,
        b"host",
        &fp,
        &thumbprint,
        &field(&finished, "confirm")?,
    ) {
        return Err(Error::WrongHost);
    }
    let Some(token) = finished["accessToken"].as_str() else {
        return Err(Error::Protocol(format!("{path} answered without a token")));
    };
    let credential = Credential {
        token: token.to_owned(),
        key: base64url(&key.pkcs8),
    };
    let file = credential_path(data_dir, &fp);
    // A new pairing replaces the old credential.
    let _ = fs::remove_file(&file);
    create_once(&file, &serde_json::to_vec(&credential).expect("plain JSON"))?;
    let routes = finished["routes"]
        .as_array()
        .map(|routes| {
            routes
                .iter()
                .filter_map(|r| r.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(Paired {
        fingerprint: fp,
        name: finished["name"].as_str().unwrap_or_default().to_owned(),
        routes,
    })
}

/// Forgets the credential for the host with `fingerprint`, when this computer removes it.
///
/// # Errors
///
/// When the file exists and can't be removed.
pub fn forget(data_dir: &Path, fingerprint: &str) -> io::Result<()> {
    match fs::remove_file(credential_path(data_dir, fingerprint)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// A host found over mDNS: its name and where it listens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Found {
    /// The host's name, as it advertises it.
    pub name: String,
    /// Its local-network IPv4 addresses, each with its port.
    pub routes: Vec<String>,
}

/// The hosts waiting for a pairing on this network, from `wait` of listening for their mDNS
/// advertisements, by name.
///
/// # Errors
///
/// When mDNS can't start, such as without a network.
pub fn discover(wait: Duration) -> Result<Vec<Found>, Error> {
    let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| Error::Protocol(e.to_string()))?;
    let events = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| Error::Protocol(e.to_string()))?;
    let deadline = std::time::Instant::now() + wait;
    let mut found: Vec<Found> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else {
            break;
        };
        let mdns_sd::ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        let name = service
            .fullname
            .strip_suffix(&format!(".{SERVICE_TYPE}"))
            .unwrap_or(&service.fullname)
            .replace("\\.", ".");
        let mut ips: Vec<IpAddr> = service
            .addresses
            .iter()
            .map(mdns_sd::ScopedIp::to_ip_addr)
            .filter(|ip| ip.is_ipv4() && is_local_network(*ip))
            .collect();
        // Loopback only answers for a host on this same computer, so it goes last.
        ips.sort_by_key(|ip| (ip.is_loopback(), *ip));
        let routes: Vec<String> = ips
            .into_iter()
            .map(|ip| SocketAddr::new(ip, service.port).to_string())
            .collect();
        if routes.is_empty() {
            continue;
        }
        found.retain(|f| f.name != name);
        found.push(Found { name, routes });
    }
    let _ = mdns.shutdown();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// Opens the host with `fingerprint`'s `/ws` over the first of `routes` that presents its
/// certificate, in order. A route that doesn't answer, or where another computer answers, moves
/// on to the next. A refusal stops, since every route reaches the same host.
///
/// # Errors
///
/// [`Error::Refused`] without a credential or with a revoked one, or the last route's error.
pub async fn dial(
    routes: &[String],
    fingerprint: &str,
    data_dir: &Path,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, Error> {
    let credential: Credential = match fs::read(credential_path(data_dir, fingerprint)) {
        Ok(bytes) => json(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(Error::Refused),
        Err(error) => return Err(error.into()),
    };
    let key = BASE64URL_NOPAD
        .decode(credential.key.as_bytes())
        .ok()
        .and_then(|pkcs8| DpopKey::from_pkcs8(&pkcs8))
        .ok_or_else(|| Error::Protocol("the saved DPoP key is damaged".to_owned()))?;
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let attempt = dial_at(route, fingerprint, &credential.token, &key);
        match tokio::time::timeout(REQUEST_TIMEOUT, attempt).await {
            Ok(Ok(socket)) => return Ok(socket),
            Ok(Err(Error::Refused)) => return Err(Error::Refused),
            Ok(Err(error)) => last = error,
            Err(_) => last = timed_out(route),
        }
    }
    Err(last)
}

async fn dial_at(
    route: &str,
    fingerprint: &str,
    token: &str,
    key: &DpopKey,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, Error> {
    let path = "/api/auth/websocket-ticket";
    let proof = key.proof("POST", &url(route, path), Some(token));
    let authorization = format!("DPoP {token}");
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", proof.as_str()),
    ];
    let (status, body) = request(route, Some(fingerprint), "POST", path, &headers, None).await?;
    if status == 401 {
        return Err(Error::Refused);
    }
    if status != 200 {
        return Err(Error::Protocol(format!("{path} answered {status}")));
    }
    let ticket: serde_json::Value = json(&body)?;
    let Some(ticket) = ticket["ticket"].as_str() else {
        return Err(Error::Protocol(format!("{path} answered without a ticket")));
    };
    let (tls, _) = open(route, Some(fingerprint)).await?;
    let address = format!("wss://{}/ws?wsTicket={}", with_port(route), ticket);
    let (socket, _) =
        tokio_tungstenite::client_async_with_config(address, tls, Some(websocket_config()))
            .await
            .map_err(|e| match e {
                tokio_tungstenite::tungstenite::Error::Http(response)
                    if response.status() == 401 =>
                {
                    Error::Refused
                }
                other => Error::Protocol(format!("the WebSocket failed: {other}")),
            })?;
    Ok(socket)
}

/// Joins `socket` to `plxd dial`'s stdio: each line of `input` goes as a text frame, and each
/// frame comes out as a line. The end of `input` closes the socket; it's over when the host
/// closes it.
///
/// # Errors
///
/// The streams' errors.
pub async fn bridge<S, I, O>(socket: WebSocketStream<S>, input: I, mut output: O) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (mut sink, mut frames) = socket.split();
    let outgoing = async {
        let mut lines = tokio::io::BufReader::new(input).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            sink.send(Message::text(line))
                .await
                .map_err(io::Error::other)?;
        }
        let _ = sink.close().await;
        Ok::<_, io::Error>(())
    };
    let incoming = async {
        while let Some(frame) = frames.next().await {
            match frame.map_err(io::Error::other)? {
                Message::Text(text) => {
                    output.write_all(text.as_bytes()).await?;
                    output.write_all(b"\n").await?;
                    output.flush().await?;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<_, io::Error>(())
    };
    tokio::pin!(outgoing, incoming);
    let mut sending = true;
    loop {
        tokio::select! {
            done = &mut incoming => return done,
            done = &mut outgoing, if sending => {
                sending = false;
                done?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_the_alphabet_and_read_in_two_halves() {
        let code = new_code();
        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        assert_ne!(code, new_code());
        assert_eq!(format_code("7KQ4M2"), "7KQ-4M2");
        assert_eq!(normalize_code(" 7kq-4m2 "), "7KQ4M2");
    }

    #[test]
    fn spake2_agrees_only_on_the_same_code_and_certificate() {
        let fp = "ab".repeat(32);
        let run = |client_code: &str, client_fp: &str| {
            let (state, first) = pake_client(client_code, client_fp);
            let (answer, host_key) = pake_host("7KQ4M2", &fp, &first).unwrap();
            let client_key = state.finish(&answer).unwrap();
            let from_client = confirmation(&client_key, b"client", client_fp, "thumb");
            let from_host = confirmation(&host_key, b"host", &fp, "thumb");
            (
                confirms(&host_key, b"client", &fp, "thumb", &from_client),
                confirms(&client_key, b"host", client_fp, "thumb", &from_host),
            )
        };
        assert_eq!(run("7kq-4m2", &fp), (true, true));
        assert_eq!(run("7KQ4M3", &fp), (false, false), "a wrong code");
        // A machine in the middle shows the client its own certificate.
        let other = "cd".repeat(32);
        assert_eq!(run("7KQ4M2", &other), (false, false), "another certificate");
    }

    #[test]
    fn only_local_network_addresses_are_let_in() {
        for ip in [
            "192.168.1.20",
            "10.0.0.2",
            "172.16.4.1",
            "169.254.1.1",
            "100.87.92.42",
            "127.0.0.1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(is_local_network(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "100.128.0.1",
            "2001:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_local_network(ip.parse().unwrap()), "{ip}");
        }
        assert_eq!(with_port("192.168.1.20"), "192.168.1.20:7341");
        assert_eq!(with_port("fe80::1"), "[fe80::1]:7341");
        assert_eq!(with_port("mac-mini.local:9"), "mac-mini.local:9");
    }

    #[test]
    fn a_dpop_proof_checks_its_request_time_token_and_signature() {
        let key = DpopKey::generate();
        let url = "https://192.168.1.20:7341/api/auth/websocket-ticket";
        let now = now_seconds();
        let proof = key.proof("POST", url, Some("token"));
        let proven = verify_proof(&proof, "POST", url, now, Some("token")).unwrap();
        assert_eq!(proven.thumbprint, key.thumbprint());
        assert_eq!(
            DpopKey::from_pkcs8(&key.pkcs8).unwrap().thumbprint(),
            key.thumbprint()
        );

        assert!(verify_proof(&proof, "GET", url, now, Some("token")).is_err());
        assert!(
            verify_proof(
                &proof,
                "POST",
                "https://elsewhere:7341/x",
                now,
                Some("token")
            )
            .is_err()
        );
        assert!(verify_proof(&proof, "POST", url, now, Some("another")).is_err());
        assert!(verify_proof(&proof, "POST", url, now, None).is_err());
        assert!(verify_proof(&proof, "POST", url, now + 301, Some("token")).is_err());
        // Another key's signature over the same header and claims.
        let other = DpopKey::generate().proof("POST", url, Some("token"));
        let forged = format!(
            "{}.{}",
            &proof[..proof.rfind('.').unwrap()],
            &other[other.rfind('.').unwrap() + 1..]
        );
        assert_eq!(
            verify_proof(&forged, "POST", url, now, Some("token")),
            Err("a bad signature")
        );
    }

    #[test]
    fn a_host_key_is_made_once_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-key");
        let made = HostKey::load_or_create(&path).unwrap();
        assert_eq!(made.fingerprint.len(), 64);
        let again = HostKey::load_or_create(&path).unwrap();
        assert_eq!(again.fingerprint, made.fingerprint);
        again.server_config().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let bits = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(bits & 0o777, 0o600);
        }
    }
}
