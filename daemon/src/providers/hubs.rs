//! `CLIProxyAPI` hubs (0089), behind `hubs/*`.
//!
//! A hub is kept in `hubs.json` in plxd's data folder, and its access key and management key in
//! the host's keychain as one JSON object, under the hub's secret id. Each enabled hub adds two
//! provider instances, which [`super::Providers`] lists and routes to like any other:
//!
//! - `<id>-claude` runs Claude Code with `ANTHROPIC_BASE_URL` at the hub and the access key as
//!   `ANTHROPIC_AUTH_TOKEN`, on the user's own Claude Code config otherwise.
//! - `<id>-codex` runs `codex app-server` with `-c` overrides that define the hub as a model
//!   provider, [`CODEX_PROVIDER`], whose `env_key` is [`KEY_VAR`], which carries the access key.
//!
//! Whether a hub answers, and its models, come from `GET <url>/v1/models` with the access key.
//! With a management key, its accounts come from `GET /v0/management/auth-files`, and each Claude
//! and Codex account's limits from `POST /v0/management/api-call`, as T3 Code reads them. Every
//! request goes through `curl` with its key on stdin. A hub's answers can hold credentials, so no
//! body is ever logged or returned: a failure names only its kind and HTTP status.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountId, Hub, HubAccount, HubsSaveParams, ProviderEnvVar, ProviderInstance, ProviderKind,
    ProviderModel, UsageLimitWindow,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::time::Instant;
use zeroize::Zeroizing;

use super::{CACHE_TTL, Stored, read_secrets};
use crate::backend::process::{Launcher, ProcessSpec, StdinMode};
use crate::detect;
use crate::keystore::KeyStore;

/// The keychain object's name for the access key, which every secret variable of a hub's
/// instances takes.
pub(super) const ACCESS: &str = "access";

/// The keychain object's name for the management key.
const MANAGEMENT: &str = "management";

/// The variable Codex reads the access key from, as its hub provider's `env_key`.
pub(super) const KEY_VAR: &str = "PARALLAX_HUB_KEY";

/// The model provider a hub's Codex instance defines with `-c` and runs on.
pub(super) const CODEX_PROVIDER: &str = "parallax-hub";

/// How long one request to a hub may take, curl's `--max-time`.
const REQUEST_SECONDS: u64 = 15;

/// The longest hub id, so its instances' ids stay within plxd's 64.
const MAX_ID: usize = 48;

/// One hub as `hubs.json` keeps it: its keys left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    /// Whether the keychain holds a management key for it.
    #[serde(default)]
    pub management: bool,
    /// Where its keys are in the keychain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<AccountId>,
}

/// Whether a hub answered `/v1/models`, and its models for each instance.
#[derive(Clone, Debug, Default)]
pub(super) struct Reach {
    pub reachable: bool,
    pub problem: Option<String>,
    pub claude: Vec<ProviderModel>,
    pub codex: Vec<ProviderModel>,
}

/// A hub's accounts, or why they couldn't be listed. Empty without a management key.
type Accounts = Result<Vec<HubAccount>, String>;

/// A cached answer: when it was asked, of which settings, and what it said.
type Cached<T> = HashMap<String, (Instant, Entry, T)>;

/// This host's hubs.
pub(super) struct Hubs {
    file: PathBuf,
    keys: Arc<dyn KeyStore>,
    launcher: Launcher,
    stored: Mutex<Vec<Entry>>,
    reach: Mutex<Cached<Reach>>,
    accounts: Mutex<Cached<Accounts>>,
    /// One lock per hub, held while [`Self::reach`] asks it, so its two instances' probes share
    /// one request.
    asking: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// The id of hub `id`'s Claude Code instance.
pub(super) fn claude_id(id: &str) -> String {
    format!("{id}-claude")
}

/// The id of hub `id`'s Codex instance.
pub(super) fn codex_id(id: &str) -> String {
    format!("{id}-codex")
}

impl Hubs {
    /// `data_dir`'s `hubs.json`, or no hubs when it can't be read.
    pub(super) fn load(data_dir: &Path, keys: Arc<dyn KeyStore>, launcher: &Launcher) -> Self {
        let file = data_dir.join("hubs.json");
        let stored = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            file,
            keys,
            launcher: launcher.clone(),
            stored: Mutex::new(stored),
            reach: Mutex::new(HashMap::new()),
            accounts: Mutex::new(HashMap::new()),
            asking: Mutex::new(HashMap::new()),
        }
    }

    /// The instances of every enabled hub, without waiting on a lock, for plxd's start.
    pub(super) fn loaded(&mut self) -> Vec<Stored> {
        self.stored
            .get_mut()
            .iter()
            .filter(|hub| hub.enabled)
            .flat_map(instances_of)
            .collect()
    }

    /// Every hub's settings.
    pub(super) async fn entries(&self) -> Vec<Entry> {
        self.stored.lock().await.clone()
    }

    /// The instances of every enabled hub.
    pub(super) async fn instances(&self) -> Vec<Stored> {
        self.entries()
            .await
            .iter()
            .filter(|hub| hub.enabled)
            .flat_map(instances_of)
            .collect()
    }

    /// The hub whose instance `id` is, enabled or not.
    pub(super) async fn owner(&self, id: &str) -> Option<String> {
        self.stored
            .lock()
            .await
            .iter()
            .find(|hub| claude_id(&hub.id) == id || codex_id(&hub.id) == id)
            .map(|hub| hub.id.clone())
    }

    /// Adds `params` as a hub, or replaces the one with its id, keeping a key it sends none for.
    /// `taken` says whether an instance id is another provider's. Returns the hub as it was and
    /// as it is.
    ///
    /// # Errors
    ///
    /// `invalidParams` for an id, name, or URL plxd can't use, a new hub without an access key, or
    /// instance ids another provider has; an internal error if the file or keychain can't be
    /// written.
    pub(super) async fn save(
        &self,
        params: HubsSaveParams,
        taken: impl Fn(&str) -> bool,
    ) -> Result<(Option<Entry>, Entry), ErrorObject> {
        let HubsSaveParams {
            id,
            name,
            url,
            enabled,
            access_key,
            management_key,
        } = params;
        let name = name.trim().to_owned();
        let url = checked(&id, &name, &url)?;
        for instance in [claude_id(&id), codex_id(&id)] {
            if taken(&instance) {
                return Err(ErrorObject::invalid_params(format!(
                    "{instance} is already another provider's id; pick another hub id"
                )));
            }
        }
        let old = self
            .stored
            .lock()
            .await
            .iter()
            .find(|hub| hub.id == id)
            .cloned();
        let access_key = access_key.filter(|key| !key.trim().is_empty());
        if old.is_none() && access_key.is_none() {
            return Err(ErrorObject::invalid_params(
                "a new hub needs its access key",
            ));
        }
        let secrets = old.as_ref().and_then(|old| old.secrets);
        let mut management = old.as_ref().is_some_and(|old| old.management);
        let secrets = if access_key.is_some() || management_key.is_some() {
            if let Some(key) = &management_key {
                management = !key.trim().is_empty();
            }
            Some(self.keep_keys(secrets, access_key, management_key).await?)
        } else {
            secrets
        };
        let entry = Entry {
            id,
            name,
            url,
            enabled,
            management,
            secrets,
        };
        let mut stored = self.stored.lock().await;
        match stored.iter().position(|hub| hub.id == entry.id) {
            Some(i) => stored[i] = entry.clone(),
            None => stored.push(entry.clone()),
        }
        self.write(&stored)?;
        drop(stored);
        self.forget(&entry.id).await;
        Ok((old, entry))
    }

    /// Removes the hub `id` and its keys, and returns it.
    ///
    /// # Errors
    ///
    /// `invalidParams` for a hub that doesn't exist.
    pub(super) async fn remove(&self, id: &str) -> Result<Entry, ErrorObject> {
        let mut stored = self.stored.lock().await;
        let Some(i) = stored.iter().position(|hub| hub.id == id) else {
            return Err(ErrorObject::invalid_params(format!("no hub {id}")));
        };
        let entry = stored.remove(i);
        self.write(&stored)?;
        drop(stored);
        self.forget(id).await;
        if let Some(secrets) = entry.secrets {
            let keys = Arc::clone(&self.keys);
            // Off the runtime's threads, as the keychain may wait on the user.
            let _ = tokio::task::spawn_blocking(move || keys.delete(secrets)).await;
        }
        Ok(entry)
    }

    /// Every hub with what it answers: from the cache within [`CACHE_TTL`], unless `refresh`.
    pub(super) async fn list(&self, refresh: bool) -> Vec<Hub> {
        let entries = self.entries().await;
        let hubs = entries.iter().map(|entry| async move {
            let (reach, accounts) =
                futures_util::join!(self.reach(entry, refresh), self.accounts(entry, refresh));
            let (accounts, accounts_problem) = match accounts {
                Ok(accounts) => (accounts, None),
                Err(problem) => (Vec::new(), Some(problem)),
            };
            Hub {
                id: entry.id.clone(),
                name: entry.name.clone(),
                url: entry.url.clone(),
                enabled: entry.enabled,
                has_management_key: entry.management,
                claude: claude_id(&entry.id),
                codex: codex_id(&entry.id),
                reachable: reach.reachable,
                problem: reach.problem,
                claude_models: reach.claude,
                codex_models: reach.codex,
                accounts,
                accounts_problem,
                checked_at: Timestamp::now(),
            }
        });
        futures_util::future::join_all(hubs).await
    }

    /// What hub `id`'s `/v1/models` answers, for its instances' probes.
    pub(super) async fn reach_of(&self, id: &str, refresh: bool) -> Reach {
        let entry = self
            .stored
            .lock()
            .await
            .iter()
            .find(|hub| hub.id == id)
            .cloned();
        match entry {
            Some(entry) => self.reach(&entry, refresh).await,
            None => Reach::default(),
        }
    }

    /// `entry`'s `/v1/models`, cached.
    async fn reach(&self, entry: &Entry, refresh: bool) -> Reach {
        if let Some(reach) = cached(&self.reach, entry, refresh).await {
            return reach;
        }
        let asked = Instant::now();
        let asking = Arc::clone(
            self.asking
                .lock()
                .await
                .entry(entry.id.clone())
                .or_default(),
        );
        let _asking = asking.lock().await;
        // The other instance may have asked while this one waited.
        let since = self
            .reach
            .lock()
            .await
            .get(&entry.id)
            .and_then(|(at, settings, reach)| {
                (*at >= asked && settings == entry).then(|| reach.clone())
            });
        if let Some(reach) = since {
            return reach;
        }
        let keys = self.keys_of(entry).await;
        let reach = match keys.get(ACCESS) {
            None => Reach {
                problem: Some("Add the hub's access key.".into()),
                ..Reach::default()
            },
            Some(key) => match request(
                &self.launcher,
                &format!("{}/v1/models", entry.url),
                key,
                None,
            )
            .await
            {
                Ok(body) => models(&body),
                Err(problem) => Reach {
                    problem: Some(problem),
                    ..Reach::default()
                },
            },
        };
        keep(&self.reach, entry, &reach).await;
        reach
    }

    /// `entry`'s accounts and their limits, cached. None without a management key.
    async fn accounts(&self, entry: &Entry, refresh: bool) -> Accounts {
        if !entry.management {
            return Ok(Vec::new());
        }
        if let Some(accounts) = cached(&self.accounts, entry, refresh).await {
            return accounts;
        }
        let keys = self.keys_of(entry).await;
        let accounts = match keys.get(MANAGEMENT) {
            None => Err("Add the hub's management key.".into()),
            Some(key) => read_accounts(&self.launcher, &entry.url, key).await,
        };
        keep(&self.accounts, entry, &accounts).await;
        accounts
    }

    /// `entry`'s keys, read off the runtime's threads, since the keychain may wait on the user.
    async fn keys_of(&self, entry: &Entry) -> HashMap<String, String> {
        let keys = Arc::clone(&self.keys);
        let id = entry.secrets;
        tokio::task::spawn_blocking(move || read_secrets(keys.as_ref(), id))
            .await
            .unwrap_or_default()
    }

    /// Keeps the keys sent, beside those already under `id`, and returns where they are. An empty
    /// management key removes it.
    async fn keep_keys(
        &self,
        id: Option<AccountId>,
        access: Option<String>,
        management: Option<String>,
    ) -> Result<AccountId, ErrorObject> {
        let keys = Arc::clone(&self.keys);
        let kept = tokio::task::spawn_blocking(move || {
            let mut secrets = read_secrets(keys.as_ref(), id);
            if let Some(access) = access {
                secrets.insert(ACCESS.into(), access.trim().to_owned());
            }
            match management.map(|key| key.trim().to_owned()) {
                Some(key) if key.is_empty() => {
                    secrets.remove(MANAGEMENT);
                }
                Some(key) => {
                    secrets.insert(MANAGEMENT.into(), key);
                }
                None => {}
            }
            let id = id.unwrap_or_else(AccountId::generate);
            let text = Zeroizing::new(serde_json::to_string(&secrets).unwrap_or_default());
            keys.set(id, &text).map(|()| id)
        });
        kept.await
            .map_err(|error| ErrorObject::internal_error(error.to_string()))?
            .map_err(|error| {
                ErrorObject::internal_error(format!("couldn't keep the hub's keys: {error}"))
            })
    }

    /// Drops what hub `id` last answered.
    async fn forget(&self, id: &str) {
        self.reach.lock().await.remove(id);
        self.accounts.lock().await.remove(id);
    }

    fn write(&self, stored: &[Entry]) -> Result<(), ErrorObject> {
        let text = serde_json::to_vec_pretty(stored).unwrap_or_default();
        std::fs::write(&self.file, text).map_err(|error| {
            ErrorObject::internal_error(format!("couldn't save {}: {error}", self.file.display()))
        })
    }
}

/// `entry`'s cached answer in `cache`, when it's of its current settings, within [`CACHE_TTL`],
/// and not `refresh`.
async fn cached<T: Clone>(cache: &Mutex<Cached<T>>, entry: &Entry, refresh: bool) -> Option<T> {
    if refresh {
        return None;
    }
    let cache = cache.lock().await;
    let (at, settings, value) = cache.get(&entry.id)?;
    (at.elapsed() < CACHE_TTL && settings == entry).then(|| value.clone())
}

async fn keep<T: Clone>(cache: &Mutex<Cached<T>>, entry: &Entry, value: &T) {
    cache.lock().await.insert(
        entry.id.clone(),
        (Instant::now(), entry.clone(), value.clone()),
    );
}

/// The checks `hubs/save` makes, and the URL as plxd keeps it, without a trailing `/`.
fn checked(id: &str, name: &str, url: &str) -> Result<String, ErrorObject> {
    if id.is_empty()
        || id.len() > MAX_ID
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ErrorObject::invalid_params(format!(
            "a hub id is 1 to {MAX_ID} lowercase letters, digits, and dashes"
        )));
    }
    if name.is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return Err(ErrorObject::invalid_params(
            "a hub's name is 1 to 64 characters",
        ));
    }
    let url = url.trim().trim_end_matches('/');
    let scheme = url.starts_with("http://") || url.starts_with("https://");
    let host = url.split_once("://").map_or("", |(_, rest)| rest);
    let plain = !url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\');
    if !scheme || host.is_empty() || !plain || url.len() > 2048 {
        return Err(ErrorObject::invalid_params(
            "a hub's URL is an http:// or https:// address",
        ));
    }
    Ok(url.to_owned())
}

/// Hub `entry`'s two instances, named after it: Claude Code and Codex through it.
pub(super) fn instances_of(entry: &Entry) -> [Stored; 2] {
    let instance = |id: String, kind, args, env| ProviderInstance {
        id,
        kind,
        name: entry.name.clone(),
        enabled: true,
        program: None,
        home: None,
        args,
        env,
        models: Vec::new(),
        reserve: None,
    };
    let secret = |name: &str| ProviderEnvVar {
        name: name.into(),
        value: None,
        secret: true,
    };
    let claude = instance(
        claude_id(&entry.id),
        ProviderKind::Claude,
        Vec::new(),
        vec![
            ProviderEnvVar {
                name: "ANTHROPIC_BASE_URL".into(),
                value: Some(entry.url.clone()),
                secret: false,
            },
            secret("ANTHROPIC_AUTH_TOKEN"),
        ],
    );
    let codex = instance(
        codex_id(&entry.id),
        ProviderKind::Codex,
        codex_args(entry),
        vec![secret(KEY_VAR)],
    );
    [claude, codex].map(|instance| Stored {
        instance,
        secrets: entry.secrets,
        hub: Some(entry.id.clone()),
    })
}

/// `codex app-server`'s arguments for hub `entry`: `-c` overrides that define it as the model
/// provider [`CODEX_PROVIDER`] and pick it, as Theo's guide sets in `config.toml`, with the key
/// in [`KEY_VAR`] instead of the file.
fn codex_args(entry: &Entry) -> Vec<String> {
    let provider = format!("model_providers.{CODEX_PROVIDER}");
    [
        format!("model_provider={}", toml(CODEX_PROVIDER)),
        format!("{provider}.name={}", toml(&entry.name)),
        format!("{provider}.base_url={}", toml(&format!("{}/v1", entry.url))),
        format!("{provider}.wire_api=\"responses\""),
        format!("{provider}.requires_openai_auth=false"),
        format!("{provider}.supports_websockets=true"),
        format!("{provider}.env_key={}", toml(KEY_VAR)),
    ]
    .into_iter()
    .flat_map(|set| ["-c".to_owned(), set])
    .collect()
}

/// `text` as a TOML basic string.
fn toml(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A `/v1/models` answer split between the instances: Claude models run through Claude Code, and
/// every other model through Codex.
fn models(body: &Value) -> Reach {
    let Some(list) = body.get("data").and_then(Value::as_array) else {
        return Reach {
            problem: Some("The hub didn't answer with a model list.".into()),
            ..Reach::default()
        };
    };
    let mut reach = Reach {
        reachable: true,
        ..Reach::default()
    };
    for model in list {
        let Some(id) = model.get("id").and_then(Value::as_str) else {
            continue;
        };
        let model_of = ProviderModel {
            id: id.to_owned(),
            name: id.to_owned(),
        };
        let claude = id.starts_with("claude") || model["owned_by"] == "anthropic";
        if claude {
            reach.claude.push(model_of);
        } else {
            reach.codex.push(model_of);
        }
    }
    reach
}

/// The hub at `url`'s accounts, and each Claude and Codex account's limits, at most four read at
/// once.
async fn read_accounts(launcher: &Launcher, url: &str, key: &str) -> Accounts {
    use futures_util::StreamExt;
    let body = management(launcher, url, key, "auth-files", None).await?;
    let files = body
        .get("files")
        .and_then(Value::as_array)
        .ok_or("The hub didn't answer with its accounts.")?;
    let accounts = futures_util::stream::iter(files.iter().filter_map(account_of))
        .map(|(mut account, index)| async move {
            if let Some(index) = index.filter(|_| !account.disabled) {
                match limits(launcher, url, key, &account.provider, &index).await {
                    Ok((limits, plan)) => {
                        account.limits = limits;
                        account.plan = plan.or(account.plan);
                    }
                    Err(problem) => account.problem = Some(problem),
                }
            }
            account
        })
        .buffered(4)
        .collect()
        .await;
    Ok(accounts)
}

/// What an auth file says about its account, and its `auth_index`, which reads its limits, for a
/// Claude or Codex account.
fn account_of(file: &Value) -> Option<(HubAccount, Option<Index>)> {
    let text = |name: &str| file.get(name).and_then(Value::as_str).map(str::to_owned);
    let id = text("id").or_else(|| text("name"))?;
    let provider = text("provider")
        .or_else(|| text("type"))
        .unwrap_or_default();
    let claims = &file["id_token"];
    let plan = ["plan_type", "chatgpt_plan_type"]
        .iter()
        .find_map(|name| claims[name].as_str().map(str::to_owned));
    let index = text("auth_index")
        .filter(|_| matches!(provider.as_str(), "claude" | "codex"))
        .map(|auth_index| Index {
            auth_index,
            chatgpt_account: claims["chatgpt_account_id"].as_str().map(str::to_owned),
        });
    let account = HubAccount {
        id,
        email: text("email").filter(|email| !email.is_empty()),
        plan: plan.filter(|_| provider == "codex"),
        disabled: file["disabled"].as_bool().unwrap_or(false),
        provider,
        limits: Vec::new(),
        problem: None,
    };
    Some((account, index))
}

/// How the hub's `api-call` names an account.
struct Index {
    auth_index: String,
    /// A Codex account's workspace, which `ChatGPT`'s usage endpoint wants.
    chatgpt_account: Option<String>,
}

/// The `ChatGPT` endpoint a Codex login's usage is at.
const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The Anthropic endpoint a Claude login's usage is at.
const CLAUDE_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";

/// An account's limit windows and its plan, read by the hub with the account's own token, which
/// the hub puts where `$TOKEN$` is.
async fn limits(
    launcher: &Launcher,
    url: &str,
    key: &str,
    provider: &str,
    index: &Index,
) -> Result<(Vec<UsageLimitWindow>, Option<String>), String> {
    let codex = provider == "codex";
    let mut header = if codex {
        json!({
            "Authorization": "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            "Originator": "Codex Desktop",
        })
    } else {
        // The OAuth usage endpoint can answer 429 without a Claude Code user agent.
        json!({
            "Authorization": "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.1.273",
        })
    };
    if let Some(account) = index.chatgpt_account.as_deref().filter(|_| codex) {
        header["Chatgpt-Account-Id"] = account.into();
    }
    let call = json!({
        "auth_index": index.auth_index,
        "method": "GET",
        "url": if codex { CODEX_USAGE } else { CLAUDE_USAGE },
        "header": header,
    });
    let answer = management(launcher, url, key, "api-call", Some(&call)).await?;
    let status = answer["status_code"].as_u64().unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!(
            "The service refused the hub's request (HTTP {status})."
        ));
    }
    let unread = || "The hub couldn't read this account's usage.".to_owned();
    let usage: Value = answer["body"]
        .as_str()
        .and_then(|body| serde_json::from_str(body).ok())
        .ok_or_else(unread)?;
    Ok(if codex {
        let plan = usage["plan_type"].as_str().map(str::to_owned);
        (codex_windows(&usage), plan)
    } else {
        (claude_windows(&usage), None)
    })
}

/// Anthropic's OAuth usage as windows: `five_hour`, `seven_day`, and each model's weekly window
/// as `seven_day_<model>`, as [`crate::backend::limits::claude`] names Claude Code's.
fn claude_windows(usage: &Value) -> Vec<UsageLimitWindow> {
    let now = Timestamp::now();
    let window = |name: String, used: &Value, resets: &Value| UsageLimitWindow {
        window: name,
        used_percent: used.as_f64(),
        resets_at: resets.as_str().and_then(|at| at.parse().ok()),
        captured_at: now,
    };
    let named = ["five_hour", "seven_day"].into_iter().filter_map(|name| {
        let entry = usage.get(name).filter(|entry| entry.is_object())?;
        Some(window(
            name.to_owned(),
            &entry["utilization"],
            &entry["resets_at"],
        ))
    });
    let scoped = usage["limits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|limit| limit["kind"] == "weekly_scoped")
        .filter_map(|limit| {
            let model = limit["scope"]["model"]["display_name"]
                .as_str()?
                .to_lowercase()
                .replace(' ', "_");
            Some(window(
                format!("seven_day_{model}"),
                &limit["percent"],
                &limit["resets_at"],
            ))
        });
    named.chain(scoped).collect()
}

/// `ChatGPT`'s Codex usage as windows: its primary and secondary windows, named `five_hour` and
/// `seven_day` when they last that long, as [`crate::backend::limits::codex`] names them.
fn codex_windows(usage: &Value) -> Vec<UsageLimitWindow> {
    let now = Timestamp::now();
    [
        ("primary", "primary_window"),
        ("secondary", "secondary_window"),
    ]
    .into_iter()
    .filter_map(|(slot, field)| {
        let entry = usage["rate_limit"]
            .get(field)
            .filter(|entry| entry.is_object())?;
        let name = match entry["limit_window_seconds"].as_u64() {
            Some(18_000) => "five_hour",
            Some(604_800) => "seven_day",
            _ => slot,
        };
        Some(UsageLimitWindow {
            window: name.to_owned(),
            used_percent: entry["used_percent"].as_f64(),
            resets_at: entry["reset_at"]
                .as_i64()
                .and_then(|seconds| Timestamp::from_second(seconds).ok()),
            captured_at: now,
        })
    })
    .collect()
}

/// A call to the hub at `url`'s management API, `/v0/management/<path>`, with its management
/// key: a GET, or a POST of `body`. PLX-1070's account sign-ins go through this too.
pub(super) async fn management(
    launcher: &Launcher,
    url: &str,
    key: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    request(launcher, &format!("{url}/v0/management/{path}"), key, body).await
}

/// `url`'s JSON answer, through `curl` with `key` as a bearer token: a GET, or a POST of `body`.
/// The key and body go on stdin as curl config, so `ps` never shows them. An error says only what
/// kind of failure it was and the HTTP status, never what the hub answered.
async fn request(
    launcher: &Launcher,
    url: &str,
    key: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    // curl's config syntax: a quoted value takes backslash escapes.
    let quoted = |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    let mut config = Zeroizing::new(format!(
        "url = {}\nheader = {}\nsilent\nshow-error\nmax-time = {REQUEST_SECONDS}\n\
         write-out = \"\\n%{{http_code}}\"\n",
        quoted(url),
        quoted(&format!("Authorization: Bearer {key}")),
    ));
    if let Some(body) = body {
        config.push_str("request = \"POST\"\nheader = \"Content-Type: application/json\"\n");
        config.push_str("data-raw = ");
        config.push_str(&quoted(&body.to_string()));
        config.push('\n');
    }
    let home = std::env::home_dir().filter(|home| home.is_absolute() && home.is_dir());
    let mut spec = ProcessSpec::new("curl", home.unwrap_or_else(std::env::temp_dir));
    // `-q` first, so no `.curlrc` applies: one with `trace-ascii` would write the key to disk.
    spec.args = vec!["-q".into(), "-K".into(), "-".into()];
    spec.stdin = StdinMode::Piped;
    let timeout = Duration::from_secs(REQUEST_SECONDS + 5);
    let ran = detect::run_spec(launcher, &spec, config.as_bytes(), timeout)
        .await
        .map_err(|_| "Couldn't run curl on this host.".to_owned())?;
    if ran.exit_code != Some(0) {
        return Err(curl_failure(ran.exit_code));
    }
    let (text, status) = ran
        .stdout
        .trim_end()
        .rsplit_once('\n')
        .unwrap_or(("", ran.stdout.trim()));
    match status {
        "200" => serde_json::from_str(text)
            .map_err(|_| "The hub answered in a way plxd can't read.".to_owned()),
        "401" | "403" => Err(format!(
            "The hub refused the key (HTTP {status}). Check it in the hub's settings."
        )),
        status => Err(format!("The hub answered HTTP {status}.")),
    }
}

/// What curl's exit `code` means, for people.
fn curl_failure(code: Option<i32>) -> String {
    match code {
        Some(6) => "Couldn't find the hub's host.".into(),
        Some(7) => "Couldn't connect to the hub.".into(),
        Some(28) => format!("The hub didn't answer within {REQUEST_SECONDS} seconds."),
        Some(35 | 51 | 58 | 60) => "The hub's TLS certificate isn't trusted.".into(),
        Some(code) => format!("Couldn't reach the hub (curl exit {code})."),
        None => "Couldn't reach the hub.".into(),
    }
}

#[cfg(test)]
mod tests;
