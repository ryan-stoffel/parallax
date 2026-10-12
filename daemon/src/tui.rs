//! `plxd tui`: Parallax in a terminal (PLX-740), laid out like Claude Code and Codex: one column
//! with the transcript under a header, the prompt between two rules, and a status line. It is
//! another client of the plxd the app attaches to, so its threads, Spaces, Projects, and messages
//! are the app's, live, both ways.
//!
//! - Threads come from `orchestration/subscribeShell`; ← on an empty prompt or `/threads` lists
//!   them.
//! - The open thread is `orchestration/subscribeThread`, folded by [`transcript`].
//! - A message is `message.dispatch`, queued after the turn under way, carrying any `/provider`,
//!   `/model`, `/effort`, or `/mode` change made since the last one, as the app's composer does.
//!   The first message of a new thread is `thread/start`. Esc is `run.interrupt`.
//! - Typing `/` lists the commands; ↑↓ and Enter run one. Commands that choose something open a
//!   list below the prompt, which ↑↓ and Enter pick from.
//! - `host/health` every 10 s keeps the connection open and finds one that dropped; its
//!   replacement subscribes again from fresh snapshots.

mod markdown;
mod transcript;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parallax_protocol::methods::{
    AccountsDefaultsGet, AgentApprove, EventsUnsubscribe, HostHealth, OrchestrationDispatch,
    OrchestrationSubscribeShell, OrchestrationSubscribeThread, ProvidersList, RequestMethod,
    ThreadStart, ThreadUpdate,
};
use parallax_protocol::{
    AccountChoice, AccountsDefaultsGetParams, AgentApprovalAnswer, AgentApproveParams, AgentEffort,
    AgentPermission, AgentRun, AgentStatus, AgentToolStatus, ApprovalId, DispatchMode,
    EventsEventParams, EventsUnsubscribeParams, HostHealthParams, LoggedEvent,
    OrchestrationCommand, ParallaxEvent, Project, ProviderInfo, ProviderKind, ProvidersListParams,
    Repo, RepoId, RunId, SubscribeShellParams, SubscribeThreadParams, SubscriptionId, Thread,
    ThreadStartParams, ThreadUpdateParams, TurnId,
};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use tokio::sync::mpsc;

use self::transcript::{Entry, Pending, Transcript};
use crate::peer::{Incoming, Plxd};

/// How often `host/health` goes out: well under plxd's 90 s idle timeout, and soon enough that a
/// dropped connection comes back before anyone wonders.
const HEALTH: Duration = Duration::from_secs(10);

/// The longest a call may take. Keys wait while one runs, so a plxd that stops answering
/// without closing the connection must not hold the screen, and Ctrl-C, for longer.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How often the screen redraws on its own while a turn runs, for the spinner and its timer.
const FRAME: Duration = Duration::from_millis(120);

/// The most rows a list below the prompt shows at once; ↑↓ scroll the rest.
const MENU_ROWS: usize = 10;

/// The app's mark, `ParallaxMark`, in dark mode: its two circles and their overlap.
const MARK_BLUE: [u8; 3] = [0x2b, 0x5c, 0xff];
const MARK_CORAL: [u8; 3] = [0xff, 0x4a, 0x1f];
const MARK_OVERLAP: [u8; 3] = [0xe4, 0xe4, 0xe7];
const BLUE: Color = Color::Rgb(MARK_BLUE[0], MARK_BLUE[1], MARK_BLUE[2]);
const CORAL: Color = Color::Rgb(MARK_CORAL[0], MARK_CORAL[1], MARK_CORAL[2]);

/// The logo's width and height in pixels: 14 columns, and 7 rows of two pixels each.
const LOGO_PIXELS: u16 = 14;

/// The spinner's frames, Claude Code's.
const SPINNER: [&str; 6] = ["·", "✢", "✳", "✶", "✻", "✽"];

/// The slash commands, with what each does.
const COMMANDS: [(&str, &str); 9] = [
    (
        "/new",
        "start a new thread here, or in the repo or Space named",
    ),
    (
        "/threads",
        "switch to another thread, Space, or Project (also ←)",
    ),
    (
        "/provider",
        "choose who runs it: Claude, Codex, Cursor, and the rest",
    ),
    ("/model", "choose one of the provider's models"),
    ("/effort", "choose how hard it thinks"),
    (
        "/mode",
        "choose what it may do without asking (also Shift+Tab)",
    ),
    ("/stop", "stop the turn under way (also Esc)"),
    ("/help", "show the keys"),
    ("/quit", "leave (also Ctrl-C twice, or Ctrl-D)"),
];

/// The modes Shift+Tab cycles through, with their names.
const MODES: [(AgentPermission, &str); 5] = [
    (AgentPermission::Edit, "accept edits"),
    (AgentPermission::Auto, "auto mode"),
    (AgentPermission::Plan, "plan mode"),
    (AgentPermission::Manual, "ask first"),
    (AgentPermission::Bypass, "bypass permissions"),
];

/// The models the app's picker offers Claude and Codex ahead of what plxd finds, which for them
/// is nothing: the catalog in `apps/desktop/src/renderer/models.ts`. Keep the two in step.
const CATALOG: [(ProviderKind, &str, &str); 21] = [
    (ProviderKind::Claude, "claude-opus-5-5", "Claude Opus 5.5"),
    (
        ProviderKind::Claude,
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
    ),
    (ProviderKind::Claude, "claude-fable-5-1", "Claude Fable 5.1"),
    (ProviderKind::Claude, "claude-fable-5", "Claude Fable 5"),
    (ProviderKind::Claude, "claude-opus-5", "Claude Opus 5"),
    (ProviderKind::Claude, "claude-opus-4-8", "Claude Opus 4.8"),
    (ProviderKind::Claude, "claude-opus-4-7", "Claude Opus 4.7"),
    (ProviderKind::Claude, "claude-opus-4-6", "Claude Opus 4.6"),
    (ProviderKind::Claude, "claude-opus-4-5", "Claude Opus 4.5"),
    (ProviderKind::Claude, "claude-sonnet-5", "Claude Sonnet 5"),
    (
        ProviderKind::Claude,
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
    ),
    (ProviderKind::Claude, "claude-haiku-5-5", "Claude Haiku 5.5"),
    (ProviderKind::Claude, "claude-haiku-4-5", "Claude Haiku 4.5"),
    (ProviderKind::Codex, "gpt-6.1-sol", "GPT-6.1 Sol"),
    (ProviderKind::Codex, "gpt-6-astra", "GPT-6 Astra"),
    (ProviderKind::Codex, "gpt-6-sol", "GPT-6 Sol"),
    (ProviderKind::Codex, "gpt-6-luna", "GPT-6 Luna"),
    (ProviderKind::Codex, "gpt-5.6-sol", "GPT-5.6 Sol"),
    (ProviderKind::Codex, "gpt-5.6-terra", "GPT-5.6 Terra"),
    (ProviderKind::Codex, "gpt-5.6-luna", "GPT-5.6 Luna"),
    (ProviderKind::Codex, "gpt-5.5", "GPT-5.5"),
];

/// The efforts `/effort` offers, lowest first.
const EFFORTS: [AgentEffort; 5] = [
    AgentEffort::Low,
    AgentEffort::Medium,
    AgentEffort::High,
    AgentEffort::Xhigh,
    AgentEffort::Max,
];

/// Shows Parallax in this terminal until the user quits.
///
/// # Errors
///
/// Why plxd couldn't be reached, or the terminal couldn't be drawn.
pub async fn run(plxd: Plxd) -> Result<(), String> {
    let (sender, mut incoming) = mpsc::unbounded_channel();
    plxd.notify(sender);
    let mut app = App::new(plxd);
    // Before the terminal changes, so an unreachable plxd is a plain error.
    app.subscribe_shell().await?;
    app.draft = app.cwd_repo();
    app.load_providers().await;
    let (sender, mut keys) = mpsc::unbounded_channel();
    // crossterm reads keys blocking; the thread ends with the process.
    std::thread::spawn(move || {
        while let Ok(event) = event::read() {
            if sender.send(event).is_err() {
                break;
            }
        }
    });
    let mut terminal = ratatui::init();
    let result = app.run(&mut terminal, &mut keys, &mut incoming).await;
    ratatui::restore();
    result
}

/// What picking a row of a list does.
#[derive(Clone)]
enum Pick {
    /// Opens a thread, or a Project's coordinator.
    Run(RunId),
    /// Starts a thread in this repo or Space, or with `None`, in none.
    Group(Option<RepoId>),
    Provider(String),
    Model(String),
    Effort(AgentEffort),
    Mode(AgentPermission),
}

/// A row of a list.
struct Item {
    label: String,
    detail: String,
    /// A heading row, such as a repo above its threads.
    heading: bool,
    /// What the next message uses now.
    current: bool,
    pick: Pick,
}

/// A list to pick from, below the prompt.
struct Menu {
    title: &'static str,
    items: Vec<Item>,
    selected: usize,
}

impl Menu {
    /// A list that starts on its current row, or its first.
    fn new(title: &'static str, items: Vec<Item>) -> Self {
        let selected = items.iter().position(|item| item.current).unwrap_or(0);
        Self {
            title,
            items,
            selected,
        }
    }
}

/// The open thread.
struct Open {
    run: RunId,
    subscription: Option<SubscriptionId>,
    transcript: Transcript,
}

struct App {
    plxd: Plxd,
    /// The mark, drawn once.
    logo: Vec<Vec<Span<'static>>>,
    /// The provider new threads run on, from the host's defaults.
    default_backend: Option<String>,
    /// The host's providers and their models.
    providers: Vec<ProviderInfo>,
    shell: Option<SubscriptionId>,
    projects: Vec<Project>,
    repos: Vec<Repo>,
    threads: Vec<Thread>,
    runs: HashMap<RunId, AgentRun>,
    open: Option<Open>,
    /// With no thread open, the next message starts one in this repo or Space, or in none.
    draft: Option<RepoId>,
    /// The list showing below the prompt, if one is.
    menu: Option<Menu>,
    input: String,
    /// The highlighted command while `/` lists them.
    slash: usize,
    /// Messages sent from here, oldest first; the one Up recalled; and what was typed before.
    history: Vec<String>,
    recalled: Option<usize>,
    typed: String,
    /// What the next message changes: `/provider`, `/model`, `/effort`, `/mode`.
    provider: Option<String>,
    model: Option<String>,
    effort: Option<AgentEffort>,
    permission: Option<AgentPermission>,
    /// The highlighted answer, and the permission request it's for. Another request starts on
    /// Yes.
    choice: usize,
    choice_for: Option<ApprovalId>,
    /// Lines scrolled up from the transcript's end.
    scroll: u16,
    /// `/help`'s keys, shown above the prompt until the next message.
    notice: Option<String>,
    /// The last error, until the next key.
    error: Option<String>,
    /// Ctrl-C once more quits.
    quitting: bool,
    /// When the open thread's turn started, as this client saw it.
    working_since: Option<Instant>,
    frame: usize,
    dirty: bool,
    done: bool,
}

impl App {
    fn new(plxd: Plxd) -> Self {
        Self {
            plxd,
            logo: logo(),
            default_backend: None,
            providers: Vec::new(),
            shell: None,
            projects: Vec::new(),
            repos: Vec::new(),
            threads: Vec::new(),
            runs: HashMap::new(),
            open: None,
            draft: None,
            menu: None,
            input: String::new(),
            slash: 0,
            history: Vec::new(),
            recalled: None,
            typed: String::new(),
            provider: None,
            model: None,
            effort: None,
            permission: None,
            choice: 0,
            choice_for: None,
            scroll: 0,
            notice: None,
            error: None,
            quitting: false,
            working_since: None,
            frame: 0,
            dirty: true,
            done: false,
        }
    }

    async fn run(
        &mut self,
        terminal: &mut DefaultTerminal,
        keys: &mut mpsc::UnboundedReceiver<Event>,
        incoming: &mut mpsc::UnboundedReceiver<Incoming>,
    ) -> Result<(), String> {
        let mut health = tokio::time::interval(HEALTH);
        let mut frames = tokio::time::interval(FRAME);
        while !self.done {
            if self.dirty {
                self.dirty = false;
                terminal
                    .draw(|frame| self.draw(frame))
                    .map_err(|error| format!("could not draw: {error}"))?;
            }
            tokio::select! {
                Some(event) = keys.recv() => {
                    if let Event::Key(key) = event
                        && key.kind == KeyEventKind::Press
                    {
                        self.key(key).await;
                    }
                    self.dirty = true;
                }
                Some(first) = incoming.recv() => {
                    self.incoming(first).await;
                    while let Ok(more) = incoming.try_recv() {
                        self.incoming(more).await;
                    }
                    self.dirty = true;
                }
                _ = frames.tick() => self.tick(),
                _ = health.tick() => {
                    if let Err(error) = self.call::<HostHealth>(HostHealthParams {}).await {
                        self.error = Some(error);
                        self.dirty = true;
                    }
                }
            }
        }
        Ok(())
    }

    /// Sends one request, giving up after [`CALL_TIMEOUT`], which cancels it.
    async fn call<M: RequestMethod>(&self, params: M::Params) -> Result<M::Result, String> {
        tokio::time::timeout(CALL_TIMEOUT, self.plxd.call::<M>(params))
            .await
            .map_err(|_| format!("plxd didn't answer {} within {CALL_TIMEOUT:?}", M::NAME))?
    }

    /// Moves the spinner and the turn's timer.
    fn tick(&mut self) {
        let working = self
            .open
            .as_ref()
            .is_some_and(|open| self.working(open.run));
        match (working, self.working_since) {
            (true, None) => self.working_since = Some(Instant::now()),
            (false, Some(_)) => {
                self.working_since = None;
                self.dirty = true;
            }
            _ => {}
        }
        if working {
            self.frame += 1;
            self.dirty = true;
        }
    }

    async fn subscribe_shell(&mut self) -> Result<(), String> {
        let subscribed = self
            .call::<OrchestrationSubscribeShell>(SubscribeShellParams::default())
            .await?;
        self.shell = Some(subscribed.subscription);
        if let Some(shell) = subscribed.snapshot {
            self.projects = shell.projects;
            self.repos = shell.repos;
            self.threads = shell.threads;
            self.runs = shell.runs.into_iter().map(|run| (run.id, run)).collect();
        }
        Ok(())
    }

    /// Reads the host's default provider, and its providers and their models. Without them,
    /// models show by id and the lists are empty.
    async fn load_providers(&mut self) {
        let defaults = self
            .call::<AccountsDefaultsGet>(AccountsDefaultsGetParams {})
            .await;
        if let Ok(defaults) = defaults
            && let Some(AccountChoice::Subscription { backend }) = defaults.worker
        {
            self.default_backend = Some(backend);
        }
        match self
            .call::<ProvidersList>(ProvidersListParams { refresh: false })
            .await
        {
            Ok(listed) => self.providers = listed.providers,
            Err(error) => self.error = Some(error),
        }
    }

    /// The repo plxd knows at this process's folder, so `plxd tui` in a checkout starts its
    /// threads there, as Claude Code does in its folder.
    fn cwd_repo(&self) -> Option<RepoId> {
        let cwd = std::env::current_dir().ok()?.canonicalize().ok()?;
        self.repos
            .iter()
            .find(|repo| !repo.scratch && !repo.space && std::path::Path::new(&repo.path) == cwd)
            .map(|repo| repo.id)
    }

    /// Ends the open thread's subscription, if one is open.
    async fn close(&mut self) {
        if let Some(subscription) = self.open.take().and_then(|open| open.subscription) {
            let _ = self
                .call::<EventsUnsubscribe>(EventsUnsubscribeParams { subscription })
                .await;
        }
        self.scroll = 0;
        self.working_since = None;
    }

    /// Opens `run`'s transcript in place of the open one.
    async fn open(&mut self, run: RunId) -> Result<(), String> {
        self.close().await;
        let subscribed = self
            .call::<OrchestrationSubscribeThread>(SubscribeThreadParams {
                thread_id: run,
                after_seq: None,
            })
            .await?;
        let mut transcript = Transcript::default();
        if let Some(snapshot) = subscribed.snapshot {
            transcript = Transcript::new((!snapshot.more).then(|| snapshot.thread.prompt.clone()));
            transcript.apply(snapshot.requests.into_iter().chain(snapshot.events));
            self.runs.insert(run, snapshot.thread);
        }
        self.open = Some(Open {
            run,
            subscription: Some(subscribed.subscription),
            transcript,
        });
        // As the app does on opening a thread. A coordinator isn't a thread, and fails.
        let _ = self
            .call::<ThreadUpdate>(ThreadUpdateParams {
                run_id: run,
                seen: true,
                snoozed_until: None,
                title: None,
                settled: None,
            })
            .await;
        Ok(())
    }

    async fn incoming(&mut self, incoming: Incoming) {
        match incoming {
            Incoming::Event(event) => self.event(*event),
            Incoming::Reconnected => {
                let mut resubscribed = self.subscribe_shell().await;
                if resubscribed.is_ok()
                    && let Some(run) = self.open.as_ref().map(|open| open.run)
                {
                    resubscribed = self.open(run).await;
                }
                if let Err(error) = resubscribed {
                    self.error = Some(error);
                }
            }
        }
    }

    fn event(&mut self, params: EventsEventParams) {
        if let Some(open) = &mut self.open
            && open.subscription == Some(params.subscription)
        {
            let EventsEventParams {
                seq,
                time,
                project,
                event,
                ..
            } = params;
            open.transcript.apply([LoggedEvent {
                seq,
                time,
                project,
                event,
            }]);
            return;
        }
        if self.shell != Some(params.subscription) {
            return;
        }
        match params.event {
            ParallaxEvent::ProjectCreated { project }
            | ParallaxEvent::ProjectUpdated { project } => {
                upsert(&mut self.projects, project, |held, new| held.id == new.id);
            }
            ParallaxEvent::ProjectDeleted { project } => {
                self.projects.retain(|held| held.id != project);
            }
            ParallaxEvent::RepoAdded { repo } | ParallaxEvent::RepoUpdated { repo } => {
                upsert(&mut self.repos, repo, |held, new| held.id == new.id);
            }
            ParallaxEvent::RepoRemoved { repo } => self.repos.retain(|held| held.id != repo),
            ParallaxEvent::ThreadStarted { thread } | ParallaxEvent::ThreadUpdated { thread } => {
                upsert(&mut self.threads, thread, |held, new| held.id == new.id);
            }
            ParallaxEvent::ThreadDeleted { run_id, .. } => {
                self.threads.retain(|held| held.id != run_id);
            }
            ParallaxEvent::AgentStarted { run: Some(run), .. } => {
                self.runs.insert(run.id, run);
            }
            ParallaxEvent::AgentUpdated { run_id, state } => {
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.status = state.status;
                    run.error = state.error;
                    run.account_id = state.account_id;
                    if let Some(backend) = state.backend {
                        run.backend = backend;
                    }
                    run.model = state.model;
                    run.effort = state.effort;
                    run.permission = state.permission;
                }
            }
            _ => {}
        }
    }

    async fn key(&mut self, key: KeyEvent) {
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        if control && key.code == KeyCode::Char('d') {
            self.done = true;
            return;
        }
        if control && key.code == KeyCode::Char('c') {
            if !self.input.is_empty() {
                self.input.clear();
            } else if self.quitting {
                self.done = true;
            } else {
                self.quitting = true;
            }
            return;
        }
        self.quitting = false;
        self.error = None;
        if self.menu.is_some() {
            return self.menu_key(key.code).await;
        }
        if let Some(pending) = self.pending().cloned() {
            return self.approval_key(key.code, &pending).await;
        }
        let commands = self.suggestions();
        if !commands.is_empty() {
            let last = commands.len() - 1;
            match key.code {
                KeyCode::Up => return self.slash = self.slash.saturating_sub(1),
                KeyCode::Down => return self.slash = (self.slash + 1).min(last),
                KeyCode::Tab => {
                    self.input = format!("{} ", commands[self.slash.min(last)].0);
                    return;
                }
                KeyCode::Enter => {
                    let name = commands[self.slash.min(last)].0;
                    self.input.clear();
                    self.slash = 0;
                    return self.command(name, "").await;
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::Esc if self.working_since.is_some() => self.stop().await,
            KeyCode::Esc => {
                self.input.clear();
                self.notice = None;
            }
            KeyCode::Left if self.input.is_empty() => self.menu = Some(self.threads_menu()),
            KeyCode::BackTab => self.cycle_mode(),
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::ALT) => self.input.push('\n'),
            // A trailing backslash continues the message on a new line, as in Claude Code.
            KeyCode::Enter if self.input.ends_with('\\') => {
                self.input.pop();
                self.input.push('\n');
            }
            KeyCode::Enter => self.submit().await,
            KeyCode::Up if !self.input.contains('\n') => self.recall(true),
            KeyCode::Down if !self.input.contains('\n') => self.recall(false),
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Backspace => {
                self.input.pop();
                self.slash = 0;
            }
            KeyCode::Char(c) => {
                self.input.push(c);
                self.slash = 0;
            }
            _ => {}
        }
    }

    /// Steps through the messages sent from here: older with `back`, newer otherwise. Past the
    /// newest, what was typed before comes back.
    fn recall(&mut self, back: bool) {
        let Some(last) = self.history.len().checked_sub(1) else {
            return;
        };
        self.recalled = match (self.recalled, back) {
            (None, true) => {
                self.typed = std::mem::take(&mut self.input);
                Some(last)
            }
            (None, false) => return,
            (Some(i), true) => Some(i.saturating_sub(1)),
            (Some(i), false) if i < last => Some(i + 1),
            (Some(_), false) => None,
        };
        self.input = match self.recalled {
            Some(i) => self.history[i].clone(),
            None => std::mem::take(&mut self.typed),
        };
    }

    /// Moves to the next mode the provider runs.
    fn cycle_mode(&mut self) {
        let modes = self.modes();
        let at = modes.iter().position(|mode| *mode == self.mode());
        self.permission = modes
            .get(at.map_or(0, |at| (at + 1) % modes.len()))
            .copied();
    }

    /// The modes the provider runs, in [`MODES`]' order: all of them when plxd doesn't say.
    fn modes(&self) -> Vec<AgentPermission> {
        let runs = self
            .provider_info()
            .map(|provider| provider.permissions.as_slice())
            .filter(|permissions| !permissions.is_empty());
        MODES
            .iter()
            .map(|(mode, _)| *mode)
            .filter(|mode| runs.is_none_or(|runs| runs.contains(mode)))
            .collect()
    }

    /// Whether the provider takes an effort; true when plxd doesn't say.
    fn takes_effort(&self) -> bool {
        self.provider_info().is_none_or(|provider| provider.efforts)
    }

    fn provider_info(&self) -> Option<&ProviderInfo> {
        let id = self.provider()?;
        self.providers
            .iter()
            .find(|provider| provider.instance.id == id)
    }

    /// The mode the next message runs in.
    fn mode(&self) -> AgentPermission {
        self.permission
            .or_else(|| self.open_run()?.permission)
            .unwrap_or(AgentPermission::Edit)
    }

    async fn menu_key(&mut self, code: KeyCode) {
        let Some(menu) = &mut self.menu else { return };
        let last = menu.items.len().saturating_sub(1);
        match code {
            KeyCode::Esc | KeyCode::Left => self.menu = None,
            KeyCode::Up => menu.selected = menu.selected.saturating_sub(1),
            KeyCode::Down => menu.selected = (menu.selected + 1).min(last),
            KeyCode::PageUp => menu.selected = menu.selected.saturating_sub(MENU_ROWS),
            KeyCode::PageDown => menu.selected = (menu.selected + MENU_ROWS).min(last),
            KeyCode::Enter => {
                let pick = menu.items.get(menu.selected).map(|item| item.pick.clone());
                self.menu = None;
                if let Some(pick) = pick {
                    self.pick(pick).await;
                }
            }
            // In the thread list: a new thread in the selected row's repo or Space.
            KeyCode::Char('n') => {
                let repo = menu
                    .items
                    .iter()
                    .take(menu.selected + 1)
                    .rev()
                    .find_map(|item| match item.pick {
                        Pick::Group(repo) => Some(repo),
                        _ => None,
                    })
                    .flatten();
                self.menu = None;
                self.new_thread(repo).await;
            }
            _ => {}
        }
    }

    async fn pick(&mut self, pick: Pick) {
        match pick {
            Pick::Run(run) => {
                // What was chosen for one thread doesn't follow to another.
                (self.provider, self.model, self.effort, self.permission) =
                    (None, None, None, None);
                if let Err(error) = self.open(run).await {
                    self.error = Some(error);
                }
            }
            Pick::Group(repo) => self.new_thread(repo).await,
            Pick::Provider(id) => {
                let before = self.provider().map(str::to_owned);
                let thread_has_it = self.open_run().is_some_and(|run| run.backend == id);
                self.provider = (!thread_has_it).then_some(id);
                self.fit_provider(before.as_deref());
            }
            Pick::Model(id) => self.model = Some(id),
            Pick::Effort(effort) => self.effort = Some(effort),
            Pick::Mode(mode) => self.permission = Some(mode),
        }
    }

    async fn approval_key(&mut self, code: KeyCode, pending: &Pending) {
        let answers = if pending.always { 3 } else { 2 };
        let choice = self.choice(pending);
        let answer = match code {
            KeyCode::Up => {
                (self.choice, self.choice_for) =
                    (choice.saturating_sub(1), Some(pending.approval_id));
                return;
            }
            KeyCode::Down => {
                (self.choice, self.choice_for) =
                    ((choice + 1).min(answers - 1), Some(pending.approval_id));
                return;
            }
            KeyCode::Enter => choice,
            KeyCode::Esc => answers - 1,
            KeyCode::Char(c @ '1'..='3') => (c as usize - '1' as usize).min(answers - 1),
            _ => return,
        };
        let (decision, always) = match (answer, pending.always) {
            (0, _) => (AgentApprovalAnswer::Allow, false),
            (1, true) => (AgentApprovalAnswer::Allow, true),
            _ => (AgentApprovalAnswer::Deny, false),
        };
        let Some(run_id) = self.open.as_ref().map(|open| open.run) else {
            return;
        };
        let answered = self
            .call::<AgentApprove>(AgentApproveParams {
                run_id,
                approval_id: pending.approval_id,
                decision,
                input: None,
                always,
                message: None,
            })
            .await;
        if let Err(error) = answered {
            self.error = Some(error);
        }
    }

    /// The highlighted answer to `pending`: Yes until the arrows move it.
    fn choice(&self, pending: &Pending) -> usize {
        if self.choice_for == Some(pending.approval_id) {
            self.choice
        } else {
            0
        }
    }

    /// The open thread's oldest permission request.
    fn pending(&self) -> Option<&Pending> {
        self.open.as_ref()?.transcript.pending.first()
    }

    /// Leaves the open thread for a new one in `repo`, which the next message starts.
    async fn new_thread(&mut self, repo: Option<RepoId>) {
        let before = self.provider().map(str::to_owned);
        self.close().await;
        self.draft = repo;
        // A new thread runs on the host's default, unless /provider chose another.
        self.fit_provider(before.as_deref());
    }

    /// After the provider the next message runs on changed from `before`: drops a model chosen
    /// for that one, and a mode or an effort this one can't run.
    fn fit_provider(&mut self, before: Option<&str>) {
        if self.provider() != before {
            self.model = None;
        }
        if !self.modes().contains(&self.mode()) {
            self.permission = self.modes().first().copied();
        }
        if !self.takes_effort() {
            self.effort = None;
        }
    }

    async fn submit(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.recalled = None;
        if text.starts_with('/') {
            self.input.clear();
            let (name, argument) = text.split_once(' ').unwrap_or((&text, ""));
            return self.command(name, argument.trim()).await;
        }
        self.notice = None;
        let account = self
            .provider
            .clone()
            .map(|backend| AccountChoice::Subscription { backend });
        let sent = if let Some(thread_id) = self.open.as_ref().map(|open| open.run) {
            self.call::<OrchestrationDispatch>(OrchestrationCommand::MessageDispatch {
                thread_id,
                message_id: TurnId::generate(),
                text: text.clone(),
                images: Vec::new(),
                threads: Vec::new(),
                model: self.model.clone(),
                effort: self.effort,
                permission: self.permission,
                context_window: None,
                fast: None,
                account,
                dispatch_mode: DispatchMode::QueueAfterActive,
            })
            .await
            .map(drop)
        } else {
            self.start(self.draft, text.clone(), account).await
        };
        match sent {
            Ok(()) => {
                self.history.push(text);
                self.input.clear();
                self.scroll = 0;
                (self.provider, self.model, self.effort, self.permission) =
                    (None, None, None, None);
            }
            Err(error) => self.error = Some(error),
        }
    }

    /// Runs a slash command. One that chooses something, run without `argument`, opens its list.
    async fn command(&mut self, name: &str, argument: &str) {
        match name {
            "/new" | "/clear" => {
                let named = (!argument.is_empty()).then(|| {
                    self.repos
                        .iter()
                        .find(|repo| repo.name.eq_ignore_ascii_case(argument))
                        .map(|repo| repo.id)
                });
                let repo = match named {
                    Some(Some(repo)) => Some(repo),
                    Some(None) => {
                        self.error = Some(format!("no repo or Space is named {argument}"));
                        return;
                    }
                    None => self
                        .open_thread()
                        .map_or(self.draft, |thread| Some(thread.repo)),
                };
                // The threads with no repo start with none.
                let repo = repo.filter(|id| !self.repo(*id).is_some_and(|repo| repo.scratch));
                self.new_thread(repo).await;
            }
            "/threads" | "/resume" => self.menu = Some(self.threads_menu()),
            // An id the provider doesn't list still goes, as the app's custom models do.
            "/model" if !argument.is_empty() => {
                let listed = self.provider_info().map(models).unwrap_or_default();
                let id = listed
                    .into_iter()
                    .find(|(id, name)| {
                        id.eq_ignore_ascii_case(argument) || name.eq_ignore_ascii_case(argument)
                    })
                    .map_or_else(|| argument.to_owned(), |(id, _)| id);
                self.model = Some(id);
            }
            "/provider" | "/model" => {
                self.load_providers().await;
                let menu = if name == "/provider" {
                    self.providers_menu()
                } else {
                    self.models_menu()
                };
                self.choose(menu, argument).await;
            }
            "/effort" => {
                let menu = self.efforts_menu();
                self.choose(menu, argument).await;
            }
            "/mode" => {
                let menu = Ok(self.modes_menu());
                self.choose(menu, argument).await;
            }
            "/stop" => self.stop().await,
            "/help" => {
                self.notice = Some(
                    [
                        "/ lists commands: ↑↓ choose, Enter runs, Tab completes",
                        "← on an empty prompt lists threads; n there starts one",
                        "Shift+Tab mode · Esc interrupts · \\ or Alt+Enter new line",
                        "↑↓ history · PgUp/PgDn scroll · Ctrl-C twice quits",
                    ]
                    .join("\n"),
                );
            }
            "/quit" | "/exit" => self.done = true,
            _ => self.error = Some(format!("{name} isn't a command; type / to list them")),
        }
    }

    /// Opens `menu`, or with `argument`, picks its row whose label or id is that.
    async fn choose(&mut self, menu: Result<Menu, String>, argument: &str) {
        let menu = match menu {
            Ok(menu) => menu,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        if argument.is_empty() {
            self.menu = Some(menu);
            return;
        }
        let named = menu.items.into_iter().find(|item| {
            item.label.eq_ignore_ascii_case(argument) || item.detail.eq_ignore_ascii_case(argument)
        });
        match named {
            Some(item) => self.pick(item.pick).await,
            None => self.error = Some(format!("{} has no {argument}", menu.title)),
        }
    }

    /// The thread list: each Project's coordinator, then each repo and Space with its threads,
    /// newest first.
    fn threads_menu(&self) -> Menu {
        let open = self.open.as_ref().map(|open| open.run);
        let run_item = |run: RunId, label: String| Item {
            label,
            detail: if self.working(run) {
                "● working".to_owned()
            } else {
                String::new()
            },
            heading: false,
            current: Some(run) == open,
            pick: Pick::Run(run),
        };
        let mut items: Vec<Item> = self
            .projects
            .iter()
            .filter_map(|project| {
                let run = project.coordinator?;
                Some(run_item(run, format!("◆ {}", project.name)))
            })
            .collect();
        // plxd makes the entry for threads with no repo on first use; until then, offer it.
        if !self.repos.iter().any(|repo| repo.scratch) {
            items.push(Item {
                label: "Chats".to_owned(),
                detail: "n for a new thread here".to_owned(),
                heading: true,
                current: false,
                pick: Pick::Group(None),
            });
        }
        for repo in &self.repos {
            let mut threads: Vec<&Thread> = self
                .threads
                .iter()
                .filter(|thread| thread.repo == repo.id && !thread.archived)
                .collect();
            threads.sort_by_key(|thread| {
                std::cmp::Reverse(thread.last_prompt_at.unwrap_or(thread.created_at))
            });
            items.push(Item {
                label: group_name(repo),
                detail: "n for a new thread here".to_owned(),
                heading: true,
                current: false,
                pick: Pick::Group((!repo.scratch).then_some(repo.id)),
            });
            items.extend(
                threads
                    .into_iter()
                    .map(|thread| run_item(thread.id, format!("  {}", self.title(thread.id)))),
            );
        }
        Menu::new("Threads", items)
    }

    /// The host's enabled providers, signed in first.
    fn providers_menu(&self) -> Result<Menu, String> {
        let now = self.provider();
        let mut items: Vec<(bool, Item)> = self
            .providers
            .iter()
            .filter(|provider| provider.instance.enabled && provider.installed)
            .map(|provider| {
                let signed_in = provider.signed_in == Some(true);
                let detail = match (&provider.account, provider.signed_in) {
                    (Some(account), Some(true)) => format!("{} · {account}", provider.instance.id),
                    (None, Some(true)) => provider.instance.id.clone(),
                    (_, Some(false)) => format!("{} · not signed in", provider.instance.id),
                    (_, None) => format!("{} · sign-in unknown", provider.instance.id),
                };
                let item = Item {
                    label: provider.instance.name.clone(),
                    detail,
                    heading: false,
                    current: now == Some(provider.instance.id.as_str()),
                    pick: Pick::Provider(provider.instance.id.clone()),
                };
                (signed_in, item)
            })
            .collect();
        if items.is_empty() {
            return Err("plxd lists no installed providers".to_owned());
        }
        items.sort_by_key(|(signed_in, _)| !signed_in);
        Ok(Menu::new(
            "Provider",
            items.into_iter().map(|(_, item)| item).collect(),
        ))
    }

    /// The models of the provider the next message runs on: the ones plxd found, then the
    /// user's own.
    fn models_menu(&self) -> Result<Menu, String> {
        let Some(id) = self.provider() else {
            return Err("choose a provider with /provider first".to_owned());
        };
        let provider = self
            .providers
            .iter()
            .find(|provider| provider.instance.id == id)
            .ok_or_else(|| format!("plxd doesn't list the provider {id}"))?;
        let now = self.model_id();
        let items: Vec<Item> = models(provider)
            .into_iter()
            .map(|(id, name)| Item {
                current: now.as_deref() == Some(id.as_str()),
                label: name,
                detail: id.clone(),
                heading: false,
                pick: Pick::Model(id),
            })
            .collect();
        if items.is_empty() {
            return Err(format!(
                "{} lists no models; /model <id> sends one",
                provider.instance.name
            ));
        }
        Ok(Menu::new("Model", items))
    }

    fn efforts_menu(&self) -> Result<Menu, String> {
        if !self.takes_effort() {
            let provider = self
                .provider()
                .map_or_else(String::new, |id| self.provider_name(id));
            return Err(format!("{provider} doesn't take an effort"));
        }
        let now = self.effort.or_else(|| self.open_run()?.effort);
        let items = EFFORTS
            .iter()
            .map(|&effort| Item {
                label: effort_name(effort).to_owned(),
                detail: String::new(),
                heading: false,
                current: now == Some(effort),
                pick: Pick::Effort(effort),
            })
            .collect();
        Ok(Menu::new("Effort", items))
    }

    fn modes_menu(&self) -> Menu {
        let now = self.mode();
        let items = self
            .modes()
            .into_iter()
            .map(|mode| Item {
                label: mode_name(mode).to_owned(),
                detail: String::new(),
                heading: false,
                current: now == mode,
                pick: Pick::Mode(mode),
            })
            .collect();
        Menu::new("Mode", items)
    }

    /// Starts a thread with the host's defaults and the changes made here, asking here before
    /// tools run, as the app's threads do.
    async fn start(
        &mut self,
        repo: Option<RepoId>,
        prompt: String,
        account: Option<AccountChoice>,
    ) -> Result<(), String> {
        let started = self
            .call::<ThreadStart>(ThreadStartParams {
                run_id: RunId::generate(),
                repo,
                project: None,
                parent: None,
                notify: None,
                title: None,
                prompt,
                account,
                model: self.model.clone(),
                effort: self.effort,
                permission: self.permission,
                context_window: None,
                fast: None,
                branch_slug: None,
                images: Vec::new(),
                approvals: true,
                checkout: false,
                base: None,
                checkout_ref: None,
                threads: Vec::new(),
                naming: None,
            })
            .await?;
        let run = started.run.id;
        upsert(&mut self.threads, started.thread, |held, new| {
            held.id == new.id
        });
        self.runs.insert(run, started.run);
        self.open(run).await
    }

    async fn stop(&mut self) {
        let Some(thread_id) = self.open.as_ref().map(|open| open.run) else {
            return;
        };
        let command = OrchestrationCommand::RunInterrupt {
            thread_id,
            hold_queue: false,
        };
        if let Err(error) = self.call::<OrchestrationDispatch>(command).await {
            self.error = Some(error);
        }
    }

    fn open_run(&self) -> Option<&AgentRun> {
        self.runs.get(&self.open.as_ref()?.run)
    }

    fn open_thread(&self) -> Option<&Thread> {
        let run = self.open.as_ref()?.run;
        self.threads.iter().find(|thread| thread.id == run)
    }

    fn repo(&self, id: RepoId) -> Option<&Repo> {
        self.repos.iter().find(|repo| repo.id == id)
    }

    /// The provider the next message runs on: a `/provider` change, the thread's own, or the
    /// host's default.
    fn provider(&self) -> Option<&str> {
        self.provider
            .as_deref()
            .or_else(|| self.open_run().map(|run| run.backend.as_str()))
            .or(self.default_backend.as_deref())
    }

    /// A provider's name, such as Claude Code, or its id when plxd doesn't list it.
    fn provider_name(&self, id: &str) -> String {
        self.providers
            .iter()
            .find(|provider| provider.instance.id == id)
            .map_or_else(|| id.to_owned(), |provider| provider.instance.name.clone())
    }

    /// The model the next message runs on: a `/model` change, or, on the thread's own provider,
    /// the thread's model or the one its session last reported.
    fn model_id(&self) -> Option<String> {
        if self.model.is_some() || self.provider.is_some() {
            return self.model.clone();
        }
        let open = self.open.as_ref()?;
        self.open_run()?
            .model
            .clone()
            .or_else(|| open.transcript.model.clone())
    }

    /// [`Self::model_id`] by its provider's name for it, or the provider's default.
    fn model_label(&self) -> String {
        match self.model_id() {
            Some(id) => self
                .providers
                .iter()
                .flat_map(models)
                .find(|(held, _)| *held == id)
                .map_or(id, |(_, name)| name),
            None => match self.provider() {
                Some(provider) => format!("{} default model", self.provider_name(provider)),
                None => "default model".to_owned(),
            },
        }
    }

    /// A thread's title, or its prompt's first line.
    fn title(&self, run: RunId) -> String {
        let titled = self.threads.iter().find(|thread| thread.id == run);
        titled
            .and_then(|thread| thread.title.as_deref())
            .or_else(|| self.runs.get(&run)?.prompt.lines().next())
            .unwrap_or("New thread")
            .to_owned()
    }

    /// Where the open thread, or the next one, works: its repo or Space, or its Project.
    fn place(&self) -> String {
        if let Some(open) = &self.open {
            if let Some(project) = self
                .projects
                .iter()
                .find(|project| project.coordinator == Some(open.run))
            {
                return project.name.clone();
            }
            let repo = self.open_thread().and_then(|thread| self.repo(thread.repo));
            return repo.map_or_else(|| "Chats".to_owned(), group_name);
        }
        let repo = self.draft.and_then(|id| self.repo(id));
        repo.map_or_else(|| "Chats".to_owned(), group_name)
    }

    /// Whether `run`'s turn is under way. A run waiting out a usage limit isn't.
    fn working(&self, run: RunId) -> bool {
        self.runs
            .get(&run)
            .is_some_and(|run| matches!(run.status, AgentStatus::Starting | AgentStatus::Running))
    }

    /// The slash commands that start with what's typed, while only a command is typed.
    fn suggestions(&self) -> Vec<(&'static str, &'static str)> {
        if !self.input.starts_with('/') || self.input.contains(' ') {
            return Vec::new();
        }
        let mut matches: Vec<_> = COMMANDS
            .iter()
            .filter(|(name, _)| name.starts_with(self.input.as_str()))
            .copied()
            .collect();
        // `/mode` typed in full is `/mode`, though `/model` starts with it too.
        matches.sort_by_key(|(name, _)| *name != self.input);
        matches
    }

    fn draw(&self, frame: &mut Frame) {
        let area = frame.area().inner(Margin::new(1, 0));
        let notice = self
            .notice
            .as_deref()
            .map_or(0, |text| text.lines().count() + 1);
        let pending = self.pending();
        let prompt_rows = match pending {
            Some(pending) if pending.always => 7,
            Some(_) => 6,
            None => self.input_lines(area.width).len(),
        };
        let suggestions = self.suggestions();
        let below = match &self.menu {
            Some(menu) => menu.items.len().min(MENU_ROWS) + 1,
            None if !suggestions.is_empty() => suggestions.len(),
            None => 2,
        };
        let rows = |n: usize| Constraint::Length(u16::try_from(n).unwrap_or(u16::MAX));
        let [
            body,
            notice_area,
            spinner,
            meta,
            top_rule,
            prompt,
            bottom_rule,
            footer,
        ] = Layout::vertical([
            Constraint::Fill(1),
            rows(notice),
            rows(usize::from(self.working_since.is_some())),
            rows(1),
            rows(1),
            rows(prompt_rows),
            rows(1),
            rows(below),
        ])
        .areas(area);
        self.draw_transcript(frame, body);
        if let Some(text) = &self.notice {
            let lines: Vec<Line> = text
                .lines()
                .map(|line| Line::from(line).dark_gray())
                .collect();
            frame.render_widget(Paragraph::new(lines), notice_area);
        }
        if let Some(since) = self.working_since {
            let line = Line::from(vec![
                Span::from(format!("{} Working… ", SPINNER[self.frame % SPINNER.len()])).fg(CORAL),
                Span::from(format!(
                    "({}s · esc to interrupt)",
                    since.elapsed().as_secs()
                ))
                .dark_gray(),
            ]);
            frame.render_widget(Paragraph::new(line), spinner);
        }
        self.draw_meta(frame, meta);
        let rule = Paragraph::new("─".repeat(usize::from(area.width))).dark_gray();
        frame.render_widget(rule.clone(), top_rule);
        frame.render_widget(rule, bottom_rule);
        match pending {
            Some(pending) => self.draw_approval(frame, prompt, pending),
            None => self.draw_prompt(frame, prompt),
        }
        if let Some(menu) = &self.menu {
            draw_menu(frame, footer, menu);
        } else if suggestions.is_empty() {
            self.draw_footer(frame, footer);
        } else {
            let selected = self.slash.min(suggestions.len() - 1);
            let lines: Vec<Line> = suggestions
                .into_iter()
                .enumerate()
                .map(|(i, (name, what))| {
                    let line = Line::from(vec![
                        Span::from(format!("{name:<10} ")).fg(BLUE),
                        Span::from(what).dark_gray(),
                    ]);
                    if i == selected {
                        line.bold().reversed()
                    } else {
                        line
                    }
                })
                .collect();
            frame.render_widget(Paragraph::new(lines), footer);
        }
    }

    /// The header: the mark beside the version, the model, the provider and mode, and where
    /// the thread works.
    fn header(&self) -> Vec<Line<'static>> {
        let provider = self
            .provider()
            .map_or_else(|| "host default".to_owned(), |id| self.provider_name(id));
        let title = match &self.open {
            Some(open) => self.title(open.run),
            None => "new thread".to_owned(),
        };
        let effort = self.effort.or_else(|| self.open_run()?.effort);
        let text = [
            vec![],
            vec![
                Span::from("Parallax ").bold(),
                Span::from(format!("v{}", crate::version())).dark_gray(),
            ],
            vec![
                Span::from(self.model_label()).bold().fg(Color::White),
                Span::from(format!(
                    " · {} effort",
                    effort.map_or("default", effort_name)
                ))
                .dark_gray(),
            ],
            vec![Span::from(format!("{provider} · {}", mode_name(self.mode()))).dark_gray()],
            vec![Span::from(format!("{} › {title}", self.place())).dark_gray()],
            vec![Span::from("/ for commands · ← for threads").dark_gray()],
            vec![],
        ];
        self.logo
            .iter()
            .cloned()
            .zip(text)
            .map(|(mut mark, text)| {
                mark.push(Span::raw("   "));
                mark.extend(text);
                Line::from(mark)
            })
            .collect()
    }

    fn draw_transcript(&self, frame: &mut Frame, area: Rect) {
        let mut lines = self.header();
        lines.push(Line::default());
        if let Some(open) = &self.open {
            for entry in &open.transcript.entries {
                lines.extend(entry_lines(entry));
                lines.push(Line::default());
            }
        }
        if let Some(error) = &self.error {
            lines.push(Line::from(format!("  ⎿  {error}")).red());
        }
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        // The end, less what was scrolled up.
        let total = u16::try_from(paragraph.line_count(area.width)).unwrap_or(u16::MAX);
        let top = total.saturating_sub(area.height.saturating_add(self.scroll));
        frame.render_widget(paragraph.scroll((top, 0)), area);
    }

    /// Above the prompt: what the next message changes on the left, the effort on the right.
    fn draw_meta(&self, frame: &mut Frame, area: Rect) {
        let changes: Vec<String> = [
            self.provider.as_deref().map(|id| self.provider_name(id)),
            self.model.as_ref().map(|_| self.model_label()),
            self.effort
                .map(|effort| format!("{} effort", effort_name(effort))),
            self.permission.map(|mode| mode_name(mode).to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !changes.is_empty() {
            let left = format!("next message: {}", changes.join(" · "));
            frame.render_widget(Paragraph::new(left).fg(BLUE), area);
        }
        let effort = self
            .effort
            .or_else(|| self.open_run()?.effort)
            .unwrap_or(AgentEffort::Unknown);
        let symbol = match effort {
            AgentEffort::Low => "○",
            AgentEffort::High => "●",
            AgentEffort::Xhigh | AgentEffort::Max => "◉",
            _ => "◐",
        };
        let right = format!("{symbol} {} · /effort", effort_name(effort));
        frame.render_widget(Paragraph::new(right).dark_gray().right_aligned(), area);
    }

    /// The prompt's text in lines as wide as the prompt, less its `› `.
    fn input_lines(&self, width: u16) -> Vec<String> {
        let width = usize::from(width.saturating_sub(2)).max(1);
        let mut lines = Vec::new();
        // ponytail: wraps by chars, so wide characters can overflow a line; measure display
        // widths if that shows.
        for line in self.input.split('\n') {
            let chars: Vec<char> = line.chars().collect();
            if chars.is_empty() {
                lines.push(String::new());
            }
            lines.extend(
                chars
                    .chunks(width)
                    .map(|chunk| chunk.iter().collect::<String>()),
            );
        }
        lines
    }

    fn draw_prompt(&self, frame: &mut Frame, area: Rect) {
        if self.input.is_empty() {
            let placeholder = match &self.open {
                Some(_) => "Reply, add detail, or steer what it does next".to_owned(),
                None => format!("Start a new thread in {}", self.place()),
            };
            let line = Line::from(vec![
                Span::from("› ").bold(),
                Span::from(placeholder).dark_gray(),
            ]);
            frame.render_widget(Paragraph::new(line), area);
            frame.set_cursor_position(Position::new(area.x + 2, area.y));
            return;
        }
        let lines = self.input_lines(area.width);
        let last = lines.len() - 1;
        let cursor_x = u16::try_from(lines[last].chars().count()).unwrap_or(0);
        let shown: Vec<Line> = lines
            .into_iter()
            .enumerate()
            .map(|(i, line)| Line::from(format!("{}{line}", if i == 0 { "› " } else { "  " })))
            .collect();
        frame.render_widget(Paragraph::new(shown), area);
        let y = u16::try_from(last).unwrap_or(0);
        frame.set_cursor_position(Position::new(area.x + 2 + cursor_x, area.y + y));
    }

    /// A permission request, in place of the prompt, as Claude Code asks.
    fn draw_approval(&self, frame: &mut Frame, area: Rect, pending: &Pending) {
        let mut answers = vec!["Yes"];
        if pending.always {
            answers.push("Yes, and don't ask again this session");
        }
        answers.push("No");
        let mut lines = vec![
            Line::from(vec![
                Span::from(pending.tool_name.clone()).bold(),
                Span::from(format!("  {}", pending.detail)).dark_gray(),
            ]),
            Line::from("Do you want to proceed?"),
        ];
        for (i, answer) in answers.iter().enumerate() {
            lines.push(if i == self.choice(pending) {
                Line::from(format!("❯ {}. {answer}", i + 1)).fg(BLUE).bold()
            } else {
                Line::from(format!("  {}. {answer}", i + 1))
            });
        }
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(CORAL));
        frame.render_widget(Paragraph::new(lines).block(block), area);
    }

    fn draw_footer(&self, frame: &mut Frame, area: Rect) {
        let transcript = self.open.as_ref().map(|open| &open.transcript);
        let context = transcript
            .and_then(|transcript| transcript.context)
            .map_or(0, |(tokens, window)| tokens * 100 / window.max(1));
        let cost = transcript.map_or(0, |transcript| transcript.cost_micros);
        let dot = || Span::from(" · ").dark_gray();
        let provider = self
            .provider()
            .map_or_else(|| "host default".to_owned(), |id| self.provider_name(id));
        let first = Line::from(vec![
            Span::from(self.model_label()).bold(),
            dot(),
            Span::from(provider),
            dot(),
            Span::from(self.place()).fg(Color::Green),
            dot(),
            Span::from(format!("ctx {context}%")).fg(Color::Yellow),
            dot(),
            Span::from(format!(
                "${}.{:02}",
                cost / 1_000_000,
                cost % 1_000_000 / 10_000
            )),
        ]);
        let second = if self.quitting {
            Line::from("Press Ctrl-C again to exit").dark_gray()
        } else {
            Line::from(vec![
                Span::from(format!("▸▸ {} on ", mode_name(self.mode()))).fg(CORAL),
                Span::from("(shift+tab to cycle) · / for commands · ← for threads").dark_gray(),
            ])
        };
        frame.render_widget(Paragraph::new(vec![first, second]), area);
    }
}

/// A provider's models as (id, name), as the app's picker lists them: the [`CATALOG`]'s for its
/// kind, then the ones plxd found, then the user's own, each id once.
fn models(provider: &ProviderInfo) -> Vec<(String, String)> {
    let kind = provider.instance.kind;
    let catalog = CATALOG
        .iter()
        .filter(|(of, ..)| *of == kind)
        .map(|(_, id, name)| ((*id).to_owned(), (*name).to_owned()));
    let found = provider
        .models
        .iter()
        .chain(&provider.instance.models)
        .map(|model| (model.id.clone(), model.name.clone()));
    let mut seen = std::collections::HashSet::new();
    catalog
        .chain(found)
        .filter(|(id, _)| seen.insert(id.clone()))
        .collect()
}

/// A list below the prompt: its title and keys, then up to [`MENU_ROWS`] rows around the
/// selected one, with `❯` at the selected and `✓` at the current.
fn draw_menu(frame: &mut Frame, area: Rect, menu: &Menu) {
    let mut lines = vec![Line::from(vec![
        Span::from(format!("{}  ", menu.title)).bold(),
        Span::from("↑↓ choose · enter pick · esc close").dark_gray(),
    ])];
    let first = menu
        .selected
        .saturating_sub(MENU_ROWS - 1)
        .min(menu.items.len().saturating_sub(MENU_ROWS));
    let width = menu
        .items
        .iter()
        .map(|item| item.label.chars().count())
        .max()
        .unwrap_or(0);
    for (i, item) in menu.items.iter().enumerate().skip(first).take(MENU_ROWS) {
        let selected = i == menu.selected;
        let mut label = Span::from(format!("{:<width$}", item.label));
        if item.heading {
            label = label.bold();
        }
        let mut line = Line::from(vec![
            Span::from(if selected { "❯ " } else { "  " }).fg(BLUE),
            label,
            Span::from(if item.current { " ✓" } else { "  " }).fg(Color::Green),
            Span::from(format!("  {}", item.detail)).dark_gray(),
        ]);
        if selected {
            line = line.fg(BLUE).bold();
        }
        lines.push(line);
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// The app's mark in [`LOGO_PIXELS`] square pixels, two to a terminal row with `▀` and `▄`.
/// Its circles are `ParallaxMark`'s: radius 7 at (9.5, 9.5) and (14.5, 14.5), here cropped to
/// their bounds. Each pixel is sampled 6 × 6 times. One at least half covered takes the mix of
/// the colors over it, which smooths where the circles meet.
fn logo() -> Vec<Vec<Span<'static>>> {
    const SAMPLES: u16 = 6;
    const LOW: f64 = 2.5;
    const SIDE: f64 = 19.0;
    let at = |pixel: u16, sample: u16| {
        let offset = (f64::from(sample) + 0.5) / f64::from(SAMPLES);
        LOW + SIDE * (f64::from(pixel) + offset) / f64::from(LOGO_PIXELS)
    };
    let pixel = |x: u16, y: u16| {
        let mut sum = [0u32; 3];
        let mut hits = 0;
        for (a, b) in (0..SAMPLES).flat_map(|a| (0..SAMPLES).map(move |b| (a, b))) {
            let (px, py) = (at(x, a), at(y, b));
            let inside = |center: f64| (px - center).powi(2) + (py - center).powi(2) <= 49.0;
            let color = match (inside(9.5), inside(14.5)) {
                (true, true) => MARK_OVERLAP,
                (true, false) => MARK_BLUE,
                (false, true) => MARK_CORAL,
                (false, false) => continue,
            };
            hits += 1;
            for (total, part) in sum.iter_mut().zip(color) {
                *total += u32::from(part);
            }
        }
        let mix = |total: u32| u8::try_from(total / hits.max(1)).unwrap_or(u8::MAX);
        (hits * 2 >= u32::from(SAMPLES * SAMPLES))
            .then(|| Color::Rgb(mix(sum[0]), mix(sum[1]), mix(sum[2])))
    };
    (0..LOGO_PIXELS / 2)
        .map(|row| {
            (0..LOGO_PIXELS)
                .map(|x| match (pixel(x, row * 2), pixel(x, row * 2 + 1)) {
                    (Some(up), Some(down)) => Span::styled("▀", Style::new().fg(up).bg(down)),
                    (Some(up), None) => Span::styled("▀", Style::new().fg(up)),
                    (None, Some(down)) => Span::styled("▄", Style::new().fg(down)),
                    (None, None) => Span::raw(" "),
                })
                .collect()
        })
        .collect()
}

/// The lines an entry shows, as Claude Code lays them out: `›` before a message, `●` before a
/// reply or a tool call, and `⎿` before what the tool returned.
fn entry_lines(entry: &Entry) -> Vec<Line<'static>> {
    match entry {
        Entry::User(text) => text
            .lines()
            .enumerate()
            .map(|(i, line)| {
                let prefix = if i == 0 { "› " } else { "  " };
                Line::from(format!("{prefix}{line}")).dark_gray()
            })
            .collect(),
        Entry::Assistant { text, .. } => markdown::lines(text)
            .into_iter()
            .enumerate()
            .map(|(i, mut line)| {
                let prefix = if i == 0 { "● " } else { "  " };
                line.spans.insert(0, Span::raw(prefix));
                line
            })
            .collect(),
        Entry::Tool {
            name,
            detail,
            status,
            output,
            ..
        } => {
            let color = match status {
                Some(AgentToolStatus::Ok) => Color::Green,
                Some(_) => Color::Red,
                None => Color::Yellow,
            };
            let call = if detail.is_empty() {
                name.clone()
            } else {
                format!("{name}({detail})")
            };
            let mut lines = vec![Line::from(vec![
                Span::from("● ").fg(color),
                Span::from(call).bold(),
            ])];
            if let Some(output) = output {
                lines.push(Line::from(format!("  ⎿  {output}")).dark_gray());
            }
            lines
        }
        Entry::Note(text) => vec![Line::from(format!("  {text}")).dark_gray().italic()],
    }
}

fn mode_name(mode: AgentPermission) -> &'static str {
    MODES
        .iter()
        .find(|(held, _)| *held == mode)
        .map_or("default", |(_, name)| name)
}

fn effort_name(effort: AgentEffort) -> &'static str {
    match effort {
        AgentEffort::Low => "low",
        AgentEffort::Medium => "medium",
        AgentEffort::High => "high",
        AgentEffort::Xhigh => "xhigh",
        AgentEffort::Max => "max",
        AgentEffort::Unknown => "default",
    }
}

/// A repo's or Space's name, with plxd's entry for threads with no repo as Chats.
fn group_name(repo: &Repo) -> String {
    if repo.scratch {
        "Chats".to_owned()
    } else {
        repo.name.clone()
    }
}

/// Replaces the item `same` matches with `new`, or adds it.
fn upsert<T>(items: &mut Vec<T>, new: T, same: impl Fn(&T, &T) -> bool) {
    match items.iter_mut().find(|held| same(held, &new)) {
        Some(held) => *held = new,
        None => items.push(new),
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{AgentEffort, AgentPermission, ClientInfo, ProviderInfo};
    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use super::App;
    use crate::peer::Plxd;

    /// An app whose plxd is never reached: these keys make no calls.
    fn app() -> App {
        App::new(Plxd::new(|| async {
            Err::<(tokio::io::DuplexStream, ClientInfo), String>("no plxd in tests".to_owned())
        }))
    }

    async fn press(app: &mut App, codes: &[KeyCode]) {
        for &code in codes {
            app.key(KeyEvent::from(code)).await;
        }
    }

    #[tokio::test]
    async fn history_keeps_what_was_typed() {
        let mut app = app();
        app.input = "draft".to_owned();
        press(&mut app, &[KeyCode::Down, KeyCode::Up]).await;
        assert_eq!(app.input, "draft", "no history: the arrows change nothing");

        app.history = vec!["one".to_owned(), "two".to_owned()];
        press(&mut app, &[KeyCode::Up, KeyCode::Up]).await;
        assert_eq!(app.input, "one");
        press(&mut app, &[KeyCode::Down, KeyCode::Down]).await;
        assert_eq!(app.input, "draft", "past the newest, the draft comes back");
    }

    #[tokio::test]
    async fn a_new_thread_from_an_empty_thread_list() {
        let mut app = app();
        press(&mut app, &[KeyCode::Left, KeyCode::Char('n')]).await;
        assert!(app.menu.is_none());
        assert_eq!(app.draft, None, "Chats, before plxd made its entry");
    }

    #[test]
    fn a_new_provider_drops_what_it_cant_run() {
        let provider = |id: &str, permissions: &[&str]| -> ProviderInfo {
            serde_json::from_value(serde_json::json!({
                "instance": {"id": id, "kind": id, "name": id, "enabled": true, "args": [],
                             "env": [], "models": []},
                "installed": true, "installing": false, "models": [],
                "permissions": permissions, "efforts": true, "coordinator": false, "loginEnv": [],
            }))
            .unwrap()
        };
        let mut app = app();
        app.providers = vec![
            provider("claude", &["edit", "plan"]),
            provider("codex", &["edit", "auto"]),
        ];
        app.default_backend = Some("codex".to_owned());
        app.model = Some("claude-opus-5".to_owned());
        app.effort = Some(AgentEffort::High);
        app.permission = Some(AgentPermission::Plan);

        // As after /new from a Claude thread, onto the host's default, Codex.
        app.fit_provider(Some("claude"));
        assert_eq!(app.model, None);
        assert_eq!(app.permission, Some(AgentPermission::Edit));
        assert_eq!(app.effort, Some(AgentEffort::High));
    }

    #[tokio::test]
    async fn enter_runs_the_highlighted_command() {
        let mut app = app();
        press(
            &mut app,
            &[KeyCode::Char('/'), KeyCode::Down, KeyCode::Enter],
        )
        .await;
        assert_eq!(app.input, "");
        assert_eq!(app.menu.as_ref().map(|menu| menu.title), Some("Threads"));

        app.menu = None;
        for c in "/mode".chars() {
            press(&mut app, &[KeyCode::Char(c)]).await;
        }
        press(&mut app, &[KeyCode::Enter]).await;
        assert_eq!(app.menu.as_ref().map(|menu| menu.title), Some("Mode"));
    }
}
