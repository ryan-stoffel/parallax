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
//!   When the TLS handshake picks [`EARLY_WS`], the lines already waiting on `plxd dial`'s input
//!   go as frames behind the upgrade request, a round trip sooner (PLX-1483).
//!
//! - An `account:` host (0091) is pinned by its relay id, the JWK thumbprint of its certificate's
//!   key ([`Pin::HostId`]). This computer signs in to it with a Clerk token ([`sign_in`]) and one
//!   [`device_key`] for every such host, which the host approves once ([`await_approval`]), or
//!   pairs with its setup code ([`pair_account`]).
//!
//! [`dial`] races a host's routes ([`race`], 0091): the direct ones (LAN, Tailscale, any the user
//! added) at once and the relay [`RELAY_HEAD_START`] later, or each in the user's order, and only
//! the first to present the pinned certificate gets the credential. [`bridge`] joins the WebSocket
//! to `plxd dial`'s stdio. Its credential stays in its data folder, readable only by this user.

use std::collections::VecDeque;
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

/// `plxd dial --sign-in` exits with this when the host says this computer's key was removed (0091):
/// only [`new_device_key`] gets it back in, and then only once approved.
pub const EXIT_REMOVED: i32 = 6;

/// Why a host refuses a removed key's sign-in, which clients read to offer a new key (0091). Hosts
/// have said just this since 0091, so no version check is needed. It's the host's word, inside the
/// pinned connection, and all it can lead to is the user asking for approval again.
pub const DEVICE_REMOVED: &str = "this device was removed";

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

/// The ALPN protocol of a listener that keeps what a client sends behind a `/ws` upgrade request
/// and gives it to the WebSocket once it accepted the upgrade (PLX-1483). In everything else it
/// is the listener's HTTP/1.1. The host lists it and a client offers it, so the handshake a client
/// makes anyway says what the plxd answering it does: a host from before this picks nothing, and
/// a client then sends nothing before the 101. Nothing is saved, so a host rolled back is never
/// sent what it would drop.
pub const EARLY_WS: &[u8] = b"plxd-early-ws";

/// What the listener lists and `plxd dial` offers, most wanted first. `http/1.1` keeps a
/// handshake working for a client that offers a list without [`EARLY_WS`], such as a browser.
fn alpn_protocols() -> Vec<Vec<u8>> {
    vec![EARLY_WS.to_vec(), b"http/1.1".to_vec()]
}

/// How many bytes of frames go behind an upgrade request. With the request's head, that stays
/// under the 16 KiB of one TLS record, so a host that refuses the upgrade has read all of it and
/// closes cleanly, and the client still reads the refusal.
const MAX_EARLY_FRAMES: usize = 8 * 1024;

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
    /// client certificates, and [`EARLY_WS`] for a client that offers it.
    ///
    /// # Errors
    ///
    /// If rustls refuses the key.
    pub fn server_config(&self) -> io::Result<Arc<rustls::ServerConfig>> {
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .and_then(|builder| {
                builder.with_no_client_auth().with_single_cert(
                    vec![self.certificate.clone()],
                    PrivateKeyDer::Pkcs8(self.key.clone_key()),
                )
            })
            .map_err(io::Error::other)?;
        // No session tickets: plxd's client makes a new config for each connect, so it never
        // resumes. The tickets were a write of their own just before the 101, which a hop on the
        // relay's path that leaves Nagle on held for the client's delayed ACK, 40 ms (PLX-1512).
        config.send_tls13_tickets = 0;
        config.alpn_protocols = alpn_protocols();
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

/// The largest removal statement plxd sends or reads, as the relay caps it (0091).
pub const MAX_REMOVAL_BYTES: usize = 8192;

/// A statement of removed keys, as one host signs it for the account's other hosts (0091). The
/// relay passes it on as an opaque string. Its signer is whoever holds the key in it, so a receiver
/// asks whether it approved that host.
#[derive(Serialize, Deserialize)]
struct RemovalStatement {
    x: String,
    y: String,
    removed: Vec<String>,
    signature: String,
}

/// What a host signs: the keys `removed` are removed on `account`. Tagged so no other signature of
/// the host key reads as one, and with no time, since a removed key stays removed and a replay
/// changes nothing.
fn removal_message(account: &str, removed: &[String]) -> String {
    format!("parallax-access-removed\n{account}\n{}", removed.join("\n"))
}

/// A statement that `key`'s holder removed the keys `removed` on `account`.
#[must_use]
pub fn signed_removal(key: &DpopKey, account: &str, removed: &[String]) -> String {
    let (x, y) = key.coordinates();
    let signature = key.sign(removal_message(account, removed).as_bytes());
    serde_json::to_string(&RemovalStatement {
        x,
        y,
        removed: removed.to_vec(),
        signature: base64url(&signature),
    })
    .unwrap_or_default()
}

/// The host id that signed `statement` for `account`, and the keys it says are removed.
///
/// # Errors
///
/// Why it doesn't check out, for the log.
pub fn open_removal(statement: &str, account: &str) -> Result<(String, Vec<String>), &'static str> {
    if statement.len() > MAX_REMOVAL_BYTES {
        return Err("too long");
    }
    let statement: RemovalStatement =
        serde_json::from_str(statement).map_err(|_| "not a removal statement")?;
    if !statement.removed.iter().all(|key| is_host_id(key)) {
        return Err("not key thumbprints");
    }
    let (Some(x), Some(y), Some(signature)) = (
        base64url_decode(&statement.x),
        base64url_decode(&statement.y),
        base64url_decode(&statement.signature),
    ) else {
        return Err("bad base64url");
    };
    if x.len() != 32 || y.len() != 32 {
        return Err("a bad public key");
    }
    let point = [&[4][..], &x, &y].concat();
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
        .verify(
            removal_message(account, &statement.removed).as_bytes(),
            &signature,
        )
        .map_err(|_| "a bad signature")?;
    Ok((thumbprint(&statement.x, &statement.y), statement.removed))
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
    /// The host says this computer's key was removed, so it refuses that key for good.
    #[error("this computer was removed from your computers; start over with a new key in Settings")]
    Removed,
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

/// The file [`device_key`] keeps its key in.
fn device_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join("remote-device-key")
}

/// This computer's own `DPoP` key for `account:` hosts (0091), made the first time. One key for
/// every host, since its thumbprint is what the user's hosts approve and copy between them.
///
/// # Errors
///
/// When the file can't be read or written, or is damaged.
pub fn device_key(data_dir: &Path) -> io::Result<DpopKey> {
    let path = device_key_path(data_dir);
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

/// Replaces [`device_key`] with a new one, for a computer whose key was removed or made read-only
/// (0091), and deletes what the old one held: each session saved with it and each request's kept
/// value. A session paired on the LAN has a key of its own and stays. Each host's count of requests
/// stays, so starting over doesn't reset the 5 an hour. The new key has no session and no approval.
///
/// # Errors
///
/// When a file can't be read, written, or deleted, or the new key can't be read back.
pub fn new_device_key(data_dir: &Path) -> io::Result<DpopKey> {
    let path = device_key_path(data_dir);
    let old = match fs::read(&path) {
        Ok(pkcs8) => Some(base64url(&pkcs8)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let saved = match fs::read_dir(data_dir.join("remote-hosts")) {
        Ok(saved) => saved.collect::<io::Result<Vec<_>>>()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    for file in saved {
        let file = file.path();
        let holds_old = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Credential>(&bytes).ok())
            .is_some_and(|credential| Some(credential.key) == old);
        if holds_old || file.extension().is_some_and(|ext| ext == "request") {
            fs::remove_file(file)?;
        }
    }
    if old.is_some() {
        fs::remove_file(&path)?;
    }
    let pkcs8 = create_once(&path, &DpopKey::generate().pkcs8)?;
    DpopKey::from_pkcs8(&pkcs8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "the new device key is damaged"))
}

/// The key this host seals a push's title and text with (0100): 32 random bytes in an owner-only
/// file, made the first time. A phone keeps a copy from `relay/pushKey`.
///
/// # Errors
///
/// When the file can't be read or written, or is damaged.
///
/// # Panics
///
/// If the OS has no random numbers.
pub fn push_key(data_dir: &Path) -> io::Result<[u8; 32]> {
    let path = data_dir.join("relay-push-key");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut key = [0; 32];
            getrandom::fill(&mut key).expect("the OS's random numbers");
            create_once(&path, &key)?
        }
        Err(error) => return Err(error),
    };
    <[u8; 32]>::try_from(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the push key file is damaged"))
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
    let stream: crate::relay::Stream = if let Some(host_id) = route.strip_prefix(RELAY_ROUTE) {
        Box::new(crate::relay::open_stream(host_id).await?)
    } else {
        let tcp = TcpStream::connect(with_port(route)).await?;
        let _ = tcp.set_nodelay(true);
        Box::new(tcp)
    };
    tls_over(stream, pin).await
}

/// TLS over `stream` to the certificate `pin` accepts, and the fingerprint it presented.
async fn tls_over(
    stream: crate::relay::Stream,
    pin: &Pin,
) -> Result<(TlsStream<crate::relay::Stream>, String), Error> {
    crate::connect_timing::mark("pinned_tls_start");
    let provider = provider();
    let seen = Arc::new(Mutex::new(None));
    let verifier = Pinned {
        pin: pin.clone(),
        seen: Arc::clone(&seen),
        algorithms: provider.signature_verification_algorithms,
    };
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = alpn_protocols();
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
    crate::connect_timing::mark("pinned_tls_ready");
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
    let (tls, _) = open_pinned(route, pin).await?;
    send(tls, route, None, method, path, headers, body).await
}

/// How long a sign-in's connection may wait for its next step and still carry it. The steps follow
/// each other at once, so a longer gap is a pause for the user. The host waits 2 s for a next
/// request, so this stays under that.
pub const KEEP_IDLE: Duration = Duration::from_secs(1);

/// A pinned connection a sign-in step left open for the next, and since when.
struct Kept {
    route: String,
    pin: Pin,
    since: tokio::time::Instant,
    tls: TlsStream<crate::relay::Stream>,
}

/// The connections sign-in steps left open (PLX-1462): one, as `plxd dial` signs in to one host.
static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());

/// Leaves `tls`, checked against `pin`, open for the next sign-in step to `route`, in place of one
/// left there before, which a new sign-in may have outlived.
fn leave_open(route: &str, pin: &Pin, tls: TlsStream<crate::relay::Stream>) {
    let since = tokio::time::Instant::now();
    let (route, pin) = (route.to_owned(), pin.clone());
    let mut kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    kept.retain(|each| each.route != route || each.pin != pin);
    kept.push(Kept {
        route,
        pin,
        since,
        tls,
    });
}

/// A connection a sign-in step left open to `route` with `pin` within [`KEEP_IDLE`]. Older ones
/// are closed here, so they don't hold a relay stream.
fn kept(route: &str, pin: &Pin) -> Option<TlsStream<crate::relay::Stream>> {
    let mut kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    kept.retain(|each| each.since.elapsed() < KEEP_IDLE);
    let at = kept
        .iter()
        .position(|each| each.route == route && each.pin == *pin)?;
    Some(kept.swap_remove(at).tls)
}

/// A request's connection failed before any of its answer came back, which a kept connection the
/// host already closed does. It keeps the network's error, and says what it says.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct Unanswered(io::Error);

/// [`Unanswered`], as the error a request answers with.
fn unanswered(error: io::Error) -> Error {
    Error::Io(io::Error::other(Unanswered(error)))
}

/// Whether `error` is [`Unanswered`].
fn is_unanswered(error: &Error) -> bool {
    let Error::Io(error) = error else {
        return false;
    };
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Unanswered>())
        .is_some()
}

/// The [`Descriptor`] of the host at the end of `stream`, over TLS to the certificate `pin`
/// accepts: the connection check's proof that a request got there and an answer got back.
pub(crate) async fn read_descriptor(
    stream: crate::relay::Stream,
    pin: &Pin,
) -> Result<Descriptor, Error> {
    let (tls, _) = tls_over(stream, pin).await?;
    let path = "/.well-known/parallax";
    match send(tls, "parallax", None, "GET", path, &[], None).await? {
        (200, body) => json(&body),
        (status, _) => Err(Error::Protocol(format!("plxd answered {status}"))),
    }
}

/// One HTTPS request over `tls`, a connection that presented the pinned certificate. With `keep`,
/// the pin `tls` was checked against, it asks the host to keep the connection, and leaves it for
/// the next sign-in step when the host did and answered 202, which a next step follows.
async fn send(
    mut tls: TlsStream<crate::relay::Stream>,
    route: &str,
    keep: Option<&Pin>,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&serde_json::Value>,
) -> Result<(u16, Vec<u8>), Error> {
    let body = body.map(ToString::to_string).unwrap_or_default();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: {}\r\nContent-Length: {}\r\n",
        with_port(route),
        if keep.is_some() {
            "keep-alive"
        } else {
            "close"
        },
        body.len()
    );
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    head.push_str("\r\n");
    tls.write_all(head.as_bytes()).await.map_err(unanswered)?;
    tls.write_all(body.as_bytes()).await.map_err(unanswered)?;
    tls.flush().await.map_err(unanswered)?;
    let (status, answer, open) = read_answer(&mut tls).await?;
    if let Some(pin) = keep.filter(|_| open && status == 202) {
        leave_open(route, pin, tls);
    }
    Ok((status, answer))
}

/// The status and body of the answer on `tls`, read to its `Content-Length`, or to the end without
/// one, and whether the host keeps the connection open after it. [`Unanswered`] when the connection
/// ended before the answer's first byte.
async fn read_answer(
    tls: &mut TlsStream<crate::relay::Stream>,
) -> Result<(u16, Vec<u8>, bool), Error> {
    let not_http = || Error::Protocol("plxd sent an answer that isn't HTTP".to_owned());
    let mut answer = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let read = match tls.read(&mut chunk).await {
            Ok(read) => read,
            // A peer that closes without TLS's close_notify still sent the whole answer.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => 0,
            Err(error) if answer.is_empty() => return Err(unanswered(error)),
            Err(error) => return Err(error.into()),
        };
        if read == 0 && answer.is_empty() {
            let ended = io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "plxd closed the connection without answering",
            );
            return Err(unanswered(ended));
        }
        answer.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; 16];
        let mut response = httparse::Response::new(&mut headers);
        let length = match response.parse(&answer) {
            Ok(httparse::Status::Complete(length)) => length,
            Ok(httparse::Status::Partial) if read > 0 => continue,
            _ => return Err(not_http()),
        };
        let header = |name: &str| {
            response
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| String::from_utf8_lossy(h.value).into_owned())
        };
        let status = response.code.unwrap_or(0);
        let open = header("connection").is_some_and(|v| v.eq_ignore_ascii_case("keep-alive"));
        match header("content-length").and_then(|v| v.trim().parse::<usize>().ok()) {
            Some(size) if answer.len() >= length + size => {
                return Ok((status, answer[length..length + size].to_vec(), open));
            }
            Some(_) if read == 0 => return Err(not_http()),
            None if read == 0 => return Ok((status, answer[length..].to_vec(), false)),
            _ => {}
        }
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
/// As [`pair`]'s, and [`Error::WrongHost`] when another key answers at the last route it tried.
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
    // The first connection learns which certificate answers, of those an `account:` host's id
    // allows; the later ones must present it.
    let pin = host_id.map_or(Pin::Any, |id| Pin::HostId(id.to_owned()));
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let (tls, fp) = match first_connection(route, &pin).await {
            Ok(opened) => opened,
            Err(error) => {
                last = error;
                continue;
            }
        };
        let pairing = pair_at(tls, fp, route, code, name, data_dir, host_id);
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

/// The connection a sign-in or a pairing starts over at `route`, and the certificate it presented.
/// Failing here, even on a key `pin` refuses, has sent nothing, so the caller moves on to the next
/// route: a stale address the user added mustn't stop it reaching the host another way.
async fn first_connection(
    route: &str,
    pin: &Pin,
) -> Result<(TlsStream<crate::relay::Stream>, String), Error> {
    tokio::time::timeout(REQUEST_TIMEOUT, open_pinned(route, pin))
        .await
        .map_err(|_| timed_out(route))?
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
    tls: TlsStream<crate::relay::Stream>,
    fp: String,
    route: &str,
    code: &str,
    name: &str,
    data_dir: &Path,
    host_id: Option<&str>,
) -> Result<Paired, Error> {
    let (state, first) = pake_client(code, &fp);
    let start = json!({ "pake": base64url(&first) });
    let path = "/api/pair/start";
    let (status, answer) = send(tls, route, None, "POST", path, &[], Some(&start)).await?;
    let started = answered(path, status, &answer)?;
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
    /// The user clicked Allow, and the host waits for its own screen to confirm too.
    Confirm,
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

/// Deletes what this computer keeps for reaching the `account:` host `host_id`: its credential,
/// its waiting request, and its requests this hour. Any being gone already is not an error.
///
/// # Errors
///
/// If a file that's there can't be deleted.
pub fn forget_host(data_dir: &Path, host_id: &str) -> io::Result<()> {
    for path in [
        credential_path(data_dir, host_id),
        committed_path(data_dir, host_id),
        requests_path(data_dir, host_id),
    ] {
        match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
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
/// its code. Answers with the route that answered. With `compare`, for a host nothing vouches for
/// yet, one that answers with a session at once is refused and its session isn't saved, since it
/// showed no code for the user to compare.
///
/// # Errors
///
/// [`Error::Removed`] when the host says this computer's key was removed, [`Error::Refused`] when
/// it refuses the token or the key otherwise, or its request limit is reached, [`Error::WrongHost`]
/// when another key answers at the last route tried or the host's value doesn't match its
/// commitment, and the last route's error when none answered.
pub async fn sign_in(
    routes: &[String],
    host_id: &str,
    token: &str,
    name: &str,
    compare: bool,
    data_dir: &Path,
) -> Result<(String, SignIn), Error> {
    if !is_host_id(host_id) {
        return Err(Error::Protocol(format!("{host_id} isn't a relay id")));
    }
    let key = device_key(data_dir)?;
    let pin = Pin::HostId(host_id.to_owned());
    let mut last = Error::Protocol("no routes".to_owned());
    for route in routes {
        let tls = match first_connection(route, &pin).await {
            Ok((tls, _)) => tls,
            Err(error) => {
                last = error;
                continue;
            }
        };
        let attempt = sign_in_at(tls, route, host_id, token, name, compare, data_dir, &key);
        match tokio::time::timeout(REQUEST_TIMEOUT, attempt).await {
            Ok(Ok(signed_in)) => return Ok((route.clone(), signed_in)),
            Ok(Err(error @ (Error::Refused | Error::Removed | Error::WrongHost))) => {
                return Err(error);
            }
            Ok(Err(error)) => last = error,
            Err(_) => last = timed_out(route),
        }
    }
    Err(last)
}

#[expect(
    clippy::too_many_arguments,
    reason = "one connection and what a sign-in over it needs"
)]
async fn sign_in_at(
    tls: TlsStream<crate::relay::Stream>,
    route: &str,
    host_id: &str,
    token: &str,
    name: &str,
    compare: bool,
    data_dir: &Path,
    key: &DpopKey,
) -> Result<SignIn, Error> {
    let pin = Pin::HostId(host_id.to_owned());
    let path = "/api/auth/account";
    let proof = key.proof("POST", &url(route, path), Some(token));
    let body = json!({ "token": token, "clientLabel": name });
    let headers = [("DPoP", proof.as_str())];
    let (status, answer) =
        send(tls, route, Some(&pin), "POST", path, &headers, Some(&body)).await?;
    let answer: serde_json::Value = match status {
        200 if compare => return Err(Error::Refused),
        200 => return approved(route, host_id, key, data_dir, &json(&answer)?),
        202 => json(&answer)?,
        403 if json::<serde_json::Value>(&answer)
            .is_ok_and(|body| body["error_description"].as_str() == Some(DEVICE_REMOVED)) =>
        {
            return Err(Error::Removed);
        }
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
        if compare {
            return Err(Error::Refused);
        }
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

/// One call to `/api/auth/approval` with `body`: 200 with a session, or 202 while it waits. It goes
/// on the connection the last sign-in step left open when there is one, so a sign-in through the
/// relay takes one stream (PLX-1462). Pinning holds, since a connection is kept with its pin. A kept
/// connection the host already closed gets no answer, and then the call goes once more on a new
/// one, with a new proof. Sending the same step twice is safe.
async fn approval_step(
    route: &str,
    pin: &Pin,
    key: &DpopKey,
    body: &serde_json::Value,
) -> Result<(u16, serde_json::Value), Error> {
    let path = "/api/auth/approval";
    let call = async |tls| {
        let proof = key.proof("POST", &url(route, path), None);
        let headers = [("DPoP", proof.as_str())];
        send(tls, route, Some(pin), "POST", path, &headers, Some(body)).await
    };
    let reused = match kept(route, pin) {
        Some(tls) => match call(tls).await {
            Err(error) if is_unanswered(&error) => None,
            sent => Some(sent?),
        },
        None => None,
    };
    let (status, answer) = match reused {
        Some(answered) => answered,
        None => call(open_pinned(route, pin).await?.0).await?,
    };
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
    // A real host drops a request by then, and a fake one doesn't get to hold this forever.
    let give_up = tokio::time::Instant::now() + REQUEST_LIFETIME + REQUEST_TIMEOUT;
    loop {
        if tokio::time::Instant::now() >= give_up {
            let _ = fs::remove_file(committed_path(data_dir, host_id));
            return Err(Error::Refused);
        }
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

/// Tells the `account:` host `host_id` that the user clicked Allow here on `request` (0091). The
/// device named by the setup command gets its session. Any other gets [`SignIn::Confirm`]: the host
/// takes no client's word alone, and [`await_approval`] waits for its own screen.
///
/// # Errors
///
/// [`Error::Refused`] when the request lapsed or was denied, or the network's error.
pub async fn allow(
    route: &str,
    host_id: &str,
    request: &str,
    data_dir: &Path,
) -> Result<SignIn, Error> {
    let key = device_key(data_dir)?;
    let pin = Pin::HostId(host_id.to_owned());
    let body = json!({ "request": request, "allow": true });
    let (status, answer) = approval_step(route, &pin, &key, &body).await?;
    if status == 200 {
        return approved(route, host_id, &key, data_dir, &answer);
    }
    Ok(SignIn::Confirm)
}

/// Drops this computer's own `request` at the `account:` host `host_id`, as the user clicked Deny,
/// and forgets its value. A host out of reach is not an error: the request lapses there.
pub async fn withdraw(route: &str, host_id: &str, request: &str, data_dir: &Path) {
    let _ = fs::remove_file(committed_path(data_dir, host_id));
    let Ok(key) = device_key(data_dir) else {
        return;
    };
    let pin = Pin::HostId(host_id.to_owned());
    let body = json!({ "request": request, "deny": true });
    let _ = approval_step(route, &pin, &key, &body).await;
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
/// ones (LAN, Tailscale, any the user added) at once, `relay:` ones [`RELAY_HEAD_START`] later, or
/// as soon as every direct one failed. With `in_order`, the user's order: each route starts
/// [`RELAY_HEAD_START`] after the one above it, or as soon as those above it failed. Nothing is sent
/// over any of them before its certificate checks out, and the others are dropped once one does.
///
/// # Errors
///
/// The last route's error when none answered with the pinned certificate.
pub async fn race(routes: &[String], in_order: bool, pin: &Pin) -> Result<Opened, Error> {
    let opened = first(routes, in_order, |route| async move {
        open_pinned(&route, pin).await
    })
    .await?;
    let (route, (tls, fingerprint)) = opened;
    Ok((route, tls, fingerprint))
}

/// The first of `routes` that `open` opens, in [`race`]'s order, with the route.
async fn first<T, F, Opening>(
    routes: &[String],
    in_order: bool,
    open: F,
) -> Result<(String, T), Error>
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
    // The routes that start together, each group after the one before it.
    let mut groups: VecDeque<Vec<String>> = if in_order {
        routes.iter().map(|route| vec![route.clone()]).collect()
    } else {
        let (relayed, direct): (Vec<String>, Vec<String>) = routes
            .iter()
            .cloned()
            .partition(|route| route.starts_with(RELAY_ROUTE));
        [direct, relayed]
            .into_iter()
            .filter(|group| !group.is_empty())
            .collect()
    };
    let mut running = FuturesUnordered::new();
    let head_start = tokio::time::sleep(Duration::ZERO);
    tokio::pin!(head_start);
    let mut last = Error::Protocol("no routes".to_owned());
    loop {
        if running.is_empty() {
            let Some(group) = groups.pop_front() else {
                return Err(last);
            };
            running.extend(group.into_iter().map(&attempt));
            head_start
                .as_mut()
                .reset(tokio::time::Instant::now() + RELAY_HEAD_START);
        }
        tokio::select! {
            () = &mut head_start, if !groups.is_empty() => {
                running.extend(groups.pop_front().into_iter().flatten().map(&attempt));
                head_start
                    .as_mut()
                    .reset(tokio::time::Instant::now() + RELAY_HEAD_START);
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
pub async fn probe(routes: &[String], in_order: bool, pin: &Pin) -> Result<String, Error> {
    race(routes, in_order, pin).await.map(|(route, ..)| route)
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

/// The lines `plxd dial` sends, each one message, read ahead of the connection: the ones already
/// waiting when the upgrade goes out can go behind it (PLX-1483).
#[derive(Debug)]
pub struct Input<I> {
    lines: tokio::io::Lines<tokio::io::BufReader<I>>,
    /// Read and not sent yet, oldest first.
    ahead: VecDeque<String>,
    /// A failed read, for [`Input::next`] to answer with after `ahead`.
    failed: Option<io::Error>,
}

impl<I: AsyncRead + Unpin> Input<I> {
    /// Reads `input`'s lines.
    pub fn new(input: I) -> Self {
        Input {
            lines: tokio::io::BufReader::new(input).lines(),
            ahead: VecDeque::new(),
            failed: None,
        }
    }

    /// Takes the lines that are there now, without waiting, until it holds an upgrade's worth. The
    /// first call starts the read, so a later one finds what came since.
    fn fill(&mut self) {
        use futures_util::FutureExt as _;
        // A line counts its newline, so empty ones reach the limit too.
        let held =
            |ahead: &VecDeque<String>| ahead.iter().map(|line| line.len() + 1).sum::<usize>();
        while self.failed.is_none() && held(&self.ahead) < MAX_EARLY_FRAMES {
            // `next_line` is cancellation safe: a line that isn't whole yet stays in `lines`.
            match self.lines.next_line().now_or_never() {
                Some(Ok(Some(line))) => self.ahead.push_back(line),
                Some(Err(error)) => self.failed = Some(error),
                // Nothing more yet, or the end, which the next read finds again.
                Some(Ok(None)) | None => break,
            }
        }
    }

    /// The lines waiting now as the text frames a client sends, as many from the first as fit
    /// [`MAX_EARLY_FRAMES`], and how many lines that is. They stay here until [`Input::sent`].
    fn early(&mut self) -> (Vec<u8>, usize) {
        self.fill();
        let mut frames = Vec::new();
        let mut lines = 0;
        for line in &self.ahead {
            let mut frame = Vec::new();
            // As `bridge` does, an empty line is no message.
            if !line.trim().is_empty() {
                text_frame(line, &mut frame);
            }
            if frames.len() + frame.len() > MAX_EARLY_FRAMES {
                break;
            }
            frames.append(&mut frame);
            lines += 1;
        }
        (frames, lines)
    }

    /// Forgets the first `lines` lines: they went behind an upgrade the host accepted.
    fn sent(&mut self, lines: usize) {
        self.ahead.drain(..lines);
    }

    /// The next line, or `None` at the end of the input.
    async fn next(&mut self) -> io::Result<Option<String>> {
        if let Some(line) = self.ahead.pop_front() {
            return Ok(Some(line));
        }
        match self.failed.take() {
            Some(error) => Err(error),
            None => self.lines.next_line().await,
        }
    }
}

/// Appends `line` to `out` as the masked text frame a WebSocket client sends.
fn text_frame(line: &str, out: &mut Vec<u8>) {
    use tokio_tungstenite::tungstenite::protocol::frame::Frame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
    let mut frame = Frame::message(line.to_owned(), OpCode::Data(Data::Text), true);
    let mut mask = [0; 4];
    getrandom::fill(&mut mask).expect("the OS's random numbers");
    frame.header_mut().mask = Some(mask);
    frame.format(out).expect("a write to memory");
}

/// Opens the host with `fingerprint`'s `/ws` over the first of `routes` to present its
/// certificate ([`race`]).
///
/// # Errors
///
/// [`Error::Refused`] without a credential or with a revoked one, or the last route's error.
pub async fn dial(routes: &[String], fingerprint: &str, data_dir: &Path) -> Result<Dialed, Error> {
    let mut none = Input::new(tokio::io::empty());
    dial_with_input(routes, fingerprint, data_dir, &mut none).await
}

/// [`dial`], and the lines already waiting on `input` go behind the upgrade when the host keeps
/// them ([`EARLY_WS`]), so they wait for no answer. [`bridge`] sends the rest.
///
/// # Errors
///
/// As [`dial`]'s.
pub async fn dial_with_input<I: AsyncRead + Unpin>(
    routes: &[String],
    fingerprint: &str,
    data_dir: &Path,
    input: &mut Input<I>,
) -> Result<Dialed, Error> {
    let pin = Pin::Fingerprint(fingerprint.to_owned());
    dial_pinned(routes, false, &pin, fingerprint, data_dir, input).await
}

/// Opens the `account:` host `host_id`'s `/ws` as [`dial`] does, accepting only a certificate
/// whose key's JWK thumbprint is `host_id` (0091), with the session [`sign_in`] or
/// [`pair_account`] saved. `in_order` is [`race`]'s.
///
/// # Errors
///
/// As [`dial`]'s.
pub async fn dial_account(
    routes: &[String],
    in_order: bool,
    host_id: &str,
    data_dir: &Path,
) -> Result<Dialed, Error> {
    let mut none = Input::new(tokio::io::empty());
    dial_account_with_input(routes, in_order, host_id, data_dir, &mut none).await
}

/// [`dial_account`], with `input` as [`dial_with_input`] takes it.
///
/// # Errors
///
/// As [`dial`]'s.
pub async fn dial_account_with_input<I: AsyncRead + Unpin>(
    routes: &[String],
    in_order: bool,
    host_id: &str,
    data_dir: &Path,
    input: &mut Input<I>,
) -> Result<Dialed, Error> {
    if !is_host_id(host_id) {
        return Err(Error::Protocol(format!("{host_id} isn't a relay id")));
    }
    let pin = Pin::HostId(host_id.to_owned());
    dial_pinned(routes, in_order, &pin, host_id, data_dir, input).await
}

async fn dial_pinned<I: AsyncRead + Unpin>(
    routes: &[String],
    in_order: bool,
    pin: &Pin,
    saved_as: &str,
    data_dir: &Path,
    input: &mut Input<I>,
) -> Result<Dialed, Error> {
    // Starts the read, so what the app wrote as it started `plxd dial` is there by the upgrade.
    input.fill();
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
    let (route, tls, _) = race(routes, in_order, pin).await?;
    let token = &credential.token;
    // Only this handshake's answer says the host keeps them. Any other host drops what it read of
    // them with the request, so it gets none.
    let (early, lines) = if tls.get_ref().1.alpn_protocol() == Some(EARLY_WS) {
        input.early()
    } else {
        (Vec::new(), 0)
    };
    crate::connect_timing::mark("ws_upgrade_start");
    let upgraded = tokio::time::timeout(REQUEST_TIMEOUT, upgrade(&route, tls, token, &key, &early));
    let socket = match upgraded.await.map_err(|_| timed_out(&route))? {
        // A host from before 0091 takes only a ticket, and says whether the session still works.
        // A refused upgrade's frames were dropped unread, so their lines stay in `input`.
        Err(Error::Refused) => {
            let ticketed = tokio::time::timeout(REQUEST_TIMEOUT, dial_at(&route, pin, token, &key));
            ticketed.await.map_err(|_| timed_out(&route))??
        }
        other => {
            let socket = other?;
            input.sent(lines);
            socket
        }
    };
    crate::connect_timing::mark("ws_upgrade_ready");
    Ok(Dialed { socket, route })
}

/// Opens `/ws` over `tls` with the session `token` and a `DPoP` proof on the upgrade (0091).
/// `early` is frames to send behind the request, in the same TLS record, to a host that keeps
/// them ([`EARLY_WS`]): its WebSocket reads them once it accepted the upgrade, and a refusal drops
/// them unread.
async fn upgrade(
    route: &str,
    mut tls: TlsStream<crate::relay::Stream>,
    token: &str,
    key: &DpopKey,
    early: &[u8],
) -> Result<WebSocketStream<TlsStream<crate::relay::Stream>>, Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    use tokio_tungstenite::tungstenite::handshake::client::generate_request;
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    use tokio_tungstenite::tungstenite::protocol::Role;
    let bad = |e: &dyn std::fmt::Display| Error::Protocol(format!("the WebSocket failed: {e}"));
    let mut request = format!("wss://{}/ws", with_port(route))
        .into_client_request()
        .map_err(|e| bad(&e))?;
    let proof = key.proof("GET", &url(route, "/ws"), Some(token));
    let headers = request.headers_mut();
    for (name, value) in [("authorization", format!("DPoP {token}")), ("dpop", proof)] {
        headers.insert(name, value.parse().map_err(|_| bad(&"a bad header"))?);
    }
    let (mut flight, nonce) = generate_request(request).map_err(|e| bad(&e))?;
    let accept = derive_accept_key(nonce.as_bytes());
    flight.extend_from_slice(early);
    tls.write_all(&flight).await?;
    tls.flush().await?;
    let mut answer = Vec::new();
    let mut chunk = [0; 1024];
    let length = loop {
        let read = tls.read(&mut chunk).await?;
        if read == 0 {
            return Err(bad(&"the host closed the connection"));
        }
        answer.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut response = httparse::Response::new(&mut headers);
        match response.parse(&answer) {
            Ok(httparse::Status::Complete(length)) => {
                let accepted = response.headers.iter().any(|header| {
                    header.name.eq_ignore_ascii_case("sec-websocket-accept")
                        && header.value == accept.as_bytes()
                });
                match response.code {
                    Some(101) if accepted => break length,
                    Some(401) => return Err(Error::Refused),
                    Some(101) => return Err(bad(&"a wrong Sec-WebSocket-Accept")),
                    status => return Err(bad(&format!("HTTP error: {}", status.unwrap_or(0)))),
                }
            }
            Ok(httparse::Status::Partial) if answer.len() < 16 * 1024 => {}
            _ => return Err(bad(&"an answer that isn't HTTP")),
        }
    };
    // What came behind the answer is the socket's first frames.
    let rest = answer.split_off(length);
    let config = Some(websocket_config());
    Ok(WebSocketStream::from_partially_read(tls, rest, Role::Client, config).await)
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

/// Why a computer gave this plxd no session at `/api/auth/peer` (0101).
#[derive(Debug)]
pub enum PeerRefusal {
    /// It said no, and will until its user changes something: its words.
    ForGood(String),
    /// It couldn't be asked.
    Failed(Error),
}

/// A session on the computer with relay id `host_id`, over `stream`, from `POST /api/auth/peer`
/// with a `DPoP` proof by `key`, this computer's host key, named `name` (0101). TLS is pinned to
/// `host_id` before the proof goes out.
///
/// # Errors
///
/// [`PeerRefusal`].
pub async fn peer_session(
    stream: crate::relay::Stream,
    host_id: &str,
    key: &DpopKey,
    name: &str,
) -> Result<String, PeerRefusal> {
    let route = format!("{RELAY_ROUTE}{host_id}");
    let pin = Pin::HostId(host_id.to_owned());
    let (tls, _) = tls_over(stream, &pin).await.map_err(PeerRefusal::Failed)?;
    let path = "/api/auth/peer";
    let proof = key.proof("POST", &url(&route, path), None);
    let body = json!({ "clientLabel": name });
    let headers = [("DPoP", proof.as_str())];
    let (status, answer) = send(tls, &route, None, "POST", path, &headers, Some(&body))
        .await
        .map_err(PeerRefusal::Failed)?;
    let answer = json::<serde_json::Value>(&answer).map_err(PeerRefusal::Failed)?;
    match (status, answer["accessToken"].as_str()) {
        (200, Some(token)) => Ok(token.to_owned()),
        (403, _) => Err(PeerRefusal::ForGood(
            answer["error_description"]
                .as_str()
                .unwrap_or("it refused this computer")
                .to_owned(),
        )),
        _ => Err(PeerRefusal::Failed(Error::Protocol(format!(
            "{path} answered {status}: {}",
            answer["error_description"]
                .as_str()
                .or_else(|| answer["error"].as_str())
                .unwrap_or("no reason")
        )))),
    }
}

/// The WebSocket `/ws` of the computer with relay id `host_id`, over `stream`, with the session
/// `token` and a proof by `key`, and TLS pinned to `host_id` (0101).
///
/// # Errors
///
/// [`Error::Refused`] when it no longer takes the session, [`Error::WrongHost`] when another key
/// answers, or the network's error.
pub async fn peer_socket(
    stream: crate::relay::Stream,
    host_id: &str,
    token: &str,
    key: &DpopKey,
) -> Result<WebSocketStream<TlsStream<crate::relay::Stream>>, Error> {
    let route = format!("{RELAY_ROUTE}{host_id}");
    let (tls, _) = tls_over(stream, &Pin::HostId(host_id.to_owned())).await?;
    upgrade(&route, tls, token, key, &[]).await
}

/// Joins `socket` to `plxd dial`'s stdio: each line of `input` goes as a text frame, and each
/// frame comes out as a line. The end of `input` closes the socket; it's over when the host
/// closes it.
///
/// # Errors
///
/// The streams' errors.
pub async fn bridge<S, I, O>(
    socket: WebSocketStream<S>,
    mut input: Input<I>,
    mut output: O,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (mut sink, mut frames) = socket.split();
    let outgoing = async {
        while let Some(line) = input.next().await? {
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
        let mut first = true;
        while let Some(frame) = frames.next().await {
            match frame.map_err(io::Error::other)? {
                Message::Text(text) => {
                    if first {
                        crate::connect_timing::mark("first_frame");
                        first = false;
                    }
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
    fn a_new_device_key_deletes_only_what_the_old_one_held() {
        let dir = tempfile::tempdir().unwrap();
        let old = device_key(dir.path()).unwrap();
        let host = "a".repeat(43);
        save_credential(dir.path(), &host, "account session", &old).unwrap();
        save_credential(dir.path(), "lan", "paired session", &DpopKey::generate()).unwrap();
        let waiting = committed_path(dir.path(), &host);
        let counted = requests_path(dir.path(), &host);
        fs::write(&waiting, "{}").unwrap();
        fs::write(&counted, "[1]").unwrap();

        let new = new_device_key(dir.path()).unwrap();

        assert_ne!(new.thumbprint(), old.thumbprint());
        assert_eq!(
            device_key(dir.path()).unwrap().thumbprint(),
            new.thumbprint()
        );
        assert!(!credential_path(dir.path(), &host).exists(), "its session");
        assert!(!waiting.exists(), "its request's value");
        assert!(
            credential_path(dir.path(), "lan").exists(),
            "another key's session"
        );
        assert_eq!(fs::read(&counted).unwrap(), b"[1]", "the count of requests");
    }

    #[test]
    fn the_push_key_is_made_once_and_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let key = push_key(dir.path()).unwrap();
        assert_eq!(push_key(dir.path()).unwrap(), key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(dir.path().join("relay-push-key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// How a stand-in host answers a connection's request.
    #[derive(Clone, Copy)]
    enum Answer {
        /// 401, as a host refusing a `/ws` upgrade.
        Refuse,
        /// A WebSocket ticket.
        Ticket,
        /// 101, then it reads this many text frames.
        Accept(usize),
    }

    /// What a stand-in host had read behind the request before it answered, and the frames it
    /// then read.
    type Seen = (Vec<u8>, Vec<String>);

    /// A stand-in host with `key` on a loopback port, answering one connection per `answers`. One
    /// that doesn't keep `early` bytes has no ALPN list and drops what it read behind a request,
    /// as every plxd before PLX-1483 does.
    async fn stand_in(
        key: &HostKey,
        early: bool,
        answers: &[Answer],
    ) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
        use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
        use tokio_tungstenite::tungstenite::protocol::Role;
        let mut config = (*key.server_config().unwrap()).clone();
        if !early {
            config.alpn_protocols.clear();
        }
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let route = listener.local_addr().unwrap().to_string();
        let answers = answers.to_vec();
        let served = tokio::spawn(async move {
            let mut seen = Vec::new();
            for answer in answers {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut tls = acceptor.accept(tcp).await.unwrap();
                let (mut read, mut chunk) = (Vec::new(), [0; 16 * 1024]);
                let head = loop {
                    let n = tls.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "the client closed before its request");
                    read.extend_from_slice(&chunk[..n]);
                    if let Some(at) = read.windows(4).position(|four| four == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let behind = read.split_off(head);
                let head = String::from_utf8(read).unwrap();
                let json = |status: &str, body: &str| {
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let mut frames = Vec::new();
                match answer {
                    Answer::Refuse => {
                        let refusal = json("401 Unauthorized", "{}");
                        tls.write_all(refusal.as_bytes()).await.unwrap();
                        tls.shutdown().await.unwrap();
                    }
                    Answer::Ticket => {
                        let ticket = json("200 OK", r#"{"ticket":"t","expiresIn":30}"#);
                        tls.write_all(ticket.as_bytes()).await.unwrap();
                        tls.shutdown().await.unwrap();
                    }
                    Answer::Accept(count) => {
                        let nonce = head
                            .lines()
                            .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
                            .unwrap();
                        let accept = derive_accept_key(nonce.as_bytes());
                        let switching = format!(
                            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                        );
                        tls.write_all(switching.as_bytes()).await.unwrap();
                        let kept = if early { behind.clone() } else { Vec::new() };
                        let mut socket =
                            WebSocketStream::from_partially_read(tls, kept, Role::Server, None)
                                .await;
                        while frames.len() < count {
                            match socket.next().await {
                                Some(Ok(Message::Text(text))) => frames.push(text.to_string()),
                                Some(Ok(_)) => {}
                                other => panic!("the client's frames ended: {other:?}"),
                            }
                        }
                    }
                }
                seen.push((behind, frames));
            }
            seen
        });
        (route, served)
    }

    /// What the stand-in host saw, failing when it doesn't get its frames.
    async fn within(served: tokio::task::JoinHandle<Vec<Seen>>) -> Vec<Seen> {
        tokio::time::timeout(Duration::from_secs(10), served)
            .await
            .expect("the host got every line")
            .unwrap()
    }

    /// Two lines with an empty one between them.
    const WAITING: &[u8] = b"one\n\ntwo\n";

    /// Dials the stand-in host at `route` as `plxd dial` does, with `waiting` already on its input
    /// and the line `three` written once it's connected.
    async fn dial_with_lines(key: &HostKey, route: String, waiting: &[u8]) {
        let dir = tempfile::tempdir().unwrap();
        let pin = fingerprint(&key.certificate);
        save_credential(dir.path(), &pin, "token", &DpopKey::generate()).unwrap();
        let (mut app, stdin) = tokio::io::duplex(64 * 1024);
        app.write_all(waiting).await.unwrap();
        let mut input = Input::new(stdin);
        let dialed = dial_with_input(&[route], &pin, dir.path(), &mut input)
            .await
            .unwrap();
        app.write_all(b"three\n").await.unwrap();
        tokio::spawn(async move {
            let _app = app;
            bridge(dialed.socket, input, tokio::io::sink()).await
        });
    }

    #[tokio::test]
    async fn waiting_lines_go_behind_the_upgrade_only_to_a_host_that_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        let lines = ["one", "two", "three"].map(str::to_owned);

        // A host from before this, or rolled back to one: nothing goes before its 101, and every
        // line arrives after it.
        let (route, served) = stand_in(&key, false, &[Answer::Accept(3)]).await;
        dial_with_lines(&key, route, WAITING).await;
        let seen = within(served).await;
        assert!(seen[0].0.is_empty(), "sent behind the request: {seen:?}");
        assert_eq!(seen[0].1, lines);

        // A host that keeps them had the waiting lines before it answered, once and in order.
        let (route, served) = stand_in(&key, true, &[Answer::Accept(3)]).await;
        dial_with_lines(&key, route, WAITING).await;
        let seen = within(served).await;
        assert!(!seen[0].0.is_empty(), "nothing went behind the request");
        assert_eq!(seen[0].1, lines);
    }

    #[tokio::test]
    async fn lines_sent_behind_a_refused_upgrade_go_again_on_the_ticket_socket() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        let answers = [Answer::Refuse, Answer::Ticket, Answer::Accept(3)];
        let (route, served) = stand_in(&key, true, &answers).await;
        dial_with_lines(&key, route, WAITING).await;
        let seen = within(served).await;
        assert!(!seen[0].0.is_empty(), "nothing went behind the request");
        assert!(seen[2].0.is_empty(), "a ticket's socket has no early lines");
        assert_eq!(seen[2].1, ["one", "two", "three"]);
    }

    #[tokio::test]
    async fn lines_past_the_early_limit_wait_for_the_101_and_arrive_once_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        let long = "x".repeat(MAX_EARLY_FRAMES + 1024);
        let waiting = format!("a\n{long}\nb\n");
        let (route, served) = stand_in(&key, true, &[Answer::Accept(4)]).await;
        dial_with_lines(&key, route, waiting.as_bytes()).await;
        let seen = within(served).await;
        // Only `a` went behind the request: a masked one-byte text frame is 7 bytes.
        assert_eq!(seen[0].0.len(), 7);
        assert_eq!(seen[0].1, ["a", long.as_str(), "b", "three"]);
    }

    /// What ALPN protocol the listener's TLS picks for a client that offers `offered`.
    async fn picked(key: &HostKey, offered: &[&[u8]]) -> Option<Vec<u8>> {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(key.server_config().unwrap());
        let served = tokio::spawn(async move { acceptor.accept(far).await.map(drop) });
        let provider = provider();
        let verifier = Pinned {
            pin: Pin::Any,
            seen: Arc::default(),
            algorithms: provider.signature_verification_algorithms,
        };
        let mut config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        config.alpn_protocols = offered.iter().map(|name| name.to_vec()).collect();
        let name = ServerName::try_from("parallax").unwrap();
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, near)
            .await
            .unwrap();
        served.await.unwrap().unwrap();
        tls.get_ref().1.alpn_protocol().map(<[u8]>::to_vec)
    }

    #[tokio::test]
    async fn the_listener_picks_early_ws_only_for_a_client_that_offers_it() {
        let dir = tempfile::tempdir().unwrap();
        let key = HostKey::load_or_create(&dir.path().join("key")).unwrap();
        assert_eq!(picked(&key, &[]).await, None, "a client from before this");
        assert_eq!(
            picked(&key, &[b"h2", b"http/1.1"]).await.as_deref(),
            Some(&b"http/1.1"[..]),
            "a browser, URLSession, or OkHttp"
        );
        assert_eq!(
            picked(&key, &[EARLY_WS, b"http/1.1"]).await.as_deref(),
            Some(EARLY_WS)
        );
    }

    /// Races `routes` with each answering `(after ms, ok)` from `answers`, by route, and records
    /// when each started: the winner and the start times.
    async fn race_of(
        answers: &[(&str, u64, bool)],
    ) -> (Result<String, String>, Vec<(String, u64)>) {
        race_in(false, answers).await
    }

    /// [`race_of`], in the user's order with `in_order`.
    async fn race_in(
        in_order: bool,
        answers: &[(&str, u64, bool)],
    ) -> (Result<String, String>, Vec<(String, u64)>) {
        let started = Arc::new(Mutex::new(Vec::new()));
        let t0 = tokio::time::Instant::now();
        let routes: Vec<String> = answers.iter().map(|(r, ..)| (*r).to_owned()).collect();
        let won = first(&routes, in_order, |route| {
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
    async fn in_the_users_order_each_route_starts_200_ms_after_the_one_above_it() {
        let starts = |list: &[(&str, u64)]| -> Vec<(String, u64)> {
            list.iter().map(|(r, at)| ((*r).to_owned(), *at)).collect()
        };
        // The first route wins while it answers within 200 ms, though another would be faster.
        let (won, started) = race_in(
            true,
            &[
                ("home.example.com:7400", 150, true),
                ("192.168.1.5", 0, true),
                ("relay:h", 0, true),
            ],
        )
        .await;
        assert_eq!(won.as_deref(), Ok("home.example.com:7400"));
        assert_eq!(started, starts(&[("home.example.com:7400", 0)]));

        // A route above that hangs holds the next back for 200 ms, and the relay can go first.
        let (won, started) = race_in(
            true,
            &[
                ("relay:h", 5_000, true),
                ("192.168.1.5", 5_000, true),
                ("10.0.0.5", 40, true),
            ],
        )
        .await;
        assert_eq!(won.as_deref(), Ok("10.0.0.5"));
        assert_eq!(
            started,
            starts(&[("relay:h", 0), ("192.168.1.5", 200), ("10.0.0.5", 400)])
        );

        // A route above that failed starts the next at once.
        let (won, started) =
            race_in(true, &[("192.168.1.5", 10, false), ("relay:h", 20, true)]).await;
        assert_eq!(won.as_deref(), Ok("relay:h"));
        assert_eq!(started, starts(&[("192.168.1.5", 0), ("relay:h", 10)]));
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
