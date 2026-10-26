//! Provider instances (0040): the configured ways a host runs agents, behind `providers/*`.
//!
//! An instance is a [`ProviderInstance`]: a kind, a name, and the user's settings. A host lists
//! only the instances its user added from the app's Add provider dialog, and on its first run, the
//! built-in agents (`claude`, `codex`, `cursor`) whose CLI is installed. Instances live in
//! `providers.json` in plxd's data folder, except secret variables, which live in the host's
//! keychain under the instance's secret id, one JSON object per instance.
//!
//! Every enabled instance is a backend in the [`BackendRegistry`], under its id, so a thread
//! starts on one as `AccountChoice::Subscription { backend: <id> }`. A built-in instance with no
//! settings runs the backend plxd registered at startup; one the host doesn't list isn't routed
//! to, though key accounts keep their startup backends.
//!
//! An account pool (PLX-1033) is an instance with `members`: other instances of its kind. It is
//! never a backend. It lists its members' models and state, and `agents::placement::pool_member`
//! starts its threads on the member with the most headroom.

mod identity;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountId, AgentPermission, CliKind, ProviderEnvVar, ProviderInfo, ProviderInstance,
    ProviderKind, ProviderModel, ProvidersListResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::backend::acp::{self, AcpAgent, AcpBackend};
use crate::backend::claude::{self, ClaudeBackend};
use crate::backend::codex::{self, CodexBackend};
use crate::backend::opencode::{self, Opencode, OpencodeBackend};
use crate::backend::process::{Launcher, Output, ProcessSpec, StdinMode};
use crate::backend::{Backend, Overrides, check_argument};
use crate::detect::{self, CliDetector};
use crate::keystore::KeyStore;
use crate::routing::BackendRegistry;

/// How long a probe's answer is served before `providers/list` probes again.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// How long one probe step may take: a version, a status command, or an ACP session.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// What a Pi instance with no model it can use says.
const PI_NO_MODELS: &str = "Pi has no usable models. Run `pi` and use /login, or configure an API \
                            key in ~/.pi/agent.";

/// What runs a kind, and how.
#[derive(Clone, Debug)]
enum Driver {
    /// Claude Code, with the instance's variables: a model service sets its endpoint there.
    Claude,
    /// Codex's `app-server`.
    Codex,
    /// Cursor through the official SDK sidecar (0053).
    CursorSdk,
    /// An ACP agent.
    Acp(Box<AcpAgent>),
    /// `OpenCode`'s HTTP server, at the instance's `OPENCODE_SERVER_URL` or one a run starts.
    Opencode,
}

/// A kind's defaults.
#[derive(Clone, Debug)]
struct Preset {
    program: &'static str,
    driver: Driver,
    /// The command that signs it in, in a terminal on the host. Empty: none.
    login: &'static [&'static str],
    /// The variable the instance's home folder sets, for an ACP agent or an account probe.
    home_env: Option<&'static str>,
    /// Where a model service lists its models, `OpenAI` style, and the variable that holds its key.
    models_url: Option<(&'static str, &'static str)>,
}

/// The ACP agent `program args` with the usual Plan mode `plan`.
fn acp_agent(label: &str, program: &str, args: &[&str]) -> AcpAgent {
    AcpAgent::new("", label, program, args)
}

/// Hermes Agent, `hermes acp`, named `label`. Its modes are its edit approval policy.
fn hermes_agent(label: &str) -> AcpAgent {
    AcpAgent {
        modes: vec![
            (AgentPermission::Manual, "default".into()),
            (AgentPermission::Edit, "accept_edits".into()),
            (AgentPermission::Bypass, "dont_ask".into()),
        ],
        ..acp_agent(label, "hermes", &["acp"])
    }
}

/// Where Ollama Cloud lists its models, which needs no key.
const OLLAMA_CLOUD_MODELS: &str = "https://ollama.com/v1/models";

/// Hermes Agent's provider for Ollama Cloud. In a home with no config of its own, Hermes runs every
/// model on it.
const HERMES_OLLAMA: &str = "ollama-cloud";

/// The persona Ollama Cloud's Hermes Agent runs with, as its home's `SOUL.md` (0070).
const OLLAMA_SOUL: &str = "You are Ollama Cloud's coding agent in Parallax, running an open model \
on Ollama Cloud. Asked what you are, say that, and name your model. Be direct: match the length of \
your reply to the weight of the ask, and report finished work as what changed, what's verified, and \
what's left. No filler, and no restating the request. When unsure, say so plainly.\n";

/// Whether `instance` is Ollama Cloud on Hermes Agent. One that sets `ANTHROPIC_BASE_URL` was added
/// before 0070 and runs Claude Code against ollama.com.
fn on_hermes(instance: &ProviderInstance) -> bool {
    instance.kind == ProviderKind::OllamaCloud
        && !instance
            .env
            .iter()
            .any(|var| var.name == "ANTHROPIC_BASE_URL")
}

/// The defaults of `kind`. `None` for a kind this plxd doesn't know.
fn preset(kind: ProviderKind) -> Option<Preset> {
    let base = |program, driver| Preset {
        program,
        driver,
        login: &[],
        home_env: None,
        models_url: None,
    };
    Some(match kind {
        ProviderKind::Claude => Preset {
            login: &["claude", "auth", "login"],
            home_env: Some(claude::CONFIG_DIR_ENV),
            ..base("claude", Driver::Claude)
        },
        ProviderKind::Codex => Preset {
            login: &["codex", "login"],
            home_env: Some(codex::CONFIG_DIR_ENV),
            ..base("codex", Driver::Codex)
        },
        ProviderKind::Cursor => Preset {
            // Sign-in is `cursor/signIn`, not a terminal command. The program is unused: the
            // sidecar is what runs, and a first run seeds Cursor when that script is present.
            login: &[],
            ..base("node", Driver::CursorSdk)
        },
        ProviderKind::Opencode => Preset {
            login: &["opencode", "auth", "login"],
            home_env: Some("OPENCODE_CONFIG_DIR"),
            ..base("opencode", Driver::Opencode)
        },
        // Pi has no ACP of its own: `pi-acp` runs `pi --mode rpc`. Pi before 0.81 needs
        // `pi-acp@0.0.27`, which an instance's arguments pick. It signs in in that `pi`, which
        // the probe finds.
        ProviderKind::Pi => base(
            "npx",
            Driver::Acp(Box::new(acp_agent("Pi", "npx", &["-y", "pi-acp@0.0.34"]))),
        ),
        ProviderKind::GrokBuild => Preset {
            login: &["grok", "login"],
            ..base(
                "grok",
                Driver::Acp(Box::new(AcpAgent {
                    scrub: vec!["XAI_".into()],
                    model_flag: Some("--model".into()),
                    bypass_flag: Some("--always-approve".into()),
                    ..acp_agent("Grok Build", "grok", &["agent", "stdio"])
                })),
            )
        },
        ProviderKind::Hermes => Preset {
            login: &["hermes", "setup", "--portal"],
            home_env: Some("HERMES_HOME"),
            ..base(
                "hermes",
                Driver::Acp(Box::new(hermes_agent("Hermes Agent"))),
            )
        },
        // Hermes Agent's own Ollama Cloud provider, with the key in `OLLAMA_API_KEY`, in a home of
        // its own (0070). Its models are listed from Ollama Cloud, not from Hermes.
        ProviderKind::OllamaCloud => Preset {
            home_env: Some("HERMES_HOME"),
            models_url: Some((OLLAMA_CLOUD_MODELS, "OLLAMA_API_KEY")),
            ..base(
                "hermes",
                Driver::Acp(Box::new(AcpAgent {
                    env: vec![("HERMES_INFERENCE_PROVIDER".into(), HERMES_OLLAMA.into())],
                    ..hermes_agent("Ollama Cloud")
                })),
            )
        },
        ProviderKind::OpenRouter => Preset {
            models_url: Some((
                "https://openrouter.ai/api/v1/models?supported_parameters=tools",
                "ANTHROPIC_AUTH_TOKEN",
            )),
            ..base("claude", Driver::Claude)
        },
        ProviderKind::LocalModel => Preset {
            models_url: Some(("http://127.0.0.1:8080/v1/models", "ANTHROPIC_AUTH_TOKEN")),
            ..base("claude", Driver::Claude)
        },
        // Google's own ACP server for Antigravity, the way it lets other apps run Antigravity
        // (`agy` itself bars third-party clients on a personal account). It signs in itself.
        ProviderKind::Antigravity => Preset {
            home_env: Some("GEMINI_HOME"),
            ..base(
                "agy_acp_server.par",
                Driver::Acp(Box::new(AcpAgent {
                    scrub: vec!["GEMINI_".into(), "GOOGLE_".into()],
                    env: vec![("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into())],
                    ..acp_agent("Antigravity", "agy_acp_server.par", &[])
                })),
            )
        },
        ProviderKind::Acp => base("", Driver::Acp(Box::new(acp_agent("", "", &[])))),
        ProviderKind::Unknown => return None,
    })
}

/// `instance`'s defaults: its kind's, except that `OpenCode` 2 (`opencode2`) stays on
/// `opencode2 acp`, since its HTTP API isn't 1.x's (0055, PLX-566), and an Ollama Cloud instance
/// from before 0070 runs Claude Code.
fn preset_for(instance: &ProviderInstance) -> Option<Preset> {
    let mut preset = preset(instance.kind)?;
    if instance.kind == ProviderKind::OllamaCloud && !on_hermes(instance) {
        preset = Preset {
            program: "claude",
            driver: Driver::Claude,
            login: &[],
            home_env: None,
            models_url: Some((OLLAMA_CLOUD_MODELS, "ANTHROPIC_AUTH_TOKEN")),
        };
    }
    let opencode2 = instance
        .program
        .as_deref()
        .and_then(|program| Path::new(program).file_stem())
        .is_some_and(|stem| stem == "opencode2");
    if instance.kind == ProviderKind::Opencode && opencode2 {
        preset.driver = Driver::Acp(Box::new(AcpAgent {
            modes: vec![(AgentPermission::Plan, "plan".to_owned())],
            edit_mode: Some("build".to_owned()),
            ..acp_agent("OpenCode", "opencode2", &["acp"])
        }));
    }
    Some(preset)
}

/// The built-in instances: what a first run lists when their CLI is installed, and the ids whose
/// startup backends an instance with no settings runs.
const BUILT_IN: &[(&str, ProviderKind, &str)] = &[
    ("claude", ProviderKind::Claude, "Claude Code"),
    ("codex", ProviderKind::Codex, "Codex"),
    ("cursor", ProviderKind::Cursor, "Cursor"),
];

/// Whether a first run should list this built-in. Cursor always is, since plxd embeds its
/// sidecar; the others when their CLI is on `PATH`.
fn built_in_present(launcher: &Launcher, kind: ProviderKind) -> bool {
    if kind == ProviderKind::Cursor {
        return true;
    }
    preset(kind).is_some_and(|preset| detect::resolve(launcher, preset.program).is_some())
}

/// The CLI plxd's detector already probes for a built-in instance.
fn detected_cli(id: &str) -> Option<CliKind> {
    match id {
        "claude" => Some(CliKind::Claude),
        "codex" => Some(CliKind::Codex),
        "cursor" => Some(CliKind::Cursor),
        _ => None,
    }
}

/// One instance as `providers.json` keeps it: secret values left out.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(flatten)]
    instance: ProviderInstance,
    /// Where its secret variables are in the keychain, once it has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secrets: Option<AccountId>,
}

/// What a probe of an instance depends on: its settings but `enabled`, and where its secrets are.
type Probed = (ProviderInstance, Option<AccountId>);

fn probed(entry: &Stored) -> Probed {
    let instance = ProviderInstance {
        enabled: false,
        ..entry.instance.clone()
    };
    (instance, entry.secrets)
}

/// What a probe found, kept for [`CACHE_TTL`].
#[derive(Clone, Debug, Default)]
struct Found {
    installed: bool,
    /// Whether a sidecar's SDK (Cursor's, Claude's) is installing in the background. Never cached,
    /// so a list sees it end.
    installing: bool,
    path: Option<String>,
    version: Option<String>,
    signed_in: Option<bool>,
    account: Option<String>,
    note: Option<String>,
    models: Vec<ProviderModel>,
    /// The command that signs it in, from the agent's own sign-in methods.
    login: Option<Vec<String>>,
    /// The variables an ACP agent runs with, none secret, which its sign-in gets too.
    login_env: Option<Vec<(OsString, OsString)>>,
}

/// This host's provider instances.
pub struct Providers {
    file: PathBuf,
    keys: Arc<dyn KeyStore>,
    launcher: Launcher,
    registry: BackendRegistry,
    stored: Mutex<Vec<Stored>>,
    /// Each instance's last probe: when it ended, what it probed ([`probed`]), and what it found.
    cache: Mutex<HashMap<String, (Instant, Probed, Found)>>,
    /// One lock per instance, held while [`Self::found`] probes it, so lists running at once, as
    /// onboarding's saves do, wait on one probe instead of each starting their own.
    probing: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The backends plxd registered at startup under the built-in instances' ids, which a
    /// built-in instance with no settings runs.
    defaults: HashMap<String, Arc<dyn Backend>>,
}

impl std::fmt::Debug for Providers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Providers")
            .field("file", &self.file)
            .finish_non_exhaustive()
    }
}

impl Providers {
    /// Loads `data_dir`'s `providers.json`, adds the built-in instances it lacks, and registers
    /// every enabled instance's backend in `registry`. A file that can't be read starts empty.
    pub fn load(
        data_dir: &Path,
        keys: Arc<dyn KeyStore>,
        launcher: &Launcher,
        registry: &BackendRegistry,
    ) -> Self {
        let file = data_dir.join("providers.json");
        let saved: Option<Vec<Stored>> = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        // The first time, the built-in agents whose CLI is installed; after that, only what the
        // user added or kept.
        let first = saved.is_none();
        let mut stored = saved.unwrap_or_default();
        for (id, kind, name) in BUILT_IN {
            if first && built_in_present(launcher, *kind) {
                let instance = ProviderInstance {
                    id: (*id).to_owned(),
                    kind: *kind,
                    name: (*name).to_owned(),
                    enabled: true,
                    program: None,
                    home: None,
                    args: Vec::new(),
                    env: Vec::new(),
                    models: Vec::new(),
                    reserve: None,
                    members: None,
                };
                stored.push(Stored {
                    instance,
                    secrets: None,
                });
            }
        }
        let defaults = BUILT_IN
            .iter()
            .filter_map(|(id, ..)| Some(((*id).to_owned(), registry.by_backend_name(id)?.1)))
            .collect();
        let mut providers = Self {
            file,
            keys,
            launcher: launcher.clone(),
            registry: registry.clone(),
            defaults,
            stored: Mutex::new(Vec::new()),
            cache: Mutex::new(HashMap::new()),
            probing: Mutex::new(HashMap::new()),
        };
        for (id, ..) in BUILT_IN {
            if !stored.iter().any(|s| s.instance.id == *id) {
                providers.registry.remove(id);
            }
        }
        for entry in &stored {
            providers.register(entry);
        }
        *providers.stored.get_mut() = stored;
        providers
    }

    /// Drops a cached probe so the next list reads the sidecar again.
    pub async fn invalidate(&self, id: &str) {
        self.cache.lock().await.remove(id);
    }

    /// The kind of the instance `id`, if the host has it.
    pub async fn kind(&self, id: &str) -> Option<ProviderKind> {
        self.stored
            .lock()
            .await
            .iter()
            .find(|entry| entry.instance.id == id)
            .map(|entry| entry.instance.kind)
    }

    /// Whether the instance `id` sets the variable `name`, secret or not.
    pub async fn sets(&self, id: &str, name: &str) -> bool {
        self.stored
            .lock()
            .await
            .iter()
            .filter(|entry| entry.instance.id == id)
            .any(|entry| entry.instance.env.iter().any(|var| var.name == name))
    }

    /// Every instance with its state, probing those whose cached state is older than
    /// [`CACHE_TTL`], or all of them with `refresh`.
    pub async fn list(&self, detector: &CliDetector, refresh: bool) -> ProvidersListResult {
        let stored = self.stored.lock().await.clone();
        let probes = stored.iter().map(|entry| async move {
            if entry.instance.members.is_some() {
                Found::default()
            } else {
                self.found(detector, entry, refresh).await
            }
        });
        let found = futures_util::future::join_all(probes).await;
        let providers = with_pools(stored, found);
        ProvidersListResult {
            providers,
            checked_at: Timestamp::now(),
        }
    }

    /// Every instance with what placing a Project's child needs (0046), from what plxd last found
    /// without probing anything, since a probe can take seconds: an instance's last probe however
    /// old, or for a built-in agent the detector's fresh answer. One never probed has no sign-in
    /// or models.
    pub async fn known(&self, detector: &CliDetector) -> Vec<ProviderInfo> {
        let stored = self.stored.lock().await.clone();
        let mut known: Vec<(Stored, Found)> = Vec::with_capacity(stored.len());
        for entry in stored {
            let cached = self
                .cache
                .lock()
                .await
                .get(&entry.instance.id)
                .map(|(_, _, found)| found.clone());
            let found = match cached {
                Some(found) => found,
                None => match detected_cli(&entry.instance.id) {
                    Some(cli) if entry.instance.program.is_none() => detector
                        .cached(cli)
                        .await
                        .map(|detected| Found {
                            signed_in: detected.signed_in,
                            ..Found::default()
                        })
                        .unwrap_or_default(),
                    _ => Found::default(),
                },
            };
            known.push((entry, found));
        }
        let (stored, found) = known.into_iter().unzip();
        with_pools(stored, found)
    }

    /// The members of the pool `id`, or `None` when `id` isn't a pool.
    pub async fn members(&self, id: &str) -> Option<Vec<String>> {
        self.stored
            .lock()
            .await
            .iter()
            .find(|entry| entry.instance.id == id)
            .and_then(|entry| entry.instance.members.clone())
    }

    /// A pool's members for a new run. Disabled pools cannot start runs, even through RPC.
    ///
    /// # Errors
    ///
    /// `invalidParams` when the named pool is disabled.
    pub async fn enabled_members(&self, id: &str) -> Result<Option<Vec<String>>, ErrorObject> {
        let stored = self.stored.lock().await;
        let Some(instance) = stored.iter().find(|entry| entry.instance.id == id) else {
            return Ok(None);
        };
        if instance.instance.members.is_some() && !instance.instance.enabled {
            return Err(ErrorObject::invalid_params("this account pool is disabled"));
        }
        Ok(instance.instance.members.clone())
    }

    /// Adds `instance`, or replaces the one with its id, keeping stored secrets it sends no value
    /// for, and registers its backend.
    ///
    /// # Errors
    ///
    /// `invalidParams` for an id, kind, or setting plxd can't use, and an internal error if the
    /// file or the keychain can't be written.
    pub async fn save(&self, mut instance: ProviderInstance) -> Result<(), ErrorObject> {
        check(&instance)?;
        // The list isn't locked while the keychain may wait on the user.
        let old = self
            .stored
            .lock()
            .await
            .iter()
            .find(|s| s.instance.id == instance.id)
            .cloned();
        if old
            .as_ref()
            .is_some_and(|old| old.instance.kind != instance.kind)
        {
            return Err(ErrorObject::invalid_params(
                "an instance's kind can't change; add a new instance instead",
            ));
        }
        check_pool(&instance, &self.stored.lock().await)?;
        if let Some(home) = &instance.home
            && old.as_ref().and_then(|entry| entry.instance.home.as_ref()) != Some(home)
        {
            instance.home = Some(own_home(home)?);
        }
        if on_hermes(&instance) && instance.home.is_none() {
            instance.home = Some(self.ollama_cloud_home(&instance.id)?);
        }
        let secret_id = self.save_secrets(old.as_ref(), &mut instance).await?;
        let entry = Stored {
            instance,
            secrets: secret_id,
        };
        let mut stored = self.stored.lock().await;
        match stored
            .iter()
            .position(|s| s.instance.id == entry.instance.id)
        {
            Some(i) => stored[i] = entry.clone(),
            None => stored.push(entry.clone()),
        }
        self.write(&stored)?;
        // Turning an instance on or off changes nothing a probe finds, so its last one stands.
        if old.as_ref().map(probed) != Some(probed(&entry)) {
            self.cache.lock().await.remove(&entry.instance.id);
        }
        self.register(&entry);
        Ok(())
    }

    /// Where plxd makes instance `id`'s Ollama Cloud home: `ollama-cloud/<id>` in its data folder.
    fn own_ollama_home(&self, id: &str) -> PathBuf {
        self.file.with_file_name("ollama-cloud").join(id)
    }

    /// A home for Ollama Cloud's Hermes Agent, [`Self::own_ollama_home`], so it shares none of the
    /// user's own Hermes config, sessions, or memory, with [`OLLAMA_SOUL`] as its `SOUL.md`, which
    /// Hermes keeps since it didn't write it.
    fn ollama_cloud_home(&self, id: &str) -> Result<String, ErrorObject> {
        let dir = self.own_ollama_home(id);
        let soul = dir.join("SOUL.md");
        std::fs::create_dir_all(&dir)
            .and_then(|()| {
                if soul.exists() {
                    Ok(())
                } else {
                    std::fs::write(&soul, OLLAMA_SOUL)
                }
            })
            .map_err(|error| {
                ErrorObject::internal_error(format!("couldn't make {}: {error}", dir.display()))
            })?;
        Ok(dir.display().to_string())
    }

    /// Keeps `instance`'s secret values in the keychain, takes them out of it, and returns where
    /// they are. The keychain is only touched when a secret's value or the set of secrets
    /// changed, off the runtime's threads, since it may wait for the user to allow plxd.
    async fn save_secrets(
        &self,
        old: Option<&Stored>,
        instance: &mut ProviderInstance,
    ) -> Result<Option<AccountId>, ErrorObject> {
        let names = |env: &[parallax_protocol::ProviderEnvVar]| -> Vec<String> {
            env.iter()
                .filter(|var| var.secret)
                .map(|var| var.name.clone())
                .collect()
        };
        let old_id = old.and_then(|old| old.secrets);
        let sent = instance
            .env
            .iter()
            .any(|var| var.secret && var.value.is_some());
        if !sent && old.map(|old| names(&old.instance.env)) == Some(names(&instance.env)) {
            return Ok(old_id);
        }
        let keys = Arc::clone(&self.keys);
        let new: HashMap<String, String> = instance
            .env
            .iter_mut()
            .filter(|var| var.secret)
            .filter_map(|var| Some((var.name.clone(), var.value.take()?)))
            .collect();
        let wanted = names(&instance.env);
        let blocking = tokio::task::spawn_blocking(move || {
            let mut secrets = read_secrets(keys.as_ref(), old_id);
            secrets.retain(|name, _| wanted.contains(name));
            secrets.extend(new);
            if secrets.is_empty() {
                if let Some(id) = old_id {
                    keys.delete(id)?;
                }
                return Ok(None);
            }
            let id = old_id.unwrap_or_else(AccountId::generate);
            keys.set(id, &serde_json::to_string(&secrets).unwrap_or_default())?;
            Ok(Some(id))
        });
        blocking
            .await
            .map_err(|error| ErrorObject::internal_error(error.to_string()))?
            .map_err(|error: crate::keystore::KeyStoreError| {
                ErrorObject::internal_error(format!("couldn't keep the secrets: {error}"))
            })
    }

    /// Removes the instance `id` and its secrets.
    ///
    /// # Errors
    ///
    /// `invalidParams` for an id that doesn't exist.
    pub async fn remove(&self, id: &str) -> Result<(), ErrorObject> {
        let mut stored = self.stored.lock().await;
        let Some(i) = stored.iter().position(|s| s.instance.id == id) else {
            return Err(ErrorObject::invalid_params(format!("no provider {id}")));
        };
        if let Some(pool) = stored.iter().find(|s| {
            s.instance
                .members
                .as_ref()
                .is_some_and(|members| members.iter().any(|member| member == id))
        }) {
            return Err(ErrorObject::invalid_params(format!(
                "{} is in the pool {}; take it out of the pool first",
                stored[i].instance.name, pool.instance.name
            )));
        }
        let entry = stored.remove(i);
        self.write(&stored)?;
        self.registry.remove(id);
        drop(stored);
        // Ollama Cloud's Hermes home goes with it, so one added again under its id starts clean.
        // A home the user set is theirs, and stays.
        let own = self.own_ollama_home(id);
        if on_hermes(&entry.instance) && entry.instance.home.as_deref() == own.to_str() {
            let _ = std::fs::remove_dir_all(own);
        }
        if let Some(secrets) = entry.secrets {
            let keys = Arc::clone(&self.keys);
            // Off the runtime's threads, as the keychain may wait on the user.
            let _ = tokio::task::spawn_blocking(move || keys.delete(secrets)).await;
        }
        Ok(())
    }

    fn write(&self, stored: &[Stored]) -> Result<(), ErrorObject> {
        let text = serde_json::to_vec_pretty(stored).unwrap_or_default();
        std::fs::write(&self.file, text).map_err(|error| {
            ErrorObject::internal_error(format!("couldn't save {}: {error}", self.file.display()))
        })
    }

    /// Every variable `entry` sets, secrets included, read from the keychain.
    #[cfg(test)]
    fn env(&self, entry: &Stored) -> Vec<(OsString, OsString)> {
        full_env(self.keys.as_ref(), entry)
    }

    /// Puts `entry`'s backend in the registry, or takes it out while it's off. A built-in
    /// instance with nothing set keeps the backend registered at startup. One with secrets reads
    /// them from the keychain only when a run starts, so neither plxd's start nor a list waits on
    /// the keychain, which can ask the user first.
    fn register(&self, entry: &Stored) {
        let instance = &entry.instance;
        if !instance.enabled || instance.members.is_some() {
            self.registry.remove(&instance.id);
            return;
        }
        let plain = detected_cli(&instance.id).is_some()
            && instance.program.is_none()
            && instance.home.is_none()
            && instance.args.is_empty()
            && instance.env.is_empty();
        if plain && let Some(default) = self.defaults.get(&instance.id) {
            self.registry.set(Arc::clone(default));
            return;
        }
        let Some(backend) = build(&self.launcher, entry, plain_env(entry)) else {
            return;
        };
        if entry.instance.env.iter().any(|var| var.secret) {
            self.registry.set(Arc::new(WithSecrets {
                plain: backend,
                keys: Arc::clone(&self.keys),
                launcher: self.launcher.clone(),
                entry: entry.clone(),
            }));
        } else {
            self.registry.set(backend);
        }
    }

    /// `entry`'s state: from the cache while it's fresh, else probed.
    async fn found(&self, detector: &CliDetector, entry: &Stored, refresh: bool) -> Found {
        let id = &entry.instance.id;
        if !refresh && let Some(found) = self.cached(entry, None).await {
            return found;
        }
        let asked = Instant::now();
        let probing = Arc::clone(self.probing.lock().await.entry(id.clone()).or_default());
        let _probing = probing.lock().await;
        // Another list may have probed it while this one waited, which a `refresh` takes when
        // that probe ended after it asked.
        if let Some(found) = self.cached(entry, refresh.then_some(asked)).await {
            return found;
        }
        let found = self.probe(detector, entry, refresh).await;
        let mut cache = self.cache.lock().await;
        if found.installing {
            cache.remove(id);
        } else {
            cache.insert(id.clone(), (Instant::now(), probed(entry), found.clone()));
        }
        found
    }

    /// `entry`'s cached state, from a probe of its current settings that ended after `since`, or
    /// without one, within [`CACHE_TTL`].
    async fn cached(&self, entry: &Stored, since: Option<Instant>) -> Option<Found> {
        let cache = self.cache.lock().await;
        let (at, settings, found) = cache.get(&entry.instance.id)?;
        let recent = since.map_or_else(|| at.elapsed() < CACHE_TTL, |since| *at >= since);
        (recent && *settings == probed(entry)).then(|| found.clone())
    }

    async fn probe(&self, detector: &CliDetector, entry: &Stored, refresh: bool) -> Found {
        let instance = &entry.instance;
        if instance.kind == ProviderKind::Cursor {
            return probe_cursor(&self.launcher, entry).await;
        }
        let Some(preset) = preset_for(instance) else {
            return Found {
                note: Some("this plxd doesn't know this kind of provider; update plxd".into()),
                ..Found::default()
            };
        };
        let default_program = detected_cli(&instance.id).filter(|_| instance.program.is_none());
        // An `OpenCode` server at a URL needs no `opencode` on this host.
        let mut found = if matches!(preset.driver, Driver::Opencode) && opencode_at_url(instance) {
            Found {
                installed: true,
                ..Found::default()
            }
        } else if let Some(cli) = default_program {
            let detected = if refresh {
                detector.refresh_one(cli).await
            } else {
                detector.get(cli).await
            };
            Found {
                installed: detected.installed,
                path: detected.path,
                version: detected.version,
                signed_in: detected.signed_in,
                account: detected.plan,
                note: detected.note,
                ..Found::default()
            }
        } else {
            self.locate(instance, &preset).await
        };
        if !found.installed {
            return found;
        }
        let env = plain_env(entry);
        if matches!(instance.kind, ProviderKind::Claude | ProviderKind::Codex) {
            let mut account_env = env.clone();
            account_env.extend(home_var(instance, &preset));
            identity::probe(
                &self.launcher,
                instance,
                &program_of(instance, &preset),
                account_env,
                &mut found,
            )
            .await;
        }
        match (&preset.driver, preset.models_url) {
            // Ollama Cloud's Hermes Agent too: its models are the service's, so it isn't started.
            (_, Some((url, key_name))) => {
                probe_service(&self.launcher, entry, &env, url, key_name, &mut found).await;
            }
            (Driver::Acp(agent), None) => {
                // Probed without its secrets, which only a run reads, and which never go on the
                // sign-in command line, where `ps` would show them.
                let agent = acp_for(
                    instance,
                    &preset,
                    (**agent).clone(),
                    overrides(entry, env.clone()),
                );
                acp_probe(&self.launcher, &agent, &mut found).await;
                if instance.kind == ProviderKind::Pi {
                    pi_sign_in(&self.launcher, instance, &mut found);
                }
            }
            (Driver::Opencode, _) => {
                probe_opencode(&self.launcher, entry, &preset, &mut found).await;
            }
            _ => {}
        }
        if instance.kind == ProviderKind::OllamaCloud {
            for model in &mut found.models {
                model.name = ollama_model_name(&model.id);
            }
        }
        // Claude runs through the Agent SDK sidecar (0061), which needs Node and installs the
        // SDK on first use.
        if matches!(preset.driver, Driver::Claude)
            && let Some(note) = crate::backend::claude::sdk::status(&self.launcher).await
        {
            found.installing = crate::backend::claude::sdk::SDK
                .install_state(&self.launcher)
                .0;
            found.note = Some(note);
        }
        found
    }

    /// Where `instance`'s program is on this host, and its version. Not installed, with a note,
    /// when it isn't there.
    async fn locate(&self, instance: &ProviderInstance, preset: &Preset) -> Found {
        let program = program_of(instance, preset);
        let Some(path) = detect::resolve(&self.launcher, &program) else {
            let note = if on_hermes(instance) {
                "Ollama Cloud runs through Hermes Agent, which isn't installed on this host".into()
            } else {
                format!("{program} isn't installed on this host")
            };
            return Found {
                note: Some(note),
                ..Found::default()
            };
        };
        // Pi runs through `npx pi-acp`, so its version is the `pi` the adapter runs.
        let versioned = match instance.kind {
            ProviderKind::Pi => pi_command(instance),
            _ => program.clone(),
        };
        // `npx` alone can't run Pi: the adapter needs the `pi` it runs.
        if instance.kind == ProviderKind::Pi
            && detect::resolve(&self.launcher, &versioned).is_none()
        {
            return Found {
                path: Some(path.display().to_string()),
                note: Some(format!("{versioned} isn't installed on this host")),
                ..Found::default()
            };
        }
        // Antigravity's server prints its build, not a version, and `npx` or `uvx` would print
        // their own: the agent's `initialize` says it instead.
        let launcher_program = ["npx", "uvx"].iter().any(|launcher| {
            Path::new(&program)
                .file_stem()
                .is_some_and(|stem| stem == *launcher)
        });
        // Ollama Cloud's Hermes Agent stays out of sight.
        let version = match instance.kind {
            ProviderKind::Antigravity => None,
            ProviderKind::OllamaCloud if on_hermes(instance) => None,
            ProviderKind::Acp if launcher_program => None,
            _ => detect::run(&self.launcher, &versioned, &["--version"], PROBE_TIMEOUT)
                .await
                .ok()
                .filter(|ran| ran.exit_code == Some(0))
                .and_then(|ran| version_of(&ran.stdout)),
        };
        Found {
            installed: true,
            path: Some(path.display().to_string()),
            version,
            ..Found::default()
        }
    }
}

/// A model service's models, listed from `url` or from `/v1/models` at the instance's own
/// `ANTHROPIC_BASE_URL`, and whether it has its key, `key_name`: a secret it isn't read for,
/// since the services list models without one, or a plain value among `env`.
async fn probe_service(
    launcher: &Launcher,
    entry: &Stored,
    env: &[(OsString, OsString)],
    url: &str,
    key_name: &str,
    found: &mut Found,
) {
    let instance = &entry.instance;
    let url = instance
        .env
        .iter()
        .find(|var| var.name == "ANTHROPIC_BASE_URL")
        .and_then(|var| var.value.as_deref())
        .filter(|base| !url.starts_with(base.trim_end_matches('/')))
        .map_or_else(
            || url.to_owned(),
            |base| format!("{}/v1/models", base.trim_end_matches('/')),
        );
    let key = env
        .iter()
        .find(|(name, _)| name == key_name)
        .map(|(_, value)| value.to_string_lossy().into_owned())
        .filter(|key| !key.is_empty());
    let has_secret = entry.secrets.is_some() && has_secret(instance, key_name);
    match models_from(launcher, &url, key.as_deref()).await {
        Ok(models) => found.models = models,
        Err(error) => found.note = Some(error),
    }
    found.signed_in = Some(has_secret || key.is_some());
    if found.signed_in == Some(false) {
        found.note = Some("Add the service's API key".into());
    }
}

/// What people see for an Ollama model id: `glm-5.3` is `GLM 5.3`, `kimi-k2.7-code` is
/// `Kimi K2.7 Code`, `gpt-oss:120b` is `gpt-oss 120B`.
fn ollama_model_name(id: &str) -> String {
    let (base, tag) = id.split_once(':').unwrap_or((id, ""));
    // OpenAI writes gpt-oss in lowercase.
    let (lead, rest) = base
        .strip_prefix("gpt-oss")
        .map_or(("", base), |rest| ("gpt-oss", rest));
    let mut name: Vec<String> = Vec::new();
    if !lead.is_empty() {
        name.push(lead.to_owned());
    }
    for word in rest.split('-').filter(|word| !word.is_empty()) {
        name.push(match word {
            "glm" => "GLM".to_owned(),
            "deepseek" => "DeepSeek".to_owned(),
            "minimax" => "MiniMax".to_owned(),
            "vl" => "VL".to_owned(),
            _ => {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            }
        });
    }
    let size = tag
        .strip_suffix('b')
        .is_some_and(|n| n.parse::<f64>().is_ok());
    match tag {
        "" => {}
        _ if size => name.push(tag.to_uppercase()),
        _ => name.push(tag.to_owned()),
    }
    name.join(" ")
}

/// Whether `instance` is an `OpenCode` whose server is at a URL, which needs no `opencode` on this
/// host.
fn opencode_at_url(instance: &ProviderInstance) -> bool {
    instance.kind == ProviderKind::Opencode
        && instance.env.iter().any(|var| {
            var.name == opencode::URL_VAR
                && !var.secret
                && var.value.as_deref().is_some_and(|url| !url.is_empty())
        })
}

/// `entry`'s `OpenCode` server: its version, its models, and whether it was reachable, in `note`. A
/// password kept as a secret isn't read: the keychain can ask the user first (0040).
async fn probe_opencode(launcher: &Launcher, entry: &Stored, preset: &Preset, found: &mut Found) {
    let instance = &entry.instance;
    let opencode = opencode_for(instance, preset, overrides(entry, plain_env(entry)));
    let secret = has_secret(instance, opencode::PASSWORD_VAR);
    let inspected = opencode::inspect(launcher, &opencode, secret).await;
    found.version = inspected.version.or(found.version.take());
    found.models = inspected.models;
    found.signed_in = inspected.signed_in;
    found.note = inspected.note;
    found.login_env = Some(opencode.env);
}

/// Cursor's state from its SDK sidecar (0053), with the instance's plain `CURSOR_API_KEY`.
async fn probe_cursor(launcher: &Launcher, entry: &Stored) -> Found {
    let instance = &entry.instance;
    // A `CURSOR_API_KEY` kept as a secret isn't read here: the keychain can ask the user
    // first. The sidecar checks a plain one with `Cursor.me`.
    let api_key = crate::backend::cursor_sdk::API_KEY;
    let env: Vec<_> = plain_env(entry)
        .into_iter()
        .filter(|(name, _)| name == api_key)
        .collect();
    let secret_key = env.is_empty() && has_secret(instance, api_key);
    let report = if secret_key {
        // A key means the user chose Cursor: an SDK not installed yet installs in the background.
        crate::backend::cursor_sdk::unready(launcher, true).unwrap_or_else(|| {
            crate::backend::cursor_sdk::Report {
                installed: true,
                signed_in: Some(true),
                note: Some("Uses CURSOR_API_KEY from this provider's settings".into()),
                ..Default::default()
            }
        })
    } else {
        crate::backend::cursor_sdk::inspect(launcher, &instance.id, &env, PROBE_TIMEOUT).await
    };
    Found {
        installed: report.installed,
        installing: report.installing,
        path: report.path,
        version: report.version,
        signed_in: report.signed_in,
        account: report.email,
        note: report.note,
        models: report.models,
        ..Found::default()
    }
}

/// `entry`'s variables that aren't secret.
fn plain_env(entry: &Stored) -> Vec<(OsString, OsString)> {
    entry
        .instance
        .env
        .iter()
        .filter(|var| !var.secret)
        .filter_map(|var| Some((var.name.clone().into(), var.value.clone()?.into())))
        .collect()
}

/// The secret values kept in `keys` under `id`, by name. None when they can't be read.
fn read_secrets(keys: &dyn KeyStore, id: Option<AccountId>) -> HashMap<String, String> {
    id.and_then(|id| keys.get(id).ok().flatten())
        .and_then(|text| serde_json::from_str(text.as_str()).ok())
        .unwrap_or_default()
}

/// Whether `instance` keeps the variable `name` as a secret.
fn has_secret(instance: &ProviderInstance, name: &str) -> bool {
    instance
        .env
        .iter()
        .any(|var| var.secret && var.name == name)
}

/// Every variable `entry` sets, its secrets read from `keys`. A secret that can't be read is
/// left out, and the agent then fails as signed out.
fn full_env(keys: &dyn KeyStore, entry: &Stored) -> Vec<(OsString, OsString)> {
    let secrets = read_secrets(keys, entry.secrets);
    entry
        .instance
        .env
        .iter()
        .filter_map(|var| {
            let value = if var.secret {
                secrets.get(&var.name).cloned()
            } else {
                var.value.clone()
            }?;
            Some((var.name.clone().into(), value.into()))
        })
        .collect()
}

/// What `entry` changes about its kind's backend, with the variables `env`.
fn overrides(entry: &Stored, env: Vec<(OsString, OsString)>) -> Overrides {
    let instance = &entry.instance;
    Overrides {
        name: Some(instance.id.clone()),
        program: instance.program.as_ref().map(Into::into),
        home: instance.home.as_ref().map(PathBuf::from),
        args: instance.args.iter().map(Into::into).collect(),
        env,
    }
}

/// The backend that runs `entry` with the variables `env`.
fn build(
    launcher: &Launcher,
    entry: &Stored,
    env: Vec<(OsString, OsString)>,
) -> Option<Arc<dyn Backend>> {
    let instance = &entry.instance;
    let preset = preset_for(instance)?;
    let launcher = launcher.clone();
    let mut overrides = overrides(entry, env);
    Some(match &preset.driver {
        Driver::Claude => {
            if overrides.program.is_none() && preset.program != "claude" {
                overrides.program = Some(preset.program.into());
            }
            let backend = ClaudeBackend::new(launcher).with_overrides(overrides);
            // A model service runs a Project's agents only in Bypass (0042).
            if preset.models_url.is_some() {
                Arc::new(backend.bypass_only_in_projects())
            } else {
                Arc::new(backend)
            }
        }
        Driver::Codex => Arc::new(CodexBackend::new(launcher).with_overrides(overrides)),
        Driver::CursorSdk => Arc::new(
            crate::backend::cursor_sdk::CursorSdkBackend::new(launcher).with_overrides(overrides),
        ),
        Driver::Acp(agent) => Arc::new(AcpBackend::new(
            launcher,
            acp_for(instance, &preset, (**agent).clone(), overrides),
        )),
        Driver::Opencode => Arc::new(OpencodeBackend::new(
            launcher,
            opencode_for(instance, &preset, overrides),
        )),
    })
}

/// An instance's backend that reads its secrets from the keychain when a run starts: `plain`,
/// built without them, answers everything else.
struct WithSecrets {
    plain: Arc<dyn Backend>,
    keys: Arc<dyn KeyStore>,
    launcher: Launcher,
    entry: Stored,
}

impl WithSecrets {
    /// The backend with its secrets. Reading them may wait for the user to allow plxd into the
    /// keychain, so other tasks move off this thread meanwhile where the runtime allows it.
    fn full(&self) -> Arc<dyn Backend> {
        let read = || full_env(self.keys.as_ref(), &self.entry);
        let multi_thread = tokio::runtime::Handle::try_current().is_ok_and(|handle| {
            handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        });
        let env = if multi_thread {
            tokio::task::block_in_place(read)
        } else {
            read()
        };
        build(&self.launcher, &self.entry, env).unwrap_or_else(|| Arc::clone(&self.plain))
    }
}

impl Backend for WithSecrets {
    fn name(&self) -> &str {
        self.plain.name()
    }

    fn capabilities(&self) -> crate::backend::Capabilities {
        self.plain.capabilities()
    }

    fn start(
        &self,
        request: crate::backend::RunRequest,
    ) -> Result<crate::backend::Started, crate::backend::StartError> {
        self.full().start(request)
    }

    fn efforts(&self) -> &'static [parallax_protocol::AgentEffort] {
        self.plain.efforts()
    }

    fn permissions(&self) -> &[AgentPermission] {
        self.plain.permissions()
    }

    fn project_permissions(&self) -> &[AgentPermission] {
        self.plain.project_permissions()
    }

    fn full_thread(&self) -> bool {
        self.plain.full_thread()
    }

    fn cli(&self) -> Option<CliKind> {
        self.plain.cli()
    }

    fn context_windows(&self) -> &'static [u32] {
        self.plain.context_windows()
    }

    fn fast_mode(&self) -> bool {
        self.plain.fast_mode()
    }

    fn commands(
        &self,
        cwd: &Path,
    ) -> Result<Option<crate::backend::CommandsProbe>, crate::backend::StartError> {
        // A command list needs no key, so it never waits on the keychain.
        self.plain.commands(cwd)
    }

    fn limits(
        &self,
        cwd: &Path,
    ) -> Result<Option<crate::backend::LimitsProbe>, crate::backend::StartError> {
        // An instance whose credential is a secret would read another login's limits without
        // it, and reading it on every poll could wait on the keychain, so it reports none.
        if self.entry.instance.env.iter().any(|var| var.secret) {
            return Ok(None);
        }
        self.plain.limits(cwd)
    }

    fn namer(
        &self,
        dir: &Path,
        model: &str,
        effort: Option<parallax_protocol::AgentEffort>,
    ) -> Result<Option<crate::backend::NameProbe>, crate::backend::StartError> {
        self.full().namer(dir, model, effort)
    }

    fn rewind(
        &self,
        rewind: crate::backend::Rewind,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
        self.full().rewind(rewind)
    }
}

/// How Pi signs in, from what its adapter's probe found: in the `pi` the adapter runs, where plxd
/// found it, with plxd's PATH, since the app's own may have neither it nor the `node` an npm install
/// of it runs on. With no model it can use, it says how (PLX-558).
fn pi_sign_in(launcher: &Launcher, instance: &ProviderInstance, found: &mut Found) {
    found.login = detect::resolve(launcher, &pi_command(instance))
        .map(|path| vec![path.display().to_string()]);
    let env = launcher.environment(&detect::probe_spec("pi"));
    // An instance's own PATH, which its runs use, stays.
    let own_path = instance.env.iter().any(|var| var.name == "PATH");
    if let Some(path) = env.get("PATH").filter(|_| !own_path) {
        found
            .login_env
            .get_or_insert_with(Vec::new)
            .push(("PATH".into(), path.to_owned()));
    }
    // pi-acp says only that it needs a sign-in.
    if found.signed_in == Some(false) || (found.signed_in == Some(true) && found.models.is_empty())
    {
        found.signed_in = Some(false);
        found.note = Some(PI_NO_MODELS.into());
    }
}

/// The `pi` a Pi instance's adapter runs: its `PI_ACP_PI_COMMAND`, or `pi`.
fn pi_command(instance: &ProviderInstance) -> String {
    instance
        .env
        .iter()
        .find(|var| var.name == "PI_ACP_PI_COMMAND")
        .and_then(|var| var.value.clone())
        .unwrap_or_else(|| "pi".to_owned())
}

/// The program `instance` runs: its own, or its kind's.
fn program_of(instance: &ProviderInstance, preset: &Preset) -> String {
    instance
        .program
        .clone()
        .unwrap_or_else(|| preset.program.to_owned())
}

/// `preset`'s ACP agent as `instance` runs it.
fn acp_for(
    instance: &ProviderInstance,
    preset: &Preset,
    mut agent: AcpAgent,
    overrides: Overrides,
) -> AcpAgent {
    agent.name.clone_from(&instance.id);
    if agent.label.is_empty() {
        agent.label.clone_from(&instance.name);
    }
    agent.program = program_of(instance, preset).into();
    // An ACP agent's, and Pi's adapter's, arguments are the whole list; another kind's follow
    // its own.
    match instance.kind {
        ProviderKind::Acp | ProviderKind::Pi if !overrides.args.is_empty() => {
            agent.args = overrides.args;
        }
        ProviderKind::Acp | ProviderKind::Pi => {}
        _ => agent.args.extend(overrides.args),
    }
    agent.env.extend(overrides.env);
    agent.env.extend(home_var(instance, preset));
    // Antigravity's server finds its harness beside it.
    if instance.kind == ProviderKind::Antigravity
        && let Some(dir) = Path::new(&agent.program)
            .parent()
            .filter(|dir| dir.is_absolute())
    {
        let harness = dir.join("localharness_external");
        agent
            .env
            .push(("ANTIGRAVITY_HARNESS_PATH".into(), harness.into()));
    }
    agent
}

/// The variable that sets `instance`'s home folder, when its kind has one and it sets a home.
fn home_var(instance: &ProviderInstance, preset: &Preset) -> Option<(OsString, OsString)> {
    Some((preset.home_env?.into(), instance.home.as_ref()?.into()))
}

/// `instance`'s `OpenCode`, with the variables in `overrides` and its home folder.
fn opencode_for(instance: &ProviderInstance, preset: &Preset, overrides: Overrides) -> Opencode {
    let mut env = overrides.env;
    env.extend(home_var(instance, preset));
    let program = program_of(instance, preset);
    Opencode::new(&instance.id, "OpenCode", program, overrides.args, env)
}

/// The first version-looking word of `text`, such as `1.0.39` from `grok 1.0.39` or `18.5.0`
/// from `name/18.5.0`.
fn version_of(text: &str) -> Option<String> {
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let words = || line.split(|c: char| c.is_whitespace() || c == '/');
    words()
        .find(|word| {
            word.trim_start_matches('v')
                .starts_with(|c: char| c.is_ascii_digit())
        })
        .or_else(|| words().next_back())
        .map(|word| word.trim_start_matches('v').to_owned())
}

/// The models an OpenAI-style `/v1/models` at `url` lists, read with `curl` so plxd needs no
/// HTTP client of its own.
async fn models_from(
    launcher: &Launcher,
    url: &str,
    key: Option<&str>,
) -> Result<Vec<ProviderModel>, String> {
    let mut spec = ProcessSpec::new("curl", std::env::temp_dir());
    // The key goes on stdin as a curl config line, so `ps` never shows it.
    spec.args = ["-sS", "--max-time", "15", "-K", "-", url]
        .iter()
        .map(Into::into)
        .collect();
    spec.stdin = StdinMode::Piped;
    let config = key
        .map(|key| format!("header = \"Authorization: Bearer {key}\"\n"))
        .unwrap_or_default();
    let ran = detect::run_spec(launcher, &spec, config.as_bytes(), PROBE_TIMEOUT).await?;
    if ran.exit_code != Some(0) {
        return Err(format!("couldn't reach {url}: {}", ran.stderr_tail.trim()));
    }
    let body: Value = serde_json::from_str(&ran.stdout)
        .map_err(|_| format!("{url} didn't answer with a model list"))?;
    if let Some(error) = body.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map_or_else(|| error.to_string(), str::to_owned);
        return Err(message);
    }
    let models = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{url} didn't answer with a model list"))?;
    Ok(models
        .iter()
        .filter_map(|model| {
            let id = model.get("id").or_else(|| model.get("model"))?.as_str()?;
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_owned();
            Some(ProviderModel {
                id: id.to_owned(),
                name,
            })
        })
        .collect())
}

/// Starts `agent`, opens a session in the user's home, and reads what its answers say: how it
/// signs in, from `initialize`, and whether it is signed in and its models, from `session/new`.
/// The agent is killed once it answers, or after [`PROBE_TIMEOUT`]. A browser it would open for
/// a sign-in is never opened: that waits for the user's Sign in.
async fn acp_probe(launcher: &Launcher, agent: &AcpAgent, found: &mut Found) {
    found.login_env = Some(agent.env.clone());
    let home = std::env::home_dir().unwrap_or_else(std::env::temp_dir);
    let mut spec = ProcessSpec::new(&agent.program, &home);
    spec.args.clone_from(&agent.args);
    spec.scrub = launcher.base().starting_with(&agent.scrub);
    spec.inject = agent.env.iter().cloned().collect();
    spec.inject.set("BROWSER", "/usr/bin/true");
    spec.stdin = StdinMode::Piped;
    let mut process = match launcher.spawn(&spec) {
        Ok(process) => process,
        Err(error) => {
            found.note = Some(format!("couldn't start it: {error}"));
            return;
        }
    };
    let mut stdin = process.take_stdin();
    let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": acp::initialize_params()});
    let session = json!({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": home, "mcpServers": []}});
    let input = format!("{initialize}\n{session}\n");
    let read = async {
        if let Some(pipe) = &mut stdin {
            use tokio::io::AsyncWriteExt;
            let _ = pipe.write_all(input.as_bytes()).await;
        }
        loop {
            let message = match process.next().await {
                Some(Output::Line(line)) => match serde_json::from_slice::<Value>(&line) {
                    Ok(message) => message,
                    Err(_) => continue,
                },
                Some(Output::Oversized { .. }) => continue,
                Some(Output::Exited(exit)) => {
                    found.note = Some(format!("it exited: {}", exit.stderr_tail.trim()));
                    return;
                }
                None => return,
            };
            if message["id"] == 1 {
                let result = &message["result"];
                found.login = login_of(agent, &result["authMethods"]);
                if found.version.is_none() {
                    found.version = result["agentInfo"]["version"].as_str().map(str::to_owned);
                }
                continue;
            }
            if message["id"] != 2 {
                continue;
            }
            match message.get("error") {
                // pi-acp answers ACP's -32000; Hermes Agent says so in its data.
                Some(error)
                    if error["code"] == -32000 || {
                        let lower = error.to_string().to_ascii_lowercase();
                        ["auth", "login", "not connected"]
                            .iter()
                            .any(|w| lower.contains(w))
                    } =>
                {
                    found.signed_in = Some(false);
                }
                Some(error) => found.note = acp::error_text(error),
                None => {
                    found.signed_in = Some(true);
                    found.models = session_models(&message["result"]);
                }
            }
            return;
        }
    };
    if tokio::time::timeout(PROBE_TIMEOUT, read).await.is_err() {
        found.note = Some(format!(
            "it didn't open a session within {}s; it may be waiting for you to sign in",
            PROBE_TIMEOUT.as_secs()
        ));
    }
}

/// The command that signs in to `agent`, from its `initialize` answer's `authMethods`: a terminal
/// method's arguments after the agent's own command, or else `plxd acp-login` with the first
/// method the agent runs itself (ACP's `agent` type), for a browser sign-in. Its variables go in
/// `ProviderInfo::login_env`.
fn login_of(agent: &AcpAgent, methods: &Value) -> Option<Vec<String>> {
    let methods = methods.as_array()?;
    let command = || {
        std::iter::once(&agent.program)
            .chain(&agent.args)
            .map(|arg| arg.to_string_lossy().into_owned())
    };
    if let Some(terminal) = methods.iter().find(|m| m["type"] == "terminal") {
        let args = terminal["args"].as_array().into_iter().flatten();
        return Some(
            command()
                .chain(args.filter_map(|arg| arg.as_str().map(str::to_owned)))
                .collect(),
        );
    }
    let method = methods
        .iter()
        .find(|m| m.get("type").is_none_or(|kind| kind == "agent"))?
        .get("id")?
        .as_str()?;
    let plxd = std::env::current_exe().ok()?;
    Some(
        [
            plxd.to_string_lossy().into_owned(),
            "acp-login".to_owned(),
            "--method".to_owned(),
            method.to_owned(),
            "--".to_owned(),
        ]
        .into_iter()
        .chain(command())
        .collect(),
    )
}

/// The models a `session/new` answer lists: ACP's `models`, or its model config option.
fn session_models(result: &Value) -> Vec<ProviderModel> {
    let from = |list: &Value, id: &str, name: &str| -> Vec<ProviderModel> {
        list.as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get(id)?.as_str()?.to_owned();
                let name = model
                    .get(name)
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned();
                Some(ProviderModel { id, name })
            })
            .collect()
    };
    let models = from(&result["models"]["availableModels"], "modelId", "name");
    if !models.is_empty() {
        return models;
    }
    result["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| option["category"] == "model")
        .map(|option| from(&option["options"], "value", "name"))
        .unwrap_or_default()
}

/// The checks `providers/save` makes before keeping `instance`.
fn check(instance: &ProviderInstance) -> Result<(), ErrorObject> {
    let id = &instance.id;
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ErrorObject::invalid_params(
            "an id is 1 to 64 lowercase letters, digits, and dashes",
        ));
    }
    if preset(instance.kind).is_none() {
        return Err(ErrorObject::invalid_params(
            "this plxd doesn't know that kind of provider",
        ));
    }
    if let Some((built_in, kind, _)) = BUILT_IN.iter().find(|(built_in, ..)| built_in == id)
        && instance.kind != *kind
    {
        return Err(ErrorObject::invalid_params(format!(
            "{built_in} is a built-in provider of another kind"
        )));
    }
    if instance.kind == ProviderKind::Acp
        && instance.program.is_none()
        && instance.members.is_none()
    {
        return Err(ErrorObject::invalid_params(
            "an ACP agent needs the program that starts it",
        ));
    }
    for model in &instance.models {
        check_argument("model", &model.id)
            .map_err(|e| ErrorObject::invalid_params(e.to_string()))?;
    }
    for var in &instance.env {
        if var.name.is_empty() || var.name.contains(['=', '\0']) {
            return Err(ErrorObject::invalid_params(format!(
                "{:?} isn't a variable name",
                var.name
            )));
        }
    }
    if instance.reserve.is_some_and(|reserve| reserve > 100) {
        return Err(ErrorObject::invalid_params(
            "a reserve is a percent from 0 to 100",
        ));
    }
    Ok(())
}

/// An instance's home folder as plxd keeps it: `~` at its start is this host's home folder, and
/// the folder is made if it's missing, so a second account added as `~/.codex-work` has its own
/// `CODEX_HOME` to sign in to (PLX-1033).
fn own_home(home: &str) -> Result<String, ErrorObject> {
    let rest = home
        .strip_prefix("~/")
        .or_else(|| home.strip_prefix("~\\"))
        .or((home == "~").then_some(""));
    let path = match rest {
        Some(rest) => std::env::home_dir()
            .ok_or_else(|| ErrorObject::internal_error("this host's home folder is unknown"))?
            .join(rest),
        None => PathBuf::from(home),
    };
    if !path.is_absolute() {
        return Err(ErrorObject::invalid_params(
            "an account home must be an absolute path or start with ~/",
        ));
    }
    std::fs::create_dir_all(&path).map_err(|error| {
        ErrorObject::invalid_params(format!("couldn't make {}: {error}", path.display()))
    })?;
    Ok(path.display().to_string())
}

/// The checks `providers/save` makes on a pool, against the host's `stored` instances: two or
/// more members, each an instance of the pool's kind that isn't a pool, and an instance in a pool
/// can't become one.
fn check_pool(instance: &ProviderInstance, stored: &[Stored]) -> Result<(), ErrorObject> {
    let Some(members) = &instance.members else {
        return Ok(());
    };
    let mut seen: Vec<&String> = Vec::new();
    for member in members {
        if seen.contains(&member) {
            continue;
        }
        seen.push(member);
        let Some(entry) = stored.iter().find(|s| s.instance.id == *member) else {
            return Err(ErrorObject::invalid_params(format!("no provider {member}")));
        };
        if entry.instance.id == instance.id || entry.instance.members.is_some() {
            return Err(ErrorObject::invalid_params("a pool can't hold a pool"));
        }
        if entry.instance.kind != instance.kind {
            return Err(ErrorObject::invalid_params(format!(
                "{} is another kind of provider than the pool",
                entry.instance.name
            )));
        }
    }
    if seen.len() < 2 {
        return Err(ErrorObject::invalid_params(
            "a pool needs two or more providers",
        ));
    }
    let pooled = stored.iter().any(|s| {
        s.instance
            .members
            .as_ref()
            .is_some_and(|members| members.contains(&instance.id))
    });
    if pooled {
        return Err(ErrorObject::invalid_params(
            "a provider in a pool can't be a pool",
        ));
    }
    Ok(())
}

/// `providers/list`'s answer for `stored` instances with what was `found` for each: a pool's from
/// its members. It is installed and signed in when any member is, signed out when every member
/// is, offers every member's models, and has no sign-in of its own.
fn with_pools(stored: Vec<Stored>, found: Vec<Found>) -> Vec<ProviderInfo> {
    let pooled: Vec<Found> = stored
        .iter()
        .map(|entry| {
            let Some(members) = &entry.instance.members else {
                return Found::default();
            };
            let mine: Vec<&Found> = stored
                .iter()
                .zip(&found)
                .filter(|(other, _)| members.contains(&other.instance.id))
                .map(|(_, found)| found)
                .collect();
            let mut models: Vec<ProviderModel> = Vec::new();
            for model in mine.iter().flat_map(|found| &found.models).chain(
                stored
                    .iter()
                    .filter(|other| members.contains(&other.instance.id))
                    .flat_map(|other| &other.instance.models),
            ) {
                if !models.iter().any(|m| m.id == model.id) {
                    models.push(model.clone());
                }
            }
            let signed_in = if mine.iter().any(|f| f.signed_in == Some(true)) {
                Some(true)
            } else if !mine.is_empty() && mine.iter().all(|f| f.signed_in == Some(false)) {
                Some(false)
            } else {
                None
            };
            Found {
                installed: mine.iter().any(|f| f.installed),
                signed_in,
                models,
                ..Found::default()
            }
        })
        .collect();
    stored
        .into_iter()
        .zip(found)
        .zip(pooled)
        .map(|((entry, found), pooled)| {
            if entry.instance.members.is_none() {
                return info(entry.instance, found);
            }
            let mut info = info(entry.instance, pooled);
            info.login = None;
            info.login_env = Vec::new();
            info
        })
        .collect()
}

/// What `providers/list` says about one instance.
fn info(instance: ProviderInstance, found: Found) -> ProviderInfo {
    let preset = preset_for(&instance);
    let (permissions, efforts) = match preset.as_ref().map(|p| &p.driver) {
        Some(Driver::Claude) => (
            vec![
                AgentPermission::Auto,
                AgentPermission::Manual,
                AgentPermission::Edit,
                AgentPermission::Plan,
                AgentPermission::Bypass,
            ],
            true,
        ),
        Some(Driver::Codex) => (
            vec![
                AgentPermission::Auto,
                AgentPermission::Manual,
                AgentPermission::Edit,
                AgentPermission::Bypass,
            ],
            true,
        ),
        Some(Driver::CursorSdk) => (
            vec![
                AgentPermission::Edit,
                AgentPermission::Plan,
                AgentPermission::Auto,
                AgentPermission::Bypass,
            ],
            false,
        ),
        Some(Driver::Acp(agent)) => (agent.permissions(), false),
        Some(Driver::Opencode) => (opencode::PERMISSIONS.to_vec(), false),
        None => (vec![AgentPermission::Edit], false),
    };
    // A kind with Auto or Bypass can run a Project's coordinator (0042). A model service's Auto
    // isn't offered in a Project, but its Bypass is.
    let coordinator = permissions
        .iter()
        .any(|p| matches!(p, AgentPermission::Auto | AgentPermission::Bypass));
    // The login runs the instance's own program where it is the kind's. An agent without a
    // preset login says how it signs in.
    let login = preset.filter(|p| !p.login.is_empty()).map(|p| {
        p.login
            .iter()
            .enumerate()
            .map(|(i, arg)| match &instance.program {
                Some(program) if i == 0 && *arg == p.program => program.clone(),
                _ => (*arg).to_owned(),
            })
            .collect()
    });
    let login = login.or(found.login);
    let login_env = found.login_env.map_or_else(
        || {
            instance
                .env
                .iter()
                .filter(|var| !var.secret && var.value.is_some())
                .cloned()
                .collect()
        },
        |env| {
            env.into_iter()
                .map(|(name, value)| ProviderEnvVar {
                    name: name.to_string_lossy().into_owned(),
                    value: Some(value.to_string_lossy().into_owned()),
                    secret: false,
                })
                .collect()
        },
    );
    let mut instance = instance;
    for var in &mut instance.env {
        if var.secret {
            var.value = None;
        }
    }
    ProviderInfo {
        instance,
        installed: found.installed,
        installing: found.installing,
        path: found.path,
        version: found.version,
        signed_in: found.signed_in,
        account: found.account,
        note: found.note,
        models: found.models,
        permissions,
        efforts,
        coordinator,
        login,
        login_env,
        sign_in_error: None,
    }
}

/// The built-in `cursor` instance's backend before any setting changes it: the Cursor SDK
/// sidecar (0053).
#[must_use]
pub fn cursor_backend(launcher: Launcher) -> crate::backend::cursor_sdk::CursorSdkBackend {
    crate::backend::cursor_sdk::CursorSdkBackend::new(launcher)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parallax_protocol::{ProviderEnvVar, ProviderInstance, ProviderKind};

    use super::{Found, Providers, Stored, home_var, preset, with_pools};
    use crate::backend::process::{Environment, Launcher};
    use crate::keystore::{KeyStore, MemoryKeyStore};
    use crate::paths::DataDir;
    use crate::routing::BackendRegistry;

    fn load(dir: &std::path::Path, keys: Arc<MemoryKeyStore>) -> (Providers, BackendRegistry) {
        let launcher = Launcher::new(
            DataDir::new(dir.join("data")).unwrap(),
            Environment::empty(),
        );
        let registry = BackendRegistry::new();
        let providers = Providers::load(dir, keys, &launcher, &registry);
        (providers, registry)
    }

    /// An enabled instance with no settings.
    fn instance(id: &str, kind: ProviderKind, name: &str) -> ProviderInstance {
        ProviderInstance {
            id: id.into(),
            kind,
            name: name.into(),
            enabled: true,
            program: None,
            home: None,
            args: Vec::new(),
            env: Vec::new(),
            models: Vec::new(),
            reserve: None,
            members: None,
        }
    }

    fn ollama() -> ProviderInstance {
        ProviderInstance {
            env: vec![
                ProviderEnvVar {
                    name: "ANTHROPIC_BASE_URL".into(),
                    value: Some("https://ollama.com".into()),
                    secret: false,
                },
                ProviderEnvVar {
                    name: "ANTHROPIC_AUTH_TOKEN".into(),
                    value: Some("ollama-key".into()),
                    secret: true,
                },
            ],
            ..instance("ollama", ProviderKind::OllamaCloud, "Ollama Cloud")
        }
    }

    #[tokio::test]
    async fn a_saved_instance_keeps_its_secret_in_the_keychain_and_routes_by_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let (providers, registry) = load(dir.path(), Arc::clone(&keys));
        providers.save(ollama()).await.unwrap();

        let file = std::fs::read_to_string(dir.path().join("providers.json")).unwrap();
        assert!(
            !file.contains("ollama-key"),
            "the key stays out of the file"
        );
        let stored: Vec<Stored> = serde_json::from_str(&file).unwrap();
        let secrets = stored
            .iter()
            .find(|s| s.instance.id == "ollama")
            .unwrap()
            .secrets;
        let kept = keys.get(secrets.unwrap()).unwrap().unwrap();
        assert!(kept.contains("ollama-key"));
        assert_eq!(
            registry.by_backend_name("ollama").unwrap().1.name(),
            "ollama"
        );

        // Saving again without the value keeps it; a reload registers it again.
        let mut edited = ollama();
        edited.env[1].value = None;
        edited.name = "Ollama".into();
        providers.save(edited).await.unwrap();
        let (reloaded, registry) = load(dir.path(), keys);
        let entry = reloaded
            .stored
            .lock()
            .await
            .iter()
            .find(|s| s.instance.id == "ollama")
            .cloned();
        let env = reloaded.env(&entry.unwrap());
        assert!(
            env.iter()
                .any(|(name, value)| name == "ANTHROPIC_AUTH_TOKEN" && value == "ollama-key")
        );
        assert!(registry.by_backend_name("ollama").is_some());
    }

    #[tokio::test]
    async fn an_account_home_is_created_only_when_added_or_changed() {
        let dir = tempfile::tempdir().unwrap();
        let (providers, _) = load(dir.path(), Arc::new(MemoryKeyStore::new()));
        let home = dir.path().join("account");
        let mut account = ProviderInstance {
            home: Some(home.display().to_string()),
            ..instance("work", ProviderKind::Codex, "Work")
        };
        providers.save(account.clone()).await.unwrap();
        assert!(home.is_dir());

        // An unavailable home must not prevent renaming or disabling the account.
        std::fs::remove_dir(&home).unwrap();
        std::fs::write(&home, "unavailable folder").unwrap();
        account.name = "Personal".into();
        account.enabled = false;
        providers.save(account.clone()).await.unwrap();
        assert!(home.is_file());

        let changed = dir.path().join("changed");
        account.home = Some(changed.display().to_string());
        providers.save(account.clone()).await.unwrap();
        assert!(changed.is_dir());

        account.home = Some("relative-account-home".into());
        assert!(providers.save(account).await.is_err());
    }

    #[test]
    fn an_account_probe_reads_its_own_home() {
        for (kind, var) in [
            (ProviderKind::Claude, "CLAUDE_CONFIG_DIR"),
            (ProviderKind::Codex, "CODEX_HOME"),
        ] {
            let account = ProviderInstance {
                home: Some("/accounts/work".into()),
                ..instance("work", kind, "Work")
            };
            assert_eq!(
                home_var(&account, &preset(kind).unwrap()),
                Some((var.into(), "/accounts/work".into()))
            );
        }
    }

    #[tokio::test]
    async fn a_pool_holds_two_instances_of_its_kind_and_is_never_a_backend() {
        let dir = tempfile::tempdir().unwrap();
        let (providers, registry) = load(dir.path(), Arc::new(MemoryKeyStore::new()));
        for id in ["work", "home"] {
            providers
                .save(instance(id, ProviderKind::Codex, id))
                .await
                .unwrap();
        }
        providers
            .save(instance("claude-x", ProviderKind::Claude, "Claude X"))
            .await
            .unwrap();
        let pool = |members: &[&str]| ProviderInstance {
            members: Some(members.iter().map(|&m| m.to_owned()).collect()),
            ..instance("pool", ProviderKind::Codex, "Codex pool")
        };

        assert!(providers.save(pool(&["work"])).await.is_err(), "one member");
        assert!(providers.save(pool(&["work", "work"])).await.is_err());
        assert!(providers.save(pool(&["work", "claude-x"])).await.is_err());
        assert!(providers.save(pool(&["work", "gone"])).await.is_err());
        providers.save(pool(&["work", "home"])).await.unwrap();
        assert!(registry.by_backend_name("pool").is_none());
        assert!(registry.by_backend_name("work").is_some());
        assert_eq!(
            providers.members("pool").await,
            Some(vec!["work".to_owned(), "home".to_owned()])
        );
        assert_eq!(providers.members("work").await, None);

        // A member leaves the pool before it can go.
        assert!(providers.remove("work").await.is_err());
        providers.remove("pool").await.unwrap();
        providers.remove("work").await.unwrap();
    }

    #[test]
    fn a_pool_lists_its_members_models_and_sign_in() {
        let entry = |instance| Stored {
            instance,
            secrets: None,
        };
        let model = |id: &str| parallax_protocol::ProviderModel {
            id: id.into(),
            name: id.into(),
        };
        let stored = vec![
            entry(ProviderInstance {
                models: vec![model("custom"), model("gpt-5")],
                ..instance("work", ProviderKind::Codex, "Work")
            }),
            entry(instance("home", ProviderKind::Codex, "Home")),
            entry(ProviderInstance {
                members: Some(vec!["work".into(), "home".into()]),
                ..instance("pool", ProviderKind::Codex, "Pool")
            }),
        ];
        let found = vec![
            Found {
                installed: true,
                signed_in: Some(false),
                models: vec![model("gpt-5")],
                ..Found::default()
            },
            Found {
                installed: true,
                signed_in: Some(true),
                models: vec![model("gpt-5"), model("gpt-5-mini")],
                ..Found::default()
            },
            Found::default(),
        ];
        let listed = with_pools(stored, found);
        let pool = &listed[2];
        assert!(pool.installed);
        assert_eq!(pool.signed_in, Some(true));
        let ids: Vec<&str> = pool.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-5", "gpt-5-mini", "custom"]);
        assert_eq!(pool.login, None);
        assert_eq!(listed[0].signed_in, Some(false));
    }
}
