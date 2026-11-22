//! Which certificate a client of plxd's listener accepts (0065, 0091). plxd's `dial` and the
//! browser's TLS in WebAssembly (0108) both check the handshake's certificate with [`Pin`], so a
//! browser pins a host exactly as `plxd dial` and the phone do.

use ring::digest::{SHA256, digest};
use rustls_pki_types::CertificateDer;

/// Which certificate a connection accepts.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
    /// Whether `certificate`, the DER of the handshake's end-entity certificate, is the pinned one.
    /// The TLS handshake proves the host holds its key.
    #[must_use]
    pub fn accepts(&self, certificate: &[u8]) -> bool {
        match self {
            Self::Any => true,
            Self::Fingerprint(pinned) => *pinned == fingerprint(certificate),
            Self::HostId(id) => key_id(certificate).is_some_and(|key| key == *id),
        }
    }
}

/// A certificate's fingerprint: the SHA-256 of its DER, in lowercase hex.
#[must_use]
pub fn fingerprint(certificate: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    digest(&SHA256, certificate)
        .as_ref()
        .iter()
        .flat_map(|b| [DIGITS[usize::from(b >> 4)], DIGITS[usize::from(b & 15)]])
        .map(char::from)
        .collect()
}

/// The JWK thumbprint (RFC 7638) of the P-256 key whose point is `x`, `y` in base64url.
#[must_use]
pub fn thumbprint(x: &str, y: &str) -> String {
    let members = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    base64url(digest(&SHA256, members.as_bytes()).as_ref())
}

/// `bytes` in base64url without padding (RFC 4648 §5), as JWKs use. Written out rather than
/// taken from a crate, which would add to what a browser downloads (0108).
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk
            .iter()
            .enumerate()
            .fold(0_u32, |group, (i, b)| group | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            text.push(char::from(ALPHABET[(group >> (18 - 6 * i)) as usize & 63]));
        }
    }
    text
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_id_pin_takes_only_the_certificate_with_that_key() {
        let made = rcgen::generate_simple_self_signed(["parallax".to_owned()]).unwrap();
        let other = rcgen::generate_simple_self_signed(["parallax".to_owned()]).unwrap();
        let point = made.signing_key.public_key_raw();
        let id = thumbprint(&base64url(&point[1..33]), &base64url(&point[33..]));
        let pin = Pin::HostId(id);
        assert!(pin.accepts(made.cert.der()));
        assert!(!pin.accepts(other.cert.der()));
        assert!(!pin.accepts(b"not a certificate"));
    }

    #[test]
    fn a_certificate_without_a_p256_key_has_no_host_id() {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
        let params = rcgen::CertificateParams::new(["parallax".to_owned()]).unwrap();
        let cert = params.self_signed(&key).unwrap();
        assert_eq!(key_id(cert.der()), None);
    }

    #[test]
    fn base64url_matches_rfc_4648() {
        let cases = [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(base64url(plain.as_bytes()), encoded);
        }
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn a_fingerprint_pin_takes_only_that_certificate() {
        let made = rcgen::generate_simple_self_signed(["parallax".to_owned()]).unwrap();
        let other = rcgen::generate_simple_self_signed(["parallax".to_owned()]).unwrap();
        let pin = Pin::Fingerprint(fingerprint(made.cert.der()));
        assert!(pin.accepts(made.cert.der()));
        assert!(!pin.accepts(other.cert.der()));
        assert_eq!(
            fingerprint(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
