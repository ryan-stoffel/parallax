//! `/settings` in `plxd tui` (PLX-1085): the app's account and host settings, so the TUI stands
//! alone. A screen of its own over the transcript, on the plxd methods the app's Settings uses:
//!
//! - **Providers**, from `providers/list`: Enter signs in. One with a `login` command gets the
//!   terminal (`plxd tui` steps aside, runs it with its `loginEnv` and home, and comes back), as
//!   the app's sign-in terminal runs it. Cursor signs in and out in the browser (`cursor/signIn`,
//!   `cursor/signOut`). Space turns one on or off (`providers/save`).
//! - **New threads**: the provider they run on, `accounts/defaults/set`'s worker default.
//! - **GitHub**, from `github/status`: `github/install`, then `github/signIn`'s device code.
//! - **API keys**, from `accounts/keys/list`: add one (the key shows as dots), or remove one.
//! - **General**, from `host/settings/get`: each toggle, and the device name.
//!
//! While a browser sign-in or an install runs, the screen reads again every [`POLL`].

use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

use parallax_protocol::methods::{
    AccountsDefaultsSet, AccountsKeysAdd, AccountsKeysList, AccountsKeysRemove, CursorSignIn,
    CursorSignInCancel, CursorSignOut, GithubInstall, GithubSignInCancel, GithubSignInStart,
    GithubStatusGet, HostSettingsGet, HostSettingsSet, ProvidersSave, RequestMethod,
};
use parallax_protocol::{
    AccountChoice, AccountId, AccountsDefaultsSetParams, AccountsKeysAddParams,
    AccountsKeysListParams, AccountsKeysRemoveParams, CursorSignInParams, GithubInstallParams,
    GithubSignInCancelParams, GithubSignInParams, GithubStatus, GithubStatusParams, HostSettings,
    HostSettingsGetParams, HostSettingsSetParams, KeyAccount, Provider, ProviderInfo, ProviderKind,
    ProvidersSaveParams, Role,
};
use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Margin};
use ratatui::style::{Color, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Paragraph, Wrap};
use unicode_width::UnicodeWidthStr as _;

use super::draw::{BLUE, CORAL, clip};
use super::{App, CALL_TIMEOUT, Loaded, read_providers};
use crate::peer::Plxd;

/// How often the screen reads again while it waits on a browser sign-in or an install.
const POLL: Duration = Duration::from_secs(3);

/// The keys an API key can be for, as the app's Add API key offers them.
const KEY_PROVIDERS: [(Provider, &str); 3] = [
    (Provider::Anthropic, "Anthropic"),
    (Provider::Openai, "OpenAI"),
    (Provider::Cursor, "Cursor"),
];

/// A host setting that's on or off, with the app's name for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Toggle {
    AutoResume,
    ContinueAfterRestart,
    CleanWorktrees,
    Connect,
    Remote,
    RemoteWeb,
    Relay,
}

const TOGGLES: [Toggle; 7] = [
    Toggle::AutoResume,
    Toggle::ContinueAfterRestart,
    Toggle::CleanWorktrees,
    Toggle::Connect,
    Toggle::Remote,
    Toggle::RemoteWeb,
    Toggle::Relay,
];

impl Toggle {
    fn name(self) -> &'static str {
        match self {
            Self::AutoResume => "Resume after a usage limit",
            Self::ContinueAfterRestart => "Continue threads after restarts",
            Self::CleanWorktrees => "Clean up merged worktrees",
            Self::Connect => "Parallax Connect",
            Self::Remote => "Remote access over HTTPS",
            Self::RemoteWeb => "Web client",
            Self::Relay => "Parallax Relay",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::AutoResume => {
                "A thread a usage limit stopped waits for the limit to reset, then resumes."
            }
            Self::ContinueAfterRestart => {
                "A thread that was working when plxd restarted is told to continue where it left off."
            }
            Self::CleanWorktrees => {
                "Removes a settled or archived thread's worktree and branch once its pull requests merge."
            }
            Self::Connect => "Lets your other computers reach this one over Tailscale.",
            Self::Remote => "Lets paired devices reach this computer over HTTPS on port 7341.",
            Self::RemoteWeb => {
                "Serves Parallax as a web page to paired browsers, while remote access is on."
            }
            Self::Relay => {
                "Reaches your devices from anywhere through Parallax Relay, while remote access is on."
            }
        }
    }

    /// Its value, or None from a plxd too old to have it.
    fn get(self, host: &HostSettings) -> Option<bool> {
        match self {
            Self::AutoResume => Some(host.auto_resume),
            Self::ContinueAfterRestart => host.continue_after_restart,
            Self::CleanWorktrees => host.clean_worktrees,
            Self::Connect => host.connect,
            Self::Remote => host.remote,
            Self::RemoteWeb => host.remote_web,
            Self::Relay => host.relay,
        }
    }

    /// The change that sets it to `on`.
    fn set(self, on: bool) -> HostSettingsSetParams {
        let mut params = HostSettingsSetParams::default();
        let field = match self {
            Self::AutoResume => &mut params.auto_resume,
            Self::ContinueAfterRestart => &mut params.continue_after_restart,
            Self::CleanWorktrees => &mut params.clean_worktrees,
            Self::Connect => &mut params.connect,
            Self::Remote => &mut params.remote,
            Self::RemoteWeb => &mut params.remote_web,
            Self::Relay => &mut params.relay,
        };
        *field = Some(on);
        params
    }
}

/// A row of the screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Row {
    Heading(&'static str),
    /// A provider instance, by id.
    Provider(String),
    /// The provider new threads run on.
    DefaultProvider,
    Github,
    Key(AccountId),
    AddKey(Provider),
    Toggle(Toggle),
    DeviceName,
}

impl Row {
    fn heading(&self) -> bool {
        matches!(self, Self::Heading(_))
    }
}

/// What the one-line field at the bottom of the screen is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Purpose {
    /// A new API key's label.
    KeyLabel(Provider),
    /// The key itself, shown as dots.
    Key {
        provider: Provider,
        label: String,
    },
    DeviceName,
}

/// A sign-in that finishes in the browser, which the screen waits on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Browser {
    /// A Cursor instance's account login page.
    Cursor { instance: String, url: String },
    /// GitHub's device page, and the code to enter there, and when it started: a status read
    /// before then says nothing about it.
    Github {
        code: String,
        url: String,
        since: jiff::Timestamp,
    },
}

/// A provider's own sign-in, run in this terminal while the TUI steps aside.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Login {
    /// The provider, as people know it.
    pub(super) name: String,
    pub(super) program: String,
    pub(super) args: Vec<String>,
    pub(super) env: Vec<(OsString, OsString)>,
}

/// The screen's state. What it shows comes from plxd: the providers are [`App::providers`].
#[derive(Default)]
pub(super) struct Settings {
    /// The highlighted row, an index into [`App::settings_rows`].
    pub(super) selected: usize,
    pub(super) github: Option<GithubStatus>,
    pub(super) keys: Option<Vec<KeyAccount>>,
    pub(super) host: Option<HostSettings>,
    /// The one-line field, and what's typed in it.
    pub(super) field: Option<(Purpose, String)>,
    pub(super) browser: Option<Browser>,
    /// The key `d` was pressed on once: again removes it.
    pub(super) confirm: Option<AccountId>,
    /// What the last action did, or why it failed.
    pub(super) note: Option<String>,
    /// When the screen last read again on its own.
    polled: Option<Instant>,
}

impl App {
    /// Opens the screen, on the first provider that isn't signed in when `login`, and reads what
    /// it shows.
    pub(super) fn open_settings(&mut self, login: bool) {
        self.settings = Some(Settings::default());
        self.refresh_settings(false);
        let rows = self.settings_rows();
        let first = |wanted: &dyn Fn(&Row) -> bool| rows.iter().position(wanted);
        let signed_out = |row: &Row| match row {
            Row::Provider(id) => self
                .providers
                .iter()
                .any(|info| info.instance.id == *id && info.signed_in != Some(true)),
            _ => false,
        };
        let at = login
            .then(|| first(&signed_out))
            .flatten()
            .or_else(|| first(&|row: &Row| !row.heading()))
            .unwrap_or(0);
        if let Some(settings) = &mut self.settings {
            settings.selected = at;
        }
    }

    /// Reads everything the screen shows, in the background; [`App::take`] puts it in place.
    /// `probe` has plxd check each provider again rather than answer from its cache.
    pub(super) fn refresh_settings(&self, probe: bool) {
        let (plxd, loads) = (self.plxd.clone(), self.loads.clone());
        tokio::spawn(async move {
            let (providers, github, keys, host) = tokio::join!(
                read_providers(&plxd, probe),
                within::<GithubStatusGet>(&plxd, GithubStatusParams {}),
                within::<AccountsKeysList>(&plxd, AccountsKeysListParams {}),
                within::<HostSettingsGet>(&plxd, HostSettingsGetParams {}),
            );
            for load in [
                providers.ok(),
                github.ok().map(Loaded::Github),
                keys.ok().map(|keys| Loaded::Keys(keys.accounts)),
                host.ok().map(Loaded::Host),
            ]
            .into_iter()
            .flatten()
            {
                let _ = loads.send(load);
            }
        });
    }

    /// A `github/status` read: an install that ended says how it went.
    pub(super) fn take_github(&mut self, github: GithubStatus) {
        let Some(settings) = &mut self.settings else {
            return;
        };
        let was_installing = settings.github.as_ref().is_some_and(|held| held.installing);
        if was_installing && !github.installing {
            settings.note = Some(install_note(&github));
        }
        settings.github = Some(github);
        self.take_settings();
    }

    /// What a read found, for the screen: a browser sign-in that's done stops waiting.
    pub(super) fn take_settings(&mut self) {
        let Some(settings) = &mut self.settings else {
            return;
        };
        let done = match &settings.browser {
            Some(Browser::Cursor { instance, .. }) => {
                let info = self
                    .providers
                    .iter()
                    .find(|info| info.instance.id == *instance);
                match info {
                    Some(info) if info.signed_in == Some(true) => {
                        Some(format!("Signed in to {}.", info.instance.name))
                    }
                    Some(ProviderInfo {
                        sign_in_error: Some(error),
                        ..
                    }) => Some(format!("Couldn't sign in: {error}")),
                    _ => None,
                }
            }
            // Done when `gh` is signed in, or when plxd stopped waiting on it: failed or expired.
            Some(Browser::Github { since, .. }) => settings
                .github
                .as_ref()
                .filter(|github| github.checked_at > *since)
                .and_then(|github| match (github.signed_in, &github.account) {
                    (Some(true), Some(account)) => {
                        Some(format!("Signed in to GitHub as {account}."))
                    }
                    (Some(true), None) => Some("Signed in to GitHub.".to_owned()),
                    _ if github.signing_in.is_none() => {
                        Some(github.setup_note.clone().unwrap_or_else(|| {
                            "GitHub's sign-in ended without signing in.".to_owned()
                        }))
                    }
                    _ => None,
                }),
            None => None,
        };
        if done.is_some() {
            settings.browser = None;
            settings.note = done;
        }
    }

    /// Reads again every [`POLL`] while a browser sign-in or an install is under way.
    pub(super) fn tick_settings(&mut self) {
        let installing = self.providers.iter().any(|info| info.installing);
        let Some(settings) = &mut self.settings else {
            return;
        };
        let waiting = settings.browser.is_some()
            || installing
            || settings
                .github
                .as_ref()
                .is_some_and(|github| github.installing);
        if !waiting || settings.polled.is_some_and(|at| at.elapsed() < POLL) {
            return;
        }
        settings.polled = Some(Instant::now());
        // A browser sign-in shows up only in a fresh probe.
        self.refresh_settings(true);
    }

    /// The screen's rows, from what plxd has said so far.
    pub(super) fn settings_rows(&self) -> Vec<Row> {
        let Some(settings) = &self.settings else {
            return Vec::new();
        };
        let mut rows = vec![Row::Heading("Providers")];
        rows.extend(
            self.providers
                .iter()
                .map(|info| Row::Provider(info.instance.id.clone())),
        );
        rows.extend([
            Row::Heading("New threads"),
            Row::DefaultProvider,
            Row::Heading("GitHub"),
            Row::Github,
            Row::Heading("API keys"),
        ]);
        rows.extend(settings.keys.iter().flatten().map(|key| Row::Key(key.id)));
        rows.extend(
            KEY_PROVIDERS
                .iter()
                .map(|(provider, _)| Row::AddKey(*provider)),
        );
        if let Some(host) = &settings.host {
            rows.push(Row::Heading("General"));
            rows.extend(
                TOGGLES
                    .iter()
                    .filter(|toggle| toggle.get(host).is_some())
                    .map(|toggle| Row::Toggle(*toggle)),
            );
            rows.push(Row::DeviceName);
        }
        rows
    }

    /// A key while the screen is open.
    pub(super) async fn settings_key(&mut self, key: KeyEvent) {
        let Some(settings) = &mut self.settings else {
            return;
        };
        if settings.field.is_some() {
            return self.field_key(key).await;
        }
        let rows = self.settings_rows();
        let Some(settings) = &mut self.settings else {
            return;
        };
        if key.code != KeyCode::Char('d') && key.code != KeyCode::Delete {
            settings.confirm = None;
        }
        let row = rows.get(settings.selected).cloned();
        let step = |from: usize, by: isize| next_row(&rows, from, by);
        match key.code {
            KeyCode::Esc if settings.browser.is_some() => self.cancel_browser().await,
            KeyCode::Esc => self.settings = None,
            KeyCode::Up => settings.selected = step(settings.selected, -1),
            KeyCode::Down => settings.selected = step(settings.selected, 1),
            KeyCode::PageUp => settings.selected = step(settings.selected, -10),
            KeyCode::PageDown => settings.selected = step(settings.selected, 10),
            KeyCode::Home => settings.selected = step(0, 0),
            KeyCode::End => settings.selected = step(rows.len().saturating_sub(1), 0),
            KeyCode::Char('r') if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                settings.note = Some("Checking again…".to_owned());
                self.refresh_settings(true);
            }
            KeyCode::Enter => {
                if let Some(row) = row {
                    self.act(&row).await;
                }
            }
            KeyCode::Char(' ') => match row {
                Some(Row::Provider(id)) => self.turn_provider(&id).await,
                Some(Row::Toggle(toggle)) => self.flip(toggle).await,
                _ => {}
            },
            KeyCode::Char('d') | KeyCode::Delete => {
                if let Some(Row::Key(id)) = row {
                    self.remove_key(id).await;
                }
            }
            _ => {}
        }
    }

    /// Enter on `row`.
    async fn act(&mut self, row: &Row) {
        match row {
            Row::Provider(id) => self.sign_in(id).await,
            Row::DefaultProvider => self.next_default().await,
            Row::Github => self.github().await,
            Row::AddKey(provider) => {
                let name = key_provider_name(*provider);
                self.set_field(Purpose::KeyLabel(*provider), name.to_owned());
            }
            Row::Toggle(toggle) => self.flip(*toggle).await,
            Row::DeviceName => {
                let name = self
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.host.as_ref()?.device_name.clone())
                    .unwrap_or_default();
                self.set_field(Purpose::DeviceName, name);
            }
            Row::Key(_) => self.note("Press d to remove this key."),
            Row::Heading(_) => {}
        }
    }

    fn set_field(&mut self, purpose: Purpose, text: String) {
        if let Some(settings) = &mut self.settings {
            settings.field = Some((purpose, text));
        }
    }

    fn note(&mut self, note: impl Into<String>) {
        if let Some(settings) = &mut self.settings {
            settings.note = Some(note.into());
        }
    }

    /// A key while the field is open: typing, Backspace, Esc to drop it, Enter to save it.
    async fn field_key(&mut self, key: KeyEvent) {
        let Some((purpose, text)) = self
            .settings
            .as_mut()
            .and_then(|settings| settings.field.as_mut())
        else {
            return;
        };
        match key.code {
            KeyCode::Esc => {
                if let Some(settings) = &mut self.settings {
                    settings.field = None;
                }
            }
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => text.push(c),
            KeyCode::Enter => {
                let (purpose, text) = (purpose.clone(), text.trim().to_owned());
                if let Some(settings) = &mut self.settings {
                    settings.field = None;
                }
                self.submit_field(purpose, text).await;
            }
            _ => {}
        }
    }

    async fn submit_field(&mut self, purpose: Purpose, text: String) {
        match purpose {
            Purpose::KeyLabel(provider) => {
                let label = if text.is_empty() {
                    key_provider_name(provider).to_owned()
                } else {
                    text
                };
                self.set_field(Purpose::Key { provider, label }, String::new());
            }
            Purpose::Key { .. } if text.is_empty() => self.note("No key was added."),
            Purpose::Key { provider, label } => {
                let added = self
                    .call::<AccountsKeysAdd>(AccountsKeysAddParams {
                        id: AccountId::generate(),
                        provider,
                        label,
                        key: text.into(),
                    })
                    .await;
                match added {
                    Ok(added) => {
                        self.note(format!("Added {}.", added.account.label));
                        if let Some(settings) = &mut self.settings {
                            settings.keys.get_or_insert_default().push(added.account);
                        }
                    }
                    Err(error) => self.note(format!("Couldn't add the key: {error}")),
                }
            }
            Purpose::DeviceName => {
                let params = HostSettingsSetParams {
                    device_name: Some(text),
                    ..HostSettingsSetParams::default()
                };
                self.save_host(params).await;
            }
        }
    }

    /// Signs in to provider `id`: in the browser for a Cursor account, otherwise with its own
    /// `login` command in this terminal. Signs a signed-in Cursor account out.
    async fn sign_in(&mut self, id: &str) {
        let Some(info) = self
            .providers
            .iter()
            .find(|info| info.instance.id == id)
            .cloned()
        else {
            return;
        };
        let name = info.instance.name.clone();
        if !info.installed {
            let why = info
                .note
                .clone()
                .unwrap_or_else(|| format!("{name} isn't installed on this computer."));
            return self.note(format!("{why} Install it, then press r."));
        }
        if cursor_account(&info) {
            let params = CursorSignInParams {
                instance: Some(info.instance.id.clone()),
            };
            if info.signed_in == Some(true) {
                return match self.call::<CursorSignOut>(params).await {
                    Ok(_) => {
                        self.note(format!("Signed out of {name}."));
                        self.refresh_settings(true);
                    }
                    Err(error) => self.note(format!("Couldn't sign out of {name}: {error}")),
                };
            }
            return match self.call::<CursorSignIn>(params).await {
                Ok(started) => {
                    open_url(&started.url);
                    if let Some(settings) = &mut self.settings {
                        settings.note = None;
                        settings.browser = Some(Browser::Cursor {
                            instance: info.instance.id.clone(),
                            url: started.url,
                        });
                    }
                }
                Err(error) => self.note(format!("Couldn't sign in to {name}: {error}")),
            };
        }
        if info.signed_in == Some(true) {
            return self.note(format!("{name} is signed in."));
        }
        match login_of(&info) {
            Some(login) => self.handover = Some(login),
            None => self.note(format!(
                "{name} has no sign-in here. Set it up with its own CLI, then press r."
            )),
        }
    }

    /// Turns provider `id` on or off, as the app's Settings does.
    async fn turn_provider(&mut self, id: &str) {
        let Some(info) = self.providers.iter().find(|info| info.instance.id == id) else {
            return;
        };
        if info.hub.is_some() {
            let name = info.instance.name.clone();
            return self.note(format!(
                "{name} runs through a hub, whose settings it takes."
            ));
        }
        let mut instance = info.instance.clone();
        instance.enabled = !instance.enabled;
        let on = instance.enabled;
        match self
            .call::<ProvidersSave>(ProvidersSaveParams { instance })
            .await
        {
            Ok(listed) => {
                self.providers = listed.providers;
                self.note(if on {
                    "Turned it on."
                } else {
                    "Turned it off."
                });
            }
            Err(error) => self.note(format!("Couldn't save it: {error}")),
        }
    }

    /// Moves new threads to the next installed provider that's on.
    async fn next_default(&mut self) {
        let choices: Vec<&ProviderInfo> = self
            .providers
            .iter()
            .filter(|info| info.instance.enabled && info.installed)
            .collect();
        if choices.is_empty() {
            return self.note("No provider is installed and on.");
        }
        let now = choices
            .iter()
            .position(|info| self.default_backend.as_deref() == Some(info.instance.id.as_str()));
        let next = choices[now.map_or(0, |at| (at + 1) % choices.len())];
        let (backend, name) = (next.instance.id.clone(), next.instance.name.clone());
        let before = self.provider().map(str::to_owned);
        let set = self
            .call::<AccountsDefaultsSet>(AccountsDefaultsSetParams {
                role: Role::Worker,
                account: Some(AccountChoice::Subscription {
                    backend: backend.clone(),
                }),
            })
            .await;
        match set {
            Ok(_) => {
                self.default_backend = Some(backend);
                // A model, mode, or effort chosen for the old provider doesn't follow.
                self.fit_provider(before.as_deref());
                self.note(format!("New threads run on {name}."));
            }
            Err(error) => self.note(format!("Couldn't change it: {error}")),
        }
    }

    /// Installs `gh`, or signs it in with a device code in the browser.
    async fn github(&mut self) {
        let Some(github) = self
            .settings
            .as_ref()
            .and_then(|settings| settings.github.clone())
        else {
            return self.note("Still reading GitHub's status. Try again in a moment.");
        };
        if github.installing {
            return self.note("Installing the GitHub CLI…");
        }
        if !github.installed {
            return match self.call::<GithubInstall>(GithubInstallParams {}).await {
                // An install that already ended, or failed to start, says so now: nothing polls.
                Ok(status) => {
                    if let Some(settings) = &mut self.settings {
                        settings.note = Some(install_note(&status));
                        settings.github = Some(status);
                    }
                }
                Err(error) => self.note(format!("Couldn't install the GitHub CLI: {error}")),
            };
        }
        if github.signed_in == Some(true) {
            return self.note("GitHub is signed in.");
        }
        match self.call::<GithubSignInStart>(GithubSignInParams {}).await {
            Ok(started) => {
                open_url(&started.url);
                if let Some(settings) = &mut self.settings {
                    settings.note = None;
                    settings.browser = Some(Browser::Github {
                        code: started.code,
                        url: started.url,
                        since: jiff::Timestamp::now(),
                    });
                }
            }
            Err(error) => self.note(format!("Couldn't sign in to GitHub: {error}")),
        }
    }

    /// Stops waiting on the browser, and tells plxd to stop too.
    async fn cancel_browser(&mut self) {
        let Some(browser) = self
            .settings
            .as_mut()
            .and_then(|settings| settings.browser.take())
        else {
            return;
        };
        let _ = match browser {
            Browser::Cursor { instance, .. } => self
                .call::<CursorSignInCancel>(CursorSignInParams {
                    instance: Some(instance),
                })
                .await
                .map(drop),
            Browser::Github { .. } => self
                .call::<GithubSignInCancel>(GithubSignInCancelParams {})
                .await
                .map(drop),
        };
        self.note("Sign-in cancelled.");
    }

    async fn flip(&mut self, toggle: Toggle) {
        let now = self
            .settings
            .as_ref()
            .and_then(|settings| toggle.get(settings.host.as_ref()?));
        if let Some(on) = now {
            self.save_host(toggle.set(!on)).await;
        }
    }

    async fn save_host(&mut self, params: HostSettingsSetParams) {
        match self.call::<HostSettingsSet>(params).await {
            Ok(host) => {
                if let Some(settings) = &mut self.settings {
                    settings.host = Some(host);
                    settings.note = Some("Saved.".to_owned());
                }
            }
            Err(error) => self.note(format!("Couldn't save it: {error}")),
        }
    }

    /// Removes key `id` on the second `d`.
    async fn remove_key(&mut self, id: AccountId) {
        let Some(settings) = &mut self.settings else {
            return;
        };
        if settings.confirm != Some(id) {
            settings.confirm = Some(id);
            settings.note = Some("Press d again to remove this key.".to_owned());
            return;
        }
        settings.confirm = None;
        match self
            .call::<AccountsKeysRemove>(AccountsKeysRemoveParams { id })
            .await
        {
            // The highlight stays put, on the next key or an Add row.
            Ok(_) => {
                if let Some(settings) = &mut self.settings {
                    if let Some(keys) = &mut settings.keys {
                        keys.retain(|key| key.id != id);
                    }
                    settings.note = Some("Removed the key.".to_owned());
                }
            }
            Err(error) => self.note(format!("Couldn't remove the key: {error}")),
        }
    }

    /// The screen, over everything else.
    pub(super) fn draw_settings(&self, frame: &mut Frame) {
        let Some(settings) = &self.settings else {
            return;
        };
        let area = frame.area();
        frame.render_widget(Clear, area);
        let rows = self.settings_rows();
        let selected = rows.get(settings.selected);
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(BLUE))
            .title(Line::from(vec![
                Span::from(" Settings ").bold(),
                Span::from(format!("plxd v{} ", crate::version())).dark_gray(),
            ]))
            .title_bottom(Line::from(format!(" {} ", self.keys_hint(selected))).dark_gray());
        let inner = block.inner(area).inner(Margin::new(1, 0));
        frame.render_widget(block, area);

        let about = self.about(settings, selected);
        let about_rows = Paragraph::new(about.clone())
            .wrap(Wrap { trim: false })
            .line_count(inner.width);
        let about_rows = u16::try_from(about_rows)
            .unwrap_or(u16::MAX)
            .min(inner.height / 2);
        let [list, gap, about_area] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(1),
            Constraint::Length(about_rows),
        ])
        .areas(inner);
        let rule = Paragraph::new("─".repeat(usize::from(gap.width))).dark_gray();
        frame.render_widget(rule, gap);
        frame.render_widget(Paragraph::new(about).wrap(Wrap { trim: false }), about_area);

        let width = usize::from(list.width);
        let label_width = rows
            .iter()
            .filter(|row| !row.heading())
            .map(|row| self.row_text(settings, row).0.width())
            .max()
            .unwrap_or(0)
            .min(width / 2);
        let mut lines: Vec<(Line, usize)> = Vec::new();
        for (i, row) in rows.iter().enumerate() {
            if let Row::Heading(title) = row {
                if !lines.is_empty() {
                    lines.push((Line::default(), i));
                }
                lines.push((Line::from(*title).bold().fg(BLUE), i));
                continue;
            }
            let (label, status, tone) = self.row_text(settings, row);
            let label = clip(&label, label_width);
            let pad = label_width.saturating_sub(label.width());
            let status = clip(&status, width.saturating_sub(label_width + 6));
            let marker = match tone {
                Tone::Good => Span::from("● ").fg(Color::Green),
                Tone::Bad => Span::from("● ").fg(CORAL),
                Tone::Off => Span::from("○ ").dark_gray(),
                Tone::None => Span::from("  "),
            };
            let selected = i == settings.selected;
            let status = Span::from(status);
            let mut line = Line::from(vec![
                Span::from(if selected { "❯ " } else { "  " }),
                marker,
                Span::from(format!("{label}{}  ", " ".repeat(pad))),
                // On the highlight, white like the rest of the row.
                if selected { status } else { status.dark_gray() },
            ]);
            if selected {
                let pad = width.saturating_sub(line.width());
                line.spans.push(Span::raw(" ".repeat(pad)));
                line = line.style(Style::new().bg(BLUE).fg(Color::White)).bold();
            }
            lines.push((line, i));
        }
        // Keeps the highlighted row, and its heading where there's room, on screen.
        let height = usize::from(list.height);
        let at = lines
            .iter()
            .position(|(_, i)| *i == settings.selected)
            .unwrap_or(0);
        let skip = (at + 1).saturating_sub(height);
        let shown: Vec<Line> = lines
            .into_iter()
            .skip(skip)
            .take(height)
            .map(|(line, _)| line)
            .collect();
        frame.render_widget(Paragraph::new(shown), list);
    }

    /// A row's label, its status, and its dot.
    fn row_text(&self, settings: &Settings, row: &Row) -> (String, String, Tone) {
        match row {
            Row::Heading(title) => ((*title).to_owned(), String::new(), Tone::None),
            Row::Provider(id) => match self.providers.iter().find(|info| info.instance.id == *id) {
                Some(info) => {
                    let (status, tone) = provider_status(info);
                    (info.instance.name.clone(), status, tone)
                }
                None => (id.clone(), String::new(), Tone::None),
            },
            Row::DefaultProvider => {
                let name = self
                    .default_backend
                    .as_deref()
                    .map_or_else(|| "plxd's choice".to_owned(), |id| self.provider_name(id));
                ("Provider".to_owned(), name, Tone::None)
            }
            Row::Github => {
                let (status, tone) = settings
                    .github
                    .as_ref()
                    .map_or(("checking…".to_owned(), Tone::None), github_status);
                ("GitHub CLI".to_owned(), status, tone)
            }
            Row::Key(id) => settings
                .keys
                .iter()
                .flatten()
                .find(|key| key.id == *id)
                .map_or_else(
                    || (String::new(), String::new(), Tone::None),
                    |key| {
                        let provider = key_provider_name(key.provider);
                        (
                            key.label.clone(),
                            format!("{provider} · {}", key.masked_key),
                            Tone::Good,
                        )
                    },
                ),
            Row::AddKey(provider) => (
                format!("+ Add {} key", key_provider_name(*provider)),
                String::new(),
                Tone::None,
            ),
            Row::Toggle(toggle) => {
                let on = settings.host.as_ref().and_then(|host| toggle.get(host));
                let (status, tone) = match on {
                    Some(true) => ("on", Tone::Good),
                    _ => ("off", Tone::Off),
                };
                (toggle.name().to_owned(), status.to_owned(), tone)
            }
            Row::DeviceName => {
                let name = settings
                    .host
                    .as_ref()
                    .and_then(|host| host.device_name.clone())
                    .unwrap_or_else(|| "not set".to_owned());
                ("Device name".to_owned(), name, Tone::None)
            }
        }
    }

    /// What Enter, Space, and the rest do on `row`.
    fn keys_hint(&self, row: Option<&Row>) -> String {
        let Some(settings) = &self.settings else {
            return String::new();
        };
        if let Some((purpose, _)) = &settings.field {
            return match purpose {
                Purpose::Key { .. } => "enter add the key · esc cancel".to_owned(),
                _ => "enter save · esc cancel".to_owned(),
            };
        }
        if settings.browser.is_some() {
            return "esc cancel the sign-in".to_owned();
        }
        let action = match row {
            Some(Row::Provider(id)) => self
                .providers
                .iter()
                .find(|info| info.instance.id == *id)
                .map_or("", |info| {
                    match (cursor_account(info), info.signed_in == Some(true)) {
                        (true, true) => "enter sign out · space turn on/off · ",
                        (_, false) if info.installed => "enter sign in · space turn on/off · ",
                        _ => "space turn on/off · ",
                    }
                }),
            Some(Row::DefaultProvider) => "enter next provider · ",
            Some(Row::Github) => "enter set up · ",
            Some(Row::Key(_)) => "d remove · ",
            Some(Row::AddKey(_)) => "enter add · ",
            Some(Row::Toggle(_)) => "enter turn on/off · ",
            Some(Row::DeviceName) => "enter edit · ",
            Some(Row::Heading(_)) | None => "",
        };
        format!("{action}↑↓ move · r check again · esc close")
    }

    /// Below the list: the field being typed in, a browser sign-in, the last note, and what the
    /// highlighted row does.
    fn about(&self, settings: &Settings, row: Option<&Row>) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        if let Some((purpose, text)) = &settings.field {
            let (prompt, shown) = match purpose {
                Purpose::KeyLabel(provider) => (
                    format!("Label for the {} key", key_provider_name(*provider)),
                    text.clone(),
                ),
                Purpose::Key { provider, .. } => (
                    format!("{} API key", key_provider_name(*provider)),
                    "•".repeat(text.chars().count()),
                ),
                Purpose::DeviceName => ("Device name".to_owned(), text.clone()),
            };
            lines.push(Line::from(vec![
                Span::from(format!("{prompt} › ")).fg(BLUE).bold(),
                Span::from(shown),
                Span::from("▏").fg(BLUE),
            ]));
            return lines;
        }
        match &settings.browser {
            Some(Browser::Github { code, url, .. }) => {
                lines.push(Line::from(vec![
                    Span::from("Enter ").dark_gray(),
                    Span::from(code.clone()).bold().fg(CORAL),
                    Span::from(format!(" at {url}")).dark_gray(),
                ]));
                lines.push(
                    Line::from("Waiting for GitHub… the browser should have opened.").dark_gray(),
                );
            }
            Some(Browser::Cursor { url, .. }) => {
                lines.push(
                    Line::from("Approve the sign-in in your browser. If it didn't open, go to:")
                        .dark_gray(),
                );
                lines.push(Line::from(url.clone()));
            }
            None => {}
        }
        if let Some(note) = &settings.note {
            lines.push(Line::from(note.clone()).fg(Color::Cyan));
        }
        let description = match row {
            Some(Row::Provider(id)) => self
                .providers
                .iter()
                .find(|info| info.instance.id == *id)
                .map(|info| {
                    let mut parts = vec![];
                    if let Some(version) = &info.version {
                        parts.push(format!("Version {version}"));
                    }
                    if let Some(path) = &info.path {
                        parts.push(path.clone());
                    }
                    if let Some(note) = info.note.as_ref().filter(|_| info.installed) {
                        parts.push(note.clone());
                    }
                    parts.join(" · ")
                })
                .unwrap_or_default(),
            Some(Row::DefaultProvider) => {
                "The provider a new thread runs on. /provider picks another for one message.".to_owned()
            }
            Some(Row::Github) => {
                "Parallax opens pull requests and reads their checks with the GitHub CLI, gh.".to_owned()
            }
            Some(Row::Key(_) | Row::AddKey(_)) => {
                "A key runs a provider on its API instead of your subscription. plxd keeps it in the system keychain.".to_owned()
            }
            Some(Row::Toggle(toggle)) => toggle.description().to_owned(),
            Some(Row::DeviceName) => "This computer's name on your other devices.".to_owned(),
            Some(Row::Heading(_)) | None => String::new(),
        };
        if !description.is_empty() {
            lines.push(Line::from(description).dark_gray());
        }
        lines
    }
}

/// A row's dot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tone {
    /// Signed in, or on.
    Good,
    /// Needs something: not installed, or not signed in.
    Bad,
    Off,
    None,
}

/// What a provider's row says, and its dot.
fn provider_status(info: &ProviderInfo) -> (String, Tone) {
    let (status, tone) = if info.installing {
        ("installing…".to_owned(), Tone::Off)
    } else if !info.installed {
        ("not installed".to_owned(), Tone::Bad)
    } else {
        match info.signed_in {
            Some(true) => {
                let who = [info.account.as_deref(), info.plan.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                let status = if who.is_empty() {
                    "signed in".to_owned()
                } else {
                    format!("signed in · {who}")
                };
                (status, Tone::Good)
            }
            Some(false) => ("not signed in".to_owned(), Tone::Bad),
            None => ("sign-in unknown".to_owned(), Tone::Off),
        }
    };
    if info.instance.enabled {
        (status, tone)
    } else {
        (format!("off · {status}"), Tone::Off)
    }
}

fn github_status(github: &GithubStatus) -> (String, Tone) {
    let version = github
        .version
        .as_ref()
        .map_or_else(String::new, |version| format!(" · gh {version}"));
    if github.installing {
        return ("installing…".to_owned(), Tone::Off);
    }
    if !github.installed {
        return ("not installed".to_owned(), Tone::Bad);
    }
    match (github.signed_in, &github.account) {
        (Some(true), Some(account)) => (format!("signed in as {account}{version}"), Tone::Good),
        (Some(true), None) => (format!("signed in{version}"), Tone::Good),
        (Some(false), _) => (format!("not signed in{version}"), Tone::Bad),
        (None, _) => (format!("sign-in unknown{version}"), Tone::Off),
    }
}

/// How a `github/install` stands, by the status it or a later read returned.
fn install_note(github: &GithubStatus) -> String {
    match (&github.setup_note, github.installing, github.installed) {
        (_, true, _) => "Installing the GitHub CLI…".to_owned(),
        (Some(why), ..) => why.clone(),
        (None, _, true) => "Installed the GitHub CLI. Press enter to sign in.".to_owned(),
        (None, _, false) => "The GitHub CLI didn't install.".to_owned(),
    }
}

/// Whether `info` is a Cursor account that signs in in the browser: a Cursor instance with no
/// `CURSOR_API_KEY` of its own, as the app's Settings tells them apart.
fn cursor_account(info: &ProviderInfo) -> bool {
    info.instance.kind == ProviderKind::Cursor
        && !info
            .instance
            .env
            .iter()
            .any(|var| var.name == "CURSOR_API_KEY")
}

/// `info`'s own sign-in, as the app's sign-in terminal runs it: its `login` argv with its
/// `loginEnv` and its home's variable. A program that's the one plxd found runs from where plxd
/// found it.
pub(super) fn login_of(info: &ProviderInfo) -> Option<Login> {
    let (program, args) = info.login.as_ref()?.split_first()?;
    let own = info.path.as_deref().filter(|path| {
        Path::new(path)
            .file_stem()
            .is_some_and(|stem| stem == program.as_str())
    });
    let mut env: Vec<(OsString, OsString)> = info
        .login_env
        .iter()
        .map(|var| {
            (
                var.name.clone().into(),
                var.value.clone().unwrap_or_default().into(),
            )
        })
        .collect();
    env.extend(crate::providers::instance_home_var(&info.instance));
    Some(Login {
        name: info.instance.name.clone(),
        program: own.map_or_else(|| program.clone(), str::to_owned),
        args: args.to_vec(),
        env,
    })
}

fn key_provider_name(provider: Provider) -> &'static str {
    KEY_PROVIDERS
        .iter()
        .find(|(held, _)| *held == provider)
        .map_or("other", |(_, name)| name)
}

/// The row `by` rows from `from`, past headings, within the list. With `by` 0, `from` itself, or
/// the next row after it that isn't a heading.
pub(super) fn next_row(rows: &[Row], from: usize, by: isize) -> usize {
    let Some(last) = rows.len().checked_sub(1) else {
        return 0;
    };
    let mut at = from.saturating_add_signed(by).min(last);
    let step: isize = if by < 0 { -1 } else { 1 };
    while rows[at].heading() {
        match at.checked_add_signed(step).filter(|next| *next <= last) {
            Some(next) => at = next,
            // Only headings that way: it stays where it was.
            None => return from,
        }
    }
    at
}

/// Opens `url` in the browser, where there is one. The screen shows it either way.
fn open_url(url: &str) {
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "start", ""]);
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    let _ = command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Calls `M` from the background, giving up after [`CALL_TIMEOUT`], as [`App::call`] does.
async fn within<M: RequestMethod>(plxd: &Plxd, params: M::Params) -> Result<M::Result, String> {
    tokio::time::timeout(CALL_TIMEOUT, plxd.call::<M>(params))
        .await
        .map_err(|_| format!("plxd didn't answer {} within {CALL_TIMEOUT:?}", M::NAME))?
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{ClientInfo, HostSettings, ProviderInfo};
    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use parallax_protocol::GithubStatus;

    use super::{App, Browser, Purpose, Row, Settings, Toggle, login_of, next_row};
    use crate::peer::Plxd;

    /// An app whose plxd is never reached: these keys make no calls.
    fn app() -> App {
        App::new(Plxd::new(|| async {
            Err::<(tokio::io::DuplexStream, ClientInfo), String>("no plxd in tests".to_owned())
        }))
    }

    fn provider(id: &str, kind: &str, extra: &serde_json::Value) -> ProviderInfo {
        let mut info = serde_json::json!({
            "instance": { "id": id, "kind": kind, "name": id, "enabled": true },
            "installed": true,
            "permissions": [],
            "efforts": true,
            "coordinator": false,
        });
        for (key, value) in extra.as_object().unwrap() {
            info[key] = value.clone();
        }
        serde_json::from_value(info).unwrap()
    }

    #[test]
    fn rows_list_providers_keys_and_only_the_settings_plxd_has() {
        let mut app = app();
        app.providers = vec![provider("claude", "claude", &serde_json::json!({}))];
        app.settings = Some(Settings {
            host: Some(HostSettings {
                auto_resume: true,
                continue_after_restart: Some(false),
                clean_worktrees: None,
                connect: None,
                remote: None,
                remote_web: None,
                relay: None,
                device_name: None,
                device_icon: None,
            }),
            ..Settings::default()
        });
        let rows = app.settings_rows();
        let toggles: Vec<&Row> = rows
            .iter()
            .filter(|row| matches!(row, Row::Toggle(_)))
            .collect();
        assert_eq!(
            toggles,
            [
                &Row::Toggle(Toggle::AutoResume),
                &Row::Toggle(Toggle::ContinueAfterRestart)
            ]
        );
        assert_eq!(rows[1], Row::Provider("claude".to_owned()));
        assert_eq!(rows.last(), Some(&Row::DeviceName));
    }

    #[test]
    fn moving_skips_headings_and_stops_at_the_ends() {
        let rows = [
            Row::Heading("A"),
            Row::Github,
            Row::Heading("B"),
            Row::DeviceName,
        ];
        assert_eq!(next_row(&rows, 1, 1), 3);
        assert_eq!(next_row(&rows, 3, -1), 1);
        assert_eq!(next_row(&rows, 1, -1), 1);
        assert_eq!(next_row(&rows, 3, 10), 3);
        assert_eq!(next_row(&rows, 0, 0), 1);
    }

    #[test]
    fn a_sign_in_runs_the_providers_own_command_with_its_home() {
        let info = provider(
            "work",
            "codex",
            &serde_json::json!({
                "path": "/opt/bin/codex",
                "login": ["codex", "login"],
                "loginEnv": [{ "name": "NO_COLOR", "value": "1" }],
            }),
        );
        let mut info = info;
        info.instance.home = Some("/accounts/work".to_owned());
        let login = login_of(&info).unwrap();
        assert_eq!(login.program, "/opt/bin/codex");
        assert_eq!(login.args, ["login"]);
        assert_eq!(
            login.env,
            [
                ("NO_COLOR".into(), "1".into()),
                ("CODEX_HOME".into(), "/accounts/work".into())
            ]
        );
        assert!(login_of(&provider("x", "claude", &serde_json::json!({}))).is_none());
    }

    #[tokio::test]
    async fn a_typed_key_shows_only_as_dots() {
        let mut app = app();
        app.settings = Some(Settings {
            field: Some((
                Purpose::Key {
                    provider: parallax_protocol::Provider::Anthropic,
                    label: "work".to_owned(),
                },
                String::new(),
            )),
            ..Settings::default()
        });
        for c in "sk-ant-secret".chars() {
            app.settings_key(KeyEvent::from(KeyCode::Char(c))).await;
        }
        let settings = app.settings.as_ref().unwrap();
        let shown: String = app
            .about(settings, None)
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.to_string()))
            .collect();
        assert!(!shown.contains("secret"), "{shown}");
        assert!(shown.contains(&"•".repeat(13)), "{shown}");
    }

    #[test]
    fn a_github_sign_in_plxd_gave_up_on_stops_waiting() {
        let mut app = app();
        let since: jiff::Timestamp = "2026-10-27T18:00:00Z".parse().unwrap();
        app.settings = Some(Settings {
            browser: Some(Browser::Github {
                code: "AA17-58F5".to_owned(),
                url: "https://github.com/login/device".to_owned(),
                since,
            }),
            ..Settings::default()
        });
        let status = |at: &str| -> GithubStatus {
            serde_json::from_value(serde_json::json!({
                "installed": true, "signedIn": false,
                "setupNote": "the code expired", "checkedAt": at,
            }))
            .unwrap()
        };
        // A read from before the sign-in started says nothing about it.
        app.take_github(status("2026-10-27T17:59:59Z"));
        assert!(app.settings.as_ref().unwrap().browser.is_some());
        app.take_github(status("2026-10-27T18:00:05Z"));
        let settings = app.settings.as_ref().unwrap();
        assert!(settings.browser.is_none());
        assert_eq!(settings.note.as_deref(), Some("the code expired"));
    }

    #[tokio::test]
    async fn esc_closes_the_screen() {
        let mut app = app();
        app.open_settings(false);
        app.settings_key(KeyEvent::from(KeyCode::Esc)).await;
        assert!(app.settings.is_none());
    }
}
