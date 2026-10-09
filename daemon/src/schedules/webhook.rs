//! A webhook task's request (0063), as T3's `webhookVerification.ts` and `webhookTemplate.ts`:
//! its token and HMAC-SHA256 signature, checked in constant time, and the prompt rendered from
//! it.
//!
//! The template is only `{{path}}` lookups:
//!
//! - `{{body.a.b.0}}`: a field of a JSON or form-encoded body
//! - `{{headers.name}}`: a header, by any case
//! - `{{query.name}}`: a query parameter
//! - `{{body}}`: the raw body
//! - `{{request}}`: the method, path, query, headers, and body
//!
//! Strings and numbers render as text, and objects and arrays as JSON. A path with no value
//! renders empty. Wherever the whole set renders (`{{request}}`, `{{headers}}`, `{{query}}`),
//! credential-named headers and query parameters are redacted; naming one gives its value.

use std::collections::HashMap;

use data_encoding::{BASE64, BASE64URL_NOPAD, HEXLOWER_PERMISSIVE};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{SignatureEncoding, WebhookSignature};
use ring::hmac;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Where webhooks are served, before `<id>/<token>`.
pub(super) const PREFIX: &str = "/api/hooks/";

const REDACTED: &str = "[redacted]";

/// A new webhook token: 24 random bytes, base64url.
pub(super) fn new_token() -> Result<String, ErrorObject> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|error| ErrorObject::internal_error(error.to_string()))?;
    Ok(BASE64URL_NOPAD.encode(&bytes))
}

/// Whether `a` and `b` are equal, in time that tells nothing about where they differ or how long
/// either is: their SHA-256 digests are compared byte by byte, without stopping early.
pub(super) fn same(a: &str, b: &str) -> bool {
    let (a, b) = (Sha256::digest(a), Sha256::digest(b));
    a.iter()
        .zip(b.iter())
        .fold(0, |differ, (x, y)| differ | (x ^ y))
        == 0
}

/// Whether `body` carries `signature`'s header with a valid HMAC-SHA256 of it under `secret`.
pub(super) fn verify(
    signature: &WebhookSignature,
    secret: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    let Some(value) = headers.get(&signature.header.to_ascii_lowercase()) else {
        return false;
    };
    let value = value.trim();
    let prefix = &signature.prefix;
    let Some(digest) = value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
    else {
        return false;
    };
    let decoded = match signature.encoding {
        SignatureEncoding::Hex => HEXLOWER_PERMISSIVE.decode(digest.as_bytes()),
        SignatureEncoding::Base64 => BASE64.decode(digest.as_bytes()),
        SignatureEncoding::Unknown => return false,
    };
    let Ok(decoded) = decoded else {
        return false;
    };
    // `verify` compares in constant time.
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, body, &decoded).is_ok()
}

/// What a template reads from a request.
pub(super) struct Request<'a> {
    pub method: &'a str,
    /// `/api/hooks/<id>`, without the token, which would otherwise reach the prompt, and without
    /// the query.
    pub path: &'a str,
    /// Without the `?`.
    pub query: &'a str,
    /// By lowercase name.
    pub headers: &'a HashMap<String, String>,
    pub body: &'a str,
}

/// `template` with each placeholder filled from `request`.
pub(super) fn render(template: &str, request: &Request<'_>) -> String {
    let mut parsed: Option<Option<Value>> = None;
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open + 2..].find("}}") else {
            break;
        };
        out.push_str(&rest[..open]);
        let expression = rest[open + 2..open + 2 + close].trim();
        if expression.contains(['{', '}']) {
            out.push_str(&rest[open..open + 4 + close]);
        } else {
            let body = parsed.get_or_insert_with(|| parse_body(request));
            out.push_str(&resolve(expression, request, body.as_ref()));
        }
        rest = &rest[open + 4 + close..];
    }
    out.push_str(rest);
    out
}

fn resolve(expression: &str, request: &Request<'_>, body: Option<&Value>) -> String {
    let (root, path) = expression
        .split_once('.')
        .map_or((expression, None), |(root, path)| (root, Some(path)));
    match (root, path) {
        ("request", None) => format_request(request),
        ("body", None) => request.body.to_owned(),
        ("body", Some(path)) => body
            .and_then(|body| {
                path.split('.')
                    .try_fold(body, |value, key| lookup(value, key))
            })
            .map(text)
            .unwrap_or_default(),
        ("headers", None) => text(&Value::Object(
            redacted_headers(request.headers)
                .into_iter()
                .map(|(name, value)| (name, Value::String(value)))
                .collect(),
        )),
        ("headers", Some(name)) => request
            .headers
            .get(&name.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default(),
        ("query", None) => text(&Value::Object(
            pairs(&redacted_query(request.query))
                .map(|(name, value)| (name, Value::String(value)))
                .collect(),
        )),
        ("query", Some(name)) => pairs(request.query)
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn lookup<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => items.get(key.parse::<usize>().ok()?),
        _ => None,
    }
}

fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Number(_) | Value::Bool(_) => value.to_string(),
        _ => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}

/// A form-encoded body as an object, or any body that parses as JSON, since senders are loose
/// about content types.
fn parse_body(request: &Request<'_>) -> Option<Value> {
    let form = request
        .headers
        .get("content-type")
        .is_some_and(|kind| kind.contains("application/x-www-form-urlencoded"));
    if form {
        return Some(Value::Object(
            pairs(request.body)
                .map(|(name, value)| (name, Value::String(value)))
                .collect::<Map<_, _>>(),
        ));
    }
    serde_json::from_str(request.body).ok()
}

/// Whether a header or query parameter's name looks like it carries a credential.
fn credential(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
    ) || ["token", "secret", "signature", "key", "password", "auth"]
        .iter()
        .any(|word| name.contains(word))
}

fn redacted_headers(headers: &HashMap<String, String>) -> Vec<(String, String)> {
    let mut headers: Vec<_> = headers
        .iter()
        .map(|(name, value)| {
            let value = if credential(name) { REDACTED } else { value };
            (name.clone(), value.to_owned())
        })
        .collect();
    headers.sort();
    headers
}

/// `query` with credential-named values redacted, the rest as sent.
fn redacted_query(query: &str) -> String {
    query
        .split('&')
        .map(|part| match part.split_once('=') {
            Some((name, _)) if credential(&decode(name)) => format!("{name}={REDACTED}"),
            _ => part.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn format_request(request: &Request<'_>) -> String {
    let query = redacted_query(request.query);
    let mut lines = vec![if query.is_empty() {
        format!("{} {}", request.method, request.path)
    } else {
        format!("{} {}?{query}", request.method, request.path)
    }];
    lines.extend(
        redacted_headers(request.headers)
            .into_iter()
            .map(|(name, value)| format!("{name}: {value}")),
    );
    lines.push(String::new());
    lines.push(request.body.to_owned());
    lines.join("\n")
}

/// A form-encoded string's decoded name and value pairs.
fn pairs(encoded: &str) -> impl Iterator<Item = (String, String)> + '_ {
    encoded
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            (decode(name), decode(value))
        })
}

/// Percent-decodes `text`, with `+` as a space. A malformed escape stays as sent.
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = text
            .get(i + 1..i + 3)
            .filter(|hex| bytes[i] == b'%' && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[i], escaped) {
            (_, Some(byte)) => {
                out.push(byte);
                i += 3;
                continue;
            }
            (b'+', None) => out.push(b' '),
            (byte, None) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use parallax_protocol::{SignatureEncoding, WebhookSignature};
    use ring::hmac;

    use super::{Request, decode, render, same, verify};

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn placeholders_fill_from_the_body_headers_and_query() {
        let headers = headers(&[
            ("content-type", "application/json"),
            ("x-github-event", "release"),
            ("authorization", "Bearer abc"),
        ]);
        let request = Request {
            method: "POST",
            path: "/api/hooks/id",
            query: "source=ci&api_key=hunter2",
            headers: &headers,
            body: r#"{"action":"published","release":{"tag_name":"v1.2"},"assets":[{"n":3}]}"#,
        };
        let rendered = render(
            "{{ headers.X-GitHub-Event }} {{body.action}} {{body.release.tag_name}} \
             {{body.assets.0.n}} {{query.source}} [{{body.missing}}] {{nope}}",
            &request,
        );
        assert_eq!(rendered, "release published v1.2 3 ci [] ");

        let whole = render("{{request}}", &request);
        assert!(whole.starts_with("POST /api/hooks/id?source=ci&api_key=[redacted]\n"));
        assert!(whole.contains("authorization: [redacted]\n"), "{whole}");
        assert!(whole.ends_with("\n\n{\"action\":\"published\",\"release\":{\"tag_name\":\"v1.2\"},\"assets\":[{\"n\":3}]}"));
        assert_eq!(render("{{headers.authorization}}", &request), "Bearer abc");
        assert_eq!(render("{{query.api_key}}", &request), "hunter2");
        assert_eq!(render("unclosed {{body", &request), "unclosed {{body");
    }

    #[test]
    fn a_form_body_is_addressable() {
        let headers = headers(&[("content-type", "application/x-www-form-urlencoded")]);
        let request = Request {
            method: "POST",
            path: "/",
            query: "",
            headers: &headers,
            body: "text=hello+world%21&user=ryan",
        };
        assert_eq!(
            render("{{body.text}} {{body.user}}", &request),
            "hello world! ryan"
        );
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz"), "%zz");
    }

    #[test]
    fn a_signature_is_checked_over_the_raw_body() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"s3cret");
        let body = br#"{"action":"published"}"#;
        let tag = hmac::sign(&key, body);
        let hex = data_encoding::HEXLOWER.encode(tag.as_ref());
        let github = WebhookSignature {
            header: "X-Hub-Signature-256".to_owned(),
            encoding: SignatureEncoding::Hex,
            prefix: "sha256=".to_owned(),
            secret: None,
        };
        let sent = headers(&[("x-hub-signature-256", &format!("sha256={hex}"))]);
        assert!(verify(&github, "s3cret", &sent, body));
        assert!(!verify(&github, "other", &sent, body));
        assert!(!verify(&github, "s3cret", &sent, b"{}"));
        assert!(!verify(&github, "s3cret", &headers(&[]), body));
        let unprefixed = headers(&[("x-hub-signature-256", &hex)]);
        assert!(!verify(&github, "s3cret", &unprefixed, body));

        let base64 = WebhookSignature {
            header: "x-signature".to_owned(),
            encoding: SignatureEncoding::Base64,
            prefix: String::new(),
            secret: None,
        };
        let sent = headers(&[("x-signature", &data_encoding::BASE64.encode(tag.as_ref()))]);
        assert!(verify(&base64, "s3cret", &sent, body));

        assert!(same("token", "token"));
        assert!(!same("token", "tokem"));
    }
}
