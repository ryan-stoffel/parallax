//! Cursor's usage for `usage/daily` (0039), from the usage API behind cursor.com's dashboard, with
//! Cursor desktop's own sign-in. Cursor keeps no local log of tokens.
//!
//! The access token comes from Cursor's `state.vscdb`, opened read-only. It goes to `curl` on
//! stdin, never in arguments, and is never logged. The API is private and can change; a change
//! shows up as a problem, not a failed answer. `curl` rather than an HTTP crate: cursor.com's bot
//! protection turns away rustls's TLS fingerprint.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use parallax_protocol::{CliKind, UsageDay};
use rusqlite::{Connection, OpenFlags, OptionalExtension, types::ValueRef};
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::backend::claude::usd_micros;
use crate::backend::process::{Launcher, ProcessSpec, StdinMode};
use crate::detect::run_spec;

const URL: &str = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE: usize = 500;
/// 100,000 events, far more than 180 days of one person's use.
const MAX_PAGES: u32 = 200;
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Cursor's usage since local midnight of `since` in `zone`, by local day and model. No Cursor,
/// or Cursor signed out, is no usage. `Err` is why, for people.
pub(super) async fn daily(
    launcher: &Launcher,
    since: Date,
    zone: &TimeZone,
) -> Result<Vec<UsageDay>, String> {
    let Some(path) = state_db().filter(|path| path.is_file()) else {
        return Ok(Vec::new());
    };
    let token = tokio::task::spawn_blocking(move || access_token(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Couldn't read Cursor's sign-in: {error}."))?;
    let Some(token) = token else {
        return Ok(Vec::new());
    };
    let user = user_id(&token).ok_or("Couldn't read Cursor's sign-in on this host.")?;
    let cookie = Zeroizing::new(format!("WorkosCursorSessionToken={user}%3A%3A{}", *token));

    let start = since
        .to_zoned(zone.clone())
        .map_err(|error| error.to_string())?
        .timestamp()
        .as_millisecond();
    let end = Timestamp::now().as_millisecond();
    let mut events = Vec::new();
    for page in 1..=MAX_PAGES {
        let answer = fetch(launcher, &cookie, start, end, page).await?;
        let fetched = answer.usage_events_display.len();
        events.extend(answer.usage_events_display);
        if last_page(fetched, events.len(), answer.total_usage_events_count) {
            break;
        }
    }
    Ok(rows(events, zone))
}

/// Whether paging is done after a page of `fetched` events, with `collected` in all: on an empty
/// page, or once `total`, when the API says it, is in. Not on a short page: the API may cap the
/// page size below what plxd asked for.
fn last_page(fetched: usize, collected: usize, total: Option<u64>) -> bool {
    fetched == 0 || total.is_some_and(|total| collected as u64 >= total)
}

/// Cursor desktop's state database, where it keeps its sign-in.
fn state_db() -> Option<PathBuf> {
    let config = if cfg!(target_os = "macos") {
        std::env::home_dir()?.join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| std::env::home_dir().map(|home| home.join(".config")))?
    };
    Some(config.join("Cursor/User/globalStorage/state.vscdb"))
}

/// Cursor's access token, or `None` when it's signed out. Read-only: the database is Cursor's,
/// and live.
fn access_token(path: &Path) -> rusqlite::Result<Option<Zeroizing<String>>> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.query_row(
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
        [],
        |row| {
            Ok(match row.get_ref(0)? {
                ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                    String::from_utf8(bytes.to_vec()).ok()
                }
                _ => None,
            })
        },
    )
    .optional()
    .map(|token| {
        token
            .flatten()
            .filter(|token| !token.is_empty())
            .map(Zeroizing::new)
    })
}

/// The user id in an access token's `sub`, such as `user_01ABC` from `auth0|user_01ABC`.
fn user_id(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    // base64url without padding, as standard base64.
    let mut base64: String = payload
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    while !base64.len().is_multiple_of(4) {
        base64.push('=');
    }
    let claims: serde_json::Value =
        serde_json::from_slice(&crate::images::decode(&base64)?).ok()?;
    let sub = claims.get("sub")?.as_str()?;
    let id: String = sub[sub.find("user_")?..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    Some(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    total_usage_events_count: Option<u64>,
    #[serde(default)]
    usage_events_display: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    /// Milliseconds since 1970, as a string.
    timestamp: String,
    #[serde(default)]
    model: String,
    token_usage: Option<TokenUsage>,
    charged_cents: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_write_tokens: u64,
    total_cents: Option<f64>,
}

/// One page of usage events from `start` to `end` (milliseconds), through `curl` with the cookie
/// on stdin.
async fn fetch(
    launcher: &Launcher,
    cookie: &str,
    start: i64,
    end: i64,
    page: u32,
) -> Result<Page, String> {
    let body = format!(
        r#"{{"teamId":0,"startDate":"{start}","endDate":"{end}","page":{page},"pageSize":{PAGE_SIZE}}}"#
    );
    // curl's config syntax: a quoted value takes backslash escapes.
    let quoted = |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    let config = Zeroizing::new(format!(
        "url = {}\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\n\
         header = \"Origin: https://cursor.com\"\nheader = {}\ndata = {}\nsilent\nshow-error\n\
         write-out = \"\\n%{{http_code}}\"\n",
        quoted(URL),
        quoted(&format!("Cookie: {cookie}")),
        quoted(&body),
    ));
    let home = std::env::home_dir().filter(|home| home.is_absolute() && home.is_dir());
    let mut spec = ProcessSpec::new("curl", home.unwrap_or_else(|| PathBuf::from("/")));
    // `-q` first, so no `.curlrc` applies: one with `trace-ascii` would write the cookie to disk.
    spec.args = vec!["-q".into(), "-K".into(), "-".into()];
    spec.stdin = StdinMode::Piped;
    let ran = run_spec(launcher, &spec, config.as_bytes(), PAGE_TIMEOUT)
        .await
        .map_err(|error| format!("Couldn't ask Cursor for its usage: {error}."))?;
    if ran.exit_code != Some(0) {
        let why = ran
            .stderr_tail
            .trim()
            .lines()
            .last()
            .unwrap_or("curl failed");
        return Err(format!("Couldn't reach cursor.com: {why}"));
    }
    let (json, status) = ran
        .stdout
        .trim_end()
        .rsplit_once('\n')
        .unwrap_or(("", ran.stdout.trim()));
    match status {
        "200" => serde_json::from_str(json)
            .map_err(|_| "Cursor's usage API answered in a way plxd can't read.".to_owned()),
        "401" | "403" => Err(
            "Cursor's sign-in on this host has expired. Open Cursor to sign in again.".to_owned(),
        ),
        status => Err(format!("Cursor's usage API answered HTTP {status}.")),
    }
}

/// Events summed by local day in `zone` and model, leaving out those that used and cost nothing.
/// Cost is the event's token cost, else what was charged for it.
fn rows(events: Vec<Event>, zone: &TimeZone) -> Vec<UsageDay> {
    let mut days: BTreeMap<(Date, String), UsageDay> = BTreeMap::new();
    for event in events {
        let Some(at) = event
            .timestamp
            .parse()
            .ok()
            .and_then(|ms| Timestamp::from_millisecond(ms).ok())
        else {
            continue;
        };
        let tokens = event.token_usage.unwrap_or_default();
        let cents = tokens.total_cents.or(event.charged_cents);
        let counted = tokens.input_tokens
            + tokens.output_tokens
            + tokens.cache_read_tokens
            + tokens.cache_write_tokens;
        // Such as a request that errored.
        if counted == 0 && cents.unwrap_or(0.0) <= 0.0 {
            continue;
        }
        let date = at.to_zoned(zone.clone()).date();
        let day = days
            .entry((date, event.model.clone()))
            .or_insert_with(|| UsageDay {
                date,
                agent: CliKind::Cursor,
                model: event.model,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_usd_micros: None,
            });
        day.input_tokens += tokens.input_tokens;
        day.output_tokens += tokens.output_tokens;
        day.cache_read_tokens += tokens.cache_read_tokens;
        day.cache_write_tokens += tokens.cache_write_tokens;
        if let Some(micros) = cents.and_then(|cents| usd_micros(cents / 100.0)) {
            day.cost_usd_micros = Some(day.cost_usd_micros.unwrap_or(0) + micros);
        }
    }
    days.into_values().collect()
}

#[cfg(test)]
mod tests {
    use jiff::civil::date;
    use jiff::tz::TimeZone;
    use parallax_protocol::{CliKind, UsageDay};

    use super::{Page, last_page, rows, user_id};

    #[test]
    fn the_user_id_comes_from_the_tokens_subject() {
        // {"sub":"auth0|user_01ABC","exp":1}, base64url without its padding.
        let token = "e30.eyJzdWIiOiJhdXRoMHx1c2VyXzAxQUJDIiwiZXhwIjoxfQ.sig";
        assert_eq!(user_id(token).as_deref(), Some("user_01ABC"));
        assert_eq!(user_id("not-a-jwt"), None);
    }

    #[test]
    fn paging_ends_on_an_empty_page_or_the_total_not_a_short_page() {
        // No total, and fewer events than asked for: the API may cap the page size.
        assert!(!last_page(100, 100, None));
        assert!(last_page(0, 100, None));
        assert!(!last_page(100, 100, Some(250)));
        assert!(last_page(50, 250, Some(250)));
    }

    #[test]
    fn events_sum_by_local_day_and_model_with_token_cost_before_charged_cost() {
        let page: Page = serde_json::from_str(
            r#"{
              "totalUsageEventsCount": 5,
              "usageEventsDisplay": [
                { "timestamp": "1790973140132", "model": "composer-2.5", "chargedCents": 0,
                  "tokenUsage": { "inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 100, "totalCents": 6.5 } },
                { "timestamp": "1790973110215", "model": "composer-2.5", "chargedCents": 8,
                  "tokenUsage": { "inputTokens": 20, "outputTokens": 2, "cacheWriteTokens": 5 } },
                { "timestamp": "1790900000000", "model": "composer-2.5", "tokenUsage": { "outputTokens": 4 } },
                { "timestamp": "1790973000000", "model": "composer-2.5", "kind": "ERRORED", "chargedCents": 0 },
                { "timestamp": "1790973105818", "model": "gpt-6", "tokenUsage": { "inputTokens": 1 } }
              ]
            }"#,
        )
        .unwrap();
        let day = |date, model: &str, tokens: [u64; 4], cost| UsageDay {
            date,
            agent: CliKind::Cursor,
            model: model.to_owned(),
            input_tokens: tokens[0],
            output_tokens: tokens[1],
            cache_read_tokens: tokens[2],
            cache_write_tokens: tokens[3],
            cost_usd_micros: cost,
        };
        // 1790973140132 is 2026-10-02 13:32 in Los Angeles; 1790900000000 is 2026-10-02 00:13
        // UTC, but 17:13 the day before there.
        let zone = TimeZone::get("America/Los_Angeles").unwrap();
        assert_eq!(
            rows(page.usage_events_display, &zone),
            [
                day(date(2026, 10, 1), "composer-2.5", [0, 4, 0, 0], None),
                day(
                    date(2026, 10, 2),
                    "composer-2.5",
                    [30, 3, 100, 5],
                    Some(145_000)
                ),
                day(date(2026, 10, 2), "gpt-6", [1, 0, 0, 0], None),
            ]
        );
    }
}
