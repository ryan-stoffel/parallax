//! Issue trackers (0107, PLX-1594): the `issue/*` methods, behind the `issues` capability. Each
//! method finds its connection and hands the call to that tracker's module.
//!
//! - GitHub ([`github`]) is the computer's `gh` sign-in (0050), with id `github` and no store row.
//! - Linear ([`linear`]) and Jira Cloud ([`jira`]) are rows of `issue_connections`, saved by
//!   `issue/connect` once the tracker accepts the token. The token is in the host's keystore under
//!   the row's id, as a saved secret's value is (0106), and goes to `curl` on stdin ([`request`]),
//!   never in its arguments, the store, or a log. A host with no keystore (Windows, PLX-23)
//!   refuses `issue/connect`.

mod github;
mod jira;
mod linear;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use parallax_protocol::jsonrpc::{ErrorObject, INTERNAL_ERROR};
use parallax_protocol::{
    AccountId, Issue, IssueComment, IssueCommentParams, IssueConnectParams, IssueConnectResult,
    IssueConnection, IssueConnectionError, IssueConnectionsResult, IssueContainersParams,
    IssueContainersResult, IssueCreateParams, IssueDetail, IssueDisconnectParams,
    IssueDisconnectResult, IssueGetParams, IssueListParams, IssueListResult, IssueProvider,
    IssueSetStateParams,
};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::backend::process::{Launcher, ProcessSpec, StdinMode};
use crate::detect::run_spec;
use crate::server::Daemon;
use crate::store::store_error;

/// GitHub's connection id.
const GITHUB: &str = "github";

/// How long one call to a tracker may take.
const TIMEOUT: Duration = Duration::from_secs(30);

/// A connection, with what it takes to call its tracker.
enum Tracker {
    Github,
    Linear(linear::Linear),
    Jira(jira::Jira),
}

/// A tracker's failure, for the user, as the error of the method that called it.
fn failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(INTERNAL_ERROR, message)
}

/// `issue/connections`: see the module documentation.
pub(crate) async fn connections(daemon: &Daemon) -> Result<IssueConnectionsResult, ErrorObject> {
    let status = daemon.cli_detector.github().await;
    let github = (status.signed_in == Some(true)).then(|| IssueConnection {
        id: GITHUB.to_owned(),
        provider: IssueProvider::Github,
        account: status.account.unwrap_or_default(),
        site: None,
    });
    let saved = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.issue_connections().map_err(|e| store_error(&e))
        })
        .await?;
    let saved = saved.into_iter().filter_map(|row| {
        let provider = match row.provider.as_str() {
            "linear" => IssueProvider::Linear,
            "jira" => IssueProvider::Jira,
            _ => return None,
        };
        Some(IssueConnection {
            id: row.id.hyphenated().to_string(),
            provider,
            account: row.account,
            site: (!row.site.is_empty()).then_some(row.site),
        })
    });
    Ok(IssueConnectionsResult {
        connections: github.into_iter().chain(saved).collect(),
    })
}

/// `issue/connect`: checks the token with the tracker, keeps it in the keystore, then records the
/// account by the tracker's stable ids for it. An account saved before keeps its id and gets the
/// new token and names.
pub(crate) async fn connect(
    daemon: &Daemon,
    params: IssueConnectParams,
) -> Result<IssueConnectResult, ErrorObject> {
    crate::secrets::need_keystore()?;
    let launcher = daemon.cli_detector.launcher();
    let (provider, name, identity, site, account, token) = match params {
        IssueConnectParams::Linear { api_key } => {
            let key = Zeroizing::new(api_key);
            let key = Zeroizing::new(key.trim().to_owned());
            check_token(&key, "API key")?;
            let (identity, account, site) = linear::check(launcher, &key).await?;
            (
                IssueProvider::Linear,
                "linear",
                identity,
                site,
                account,
                key,
            )
        }
        IssueConnectParams::Jira {
            site,
            email,
            api_token,
        } => {
            let token = Zeroizing::new(api_token);
            let token = Zeroizing::new(token.trim().to_owned());
            check_token(&token, "API token")?;
            let site = jira::normalize_site(&site).map_err(ErrorObject::invalid_params)?;
            let email = email.trim().to_owned();
            if email.is_empty() || email.chars().any(char::is_control) || email.contains(':') {
                return Err(ErrorObject::invalid_params(
                    "the email must be one line with no colon",
                ));
            }
            let (identity, account) = jira::check(launcher, &site, &email, &token).await?;
            (IssueProvider::Jira, "jira", identity, site, account, token)
        }
    };
    let key = AccountId::generate();
    set_token(daemon, key, Zeroizing::new(token.to_string())).await?;
    let (store_site, store_account) = (site.clone(), account.clone());
    let saved = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.save_issue_connection(key.into(), name, &identity, &store_account, &store_site)
                .map_err(|e| store_error(&e))
        })
        .await;
    let kept = match saved {
        Ok(kept) => kept,
        Err(error) => {
            forget(daemon, key).await;
            return Err(error);
        }
    };
    // Already saved: its id keeps the new token.
    if kept != Uuid::from(key) {
        let result = match AccountId::try_from(kept) {
            Ok(earlier) => set_token(daemon, earlier, token).await,
            Err(_) => Err(ErrorObject::internal_error(
                "a saved connection's id is corrupt",
            )),
        };
        forget(daemon, key).await;
        result?;
    }
    Ok(IssueConnectResult {
        connection: IssueConnection {
            id: kept.hyphenated().to_string(),
            provider,
            account,
            site: Some(site),
        },
    })
}

/// `issue/disconnect`: removes a saved connection's token, then its row, so a keystore that can't
/// be written keeps both for another try. `github` and an unknown id change nothing.
pub(crate) async fn disconnect(
    daemon: &Daemon,
    params: IssueDisconnectParams,
) -> Result<IssueDisconnectResult, ErrorObject> {
    let Some(id) = Uuid::try_parse(&params.id).ok() else {
        return Ok(IssueDisconnectResult {});
    };
    // The keystore also holds API keys and secrets, so only a saved connection's id reaches it.
    let saved = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.issue_connection(id).map_err(|e| store_error(&e))
        })
        .await?;
    let (Some(_), Ok(key)) = (saved, AccountId::try_from(id)) else {
        return Ok(IssueDisconnectResult {});
    };
    let keys = Arc::clone(&daemon.keys);
    tokio::task::spawn_blocking(move || keys.delete(key))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
        .map_err(|error| crate::methods::keychain_error(&error))?;
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.delete_issue_connection(id).map_err(|e| store_error(&e))
        })
        .await?;
    Ok(IssueDisconnectResult {})
}

/// `issue/list`: every connection's at once, or one's. A connection that fails is in `errors`,
/// and the rest still answer. An unknown `connectionId` is refused.
pub(crate) async fn list(
    daemon: &Daemon,
    params: IssueListParams,
) -> Result<IssueListResult, ErrorObject> {
    let launcher = daemon.cli_detector.launcher();
    let reads = if let Some(id) = params.connection_id {
        let tracker = tracker(daemon, &id).await?;
        vec![(id, list_one(launcher, tracker).await)]
    } else {
        let ids = connections(daemon).await?.connections;
        join_all(ids.into_iter().map(|connection| async move {
            let read = match tracker(daemon, &connection.id).await {
                Ok(tracker) => list_one(launcher, tracker).await,
                Err(error) => Err(error),
            };
            (connection.id, read)
        }))
        .await
    };
    Ok(gather(reads))
}

/// Each connection's issues, most recently updated first, and each failure in `errors`.
fn gather(reads: Vec<(String, Result<Vec<Issue>, ErrorObject>)>) -> IssueListResult {
    let mut result = IssueListResult {
        issues: Vec::new(),
        errors: Vec::new(),
    };
    for (connection_id, read) in reads {
        match read {
            Ok(issues) => result.issues.extend(issues),
            Err(error) => result.errors.push(IssueConnectionError {
                connection_id,
                message: error.message,
            }),
        }
    }
    result
        .issues
        .sort_by_key(|issue| std::cmp::Reverse(issue.updated_at));
    result
}

async fn list_one(launcher: &Launcher, tracker: Tracker) -> Result<Vec<Issue>, ErrorObject> {
    match tracker {
        Tracker::Github => github::list(launcher).await,
        Tracker::Linear(linear) => linear.list(launcher).await,
        Tracker::Jira(jira) => jira.list(launcher).await,
    }
}

/// `issue/get`.
pub(crate) async fn get(
    daemon: &Daemon,
    params: IssueGetParams,
) -> Result<IssueDetail, ErrorObject> {
    let launcher = daemon.cli_detector.launcher();
    match tracker(daemon, &params.connection_id).await? {
        Tracker::Github => github::get(launcher, &params.id).await,
        Tracker::Linear(linear) => linear.get(launcher, &params.id).await,
        Tracker::Jira(jira) => jira.get(launcher, &params.id).await,
    }
}

/// `issue/containers`.
pub(crate) async fn containers(
    daemon: &Daemon,
    params: IssueContainersParams,
) -> Result<IssueContainersResult, ErrorObject> {
    let launcher = daemon.cli_detector.launcher();
    let containers = match tracker(daemon, &params.connection_id).await? {
        Tracker::Github => github::containers(launcher).await,
        Tracker::Linear(linear) => linear.containers(launcher).await,
        Tracker::Jira(jira) => jira.containers(launcher).await,
    }?;
    Ok(IssueContainersResult { containers })
}

/// `issue/create`: files an issue assigned to you, and answers with it.
pub(crate) async fn create(
    daemon: &Daemon,
    params: IssueCreateParams,
) -> Result<Issue, ErrorObject> {
    let title = params.title.trim();
    if title.is_empty() {
        return Err(ErrorObject::invalid_params("the title must not be empty"));
    }
    let (container, body) = (params.container_id.as_str(), params.body.trim());
    let launcher = daemon.cli_detector.launcher();
    match tracker(daemon, &params.connection_id).await? {
        Tracker::Github => github::create(launcher, container, title, body).await,
        Tracker::Linear(linear) => linear.create(launcher, container, title, body).await,
        Tracker::Jira(jira) => jira.create(launcher, container, title, body).await,
    }
}

/// `issue/setState`: moves an issue, and answers with it as it is now.
pub(crate) async fn set_state(
    daemon: &Daemon,
    params: IssueSetStateParams,
) -> Result<Issue, ErrorObject> {
    let (id, state) = (params.id.as_str(), params.state_id.as_str());
    let launcher = daemon.cli_detector.launcher();
    match tracker(daemon, &params.connection_id).await? {
        Tracker::Github => github::set_state(launcher, id, state).await,
        Tracker::Linear(linear) => linear.set_state(launcher, id, state).await,
        Tracker::Jira(jira) => jira.set_state(launcher, id, state).await,
    }
}

/// `issue/comment`.
pub(crate) async fn comment(
    daemon: &Daemon,
    params: IssueCommentParams,
) -> Result<IssueComment, ErrorObject> {
    let body = params.body.trim();
    if body.is_empty() {
        return Err(ErrorObject::invalid_params("the comment must not be empty"));
    }
    let launcher = daemon.cli_detector.launcher();
    match tracker(daemon, &params.connection_id).await? {
        Tracker::Github => github::comment(launcher, &params.id, body).await,
        Tracker::Linear(linear) => linear.comment(launcher, &params.id, body).await,
        Tracker::Jira(jira) => jira.comment(launcher, &params.id, body).await,
    }
}

/// Connection `id`, with its token from the keystore.
async fn tracker(daemon: &Daemon, id: &str) -> Result<Tracker, ErrorObject> {
    if id == GITHUB {
        return Ok(Tracker::Github);
    }
    let unknown = || ErrorObject::invalid_params(format!("{id:?} is not an issue connection"));
    let uuid = Uuid::try_parse(id).map_err(|_| unknown())?;
    let key = AccountId::try_from(uuid).map_err(|_| unknown())?;
    let row = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.issue_connection(uuid).map_err(|e| store_error(&e))
        })
        .await?
        .ok_or_else(unknown)?;
    let keys = Arc::clone(&daemon.keys);
    let token = tokio::task::spawn_blocking(move || keys.get(key))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
        .map_err(|error| crate::methods::keychain_error(&error))?;
    let gone = |name: &str| {
        failed(format!(
            "This computer's keychain no longer has the {name} token. Connect it again in \
             Settings › Issue trackers."
        ))
    };
    match row.provider.as_str() {
        "linear" => Ok(Tracker::Linear(linear::Linear {
            id: id.to_owned(),
            key: token.ok_or_else(|| gone("Linear"))?,
        })),
        "jira" => Ok(Tracker::Jira(jira::Jira {
            id: id.to_owned(),
            site: row.site,
            email: row.account,
            token: token.ok_or_else(|| gone("Jira"))?,
        })),
        _ => Err(unknown()),
    }
}

/// Refuses an empty token, or one that can't go in a header.
fn check_token(token: &str, what: &str) -> Result<(), ErrorObject> {
    if token.is_empty() || token.chars().any(char::is_control) {
        return Err(ErrorObject::invalid_params(format!(
            "the {what} must be one line"
        )));
    }
    Ok(())
}

/// Keeps `token` in the keystore under `key`.
async fn set_token(
    daemon: &Daemon,
    key: AccountId,
    token: Zeroizing<String>,
) -> Result<(), ErrorObject> {
    let keys = Arc::clone(&daemon.keys);
    tokio::task::spawn_blocking(move || keys.set(key, &token))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
        .map_err(|error| crate::methods::keychain_error(&error))
}

/// Removes `key` from the keystore, logging a failure.
async fn forget(daemon: &Daemon, key: AccountId) {
    let keys = Arc::clone(&daemon.keys);
    let removed = tokio::task::spawn_blocking(move || keys.delete(key)).await;
    if !matches!(removed, Ok(Ok(()))) {
        warn!("could not remove an issue tracker's token from the keystore");
    }
}

/// A tracker's HTTP answer.
struct Answer {
    status: u16,
    body: String,
}

impl Answer {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// `curl`'s config for one request: `auth` is the `Authorization` header's value and `body` is
/// JSON. A quoted value takes backslash escapes, so `\` and `"` are escaped.
fn curl_config(method: &str, url: &str, auth: &str, body: Option<&str>) -> Zeroizing<String> {
    // Written in place, with room for every escape, so no copy of the token outlives the config.
    let size = url.len() + auth.len() + body.map_or(0, str::len);
    let mut config = Zeroizing::new(String::with_capacity(2 * size + 256));
    let mut line = |key: &str, parts: &[&str]| {
        config.push_str(key);
        config.push_str(" = \"");
        for part in parts {
            for c in part.chars() {
                if matches!(c, '\\' | '"') {
                    config.push('\\');
                }
                config.push(c);
            }
        }
        config.push_str("\"\n");
    };
    line("url", &[url]);
    line("request", &[method]);
    line("header", &["Authorization: ", auth]);
    line("header", &["Accept: application/json"]);
    if let Some(body) = body {
        line("header", &["Content-Type: application/json"]);
        // `data-raw`, so a body can't name a file with `@`.
        line("data-raw", &[body]);
    }
    config.push_str("silent\nshow-error\nwrite-out = \"\\n%{http_code}\"\n");
    config
}

/// Sends one request to `tracker` (its name, for errors) through `curl`, with the config, and so
/// the token, on stdin.
async fn request(
    launcher: &Launcher,
    tracker: &str,
    method: &str,
    url: &str,
    auth: &str,
    body: Option<&serde_json::Value>,
) -> Result<Answer, ErrorObject> {
    let body = body.map(serde_json::Value::to_string);
    let config = curl_config(method, url, auth, body.as_deref());
    let home = std::env::home_dir().filter(|home| home.is_absolute() && home.is_dir());
    let mut spec = ProcessSpec::new("curl", home.unwrap_or_else(|| PathBuf::from("/")));
    // `-q` first, so no `.curlrc` applies: one with `trace-ascii` would write the token to disk.
    spec.args = vec!["-q".into(), "-K".into(), "-".into()];
    spec.stdin = StdinMode::Piped;
    let ran = run_spec(launcher, &spec, config.as_bytes(), TIMEOUT)
        .await
        .map_err(|error| failed(format!("Couldn't reach {tracker}: {error}.")))?;
    if ran.exit_code != Some(0) {
        let why = crate::github::last_line(&ran.stderr_tail);
        return Err(failed(format!("Couldn't reach {tracker}: {why}")));
    }
    let (body, status) = ran
        .stdout
        .trim_end()
        .rsplit_once('\n')
        .unwrap_or(("", ran.stdout.trim()));
    let status = status
        .parse()
        .map_err(|_| failed(format!("{tracker} answered in a way plxd can't read.")))?;
    Ok(Answer {
        status,
        body: body.to_owned(),
    })
}

/// `body` as `T`, or an error naming `tracker`.
fn parse<T: serde::de::DeserializeOwned>(tracker: &str, body: &str) -> Result<T, ErrorObject> {
    serde_json::from_str(body).map_err(|error| {
        warn!(%error, tracker, "could not read an issue tracker's answer");
        failed(format!("{tracker} answered in a way plxd can't read."))
    })
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use parallax_protocol::{
        Issue, IssueConnectionError, IssueContainer, IssueProvider, IssueState, IssueStateCategory,
    };

    use super::{curl_config, failed, gather};

    fn issue(connection: &str, key: &str, updated: i64) -> Issue {
        Issue {
            connection_id: connection.to_owned(),
            provider: IssueProvider::Linear,
            id: key.to_owned(),
            key: key.to_owned(),
            title: key.to_owned(),
            url: String::new(),
            state: IssueState {
                id: "s".to_owned(),
                name: "Todo".to_owned(),
                category: IssueStateCategory::Todo,
                color: None,
            },
            container: IssueContainer {
                id: "t".to_owned(),
                name: "Team".to_owned(),
            },
            assignee: None,
            updated_at: Timestamp::from_second(updated).unwrap(),
        }
    }

    /// One connection's failure is in `errors`, and the others' issues still come, newest first.
    #[test]
    fn a_failing_connection_is_an_error_beside_the_others_issues() {
        let result = gather(vec![
            ("a".to_owned(), Ok(vec![issue("a", "A-1", 100)])),
            ("b".to_owned(), Err(failed("Linear refused the API key."))),
            (
                "c".to_owned(),
                Ok(vec![issue("c", "C-1", 200), issue("c", "C-2", 50)]),
            ),
        ]);
        let keys: Vec<_> = result.issues.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["C-1", "A-1", "C-2"]);
        assert_eq!(
            result.errors,
            [IssueConnectionError {
                connection_id: "b".to_owned(),
                message: "Linear refused the API key.".to_owned(),
            }]
        );
    }

    /// The token goes in the config, never the arguments, and a body's quotes and backslashes
    /// survive curl's unquoting.
    #[test]
    fn a_request_carries_its_token_and_body_in_curl_config() {
        let config = curl_config(
            "POST",
            "https://api.linear.app/graphql",
            "lin_api_secret",
            Some(r#"{"query":"a \"b\"\nc"}"#),
        );
        let expected = concat!(
            r#"url = "https://api.linear.app/graphql""#,
            "\n",
            r#"request = "POST""#,
            "\n",
            r#"header = "Authorization: lin_api_secret""#,
            "\n",
            r#"header = "Accept: application/json""#,
            "\n",
            r#"header = "Content-Type: application/json""#,
            "\n",
            r#"data-raw = "{\"query\":\"a \\\"b\\\"\\nc\"}""#,
            "\nsilent\nshow-error\n",
            r#"write-out = "\n%{http_code}""#,
            "\n",
        );
        assert_eq!(config.as_str(), expected);
    }
}
