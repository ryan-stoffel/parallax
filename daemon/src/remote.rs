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
//! - A paired client opens `/ws`, which carries 0007's JSON-RPC, one message per frame, with the
//!   token and a `DPoP` proof on the upgrade itself (0091). A host from before 0091 refuses that,
//!   and the client then gets a 30 s ticket at `/api/auth/websocket-ticket` and opens `/ws` with it.
//!
//! - An `account:` host (0091) is pinned by its relay id, the JWK thumbprint of its certificate's
//!   key ([`Pin::HostId`]). This computer signs in to it with a Clerk token ([`sign_in`]) and one
//!   [`device_key`] for every such host, which the host approves once ([`await_approval`]), or
//!   pairs with its setup code ([`pair_account`]).
//!
//! [`dial`] races a host's routes ([`race`], 0091): the direct ones (LAN, Tailscale) at once, the
//! relay [`RELAY_HEAD_START`] later, and only the first to present the pinned certificate gets the
//! credential. [`bridge`] joins the WebSocket to `plxd dial`'s stdio. Its credential stays in its
//! data folder, readable only by this user.

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

/// A route through Parallax Relay starts with this, then the host's relay id (PLX-652).
pub const RELAY_ROUTE: &str = "relay:";

/// The mDNS service a host advertises while it waits for a pairing.
pub const SERVICE_TYPE: &str = "_parallax._tcp.local.";

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

pub(crate) fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// `bytes` in base64url without padding, as JWTs and `DPoP` use.
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    BASE64URL_NOPAD.encode(bytes)
}

/// The bytes of base64url `text`, without padding, if it is that.
#[must_use]
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    BASE64URL_NOPAD.decode(text.as_bytes()).ok()
}

/// `bytes` in lowercase hex.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
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

/// How many digits a new computer's setup code and a new device's approval code have (0091).
pub const DIGITS: usize = 6;

/// `DIGITS` decimal digits from the first 8 bytes of `bytes`. A u64 modulo a million is uniform
/// to within one part in 10^13.
fn digits(bytes: &[u8]) -> String {
    let mut first = [0; 8];
    first.copy_from_slice(&bytes[..8]);
    format!("{:06}", u64::from_be_bytes(first) % 1_000_000)
}

/// A new computer's setup code (0091): [`DIGITS`] random digits, which a signed-in client types to
/// run SPAKE2 pairing with it.
///
/// # Panics
///
/// If the OS has no random numbers.
#[must_use]
pub fn new_setup_code() -> String {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("the OS's random numbers");
    digits(&bytes)
}

/// How many random bytes each side of a new device's request contributes to its code.
pub const APPROVAL_VALUE_BYTES: usize = 32;

/// A new device's request starts with the host committing to its random value: this hash of it,
/// in base64url. The host reveals the value only after the client sent its own, so neither side
/// picks its value after seeing the other's (0091).
#[must_use]
pub fn approval_commitment(host_value: &[u8]) -> String {
    base64url(&sha256(
        &[b"parallax-approval-commit\0".as_slice(), host_value].concat(),
    ))
}

/// The 6 digits both ends of a new device's request show: a hash of both random values, the host's
/// relay id, and the client's `DPoP` key thumbprint. The values have a fixed length, so the parts
/// can't run into each other.
#[must_use]
pub fn approval_code(
    host_value: &[u8],
    client_value: &[u8],
    host_id: &str,
    thumbprint: &str,
) -> String {
    let hash = sha256(
        &[
            b"parallax-approval-code\0".as_slice(),
            host_value,
            client_value,
            host_id.as_bytes(),
            b"\0",
            thumbprint.as_bytes(),
        ]
        .concat(),
    );
    digits(&hash)
}

/// Whether `text` looks like a host's relay id: a JWK thumbprint, 43 characters of base64url.
#[must_use]
pub fn is_host_id(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What a P-256 public key's DER `SubjectPublicKeyInfo` starts with, before its point's x and y.
const P256_SPKI_PREFIX: &[u8] = &[
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];

/// The JWK thumbprint of a certificate's P-256 key, which is a host's relay id (0068), or `None`
/// for a certificate that isn't one or doesn't parse. The key comes from webpki's parse, the same
/// one TLS checks the handshake's signature with, so it is the key the host proves it holds.
#[must_use]
pub fn key_id(certificate: &[u8]) -> Option<String> {
    let der = CertificateDer::from(certificate);
    let parsed = webpki::EndEntityCert::try_from(&der).ok()?;
    let spki = parsed.subject_public_key_info();
    let point = spki.as_ref().strip_prefix(P256_SPKI_PREFIX)?;
    if point.len() != 64 {
        return None;
    }
    Some(thumbprint(
        &base64url(&point[..32]),
        &base64url(&point[32..]),
    ))
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
    // Unique per call, since two threads of one plxd may create the key at once (PLX-652).
    let unique = format!("tmp-{}-{}", std::process::id(), random_token(6));
    let temporary = path.with_extension(unique);
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

    /// The certificate's key as a signer, which is this host's identity on Parallax Relay
    /// (PLX-652). `None` if it isn't a P-256 key, which every plxd makes.
    #[must_use]
    pub fn signer(&self) -> Option<DpopKey> {
        DpopKey::from_pkcs8(self.key.secret_pkcs8_der())
    }

    /// This host's relay id: its key's JWK thumbprint, which an `account:` client pins (0091).
    /// Empty if it isn't a P-256 key.
    #[must_use]
    pub fn host_id(&self) -> String {
        self.signer()
            .map(|key| key.thumbprint())
            .unwrap_or_default()
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

/// Which certificate a connection accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pin {
    /// Any, while pairing with a code, for SPAKE2 to vouch for.
    Any,
    /// Only the one with this SHA-256 fingerprint, which the client paired with (0065).
    Fingerprint(String),
    /// Only one whose key's JWK thumbprint is this relay id: an `account:` host (0091). The relay
    /// can't present another key for an id, so it can't stand in for the host.
    HostId(String),
}

impl Pin {
    fn accepts(&self, certificate: &[u8], presented: &str) -> bool {
        match self {
            Self::Any => true,
            Self::Fingerprint(pinned) => pinned == presented,
            Self::HostId(id) => key_id(certificate).is_some_and(|key| key == *id),
        }
    }
}

/// Accepts only the certificate its [`Pin`] names, and keeps the fingerprint of the one presented
/// in `seen`, for SPAKE2 to vouch for while pairing.
#[derive(Debug)]
struct Pinned {
    pin: Pin,
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
        if !self.pin.accepts(end_entity, &presented) {
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
    pub(crate) fn coordinates(&self) -> (String, String) {
        // An uncompressed point: 0x04, then 32 bytes of x and 32 of y.
        let point = self.pair.public_key().as_ref();
        (base64url(&point[1..33]), base64url(&point[33..]))
    }

    /// An ES256 signature of `message`: `r` then `s`, 32 bytes each.
    ///
    /// # Panics
    ///
    /// If signing fails, which ring does only without random numbers.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.pair
            .sign(&SystemRandom::new(), message)
            .expect("signing with the OS's random numbers")
            .as_ref()
            .to_vec()
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
        format!("{input}.{}", base64url(&self.sign(input.as_bytes())))
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

/// Whether `text` is a route: an IP or host name, with a port or not, or `relay:<hostId>`
/// (PLX-652), that no command line can read as an option.
#[must_use]
pub fn is_route(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 253
        && !text.starts_with('-')
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:[]%".contains(&b))
}

/// A route as `connect` takes it: an address or host name with a port, [`PORT`] unless one is
/// given.
#[must_use]
pub fn with_port(route: &str) -> String {
    // A relay route's TLS and HTTP run inside the relay's stream, where this name is only what
    // the `Host` header and `DPoP` proofs carry. It connects to nothing.
    if let Some(host_id) = route.strip_prefix(RELAY_ROUTE) {
        return format!("{host_id}.relay");
    }
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
    /// Parallax Relay refused plxd's signed time as too far from its own clock, which it sent,
    /// in milliseconds since the epoch (PLX-652).
    #[error("this computer's clock is too far off the relay's; set it to the right time")]
    Clock(i64),
}

/// The token a paired client keeps for a host, with its `DPoP` key.
#[derive(Serialize, Deserialize)]
struct Credential {
    token: String,
    /// The `DPoP` key, PKCS #8 in base64url.
    key: String,
}

/// Where a client keeps its credential for the host with `fingerprint`, or with relay id
/// `fingerprint` for an `account:` host.
fn credential_path(data_dir: &Path, fingerprint: &str) -> PathBuf {
    data_dir.join("remote-hosts").join(fingerprint)
}

/// Saves `token` for the host `name`d so, with `key`, replacing any earlier credential.
fn save_credential(data_dir: &Path, name: &str, token: &str, key: &DpopKey) -> Result<(), Error> {
    let credential = Credential {
        token: token.to_owned(),
        key: base64url(&key.pkcs8),
    };
    let file = credential_path(data_dir, name);
    let _ = fs::remove_file(&file);
    create_once(&file, &serde_json::to_vec(&credential).expect("plain JSON"))?;
    Ok(())
}

/// This computer's own `DPoP` key for `account:` hosts (0091), made the first time. One key for
/// every host, since its thumbprint is what the user's hosts approve and copy between them.
///
/// # Errors
///
/// When the file can't be read or written, or is damaged.
pub fn device_key(data_dir: &Path) -> io::Result<DpopKey> {
    let path = data_dir.join("remote-device-key");
    let pkcs8 = match fs::read(&path) {
        Ok(pkcs8) => pkcs8,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_once(&path, &DpopKey::generate().pkcs8)?
        }
        Err(error) => return Err(error),
    };
    DpopKey::from_pkcs8(&pkcs8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "the device key file is damaged"))
}

/// A TLS connection to `route` that presents the certificate with fingerprint `pin`, or any
/// certificate without one, and the fingerprint it presented.
///
/// # Errors
///
/// [`Error::WrongHost`] when the certificate isn't the pinned one, or the network's error.
pub async fn open(
    route: &str,
    pin: Option<&str>,
) -> Result<(TlsStream<crate::relay::Stream>, String), Error> {
    let pin = pin.map_or(Pin::Any, |fp| Pin::Fingerprint(fp.to_owned()));
    open_pinned(route, &pin).await
}

/// A TLS connection to `route` that presents the certificate `pin` accepts, and the fingerprint
/// it presented.
///
/// # Errors
///
/// [`Error::WrongHost`] when `pin` refuses the certificate, or the network's error.
///
/// # Panics
///
/// Never: `parallax` is a valid server name.
pub async fn open_pinned(
    route: &str,
    pin: &Pin,
) -> Result<(TlsStream<crate::relay::Stream>, String), Error> {
    let provider = provider();
    let seen = Arc::new(Mutex::new(None));
    let verifier = Pinned {
        pin: pin.clone(),
        seen: Arc::clone(&seen),
        algorithms: provider.signature_verification_algorithms,
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let stream: crate::relay::Stream = if let Some(host_id) = route.strip_prefix(RELAY_ROUTE) {
        Box::new(crate::relay::open_stream(host_id).await?)
    } else {
        let tcp = TcpStream::connect(with_port(route)).await?;
        let _ = tcp.set_nodelay(true);
        Box::new(tcp)
    };
    let name = ServerName::try_from("parallax").expect("a DNS name");
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, stream)
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
    pin: &Pin,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&serde_json::Value>,
) -> Result<(u16, Vec<u8>), Error> {
    let (mut tls, _) = open_pinned(route, pin).await?;
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
    pair_routes(routes, code, name, data_dir, None).await
}

/// Pairs with the `account:` host `host_id` with the setup code it shows (0091), as [`pair`] does,
/// except that only a certificate with that key answers, the host approves this computer's
/// [`device_key`], and the session is saved for [`dial_account`].
///
/// # Errors
///
/// As [`pair`]'s, and [`Error::WrongHost`] when another key answers.
pub async fn pair_account(
    routes: &[String],
    host_id: &str,
    code: &str,
    name: &str,
    data_dir: &Path,
) -> Result<Paired, Error> {
    if !is_host_id(host_id) {
        return Err(Error::Protocol(format!("{host_id} isn't a relay id")));
    }
    pair_routes(routes, code, name, data_dir, Some(host_id)).await
}

async fn pair_routes(
    routes: &[String],
    code: &str,
    name: &str,
    data_dir: &Path,
    host_id: Option<&str>,
) -> Result<Paired, Error> {
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let pairing = pair_at(route, code, name, data_dir, host_id);
        let attempt = tokio::time::timeout(REQUEST_TIMEOUT, pairing);
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
    let pin = Pin::Fingerprint(fp.to_owned());
    let (status, answer) = request(route, &pin, "POST", path, headers, Some(body)).await?;
    answered(path, status, &answer)
}

/// The JSON body of a 200 from `path`. A 401 is [`Error::Refused`].
fn answered(path: &str, status: u16, body: &[u8]) -> Result<serde_json::Value, Error> {
    match status {
        200 => json(body),
        401 => Err(Error::Refused),
        _ => Err(Error::Protocol(format!("{path} answered {status}"))),
    }
}

async fn pair_at(
    route: &str,
    code: &str,
    name: &str,
    data_dir: &Path,
    host_id: Option<&str>,
) -> Result<Paired, Error> {
    // The first connection learns which certificate answers, of those an `account:` host's id
    // allows; the later ones must present it.
    let pin = host_id.map_or(Pin::Any, |id| Pin::HostId(id.to_owned()));
    let (_, fp) = open_pinned(route, &pin).await?;
    let (state, first) = pake_client(code, &fp);
    let start = json!({ "pake": base64url(&first) });
    let started = pairing_step(route, &fp, "/api/pair/start", &[], &start).await?;
    let shared = state
        .finish(&field(&started, "pake")?)
        .map_err(|e| Error::Protocol(format!("a bad SPAKE2 answer: {e:?}")))?;

    // An `account:` host approves this computer's own key, which its other hosts then share.
    let key = match host_id {
        Some(_) => device_key(data_dir)?,
        None => DpopKey::generate(),
    };
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
    // A new pairing replaces the old credential.
    save_credential(data_dir, host_id.unwrap_or(&fp), token, &key)?;
    Ok(Paired {
        fingerprint: fp,
        name: finished["name"].as_str().unwrap_or_default().to_owned(),
        routes: listed_routes(&finished),
    })
}

/// The routes an answer lists.
fn listed_routes(body: &serde_json::Value) -> Vec<String> {
    body["routes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(str::to_owned))
        .collect()
}

/// Where an account sign-in stands (0091).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SignIn {
    /// This computer's key is approved and its session saved, so [`dial_account`] reaches the host.
    Approved {
        /// The host's name.
        name: String,
        /// Where the host can be reached, best first: the route that answered, then the rest.
        routes: Vec<String>,
    },
    /// A request waits for one of the user's approved devices, which shows the same `code`.
    Pending {
        /// The request's id, for [`await_approval`].
        request: String,
        /// Its 6 digits.
        code: String,
    },
}

/// How long the host holds a call to `/api/auth/approval` with `wait` before it answers that the
/// request still waits.
pub const APPROVAL_WAIT: Duration = Duration::from_secs(25);

/// How long a new device's request waits for approval before it lapses (0091).
pub const REQUEST_LIFETIME: Duration = Duration::from_mins(10);

/// At most this many new requests a client starts with one host an hour (0091), since a fake
/// host sets no limit of its own.
pub const MAX_CLIENT_REQUESTS: usize = 5;

/// The random value a client sent for a request, kept while the request can wait, so a reconnect
/// sends the same one and a host that then answers with another commitment fails (0091).
#[derive(Serialize, Deserialize)]
struct Committed {
    request: String,
    commitment: String,
    /// The value, in base64url.
    value: String,
    /// When the request lapses, in seconds since the epoch.
    until: i64,
}

fn committed_path(data_dir: &Path, host_id: &str) -> PathBuf {
    credential_path(data_dir, &format!("{host_id}.request"))
}

/// Where a client keeps when it started requests with `host_id` within the last hour.
fn requests_path(data_dir: &Path, host_id: &str) -> PathBuf {
    credential_path(data_dir, &format!("{host_id}.requests"))
}

/// This client's value for `request` at `host_id`: the one it kept while its request can wait,
/// else a new one, kept now. While one is kept, any other request id or commitment from that host
/// id fails as [`Error::WrongHost`], so a host that answers each reconnect with a new request gets
/// no new value to try. A new one counts against [`MAX_CLIENT_REQUESTS`] an hour.
fn client_value(
    data_dir: &Path,
    host_id: &str,
    request: &str,
    commitment: &str,
) -> Result<Vec<u8>, Error> {
    let path = committed_path(data_dir, host_id);
    let now = now_seconds();
    let kept = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Committed>(&bytes).ok())
        .filter(|kept| kept.until > now);
    if let Some(kept) = kept {
        if kept.request != request || kept.commitment != commitment {
            return Err(Error::WrongHost);
        }
        return BASE64URL_NOPAD
            .decode(kept.value.as_bytes())
            .map_err(|_| Error::Protocol("the kept request is damaged".to_owned()));
    }
    let counted = requests_path(data_dir, host_id);
    let mut starts: Vec<i64> = fs::read(&counted)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    starts.retain(|at| now - at < 3600);
    if starts.len() >= MAX_CLIENT_REQUESTS {
        return Err(Error::Protocol(
            "this computer asked that one for approval 5 times this hour; try again later"
                .to_owned(),
        ));
    }
    starts.push(now);
    let _ = fs::remove_file(&counted);
    create_once(&counted, &serde_json::to_vec(&starts).expect("plain JSON"))?;
    let mut value = vec![0; APPROVAL_VALUE_BYTES];
    getrandom::fill(&mut value).map_err(|e| Error::Protocol(e.to_string()))?;
    let committed = Committed {
        request: request.to_owned(),
        commitment: commitment.to_owned(),
        value: base64url(&value),
        until: now_seconds() + i64::try_from(REQUEST_LIFETIME.as_secs()).unwrap_or(i64::MAX),
    };
    let _ = fs::remove_file(&path);
    create_once(&path, &serde_json::to_vec(&committed).expect("plain JSON"))?;
    Ok(value)
}

/// Signs in to the `account:` host `host_id` at the first of `routes` that answers, with a fresh
/// Clerk `token` (0091), as `name`. An approved [`device_key`] gets a session, saved for
/// [`dial_account`]. Any other starts a request, or finds the one waiting, and both ends then show
/// its code. Answers with the route that answered.
///
/// # Errors
///
/// [`Error::Refused`] when the host refuses the token or this computer's key, or its request
/// limit is reached, [`Error::WrongHost`] when another key answers or the host's value doesn't
/// match its commitment, and the last route's error when none answered.
pub async fn sign_in(
    routes: &[String],
    host_id: &str,
    token: &str,
    name: &str,
    data_dir: &Path,
) -> Result<(String, SignIn), Error> {
    if !is_host_id(host_id) {
        return Err(Error::Protocol(format!("{host_id} isn't a relay id")));
    }
    let key = device_key(data_dir)?;
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let attempt = sign_in_at(route, host_id, token, name, data_dir, &key);
        match tokio::time::timeout(REQUEST_TIMEOUT, attempt).await {
            Ok(Ok(signed_in)) => return Ok((route.clone(), signed_in)),
            Ok(Err(error @ (Error::Refused | Error::WrongHost))) => return Err(error),
            Ok(Err(error)) => last = error,
            Err(_) => last = timed_out(route),
        }
    }
    Err(last)
}

async fn sign_in_at(
    route: &str,
    host_id: &str,
    token: &str,
    name: &str,
    data_dir: &Path,
    key: &DpopKey,
) -> Result<SignIn, Error> {
    let pin = Pin::HostId(host_id.to_owned());
    let path = "/api/auth/account";
    let proof = key.proof("POST", &url(route, path), Some(token));
    let body = json!({ "token": token, "clientLabel": name });
    let headers = [("DPoP", proof.as_str())];
    let (status, answer) = request(route, &pin, "POST", path, &headers, Some(&body)).await?;
    let answer: serde_json::Value = match status {
        200 => return approved(route, host_id, key, data_dir, &json(&answer)?),
        202 => json(&answer)?,
        401 | 403 | 429 => return Err(Error::Refused),
        _ => return Err(Error::Protocol(format!("{path} answered {status}"))),
    };
    let (Some(request_id), Some(commitment)) =
        (answer["request"].as_str(), answer["commitment"].as_str())
    else {
        return Err(Error::Protocol(format!(
            "{path} answered without a request"
        )));
    };
    let value = client_value(data_dir, host_id, request_id, commitment)?;
    let step = json!({ "request": request_id, "value": base64url(&value) });
    let (status, answer) = approval_step(route, &pin, key, &step).await?;
    if status == 200 {
        return approved(route, host_id, key, data_dir, &answer);
    }
    // Only now does the host show its value, which must be the one it committed to.
    let host_value = field(&answer, "value")?;
    if approval_commitment(&host_value) != commitment {
        return Err(Error::WrongHost);
    }
    Ok(SignIn::Pending {
        request: request_id.to_owned(),
        code: approval_code(&host_value, &value, host_id, &key.thumbprint()),
    })
}

/// One call to `/api/auth/approval` with `body`: 200 with a session, or 202 while it waits.
async fn approval_step(
    route: &str,
    pin: &Pin,
    key: &DpopKey,
    body: &serde_json::Value,
) -> Result<(u16, serde_json::Value), Error> {
    let path = "/api/auth/approval";
    let proof = key.proof("POST", &url(route, path), None);
    let headers = [("DPoP", proof.as_str())];
    let (status, answer) = request(route, pin, "POST", path, &headers, Some(body)).await?;
    match status {
        200 | 202 => Ok((status, json(&answer)?)),
        401 | 403 => Err(Error::Refused),
        _ => Err(Error::Protocol(format!("{path} answered {status}"))),
    }
}

/// Saves the session in a sign-in's answer and forgets the request's value.
fn approved(
    route: &str,
    host_id: &str,
    key: &DpopKey,
    data_dir: &Path,
    body: &serde_json::Value,
) -> Result<SignIn, Error> {
    let Some(token) = body["accessToken"].as_str() else {
        return Err(Error::Protocol("a session without a token".to_owned()));
    };
    save_credential(data_dir, host_id, token, key)?;
    let _ = fs::remove_file(committed_path(data_dir, host_id));
    let mut routes = vec![route.to_owned()];
    routes.extend(
        listed_routes(body)
            .into_iter()
            .filter(|r| r != route && is_route(r)),
    );
    Ok(SignIn::Approved {
        name: body["name"].as_str().unwrap_or_default().to_owned(),
        routes,
    })
}

/// Waits at `route` until one of the user's devices approves `request` at the `account:` host
/// `host_id`, then saves the session, as [`sign_in`] does.
///
/// # Errors
///
/// [`Error::Refused`] when the request is denied or lapses, or the network's error.
pub async fn await_approval(
    route: &str,
    host_id: &str,
    request: &str,
    data_dir: &Path,
) -> Result<SignIn, Error> {
    let key = device_key(data_dir)?;
    let pin = Pin::HostId(host_id.to_owned());
    let body = json!({ "request": request, "wait": true });
    loop {
        let step = approval_step(route, &pin, &key, &body);
        let answered = tokio::time::timeout(APPROVAL_WAIT + REQUEST_TIMEOUT, step)
            .await
            .map_err(|_| timed_out(route))?;
        // Denied or lapsed: the user may ask again, which starts a new request, counted.
        if let Err(Error::Refused) = answered {
            let _ = fs::remove_file(committed_path(data_dir, host_id));
        }
        let (status, answer) = answered?;
        if status == 200 {
            return approved(route, host_id, &key, data_dir, &answer);
        }
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

/// How long `relay:` routes wait for a direct route to answer before they start too (0091).
pub const RELAY_HEAD_START: Duration = Duration::from_millis(200);

/// A TLS connection to a host's pinned certificate: the route it went over, the stream, and the
/// certificate's fingerprint.
pub type Opened = (String, TlsStream<crate::relay::Stream>, String);

/// Opens TLS to the first of `routes` that presents a certificate `pin` accepts (0091): the direct
/// ones (LAN, Tailscale) at once, `relay:` ones [`RELAY_HEAD_START`] later, or as soon as every
/// direct one failed. Nothing is sent over any of them before its certificate checks out, and the
/// others are dropped once one does.
///
/// # Errors
///
/// The last route's error when none answered with the pinned certificate.
pub async fn race(routes: &[String], pin: &Pin) -> Result<Opened, Error> {
    let opened = first(
        routes,
        |route| async move { open_pinned(&route, pin).await },
    )
    .await?;
    let (route, (tls, fingerprint)) = opened;
    Ok((route, tls, fingerprint))
}

/// The first of `routes` that `open` opens, in [`race`]'s order, with the route.
async fn first<T, F, Opening>(routes: &[String], open: F) -> Result<(String, T), Error>
where
    F: Fn(String) -> Opening,
    Opening: Future<Output = Result<T, Error>>,
{
    use futures_util::stream::FuturesUnordered;
    let attempt = |route: String| {
        let opening = open(route.clone());
        async move {
            let opened = tokio::time::timeout(REQUEST_TIMEOUT, opening).await;
            let opened = opened
                .map_err(|_| timed_out(&route))
                .and_then(|opened| opened);
            (route, opened)
        }
    };
    let (relayed, direct): (Vec<String>, Vec<String>) = routes
        .iter()
        .cloned()
        .partition(|route| route.starts_with(RELAY_ROUTE));
    let mut running: FuturesUnordered<_> = direct.into_iter().map(attempt).collect();
    let head_start = if running.is_empty() {
        Duration::ZERO
    } else {
        RELAY_HEAD_START
    };
    let head_start = tokio::time::sleep(head_start);
    tokio::pin!(head_start);
    let mut later = Some(relayed);
    let mut last = Error::Protocol("no routes".to_owned());
    loop {
        if running.is_empty() {
            match later.take() {
                Some(relayed) if !relayed.is_empty() => {
                    running.extend(relayed.into_iter().map(attempt));
                }
                _ => return Err(last),
            }
        }
        tokio::select! {
            () = &mut head_start, if later.is_some() => {
                running.extend(later.take().unwrap_or_default().into_iter().map(attempt));
            }
            Some((route, opened)) = running.next() => match opened {
                Ok(opened) => return Ok((route, opened)),
                Err(error) => last = error,
            },
        }
    }
}

/// The first of `routes` that presents the certificate `pin` accepts, raced as [`race`] does and
/// sent nothing: what `plxd dial --probe` answers, for the app's re-checks of the direct routes
/// while it's on the relay (0091).
///
/// # Errors
///
/// As [`race`]'s.
pub async fn probe(routes: &[String], pin: &Pin) -> Result<String, Error> {
    race(routes, pin).await.map(|(route, ..)| route)
}

/// A host's `/ws`, opened, and the route it went over.
pub struct Dialed {
    /// The WebSocket.
    pub socket: WebSocketStream<TlsStream<crate::relay::Stream>>,
    /// The route that answered first.
    pub route: String,
}

impl std::fmt::Debug for Dialed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dialed")
            .field("route", &self.route)
            .finish_non_exhaustive()
    }
}

/// Opens the host with `fingerprint`'s `/ws` over the first of `routes` to present its
/// certificate ([`race`]).
///
/// # Errors
///
/// [`Error::Refused`] without a credential or with a revoked one, or the last route's error.
pub async fn dial(routes: &[String], fingerprint: &str, data_dir: &Path) -> Result<Dialed, Error> {
    let pin = Pin::Fingerprint(fingerprint.to_owned());
    dial_pinned(routes, &pin, fingerprint, data_dir).await
}

/// Opens the `account:` host `host_id`'s `/ws` as [`dial`] does, accepting only a certificate
/// whose key's JWK thumbprint is `host_id` (0091), with the session [`sign_in`] or
/// [`pair_account`] saved.
///
/// # Errors
///
/// As [`dial`]'s.
pub async fn dial_account(
    routes: &[String],
    host_id: &str,
    data_dir: &Path,
) -> Result<Dialed, Error> {
    if !is_host_id(host_id) {
        return Err(Error::Protocol(format!("{host_id} isn't a relay id")));
    }
    let pin = Pin::HostId(host_id.to_owned());
    dial_pinned(routes, &pin, host_id, data_dir).await
}

async fn dial_pinned(
    routes: &[String],
    pin: &Pin,
    saved_as: &str,
    data_dir: &Path,
) -> Result<Dialed, Error> {
    let credential: Credential = match fs::read(credential_path(data_dir, saved_as)) {
        Ok(bytes) => json(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(Error::Refused),
        Err(error) => return Err(error.into()),
    };
    let key = BASE64URL_NOPAD
        .decode(credential.key.as_bytes())
        .ok()
        .and_then(|pkcs8| DpopKey::from_pkcs8(&pkcs8))
        .ok_or_else(|| Error::Protocol("the saved DPoP key is damaged".to_owned()))?;
    let (route, tls, _) = race(routes, pin).await?;
    let token = &credential.token;
    let upgraded = tokio::time::timeout(REQUEST_TIMEOUT, upgrade(&route, tls, token, &key));
    let socket = match upgraded.await.map_err(|_| timed_out(&route))? {
        // A host from before 0091 takes only a ticket, and says whether the session still works.
        Err(Error::Refused) => {
            let ticketed = tokio::time::timeout(REQUEST_TIMEOUT, dial_at(&route, pin, token, &key));
            ticketed.await.map_err(|_| timed_out(&route))??
        }
        other => other?,
    };
    Ok(Dialed { socket, route })
}

/// Opens `/ws` over `tls` with the session `token` and a `DPoP` proof on the upgrade (0091).
async fn upgrade(
    route: &str,
    tls: TlsStream<crate::relay::Stream>,
    token: &str,
    key: &DpopKey,
) -> Result<WebSocketStream<TlsStream<crate::relay::Stream>>, Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let bad = |e: &dyn std::fmt::Display| Error::Protocol(format!("the WebSocket failed: {e}"));
    let mut request = format!("wss://{}/ws", with_port(route))
        .into_client_request()
        .map_err(|e| bad(&e))?;
    let proof = key.proof("GET", &url(route, "/ws"), Some(token));
    let headers = request.headers_mut();
    for (name, value) in [("authorization", format!("DPoP {token}")), ("dpop", proof)] {
        headers.insert(name, value.parse().map_err(|_| bad(&"a bad header"))?);
    }
    let config = Some(websocket_config());
    let (socket, _) = tokio_tungstenite::client_async_with_config(request, tls, config)
        .await
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 401 => {
                Error::Refused
            }
            other => bad(&other),
        })?;
    Ok(socket)
}

async fn dial_at(
    route: &str,
    pin: &Pin,
    token: &str,
    key: &DpopKey,
) -> Result<WebSocketStream<TlsStream<crate::relay::Stream>>, Error> {
    let path = "/api/auth/websocket-ticket";
    let proof = key.proof("POST", &url(route, path), Some(token));
    let authorization = format!("DPoP {token}");
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", proof.as_str()),
    ];
    let (status, body) = request(route, pin, "POST", path, &headers, None).await?;
    let ticket = answered(path, status, &body)?;
    let Some(ticket) = ticket["ticket"].as_str() else {
        return Err(Error::Protocol(format!("{path} answered without a ticket")));
    };
    let (tls, _) = open_pinned(route, pin).await?;
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

    /// Races `routes` with each answering `(after ms, ok)` from `answers`, by route, and records
    /// when each started: the winner and the start times.
    async fn race_of(
        answers: &[(&str, u64, bool)],
    ) -> (Result<String, String>, Vec<(String, u64)>) {
        let started = Arc::new(Mutex::new(Vec::new()));
        let t0 = tokio::time::Instant::now();
        let routes: Vec<String> = answers.iter().map(|(r, ..)| (*r).to_owned()).collect();
        let won = first(&routes, |route| {
            let (_, after, ok) = *answers.iter().find(|(r, ..)| *r == route).unwrap();
            let at = u64::try_from(t0.elapsed().as_millis()).unwrap();
            started.lock().unwrap().push((route.clone(), at));
            async move {
                tokio::time::sleep(Duration::from_millis(after)).await;
                if ok {
                    Ok(())
                } else {
                    Err(Error::Protocol(format!("{route} failed")))
                }
            }
        })
        .await;
        let started = started.lock().unwrap().clone();
        (
            won.map(|(route, ())| route).map_err(|e| e.to_string()),
            started,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn direct_routes_start_together_and_the_relay_200_ms_later_unless_they_all_failed() {
        let starts = |list: &[(&str, u64)]| -> Vec<(String, u64)> {
            list.iter().map(|(r, at)| ((*r).to_owned(), *at)).collect()
        };
        // LAN and Tailscale start at once; the relay, which would answer at once, never starts.
        let (won, started) = race_of(&[
            ("192.168.1.5", 50, true),
            ("100.64.0.7", 30, true),
            ("relay:h", 0, true),
        ])
        .await;
        assert_eq!(won.as_deref(), Ok("100.64.0.7"), "the first to answer");
        assert_eq!(started, starts(&[("192.168.1.5", 0), ("100.64.0.7", 0)]));

        // Direct routes that don't answer leave the relay to start at 200 ms and win.
        let (won, started) = race_of(&[("192.168.1.5", 5_000, true), ("relay:h", 40, true)]).await;
        assert_eq!(won.as_deref(), Ok("relay:h"));
        assert_eq!(started, starts(&[("192.168.1.5", 0), ("relay:h", 200)]));

        // Direct routes that all failed start the relay at once.
        let (won, started) = race_of(&[
            ("192.168.1.5", 10, false),
            ("100.64.0.7", 20, false),
            ("relay:h", 0, true),
        ])
        .await;
        assert_eq!(won.as_deref(), Ok("relay:h"));
        assert_eq!(started.last(), Some(&("relay:h".to_owned(), 20)));

        // Nothing answers: the last error.
        let (won, _) = race_of(&[("192.168.1.5", 10, false), ("relay:h", 0, false)]).await;
        assert_eq!(won, Err("relay:h failed".to_owned()));
    }

    #[test]
    fn a_client_keeps_one_value_per_host_while_its_request_waits_and_asks_five_times_an_hour() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("remote-hosts")).unwrap();
        let host = "h".repeat(43);
        let value = client_value(dir.path(), &host, "r1", "c1").unwrap();
        assert_eq!(client_value(dir.path(), &host, "r1", "c1").unwrap(), value);
        // Another commitment, or another request id, from that host id fails while it waits.
        assert!(matches!(
            client_value(dir.path(), &host, "r1", "c2"),
            Err(Error::WrongHost)
        ));
        assert!(matches!(
            client_value(dir.path(), &host, "r2", "c1"),
            Err(Error::WrongHost)
        ));
        assert!(matches!(
            client_value(dir.path(), &host, "r2", "c2"),
            Err(Error::WrongHost)
        ));
        // Once the request ends, new ones start, at most five an hour.
        for i in 1..MAX_CLIENT_REQUESTS {
            fs::remove_file(committed_path(dir.path(), &host)).unwrap();
            client_value(dir.path(), &host, &format!("n{i}"), "c").unwrap();
        }
        fs::remove_file(committed_path(dir.path(), &host)).unwrap();
        assert!(matches!(
            client_value(dir.path(), &host, "n9", "c"),
            Err(Error::Protocol(_))
        ));
        let other = "o".repeat(43);
        assert!(
            client_value(dir.path(), &other, "r1", "c1").is_ok(),
            "per host"
        );
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
}
