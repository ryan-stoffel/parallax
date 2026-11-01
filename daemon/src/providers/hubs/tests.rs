//! Hubs against a stand-in `CLIProxyAPI`: a local HTTP server that answers `/v1/models` and the
//! management routes plxd calls, through the real `curl`, and a fake `codex app-server` that
//! records what a hub's Codex run gets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use parallax_protocol::{HubsSaveParams, ProviderKind};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::{ACCESS, KEY_VAR, claude_id, codex_id};
use crate::backend::process::{Environment, Launcher};
use crate::keystore::{KeyStore, MemoryKeyStore};
use crate::paths::DataDir;
use crate::providers::{Providers, Stored, full_env, tests::instance};
use crate::routing::BackendRegistry;

const ACCESS_KEY: &str = "hub-access-key";
const MANAGEMENT_KEY: &str = "hub-management-key";
/// A token a hub's answer can hold, which no error may repeat.
const LEAKED: &str = "sk-ant-oat-leaked";

/// One request the stand-in took.
#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    auth: Option<String>,
    body: Value,
}

/// A stand-in hub on a free local port, answering with `answer`, which also sees the requests
/// before it.
struct Hub {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Hub {
    async fn start(answer: fn(&Request, &[Request]) -> (u16, Value)) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let kept = Arc::clone(&kept);
                tokio::spawn(async move {
                    let (read, mut write) = socket.into_split();
                    let mut read = BufReader::new(read);
                    let mut line = String::new();
                    read.read_line(&mut line).await.unwrap();
                    let mut words = line.split_whitespace();
                    let method = words.next().unwrap().to_owned();
                    let path = words.next().unwrap().to_owned();
                    let mut headers = HashMap::new();
                    loop {
                        line.clear();
                        read.read_line(&mut line).await.unwrap();
                        let Some((name, value)) = line.trim_end().split_once(": ") else {
                            break;
                        };
                        headers.insert(name.to_ascii_lowercase(), value.to_owned());
                    }
                    let length = headers
                        .get("content-length")
                        .map_or(0, |length| length.parse().unwrap());
                    let mut body = vec![0; length];
                    read.read_exact(&mut body).await.unwrap();
                    let request = Request {
                        method,
                        path,
                        auth: headers.get("authorization").cloned(),
                        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                    };
                    let (status, answer) = {
                        let mut kept = kept.lock().unwrap();
                        let answered = answer(&request, &kept);
                        kept.push(request);
                        answered
                    };
                    let text = answer.to_string();
                    let head = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n",
                        text.len()
                    );
                    write.write_all(head.as_bytes()).await.unwrap();
                    write.write_all(text.as_bytes()).await.unwrap();
                });
            }
        });
        Self { url, requests }
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

/// `CLIProxyAPI`'s answers, in the shapes it sends: two Claude models and two others, a Claude, a
/// Codex, a disabled Codex, and a Gemini account, and each account's usage through `api-call`.
fn cliproxy(request: &Request, _: &[Request]) -> (u16, Value) {
    let management = request.auth.as_deref() == Some(&format!("Bearer {MANAGEMENT_KEY}"));
    match request.path.as_str() {
        "/v1/models" if request.auth.as_deref() == Some(&format!("Bearer {ACCESS_KEY}")) => (
            200,
            json!({"object": "list", "data": [
                {"id": "claude-opus-5-5", "object": "model", "owned_by": "anthropic"},
                {"id": "claude-sonnet-5-5", "object": "model", "owned_by": "anthropic"},
                {"id": "gpt-6-sol", "object": "model", "owned_by": "openai"},
                {"id": "gemini-3-pro", "object": "model", "owned_by": "google"},
            ]}),
        ),
        "/v0/management/auth-files" if management => (
            200,
            json!({"files": [
                {"id": "claude-ada.json", "auth_index": "1", "provider": "claude",
                 "email": "ada@example.com", "disabled": false},
                {"id": "codex-ada.json", "auth_index": "2", "provider": "codex",
                 "email": "ada@example.com",
                 "id_token": {"chatgpt_account_id": "ws-1", "plan_type": "plus"}},
                {"id": "codex-old.json", "auth_index": "3", "provider": "codex", "disabled": true},
                {"id": "gemini.json", "auth_index": "4", "provider": "gemini"},
            ]}),
        ),
        "/v0/management/api-call" if management => {
            if request.body["url"] == super::CLAUDE_PROFILE {
                let profile = json!({"organization": {"organization_type": "claude_max"}});
                return (
                    200,
                    json!({"status_code": 200, "body": profile.to_string()}),
                );
            }
            let usage = match request.body["auth_index"].as_str() {
                Some("1") => json!({
                    "five_hour": {"utilization": 42.0, "resets_at": "2026-10-27T03:00:00Z"},
                    "seven_day": {"utilization": 10.0, "resets_at": null},
                    "limits": [{"kind": "weekly_scoped", "percent": 7.0,
                                "resets_at": "2026-10-30T00:00:00Z",
                                "scope": {"model": {"display_name": "Fable"}}}],
                }),
                Some("2") => json!({
                    "plan_type": "pro",
                    "rate_limit": {
                        "primary_window": {"used_percent": 55.0, "reset_at": 1_793_000_000,
                                           "limit_window_seconds": 18_000},
                        "secondary_window": {"used_percent": 20.0, "reset_at": null,
                                             "limit_window_seconds": 604_800},
                    },
                }),
                _ => return (200, json!({"status_code": 404, "body": LEAKED})),
            };
            (200, json!({"status_code": 200, "body": usage.to_string()}))
        }
        _ => (401, json!({"error": LEAKED})),
    }
}

/// The folder on this process's `PATH` that has `curl`: `/usr/bin` on macOS and Linux, and
/// `System32` on Windows.
fn curl_folder() -> std::path::PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .find(|dir| dir.join("curl").is_file() || dir.join("curl.exe").is_file())
        .expect("curl on PATH")
}

/// Providers in `dir`, on a launcher whose `PATH` is only [`curl_folder`], so no agent is found
/// there, and that runs no Claude Agent SDK install.
fn load(dir: &std::path::Path) -> (Providers, BackendRegistry, Arc<MemoryKeyStore>) {
    // No built-in instances, which a first run would add and probe.
    std::fs::write(dir.join("providers.json"), "[]").unwrap();
    // Windows' curl can't open a socket without SYSTEMROOT.
    let root = std::env::var("SYSTEMROOT").ok();
    let base: Environment = [
        ("PATH", curl_folder().display().to_string()),
        (
            crate::backend::claude::sdk::OVERRIDE_ENV,
            "unused".to_owned(),
        ),
    ]
    .into_iter()
    .chain(root.map(|root| ("SYSTEMROOT", root)))
    .collect();
    let launcher = Launcher::new(DataDir::new(dir.join("data")).unwrap(), base);
    let registry = BackendRegistry::new();
    let keys = Arc::new(MemoryKeyStore::new());
    let providers = Providers::load(dir, Arc::clone(&keys) as _, &launcher, &registry);
    (providers, registry, keys)
}

fn hub(url: &str) -> HubsSaveParams {
    HubsSaveParams {
        id: "home".into(),
        name: "Home hub".into(),
        url: format!("{url}/"),
        enabled: true,
        access_key: Some(ACCESS_KEY.into()),
        management_key: Some(MANAGEMENT_KEY.into()),
    }
}

async fn entry(providers: &Providers, id: &str) -> Stored {
    providers
        .entries()
        .await
        .into_iter()
        .find(|entry| entry.instance.id == id)
        .unwrap()
}

#[tokio::test]
async fn a_hub_keeps_its_keys_in_the_keychain_and_runs_two_instances_through_it() {
    let dir = tempfile::tempdir().unwrap();
    let (providers, registry, keys) = load(dir.path());
    providers
        .save_hub(hub("https://hub.example:8317"))
        .await
        .unwrap();

    let file = std::fs::read_to_string(dir.path().join("hubs.json")).unwrap();
    assert!(!file.contains(ACCESS_KEY) && !file.contains(MANAGEMENT_KEY));
    let listed = serde_json::to_string(&providers.hubs(false).await).unwrap();
    assert!(!listed.contains(ACCESS_KEY) && !listed.contains(MANAGEMENT_KEY));
    assert!(listed.contains("\"url\":\"https://hub.example:8317\""));

    let claude = entry(&providers, &claude_id("home")).await;
    assert_eq!(claude.instance.kind, ProviderKind::Claude);
    assert_eq!(claude.instance.name, "Home hub");
    assert_eq!(
        full_env(keys.as_ref(), &claude),
        [
            (
                "ANTHROPIC_BASE_URL".into(),
                "https://hub.example:8317".into()
            ),
            ("ANTHROPIC_AUTH_TOKEN".into(), ACCESS_KEY.into()),
        ]
    );
    let codex = entry(&providers, &codex_id("home")).await;
    assert_eq!(
        full_env(keys.as_ref(), &codex),
        [(KEY_VAR.into(), ACCESS_KEY.into())]
    );
    for id in [claude_id("home"), codex_id("home")] {
        assert_eq!(registry.by_backend_name(&id).unwrap().1.name(), id);
        assert!(providers.remove(&id).await.is_err(), "edited only as a hub");
    }

    // Saved again without keys, it keeps them; an empty management key removes that one.
    let mut edited = hub("https://hub.example:8317");
    edited.access_key = None;
    edited.management_key = Some(String::new());
    edited.enabled = false;
    providers.save_hub(edited).await.unwrap();
    let secrets = super::read_secrets(keys.as_ref(), codex.secrets);
    assert_eq!(secrets.get(ACCESS).map(String::as_str), Some(ACCESS_KEY));
    assert_eq!(secrets.len(), 1);
    assert!(
        registry.by_backend_name(&claude_id("home")).is_none(),
        "off"
    );
    assert!(providers.entries().await.iter().all(|e| e.hub.is_none()));

    providers.remove_hub("home").await.unwrap();
    assert!(providers.hubs(false).await.is_empty());
    assert!(keys.get(codex.secrets.unwrap()).unwrap().is_none());
}

#[tokio::test]
async fn a_hub_instance_id_cant_be_another_providers() {
    let dir = tempfile::tempdir().unwrap();
    let (providers, _, _) = load(dir.path());
    let mut taken = instance("home-codex", ProviderKind::Codex, "Codex");
    providers.save(taken.clone()).await.unwrap();
    assert!(
        providers
            .save_hub(hub("https://hub.example"))
            .await
            .is_err()
    );

    taken.id = "other".into();
    providers.save(taken).await.unwrap();
    providers.remove("home-codex").await.unwrap();
    providers
        .save_hub(hub("https://hub.example"))
        .await
        .unwrap();
    let claude = instance("home-claude", ProviderKind::Claude, "Claude");
    assert!(providers.save(claude).await.is_err());

    let mut bad = hub("ftp://hub.example");
    bad.id = "other-hub".into();
    assert!(providers.save_hub(bad).await.is_err());
    let mut new = hub("https://hub.example");
    new.id = "new".into();
    new.access_key = None;
    assert!(
        providers.save_hub(new).await.is_err(),
        "a new hub needs a key"
    );
}

#[tokio::test]
async fn a_hub_lists_its_models_accounts_and_limits_through_curl() {
    let stand_in = Hub::start(cliproxy).await;
    let dir = tempfile::tempdir().unwrap();
    let (providers, _, _) = load(dir.path());
    providers.save_hub(hub(&stand_in.url)).await.unwrap();

    let listed = providers.hubs(true).await;
    let listed = &listed[0];
    assert!(listed.reachable, "{:?}", listed.problem);
    let ids = |models: &[parallax_protocol::ProviderModel]| -> Vec<String> {
        models.iter().map(|m| m.id.clone()).collect()
    };
    assert_eq!(
        ids(&listed.claude_models),
        ["claude-opus-5-5", "claude-sonnet-5-5"]
    );
    assert_eq!(ids(&listed.codex_models), ["gpt-6-sol", "gemini-3-pro"]);
    assert_eq!(listed.accounts_problem, None);

    let accounts = &listed.accounts;
    let windows = |i: usize| -> Vec<(String, Option<f64>)> {
        accounts[i]
            .limits
            .iter()
            .map(|w| (w.window.clone(), w.used_percent))
            .collect()
    };
    assert_eq!(accounts.len(), 4);
    assert_eq!(accounts[0].email.as_deref(), Some("ada@example.com"));
    assert_eq!(
        windows(0),
        [
            ("five_hour".into(), Some(42.0)),
            ("seven_day".into(), Some(10.0)),
            ("seven_day_fable".into(), Some(7.0)),
        ]
    );
    assert_eq!(
        accounts[1].plan.as_deref(),
        Some("pro"),
        "the usage's plan wins"
    );
    assert_eq!(
        windows(1),
        [
            ("five_hour".into(), Some(55.0)),
            ("seven_day".into(), Some(20.0))
        ]
    );
    assert!(accounts[2].disabled && accounts[2].limits.is_empty());
    assert_eq!(
        (accounts[3].provider.as_str(), accounts[3].problem.as_ref()),
        ("gemini", None)
    );

    let requests = stand_in.requests();
    let models = requests.iter().find(|r| r.path == "/v1/models").unwrap();
    assert_eq!(
        models.auth.as_deref(),
        Some(format!("Bearer {ACCESS_KEY}").as_str())
    );
    let calls: Vec<&Request> = requests
        .iter()
        .filter(|r| r.path == "/v0/management/api-call")
        .collect();
    // Claude's usage and profile, and Codex's usage.
    assert_eq!(calls.len(), 3, "only enabled Claude and Codex accounts");
    let codex = calls.iter().find(|r| r.body["auth_index"] == "2").unwrap();
    assert_eq!(codex.method, "POST");
    assert_eq!(
        codex.body["url"],
        "https://chatgpt.com/backend-api/wham/usage"
    );
    assert_eq!(codex.body["header"]["Chatgpt-Account-Id"], "ws-1");
    assert_eq!(codex.body["header"]["Authorization"], "Bearer $TOKEN$");

    // The instances get the hub's models for their agent, and say whether it answers.
    let infos = providers
        .list(
            &crate::detect::CliDetector::new(
                providers.launcher.clone(),
                std::time::Duration::from_secs(5),
            ),
            false,
        )
        .await;
    let hub_claude = infos
        .providers
        .iter()
        .find(|p| p.instance.id == "home-claude")
        .unwrap();
    assert_eq!(hub_claude.hub.as_deref(), Some("home"));
}

#[tokio::test]
async fn a_hubs_failures_name_the_kind_and_status_but_never_the_body() {
    let stand_in = Hub::start(cliproxy).await;
    let dir = tempfile::tempdir().unwrap();
    let (providers, _, _) = load(dir.path());
    let mut wrong = hub(&stand_in.url);
    wrong.access_key = Some("wrong".into());
    wrong.management_key = Some("wrong".into());
    providers.save_hub(wrong).await.unwrap();
    let listed = &providers.hubs(true).await[0];
    assert!(!listed.reachable);
    let problem = listed.problem.clone().unwrap();
    assert!(
        problem.contains("HTTP 401") && !problem.contains(LEAKED),
        "{problem}"
    );
    let accounts = listed.accounts_problem.clone().unwrap();
    assert!(accounts.contains("HTTP 401") && !accounts.contains(LEAKED));

    // A closed port.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    providers.save_hub(hub(&url)).await.unwrap();
    let listed = &providers.hubs(true).await[0];
    assert!(!listed.reachable);
    assert_eq!(
        listed.problem.as_deref(),
        Some("Couldn't connect to the hub.")
    );
}

/// `CLIProxyAPI`'s sign-in and account routes, as its handlers answer, then [`cliproxy`]'s.
/// Sign-in `local` finishes on the second status ask, as the hub's own forwarder would catch the
/// browser; `paste` finishes once its callback is posted; `slow` times out; `cancel` is pending.
fn accounts_api(request: &Request, before: &[Request]) -> (u16, Value) {
    let management = request.auth.as_deref() == Some(&format!("Bearer {MANAGEMENT_KEY}"));
    let (route, query) = request.path.split_once('?').unwrap_or((&request.path, ""));
    let state = query.strip_prefix("state=").unwrap_or_default();
    let asked = |path: &str| before.iter().filter(|r| r.path == path).count();
    match (request.method.as_str(), route) {
        (_, route) if route.starts_with("/v0/management") && !management => {
            (401, json!({"error": LEAKED}))
        }
        ("GET", "/v0/management/anthropic-auth-url" | "/v0/management/codex-auth-url") => {
            let state = if route.contains("anthropic") {
                "local"
            } else {
                "paste"
            };
            let url = format!("https://claude.ai/oauth/authorize?code=true&state={state}");
            (200, json!({"status": "ok", "url": url, "state": state}))
        }
        ("POST", "/v0/management/oauth-callback") => match request.body["state"].as_str() {
            Some("paste") => (200, json!({"status": "ok"})),
            _ => (404, json!({"status": "error", "error": LEAKED})),
        },
        ("GET", "/v0/management/get-auth-status") => match state {
            "local" if asked(&request.path) == 0 => (200, json!({"status": "wait"})),
            "paste" if asked("/v0/management/oauth-callback") == 0 => {
                (200, json!({"status": "wait"}))
            }
            "local" | "paste" => (200, json!({"status": "ok"})),
            "slow" => (
                200,
                json!({"status": "error", "error": format!("Timeout waiting for OAuth callback {LEAKED}")}),
            ),
            _ => (
                200,
                json!({"status": "error", "error": "unknown or expired state"}),
            ),
        },
        ("DELETE", "/v0/management/oauth-session") => {
            (200, json!({"status": "ok", "cancelled": state == "cancel"}))
        }
        ("PATCH", "/v0/management/auth-files/status") | ("DELETE", "/v0/management/auth-files")
            if request.body["name"] == "claude-ada.json" =>
        {
            (200, json!({"status": "ok"}))
        }
        ("PATCH" | "DELETE", _) => (404, json!({"error": LEAKED})),
        _ => cliproxy(request, before),
    }
}

/// The kind of a Parallax error.
fn kind(error: &parallax_protocol::jsonrpc::ErrorObject) -> Value {
    error
        .data
        .as_ref()
        .map_or(Value::Null, |data| data["kind"].clone())
}

#[tokio::test]
async fn a_hub_signs_accounts_in_when_its_forwarder_catches_the_browser_or_the_address_is_pasted() {
    use parallax_protocol::{HubService, HubSignInState};
    let stand_in = Hub::start(accounts_api).await;
    let dir = tempfile::tempdir().unwrap();
    let (providers, _, _) = load(dir.path());
    providers.save_hub(hub(&stand_in.url)).await.unwrap();

    // On the hub's computer, its forwarder catches the redirect, and plxd only asks.
    let local = providers
        .hub_sign_in("home", HubService::Claude)
        .await
        .unwrap();
    assert_eq!(local.state, "local");
    assert!(local.url.starts_with("https://claude.ai/"));
    let status = |state: &'static str| providers.hub_sign_in_status("home", state);
    assert_eq!(
        status("local").await.unwrap().status,
        HubSignInState::Waiting
    );
    assert_eq!(status("local").await.unwrap().status, HubSignInState::Done);

    // Elsewhere, the address the browser landed on is pasted, and must be this sign-in's.
    let paste = providers
        .hub_sign_in("home", HubService::Codex)
        .await
        .unwrap();
    let callback =
        |address: &'static str| providers.hub_sign_in_callback("home", &paste.state, address);
    for wrong in [
        "http://localhost:1455/auth/callback?code=c&state=local",
        "http://localhost:1455/auth/callback?state=paste",
        "not an address",
    ] {
        let error = callback(wrong).await.unwrap_err();
        assert_eq!(
            error.code,
            parallax_protocol::jsonrpc::INVALID_PARAMS,
            "{wrong}"
        );
    }
    assert_eq!(
        status("paste").await.unwrap().status,
        HubSignInState::Waiting
    );
    let address = "http://localhost:1455/auth/callback?code=a-code&scope=x&state=paste";
    assert_eq!(
        callback(address).await.unwrap().status,
        HubSignInState::Waiting
    );
    assert_eq!(status("paste").await.unwrap().status, HubSignInState::Done);

    // A failure is in plxd's words, never the hub's.
    let slow = status("slow").await.unwrap();
    assert_eq!(slow.status, HubSignInState::Failed);
    assert_eq!(
        slow.problem.as_deref(),
        Some("The sign-in timed out. Start it again.")
    );
    let expired = providers
        .hub_sign_in_callback(
            "home",
            "gone",
            "http://localhost:54545/callback?code=c&state=gone",
        )
        .await
        .unwrap_err();
    assert_eq!(kind(&expired), "hubFailed");
    assert!(!expired.message.contains(LEAKED), "{}", expired.message);

    // Cancel ends a pending sign-in, and says where one that already ended is.
    let cancel = |state: &'static str| providers.hub_sign_in_cancel("home", state);
    assert_eq!(
        cancel("cancel").await.unwrap().status,
        HubSignInState::Cancelled
    );
    assert_eq!(cancel("local").await.unwrap().status, HubSignInState::Done);
    assert!(
        status("../auth-files").await.is_err(),
        "a state goes in a URL as it is"
    );

    let requests = stand_in.requests();
    let paths: Vec<(&str, &str)> = requests
        .iter()
        .map(|r| (r.method.as_str(), r.path.as_str()))
        .collect();
    assert!(paths.contains(&("GET", "/v0/management/anthropic-auth-url?is_webui=true")));
    assert!(paths.contains(&("GET", "/v0/management/codex-auth-url?is_webui=true")));
    assert!(paths.contains(&("DELETE", "/v0/management/oauth-session?state=cancel")));
    let posted = requests
        .iter()
        .find(|r| r.path == "/v0/management/oauth-callback" && r.body["state"] == "paste")
        .unwrap();
    assert_eq!(posted.body["redirect_url"], address);
    assert!(
        requests
            .iter()
            .all(|r| r.auth.as_deref() == Some(&format!("Bearer {MANAGEMENT_KEY}"))),
        "every call carries the management key"
    );
}

#[tokio::test]
async fn a_hubs_accounts_turn_off_and_on_and_are_removed() {
    let stand_in = Hub::start(accounts_api).await;
    let dir = tempfile::tempdir().unwrap();
    let (providers, _, _) = load(dir.path());
    providers.save_hub(hub(&stand_in.url)).await.unwrap();
    let listed = providers.hubs(false).await;
    assert_eq!(listed[0].accounts[0].id, "claude-ada.json");

    providers
        .set_hub_account_enabled("home", "claude-ada.json", false)
        .await
        .unwrap();
    providers
        .set_hub_account_enabled("home", "claude-ada.json", true)
        .await
        .unwrap();
    providers
        .remove_hub_account("home", "claude-ada.json")
        .await
        .unwrap();
    let missing = providers
        .remove_hub_account("home", "gone.json")
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), "hubFailed");
    assert!(missing.message.contains("HTTP 404") && !missing.message.contains(LEAKED));

    // Each change drops the cached accounts, so the next list asks again.
    providers.hubs(false).await;
    let requests = stand_in.requests();
    let sent: Vec<(&str, &Value)> = requests
        .iter()
        .filter(|r| r.path.starts_with("/v0/management/auth-files") && r.method != "GET")
        .map(|r| (r.method.as_str(), &r.body))
        .collect();
    assert_eq!(
        sent,
        [
            (
                "PATCH",
                &json!({"name": "claude-ada.json", "disabled": true})
            ),
            (
                "PATCH",
                &json!({"name": "claude-ada.json", "disabled": false})
            ),
            ("DELETE", &json!({"name": "claude-ada.json"})),
            ("DELETE", &json!({"name": "gone.json"})),
        ]
    );
    let lists = requests
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/v0/management/auth-files")
        .count();
    assert_eq!(lists, 2);

    // Without a management key, nothing is sent.
    let mut keyless = hub(&stand_in.url);
    keyless.management_key = Some(String::new());
    providers.save_hub(keyless).await.unwrap();
    let error = providers
        .set_hub_account_enabled("home", "claude-ada.json", false)
        .await
        .unwrap_err();
    assert_eq!(error.code, parallax_protocol::jsonrpc::INVALID_PARAMS);
}

#[cfg(unix)]
#[tokio::test]
async fn a_hubs_codex_run_gets_the_hub_as_its_model_provider() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let program = bin.join("codex");
    std::fs::write(
        &program,
        include_str!("../../backend/codex/fixtures/fake-app-server.sh"),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fixture = root.join("conversation.jsonl");
    std::fs::write(&fixture, "@exit 1\n").unwrap();
    let base: Environment = [
        ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
        ("FAKE_CODEX_DIR", root.display().to_string()),
        ("FAKE_CODEX_FIXTURE", fixture.display().to_string()),
    ]
    .into_iter()
    .collect();
    let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
    let registry = BackendRegistry::new();
    let keys: Arc<dyn KeyStore> = Arc::new(MemoryKeyStore::new());
    std::fs::write(root.join("providers.json"), "[]").unwrap();
    let providers = Providers::load(&root, keys, &launcher, &registry);
    providers
        .save_hub(hub("https://hub.example:8317"))
        .await
        .unwrap();

    let (_, backend) = registry.by_backend_name("home-codex").unwrap();
    let request = crate::backend::RunRequest {
        run_id: crate::backend::RunId::generate(),
        turn_id: None,
        cwd: root.clone(),
        prompt: "Hello.".into(),
        images: Vec::new(),
        policy: crate::backend::ToolPolicy::WorkspaceWrite,
        sandbox: None,
        account: crate::backend::AccountRef {
            id: "home-codex".into(),
            credential: crate::backend::Credential::Subscription { config_home: None },
        },
        resume: None,
        model: Some("gpt-6-sol".into()),
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        orchestrator_tools: None,
        thread_tools: None,
        approvals: true,
        thread: true,
        instructions: None,
    };
    let started = backend.start(request);
    let argv = root.join("argv");
    for _ in 0..200 {
        if argv.exists() && root.join("env").exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    drop(started);
    let argv = std::fs::read_to_string(argv).unwrap();
    let argv: Vec<&str> = argv.lines().collect();
    assert_eq!(
        argv,
        [
            "app-server",
            "-c",
            "model_provider=\"parallax-hub\"",
            "-c",
            "model_providers.parallax-hub.name=\"Home hub\"",
            "-c",
            "model_providers.parallax-hub.base_url=\"https://hub.example:8317/v1\"",
            "-c",
            "model_providers.parallax-hub.wire_api=\"responses\"",
            "-c",
            "model_providers.parallax-hub.requires_openai_auth=false",
            "-c",
            "model_providers.parallax-hub.supports_websockets=true",
            "-c",
            "model_providers.parallax-hub.env_key=\"PARALLAX_HUB_KEY\"",
        ]
    );
    let env = std::fs::read_to_string(root.join("env")).unwrap();
    assert!(
        env.lines()
            .any(|line| line == format!("{KEY_VAR}={ACCESS_KEY}"))
    );
}
