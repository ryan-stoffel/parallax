//! Checks a Parallax account token (0067) in plxd, for account sign-in on the remote listener
//! (0091). [`check`] makes every check `packages/clerk-verify` makes, on ring's RSA, against the
//! Clerk instance's JWKS, which [`Clerk`] fetches over HTTPS and caches. [`check_sign_in`] adds
//! plxd's own: the token is its account's, and fresh by this computer's clock.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data_encoding::BASE64URL_NOPAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::{Map, Value};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::warn;

/// The Clerk instance the desktop app signs in with by default (0067), until production's
/// (PLX-1049). `PLXD_CLERK_ISSUER` names another.
pub const DEFAULT_ISSUER: &str = "https://adjusted-mastodon-8705.clerk.accounts.dev";

/// The desktop app's OAuth application, whose access tokens count. `PLXD_CLERK_CLIENT_IDS` lists
/// others, separated by commas.
pub const DEFAULT_CLIENT_ID: &str = "SXDueyOLOJ2v4Vmq";

/// Clock skew allowed on `exp` and `nbf`, as clerk-verify's.
const SKEW_SECONDS: f64 = 5.0;

/// How long a JWKS is kept.
const TTL: Duration = Duration::from_hours(1);

/// A token naming a key the cached set lacks refetches it at most this often, as clerk-verify's,
/// so a forged `kid` can't make every sign-in fetch.
const REFETCH: Duration = Duration::from_mins(1);

/// A sign-in's token must have been issued within this many seconds (0091).
pub const FRESH_SECONDS: f64 = 60.0;

/// How far off this computer's clock may be, either way, for [`FRESH_SECONDS`] (0091). A computer
/// further off from the relay's clock refuses account sign-ins.
pub const CLOCK_SKEW: Duration = Duration::from_mins(5);
const CLOCK_SKEW_SECONDS: f64 = CLOCK_SKEW.as_secs_f64();

/// Which tokens count: the Clerk instance and what of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The instance's Frontend API URL, which tokens carry as `iss`.
    pub issuer: String,
    /// The OAuth applications whose access tokens count, by `client_id`.
    pub client_ids: Vec<String>,
    /// The origins a browser's session token may come from (its `azp`). Empty accepts no browser;
    /// a session token without `azp`, as Clerk's native SDKs send, passes.
    pub authorized_parties: Vec<String>,
}

impl Config {
    /// `PLXD_CLERK_ISSUER`, `PLXD_CLERK_CLIENT_IDS`, and `PLXD_CLERK_AUTHORIZED_PARTIES` (comma
    /// lists), else the desktop app's instance and application, and no browser.
    #[must_use]
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let list = |value: String| -> Vec<String> {
            value
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect()
        };
        Self {
            issuer: var("PLXD_CLERK_ISSUER").unwrap_or_else(|| DEFAULT_ISSUER.to_owned()),
            client_ids: var("PLXD_CLERK_CLIENT_IDS")
                .map_or_else(|| vec![DEFAULT_CLIENT_ID.to_owned()], list),
            authorized_parties: var("PLXD_CLERK_AUTHORIZED_PARTIES")
                .map(list)
                .unwrap_or_default(),
        }
    }
}

/// RSA keys by `kid`: each one's modulus and exponent, big-endian.
pub type Keys = HashMap<String, (Vec<u8>, Vec<u8>)>;

/// Whom a token speaks for.
#[derive(Clone, Debug, PartialEq)]
pub struct Verified {
    /// The Clerk user id, `sub`.
    pub user_id: String,
    /// When it was issued, in seconds since the epoch, if it says.
    pub issued_at: Option<f64>,
}

/// A JWT split into what [`check`] needs.
#[derive(Debug)]
pub struct Jwt {
    kid: String,
    claims: Map<String, Value>,
    /// The signed part: header and claims, as sent.
    input: String,
    signature: Vec<u8>,
}

impl Jwt {
    /// The parts of `token`, if it is a compact JWT signed with RS256 and naming its key.
    ///
    /// # Errors
    ///
    /// Why it isn't, for the log.
    pub fn parse(token: &str) -> Result<Self, &'static str> {
        let mut parts = token.split('.');
        let (Some(head), Some(body), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("not a JWT");
        };
        let header = object(head).ok_or("not a JWT")?;
        // Clerk signs with RS256 only. Anything else, "none" included, is refused before any key.
        let Some(kid) = header
            .get("kid")
            .and_then(Value::as_str)
            .filter(|_| header.get("alg").and_then(Value::as_str) == Some("RS256"))
        else {
            return Err("an unexpected signing algorithm");
        };
        Ok(Self {
            kid: kid.to_owned(),
            claims: object(body).ok_or("not a JWT")?,
            input: format!("{head}.{body}"),
            signature: BASE64URL_NOPAD
                .decode(signature.as_bytes())
                .map_err(|_| "a bad signature")?,
        })
    }
}

fn object(part: &str) -> Option<Map<String, Value>> {
    let bytes = BASE64URL_NOPAD.decode(part.as_bytes()).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The user a token names, `sub`, without checking it: for a token a trusted caller handed plxd
/// to register with, whose user plxd records as its account (0091).
#[must_use]
pub fn subject(token: &str) -> Option<String> {
    let body = token.split('.').nth(1)?;
    object(body)?
        .get("sub")?
        .as_str()
        .filter(|sub| !sub.is_empty())
        .map(str::to_owned)
}

/// Checks `jwt` as clerk-verify's `verifyClerkToken` does, at `now` in seconds: signed by `keys`'
/// key of its `kid`, by `config`'s issuer, unexpired, for no other audience, naming a user, and
/// an OAuth access token of an allowed application or a session token, from an allowed origin
/// when it names one.
///
/// # Errors
///
/// Why it doesn't count, for the log.
pub fn check(jwt: &Jwt, keys: &Keys, config: &Config, now: f64) -> Result<Verified, &'static str> {
    let (n, e) = keys.get(&jwt.kid).ok_or("an unknown signing key")?;
    RsaPublicKeyComponents { n, e }
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            jwt.input.as_bytes(),
            &jwt.signature,
        )
        .map_err(|_| "a bad signature")?;
    let claims = &jwt.claims;
    let text = |name: &str| claims.get(name).and_then(Value::as_str);
    let number = |name: &str| claims.get(name).and_then(Value::as_f64);
    if text("iss") != Some(config.issuer.as_str()) {
        return Err("the wrong issuer");
    }
    if number("exp").is_none_or(|exp| exp + SKEW_SECONDS <= now) {
        return Err("expired");
    }
    if number("nbf").is_some_and(|nbf| nbf - SKEW_SECONDS > now) {
        return Err("not valid yet");
    }
    // Clerk's session and OAuth tokens carry no `aud`. One that does was meant for another
    // service.
    if claims.contains_key("aud") {
        return Err("meant for another audience");
    }
    let Some(user) = text("sub").filter(|sub| !sub.is_empty()) else {
        return Err("no user");
    };
    // An OAuth access token names its application (RFC 9068), a session token its session.
    if let Some(client_id) = text("client_id") {
        if !config.client_ids.iter().any(|id| id == client_id) {
            return Err("an unknown OAuth application");
        }
    } else {
        if text("sid").is_none() {
            return Err("neither a session nor an OAuth token");
        }
        if text("azp").is_some_and(|azp| !config.authorized_parties.iter().any(|p| p == azp)) {
            return Err("an unexpected origin");
        }
    }
    Ok(Verified {
        user_id: user.to_owned(),
        issued_at: number("iat"),
    })
}

/// plxd's own checks of a sign-in's token (0091): it is `account`'s, and was issued within
/// [`FRESH_SECONDS`] of `now` by this computer's clock, with [`CLOCK_SKEW`] either way.
/// Never by the relay's clock, which a compromised relay could use to make an old token look fresh.
///
/// # Errors
///
/// Why it doesn't count, for the log.
pub fn check_sign_in(verified: &Verified, account: &str, now: f64) -> Result<(), &'static str> {
    if verified.user_id != account {
        return Err("a token for another account");
    }
    let Some(issued) = verified.issued_at else {
        return Err("a token without its issue time");
    };
    if issued < now - FRESH_SECONDS - CLOCK_SKEW_SECONDS {
        return Err("a token issued too long ago");
    }
    if issued > now + CLOCK_SKEW_SECONDS {
        return Err("a token issued in the future");
    }
    Ok(())
}

/// Seconds since the epoch, by this computer's clock.
#[must_use]
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64())
}

/// The fetched signing keys: when, for how long, and which.
struct KeySet {
    at: Instant,
    ttl: Duration,
    keys: Keys,
}

/// Checks account tokens against the Clerk instance's JWKS, which it fetches when a check first
/// needs it and keeps for [`TTL`]. A token naming a key it lacks refetches it, at most once per
/// [`REFETCH`]. While the JWKS is out of reach, the keys it has still count.
pub(crate) struct Clerk {
    config: Config,
    /// Held across a fetch, so checks waiting on it share it.
    keys: Mutex<Option<KeySet>>,
}

impl std::fmt::Debug for Clerk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Clerk")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Clerk {
    pub(crate) fn new(config: Config) -> Self {
        Self {
            config,
            keys: Mutex::new(None),
        }
    }

    /// Whom `token` speaks for, at `now`, after every check of [`check`].
    pub(crate) async fn verify(&self, token: &str, now: f64) -> Result<Verified, &'static str> {
        let jwt = Jwt::parse(token)?;
        let keys = self.keys(&jwt.kid).await?;
        check(&jwt, &keys, &self.config, now)
    }

    /// The signing keys, fetched again when they're old, or lack `kid` and weren't just fetched.
    async fn keys(&self, kid: &str) -> Result<Keys, &'static str> {
        let mut cached = self.keys.lock().await;
        let stale = cached.as_ref().is_none_or(|set| {
            let age = set.at.elapsed();
            age >= set.ttl || (!set.keys.contains_key(kid) && age >= REFETCH)
        });
        if stale {
            match fetch(&self.config.issuer).await {
                Ok(keys) => {
                    *cached = Some(KeySet {
                        at: Instant::now(),
                        ttl: TTL,
                        keys,
                    });
                }
                Err(error) => {
                    warn!(%error, "could not fetch the account's signing keys");
                    let Some(set) = cached.as_mut() else {
                        return Err("the account's signing keys are out of reach");
                    };
                    set.at = Instant::now();
                    set.ttl = REFETCH;
                }
            }
        }
        Ok(cached
            .as_ref()
            .map(|set| set.keys.clone())
            .unwrap_or_default())
    }
}

/// The RSA keys of the JWKS at `<issuer>/.well-known/jwks.json`.
async fn fetch(issuer: &str) -> Result<Keys, String> {
    let after_scheme = issuer.split_once("://").map_or(issuer, |(_, rest)| rest);
    let prefix = after_scheme
        .find('/')
        .map_or("", |at| &after_scheme[at..])
        .trim_end_matches('/');
    let path = format!("{prefix}/.well-known/jwks.json");
    let fetched = tokio::time::timeout(
        crate::remote::REQUEST_TIMEOUT,
        crate::relay::get(issuer, &path),
    )
    .await
    .map_err(|_| "the JWKS didn't answer in time".to_owned())?;
    let body = match fetched {
        Ok((200, body)) => body,
        Ok((status, _)) => return Err(format!("the JWKS answered {status}")),
        Err(error) => return Err(error.to_string()),
    };
    let decode = |field: &Value| {
        field
            .as_str()
            .and_then(|text| BASE64URL_NOPAD.decode(text.as_bytes()).ok())
    };
    Ok(body["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|jwk| jwk["kty"] == "RSA")
        .filter_map(|jwk| {
            let kid = jwk["kid"].as_str()?.to_owned();
            Some((kid, (decode(&jwk["n"])?, decode(&jwk["e"])?)))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use ring::rand::SystemRandom;
    use ring::rsa::{KeyPair, PublicKeyComponents};
    use serde_json::json;

    use super::*;

    const ISSUER: &str = "https://clerk.example";
    const NOW: f64 = 1_800_000_000.0;

    fn key() -> KeyPair {
        let der = include_bytes!("../tests/fixtures/clerk-test-key.der");
        KeyPair::from_der(der).unwrap()
    }

    fn keys() -> Keys {
        let public: PublicKeyComponents<Vec<u8>> = key().public().into();
        HashMap::from([("k1".to_owned(), (public.n, public.e))])
    }

    fn config() -> Config {
        Config {
            issuer: ISSUER.to_owned(),
            client_ids: vec!["desktop".to_owned()],
            authorized_parties: vec!["https://app.example".to_owned()],
        }
    }

    fn sign(header: &Value, claims: &Value) -> String {
        let input = format!(
            "{}.{}",
            BASE64URL_NOPAD.encode(header.to_string().as_bytes()),
            BASE64URL_NOPAD.encode(claims.to_string().as_bytes())
        );
        let pair = key();
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{input}.{}", BASE64URL_NOPAD.encode(&signature))
    }

    fn session(change: impl FnOnce(&mut Map<String, Value>)) -> String {
        let mut claims = json!({
            "iss": ISSUER, "sub": "user_1", "sid": "sess_1", "iat": NOW, "exp": NOW + 60.0,
        });
        change(claims.as_object_mut().unwrap());
        sign(&json!({ "alg": "RS256", "kid": "k1" }), &claims)
    }

    fn verify(token: &str) -> Result<Verified, &'static str> {
        check(&Jwt::parse(token)?, &keys(), &config(), NOW)
    }

    #[test]
    fn a_session_or_oauth_token_of_the_instance_counts() {
        let verified = verify(&session(|_| {})).unwrap();
        assert_eq!(verified.user_id, "user_1");
        assert_eq!(verified.issued_at, Some(NOW));
        let oauth = session(|c| {
            c.remove("sid");
            c.insert("client_id".into(), json!("desktop"));
        });
        assert!(verify(&oauth).is_ok());
        let browser = session(|c| {
            c.insert("azp".into(), json!("https://app.example"));
        });
        assert!(verify(&browser).is_ok());
        assert_eq!(
            subject(&session(|_| {})).as_deref(),
            Some("user_1"),
            "registration reads the user without a check"
        );
    }

    #[test]
    fn every_clerk_verify_check_refuses_its_token() {
        let cases: Vec<(&str, String)> = vec![
            ("not a JWT", "a.b".to_owned()),
            (
                "an unexpected signing algorithm",
                sign(&json!({ "alg": "none", "kid": "k1" }), &json!({})),
            ),
            (
                "an unexpected signing algorithm",
                sign(&json!({ "alg": "RS256" }), &json!({})),
            ),
            (
                "an unknown signing key",
                sign(&json!({ "alg": "RS256", "kid": "k2" }), &json!({})),
            ),
            (
                "the wrong issuer",
                session(|c| drop(c.insert("iss".into(), json!("https://evil")))),
            ),
            (
                "expired",
                session(|c| drop(c.insert("exp".into(), json!(NOW - 5.0)))),
            ),
            ("expired", session(|c| drop(c.remove("exp")))),
            (
                "not valid yet",
                session(|c| drop(c.insert("nbf".into(), json!(NOW + 6.0)))),
            ),
            (
                "meant for another audience",
                session(|c| drop(c.insert("aud".into(), json!("api")))),
            ),
            (
                "no user",
                session(|c| drop(c.insert("sub".into(), json!("")))),
            ),
            (
                "an unknown OAuth application",
                session(|c| drop(c.insert("client_id".into(), json!("other")))),
            ),
            (
                "neither a session nor an OAuth token",
                session(|c| drop(c.remove("sid"))),
            ),
            (
                "an unexpected origin",
                session(|c| drop(c.insert("azp".into(), json!("https://evil.example")))),
            ),
        ];
        for (why, token) in cases {
            assert_eq!(verify(&token), Err(why), "{token}");
        }
        // Claims changed after signing.
        let good = session(|_| {});
        let (input, signature) = good.rsplit_once('.').unwrap();
        let (head, _) = input.split_once('.').unwrap();
        let claims = json!({ "iss": ISSUER, "sub": "user_2", "sid": "s", "exp": NOW + 60.0 });
        let forged = format!(
            "{head}.{}.{signature}",
            BASE64URL_NOPAD.encode(claims.to_string().as_bytes())
        );
        assert_eq!(verify(&forged), Err("a bad signature"));
    }

    #[test]
    fn a_sign_in_needs_this_accounts_token_issued_lately_by_this_clock() {
        let at = |iat: Option<f64>| Verified {
            user_id: "user_1".to_owned(),
            issued_at: iat,
        };
        assert_eq!(check_sign_in(&at(Some(NOW)), "user_1", NOW), Ok(()));
        assert_eq!(
            check_sign_in(&at(Some(NOW)), "user_2", NOW),
            Err("a token for another account")
        );
        assert_eq!(
            check_sign_in(&at(None), "user_1", NOW),
            Err("a token without its issue time")
        );
        // 60 s, plus 5 minutes of skew either way.
        assert_eq!(check_sign_in(&at(Some(NOW - 359.0)), "user_1", NOW), Ok(()));
        assert_eq!(
            check_sign_in(&at(Some(NOW - 361.0)), "user_1", NOW),
            Err("a token issued too long ago")
        );
        assert_eq!(check_sign_in(&at(Some(NOW + 299.0)), "user_1", NOW), Ok(()));
        assert_eq!(
            check_sign_in(&at(Some(NOW + 301.0)), "user_1", NOW),
            Err("a token issued in the future")
        );
    }
}
