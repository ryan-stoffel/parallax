//! `plxd tui`: Parallax in a terminal (PLX-740), laid out like Claude Code and Codex: one column
//! with the transcript under a header, the prompt between two rules, and a status line. It is
//! another client of the plxd the app attaches to, so its threads, Spaces, Projects, and messages
//! are the app's, live, both ways.
//!
//! - Threads come from `orchestration/subscribeShell`; ← on an empty prompt or `/threads` opens
//!   them in a sidebar, by repo and Space, as the app lists them.
//! - The open thread is `orchestration/subscribeThread`, folded by [`transcript`] and drawn by
//!   [`draw`], with each run of tool calls folded into one line that a click opens.
//! - A message is `message.dispatch`, queued after the turn under way, carrying any `/provider`,
//!   `/model`, `/effort`, or `/mode` change made since the last one, as the app's composer does.
//!   The first message of a new thread is `thread/start`: in the git checkout `plxd tui` ran in,
//!   in place, as Claude Code works; otherwise in a repo, Space, or Chats. Esc is
//!   `run.interrupt`.
//! - While a turn runs, the terminal's own progress bar moves (`OSC 9;4`), as for Claude Code.
//! - `host/health` every 10 s keeps the connection open and finds one that dropped; its
//!   replacement subscribes again from fresh snapshots.

mod draw;
mod markdown;
mod transcript;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parallax_protocol::methods::{
    AccountsDefaultsGet, AgentApprove, EventsUnsubscribe, HostHealth, OrchestrationDispatch,
    OrchestrationSubscribeShell, OrchestrationSubscribeThread, ProvidersList, RepoAdd,
    RequestMethod, ThreadStart, ThreadUpdate,
};
use parallax_protocol::{
    AccountChoice, AccountsDefaultsGetParams, AgentApprovalAnswer, AgentApproveParams, AgentEffort,
    AgentPermission, AgentRun, AgentStatus, ApprovalId, DispatchMode, EventsEventParams,
    EventsUnsubscribeParams, HostHealthParams, LoggedEvent, OrchestrationCommand, ParallaxEvent,
    Project, ProviderInfo, ProviderKind, ProvidersListParams, Repo, RepoAddParams, RepoId, RunId,
    SubscribeShellParams, SubscribeThreadParams, SubscriptionId, Thread, ThreadStartParams,
    ThreadUpdateParams, TurnId,
};
use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::layout::{Position, Rect};
use ratatui::text::Span;
use tokio::sync::mpsc;

use self::transcript::{Pending, Transcript};
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

/// The most files `@` lists at once.
const MENTIONS: usize = 8;

/// The most paths `@` reads from a checkout.
const MAX_FILES: usize = 50_000;

/// Lines a wheel step scrolls.
const WHEEL: u16 = 3;

/// The terminal's progress bar, `OSC 9;4`: moving while a turn runs, as Ghostty, Windows
/// Terminal, and others show it for Claude Code, and cleared after. Others ignore it.
const PROGRESS_ON: &str = "\x1b]9;4;3\x07";
const PROGRESS_OFF: &str = "\x1b]9;4;0\x07";

/// The slash commands, with what each does.
const COMMANDS: [(&str, &str); 9] = [
    (
        "/new",
        "start a new thread here, or in the repo or Space named",
    ),
    (
        "/threads",
        "open the sidebar of threads by repo and Space (also ←)",
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
    app.draft = app.cwd_draft();
    // Started inside a thread's own worktree, it opens that thread; plxd won't add its folder.
    if let Draft::Here(top) = &app.draft {
        let inside = app.runs.values().find(|run| {
            let worktree = run.worktree_path.as_deref().map(Path::new);
            worktree.and_then(|path| path.canonicalize().ok()).as_ref() == Some(top)
        });
        if let Some(run) = inside.map(|run| run.id) {
            (app.draft, app.here) = (Draft::Chats, None);
            app.open(run).await?;
        }
    }
    // In the background: the screen shows before plxd has probed every provider's CLI.
    app.refresh_providers();
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
    // ratatui's hook restores the screen on a panic; the mouse and the progress bar go first.
    let restore = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        leave();
        restore(info);
    }));
    // Clicks open tool calls and threads, and the wheel scrolls. Shift+drag still selects text.
    // crossterm's capture, which on Windows is a console mode rather than escape codes.
    let _ = execute!(std::io::stdout(), EnableMouseCapture);
    let result = app.run(&mut terminal, &mut keys, &mut incoming).await;
    leave();
    ratatui::restore();
    result
}

/// Hands the terminal back: no mouse reports, and no progress bar.
fn leave() {
    let _ = execute!(std::io::stdout(), DisableMouseCapture);
    progress(false);
}

fn write(sequence: &str) {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(sequence.as_bytes());
    let _ = stdout.flush();
}

/// Starts or clears the terminal's progress bar.
fn progress(on: bool) {
    write(if on { PROGRESS_ON } else { PROGRESS_OFF });
}

/// Where a new thread starts.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Draft {
    /// With no repo: Chats.
    Chats,
    /// A repo or Space, in a worktree of its own, as the app starts one.
    Repo(RepoId),
    /// The git checkout `plxd tui` ran in, worked in place, as Claude Code works in its folder.
    /// The first message adds it to plxd if plxd doesn't list it yet.
    Here(PathBuf),
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
    /// A model's id, a provider's account, a thread's age, or a repo's folder.
    detail: String,
    /// A heading row, such as a repo above its threads.
    heading: bool,
    /// What the next message uses now, or the open thread.
    current: bool,
    /// A thread whose turn is under way.
    working: bool,
    pick: Pick,
}

/// A list to pick from: the sidebar for threads, below the prompt for the rest.
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

    fn sidebar(&self) -> bool {
        self.title == "Threads"
    }
}

/// The open thread.
struct Open {
    run: RunId,
    subscription: Option<SubscriptionId>,
    transcript: Transcript,
}

/// Where the last frame drew what a click can land on.
#[derive(Default)]
struct Hits {
    /// The transcript's area and the content row at its top.
    transcript: Rect,
    top: u16,
    /// The most the transcript scrolls up: its rows past one screen.
    max_scroll: u16,
    /// Each run of tool calls: its first content row, the row after its last, and its key.
    tools: Vec<(u16, u16, usize)>,
    /// The sidebar's area, and the item each of its rows shows.
    sidebar: Option<(Rect, Vec<(u16, usize)>)>,
}

/// What a background read hands back to the loop.
enum Loaded {
    /// The host's default provider, and its providers and their models.
    Providers {
        backend: Option<String>,
        providers: Vec<ProviderInfo>,
    },
    /// The paths `@` offers in a folder.
    Files(PathBuf, Vec<String>),
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent bits of screen state"
)]
struct App {
    plxd: Plxd,
    /// Where background reads send what they read, and where the loop takes it.
    loads: mpsc::UnboundedSender<Loaded>,
    loaded: Option<mpsc::UnboundedReceiver<Loaded>>,
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
    /// With no thread open, where the next message starts one.
    draft: Draft,
    /// The git checkout `plxd tui` is in: where it ran, or the repo of the thread it last opened.
    /// New threads in its repo work in it, in place.
    here: Option<PathBuf>,
    /// Why the folder `plxd tui` ran in isn't [`Draft::Here`], shown until the first message.
    not_here: Option<String>,
    /// The list showing, if one is.
    menu: Option<Menu>,
    /// The runs of tool calls opened by a click, by their first entry, and whether Ctrl+O
    /// opened them all.
    expanded: HashSet<usize>,
    expand_all: bool,
    hits: RefCell<Hits>,
    input: String,
    /// The highlighted command while `/` lists them.
    slash: usize,
    /// The paths `@` offers, and the folder they're in: its files, from git, and their folders.
    files: Option<(PathBuf, Vec<String>)>,
    /// The folder whose files are being read, so another `@` there doesn't read them again.
    reading: Option<PathBuf>,
    /// The highlighted path while `@` lists them, and whether Esc closed the list.
    mention: usize,
    mentions_closed: bool,
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
        let (loads, loaded) = mpsc::unbounded_channel();
        Self {
            plxd,
            loads,
            loaded: Some(loaded),
            logo: draw::logo(),
            default_backend: None,
            providers: Vec::new(),
            shell: None,
            projects: Vec::new(),
            repos: Vec::new(),
            threads: Vec::new(),
            runs: HashMap::new(),
            open: None,
            draft: Draft::Chats,
            here: None,
            not_here: None,
            menu: None,
            expanded: HashSet::new(),
            expand_all: false,
            hits: RefCell::default(),
            input: String::new(),
            slash: 0,
            files: None,
            reading: None,
            mention: 0,
            mentions_closed: false,
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
        let mut progressing = false;
        let Some(mut loaded) = self.loaded.take() else {
            return Err("plxd tui runs once".to_owned());
        };
        while !self.done {
            if self.dirty {
                self.dirty = false;
                terminal
                    .draw(|frame| self.draw(frame))
                    .map_err(|error| format!("could not draw: {error}"))?;
            }
            if progressing != self.working_since.is_some() {
                progressing = !progressing;
                progress(progressing);
            }
            tokio::select! {
                Some(event) = keys.recv() => match event {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        self.key(key).await;
                        self.dirty = true;
                    }
                    // Capture reports every move too; only a click or the wheel changes anything.
                    Event::Mouse(mouse) if matches!(
                        mouse.kind,
                        MouseEventKind::Down(_) | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                    ) => {
                        self.mouse(mouse).await;
                        self.dirty = true;
                    }
                    Event::Resize(..) => self.dirty = true,
                    _ => {}
                },
                Some(first) = incoming.recv() => {
                    self.incoming(first).await;
                    while let Ok(more) = incoming.try_recv() {
                        self.incoming(more).await;
                    }
                    self.dirty = true;
                }
                Some(load) = loaded.recv() => {
                    self.take(load);
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

    /// Reads the host's default provider and its providers, waiting for them: for the first
    /// list, when there's nothing to show yet.
    async fn load_providers(&mut self) {
        match read_providers(&self.plxd).await {
            Ok(load) => self.take(load),
            Err(error) => self.error = Some(error),
        }
    }

    /// Reads them again in the background; [`Self::take`] puts them in place.
    fn refresh_providers(&self) {
        let (plxd, loads) = (self.plxd.clone(), self.loads.clone());
        tokio::spawn(async move {
            if let Ok(load) = read_providers(&plxd).await {
                let _ = loads.send(load);
            }
        });
    }

    /// Puts what a background read found in place.
    fn take(&mut self, load: Loaded) {
        match load {
            // Choices made before the list came are fitted to it, as choosing a provider fits them.
            Loaded::Providers { backend, providers } => {
                let before = self.provider().map(str::to_owned);
                if backend.is_some() {
                    self.default_backend = backend;
                }
                self.providers = providers;
                // With no provider known before, a model picked then was meant for this one.
                let model = before.is_none().then(|| self.model.take()).flatten();
                self.fit_provider(before.as_deref());
                self.model = model.or(self.model.take());
            }
            Loaded::Files(folder, paths) => {
                if self.reading.as_ref() == Some(&folder) {
                    self.reading = None;
                }
                // A read from a folder left since is dropped.
                if self.folder().as_ref() == Some(&folder) {
                    self.files = Some((folder, paths));
                }
            }
        }
    }

    /// Where `plxd tui` starts threads: in the git checkout it ran in, worked in place. plxd
    /// runs threads only in git checkouts, so anywhere else they start in Chats, and
    /// [`Self::not_here`] says why.
    fn cwd_draft(&mut self) -> Draft {
        let Ok(cwd) = std::env::current_dir() else {
            return Draft::Chats;
        };
        if let Some(top) = git_top(&cwd) {
            self.here = Some(top.clone());
            return Draft::Here(top);
        }
        self.not_here = Some(format!(
            "{} isn't in a git repository, and plxd runs threads in one, so new threads start in Chats.",
            tilde(&cwd)
        ));
        Draft::Chats
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
        self.expanded.clear();
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
        self.not_here = None;
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
        // Opens or closes every run of tool calls, as Claude Code's Ctrl+O shows the details.
        if control && key.code == KeyCode::Char('o') {
            self.expand_all = !self.expand_all;
            self.expanded.clear();
            return;
        }
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
        let mentions = self.mentions();
        if !mentions.is_empty() {
            let last = mentions.len() - 1;
            match key.code {
                KeyCode::Up => return self.mention = self.mention.saturating_sub(1),
                KeyCode::Down => return self.mention = (self.mention + 1).min(last),
                KeyCode::Esc => return self.mentions_closed = true,
                // Enter sends a message whose `@` is already complete, such as a folder's.
                KeyCode::Enter
                    if self.mention_query() == Some(mentions[self.mention.min(last)].as_str()) => {}
                KeyCode::Tab | KeyCode::Enter => {
                    return self.complete_mention(&mentions[self.mention.min(last)]);
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
            KeyCode::PageUp => self.scroll_up(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Backspace => {
                self.input.pop();
                (self.slash, self.mention, self.mentions_closed) = (0, 0, false);
            }
            KeyCode::Char(c) => {
                // Only an `@` that starts a word mentions a file, not one in me@example.com.
                let starts_word = self.input.chars().last().is_none_or(char::is_whitespace);
                self.input.push(c);
                (self.slash, self.mention, self.mentions_closed) = (0, 0, false);
                if c == '@' && starts_word {
                    self.load_files();
                }
            }
            _ => {}
        }
    }

    /// A click opens or closes a run of tool calls, or picks a row of the sidebar, and a click
    /// beside the sidebar closes it. The wheel scrolls the transcript.
    async fn mouse(&mut self, mouse: MouseEvent) {
        let at = Position::new(mouse.column, mouse.row);
        match mouse.kind {
            // Over the sidebar, the wheel moves through it.
            MouseEventKind::ScrollUp if self.sidebar_open() => self.menu_key(KeyCode::Up).await,
            MouseEventKind::ScrollDown if self.sidebar_open() => {
                self.menu_key(KeyCode::Down).await;
            }
            MouseEventKind::ScrollUp => self.scroll_up(WHEEL),
            MouseEventKind::ScrollDown => self.scroll = self.scroll.saturating_sub(WHEEL),
            MouseEventKind::Down(MouseButton::Left) => {
                let sidebar = self.hits.borrow().sidebar.clone();
                if let Some((area, rows)) = sidebar {
                    let row = rows.iter().find(|(row, _)| *row == at.y).map(|(_, i)| *i);
                    match (area.contains(at), row) {
                        (true, Some(index)) => {
                            if let Some(menu) = &mut self.menu {
                                menu.selected = index;
                            }
                            self.menu_key(KeyCode::Enter).await;
                        }
                        (true, None) => {}
                        (false, _) => self.menu = None,
                    }
                    return;
                }
                let hits = self.hits.borrow();
                if !hits.transcript.contains(at) {
                    return;
                }
                let row = hits.top + (at.y - hits.transcript.y);
                let key = hits
                    .tools
                    .iter()
                    .find(|(first, end, _)| (*first..*end).contains(&row))
                    .map(|(.., key)| *key);
                drop(hits);
                if let Some(key) = key
                    && !self.expanded.remove(&key)
                {
                    self.expanded.insert(key);
                }
            }
            _ => {}
        }
    }

    /// What's typed after the `@` the input ends in, while it ends in one.
    fn mention_query(&self) -> Option<&str> {
        let token = self.input.rsplit(char::is_whitespace).next()?;
        token.strip_prefix('@')
    }

    /// The paths `@` offers for what's typed after it: those whose name starts with it first,
    /// then those it's anywhere in, shortest first, case aside.
    fn mentions(&self) -> Vec<String> {
        let (Some(query), Some((_, files))) = (self.mention_query(), &self.files) else {
            return Vec::new();
        };
        if self.mentions_closed {
            return Vec::new();
        }
        let query = query.to_lowercase();
        let mut matches: Vec<(bool, &String)> = files
            .iter()
            .filter_map(|path| {
                let lower = path.to_lowercase();
                let name = lower.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                lower
                    .contains(&query)
                    .then_some((!name.starts_with(&query), path))
            })
            .collect();
        matches.sort_by_key(|(later, path)| (*later, path.len()));
        matches
            .into_iter()
            .take(MENTIONS)
            .map(|(_, path)| path.clone())
            .collect()
    }

    /// Puts `path` in place of the `@` being typed. A folder stays open for more of its path.
    fn complete_mention(&mut self, path: &str) {
        let token = self
            .input
            .rsplit(char::is_whitespace)
            .next()
            .map_or(0, str::len);
        self.input.truncate(self.input.len() - token);
        self.input.push('@');
        self.input.push_str(path);
        if !path.ends_with('/') {
            self.input.push(' ');
        }
        self.mention = 0;
    }

    /// Reads the paths `@` offers from the folder the next message works in, on each `@`, in
    /// the background: `git ls-files`, as git sees the checkout, and the folders those files are
    /// in. Until it's read, `@` offers what was read there last; in Chats, nothing.
    fn load_files(&mut self) {
        let Some(folder) = self.folder() else {
            self.files = None;
            return;
        };
        if self.files.as_ref().is_some_and(|(held, _)| *held != folder) {
            self.files = None;
        }
        if self.reading.as_ref() == Some(&folder) {
            return;
        }
        self.reading = Some(folder.clone());
        let loads = self.loads.clone();
        tokio::task::spawn_blocking(move || {
            let paths = files_in(&folder);
            let _ = loads.send(Loaded::Files(folder, paths));
        });
    }

    /// Scrolls the transcript up by `lines`, no further than its top.
    fn scroll_up(&mut self, lines: u16) {
        let max = self.hits.borrow().max_scroll;
        self.scroll = self.scroll.saturating_add(lines).min(max);
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
        let page = if menu.sidebar() { 10 } else { MENU_ROWS };
        match code {
            KeyCode::Esc | KeyCode::Left | KeyCode::Right => self.menu = None,
            KeyCode::Up => menu.selected = menu.selected.saturating_sub(1),
            KeyCode::Down => menu.selected = (menu.selected + 1).min(last),
            KeyCode::PageUp => menu.selected = menu.selected.saturating_sub(page),
            KeyCode::PageDown => menu.selected = (menu.selected + page).min(last),
            KeyCode::Enter => {
                let pick = menu.items.get(menu.selected).map(|item| item.pick.clone());
                self.menu = None;
                if let Some(pick) = pick {
                    self.pick(pick).await;
                }
            }
            // In the sidebar: a new thread in the selected row's repo or Space.
            KeyCode::Char('n') if menu.sidebar() => {
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
                self.new_thread(self.draft_for(repo)).await;
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
                match self.open(run).await {
                    Ok(()) => self.cd(),
                    Err(error) => self.error = Some(error),
                }
            }
            Pick::Group(repo) => {
                self.new_thread(self.draft_for(repo)).await;
            }
            Pick::Provider(id) => {
                let before = self.provider().map(str::to_owned);
                let thread_has_it = self.open_run().is_some_and(|run| run.backend == id);
                self.provider = (!thread_has_it).then_some(id);
                self.fit_provider(before.as_deref());
            }
            Pick::Model(id) => self.model = Some(id),
            // Checked again here: a list opened before the providers came offered every choice.
            Pick::Effort(_) if !self.takes_effort() => {
                self.error = Some("this provider doesn't take an effort".to_owned());
            }
            Pick::Effort(effort) => self.effort = Some(effort),
            Pick::Mode(mode) if !self.modes().contains(&mode) => {
                self.error = Some(format!("this provider can't run {}", mode_name(mode)));
            }
            Pick::Mode(mode) => self.permission = Some(mode),
        }
    }

    /// Moves `plxd tui` into the folder the open thread works in, when it's on this computer.
    /// A thread that works in its checkout, in place, makes that checkout [`App::here`], as if
    /// `plxd tui` ran there; a thread in a worktree changes nothing about where new threads start.
    /// The shell that started `plxd tui` stays where it was: no program can move its parent.
    fn cd(&mut self) {
        let Some(folder) = self.folder() else { return };
        if std::env::set_current_dir(&folder).is_ok()
            && self.open_run().is_some_and(|run| run.checkout)
        {
            self.here = Some(folder);
        }
    }

    /// Where a new thread in `repo` starts: in place in the checkout `plxd tui` is in, as Claude
    /// Code works; in a worktree of its own in another repo or a Space, as the app starts one;
    /// and in Chats for none.
    fn draft_for(&self, repo: Option<RepoId>) -> Draft {
        let Some(repo) = repo.and_then(|id| self.repo(id)) else {
            return Draft::Chats;
        };
        match &self.here {
            _ if repo.scratch => Draft::Chats,
            Some(here) if Path::new(&repo.path) == here => Draft::Here(here.clone()),
            _ => Draft::Repo(repo.id),
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

    /// Leaves the open thread for a new one at `draft`, which the next message starts.
    async fn new_thread(&mut self, draft: Draft) {
        let before = self.provider().map(str::to_owned);
        self.close().await;
        self.draft = draft;
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
                // On another provider, the model the header names: its first, unless picked.
                model: self
                    .model
                    .clone()
                    .or_else(|| self.provider.as_ref().and_then(|_| self.first_model())),
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
            self.start(self.draft.clone(), text.clone(), account).await
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
                let draft = match named {
                    Some(Some(repo)) => self.draft_for(Some(repo)),
                    Some(None) => {
                        self.error = Some(format!("no repo or Space is named {argument}"));
                        return;
                    }
                    // Where the open thread works, or where the next one was going to.
                    None => match self.open_thread() {
                        Some(thread) => self.draft_for(Some(thread.repo)),
                        None => self.draft.clone(),
                    },
                };
                self.new_thread(draft).await;
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
            // From what's already read, refreshed behind the list; read first only when empty.
            "/provider" | "/model" => {
                if self.providers.is_empty() {
                    self.load_providers().await;
                } else {
                    self.refresh_providers();
                }
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
                        "← on an empty prompt opens the sidebar; n there starts a thread",
                        "Click a tool line to open it · Ctrl+O opens them all",
                        "Shift+Tab mode · Esc interrupts · \\ or Alt+Enter new line",
                        "↑↓ history · wheel or PgUp/PgDn scroll · Shift+drag selects text",
                        "Ctrl-C twice quits",
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

    /// The sidebar, as the app lists threads: each repo and Space with its threads, newest
    /// first, each with its age. Projects' coordinators aren't threads, and stay out.
    fn threads_menu(&self) -> Menu {
        let open = self.open.as_ref().map(|open| open.run);
        let now = jiff::Timestamp::now();
        let run_item = |run: RunId, label: String, at: Option<jiff::Timestamp>| Item {
            label,
            detail: at.map_or_else(String::new, |at| age(now, at)),
            heading: false,
            current: Some(run) == open,
            working: self.working(run),
            pick: Pick::Run(run),
        };
        let heading = |label: String, detail: String, repo: Option<RepoId>| Item {
            label,
            detail,
            heading: true,
            current: false,
            working: false,
            pick: Pick::Group(repo),
        };
        let mut items: Vec<Item> = Vec::new();
        // plxd makes the entry for threads with no repo on first use; until then, offer it.
        if !self.repos.iter().any(|repo| repo.scratch) {
            items.push(heading("Chats".to_owned(), String::new(), None));
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
            let folder = if repo.scratch || repo.space {
                String::new()
            } else {
                tilde(Path::new(&repo.path))
            };
            items.push(heading(
                group_name(repo),
                folder,
                (!repo.scratch).then_some(repo.id),
            ));
            items.extend(threads.into_iter().map(|thread| {
                let at = thread.last_prompt_at.unwrap_or(thread.created_at);
                run_item(thread.id, self.title(thread.id), Some(at))
            }));
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
                    working: false,
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

    /// The models of the provider the next message runs on.
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
                working: false,
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
                working: false,
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
                working: false,
                pick: Pick::Mode(mode),
            })
            .collect();
        Menu::new("Mode", items)
    }

    /// Starts a thread at `draft` with the host's defaults and the changes made here, asking
    /// here before tools run, as the app's threads do.
    async fn start(
        &mut self,
        draft: Draft,
        prompt: String,
        account: Option<AccountChoice>,
    ) -> Result<(), String> {
        let (repo, checkout) = match draft {
            Draft::Chats => (None, false),
            Draft::Repo(repo) => (Some(repo), false),
            Draft::Here(path) => (Some(self.add_repo(&path).await?), true),
        };
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
                // The model the header names, as the app sends the one its composer shows.
                model: self.model.clone().or_else(|| self.first_model()),
                effort: self.effort,
                permission: self.permission,
                context_window: None,
                fast: None,
                branch_slug: None,
                images: Vec::new(),
                approvals: true,
                checkout,
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

    /// The repo entry for the checkout at `path`, adding it to plxd if plxd doesn't list it.
    async fn add_repo(&mut self, path: &Path) -> Result<RepoId, String> {
        let listed = self
            .repos
            .iter()
            .find(|repo| !repo.scratch && !repo.space && Path::new(&repo.path) == path);
        if let Some(repo) = listed {
            return Ok(repo.id);
        }
        let added = self
            .call::<RepoAdd>(RepoAddParams {
                id: RepoId::generate(),
                path: path.to_string_lossy().into_owned(),
            })
            .await?;
        let id = added.repo.id;
        upsert(&mut self.repos, added.repo, |held, new| held.id == new.id);
        Ok(id)
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

    /// The model the next message runs on: a `/model` change; on the thread's own provider, the
    /// thread's model or the one its session last reported; otherwise the provider's first, as
    /// the app's composer picks one.
    fn model_id(&self) -> Option<String> {
        if self.model.is_some() {
            return self.model.clone();
        }
        let thread = self.provider.is_none().then_some(()).and_then(|()| {
            let open = self.open.as_ref()?;
            self.open_run()?
                .model
                .clone()
                .or_else(|| open.transcript.model.clone())
        });
        thread.or_else(|| self.first_model())
    }

    /// The provider's first model, which a new thread runs on unless `/model` picks another.
    fn first_model(&self) -> Option<String> {
        models(self.provider_info()?)
            .into_iter()
            .next()
            .map(|(id, _)| id)
    }

    /// [`Self::model_id`] by its provider's name for it, such as Claude Sonnet 5.5.
    fn model_label(&self) -> String {
        let Some(id) = self.model_id() else {
            return "default model".to_owned();
        };
        self.providers
            .iter()
            .flat_map(models)
            .find(|(held, _)| *held == id)
            .map_or(id, |(_, name)| name)
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
        match &self.draft {
            Draft::Chats => "Chats".to_owned(),
            Draft::Repo(id) => self
                .repo(*id)
                .map_or_else(|| "Chats".to_owned(), group_name),
            Draft::Here(path) => path.file_name().map_or_else(
                || path.display().to_string(),
                |name| name.to_string_lossy().into_owned(),
            ),
        }
    }

    /// The folder on this computer the open thread, or the next one, works in: the thread's
    /// worktree or its repo's checkout, or the checkout `plxd tui` ran in. None for Chats and
    /// Spaces, whose folders are plxd's.
    fn folder(&self) -> Option<PathBuf> {
        let repo = match &self.open {
            Some(_) => self.open_thread().and_then(|thread| self.repo(thread.repo)),
            None => match &self.draft {
                Draft::Here(path) => return Some(path.clone()),
                Draft::Repo(id) => self.repo(*id),
                Draft::Chats => None,
            },
        }?;
        if repo.scratch || repo.space {
            return None;
        }
        let worktree = self.open_run().and_then(|run| run.worktree_path.as_deref());
        let path = PathBuf::from(worktree.unwrap_or(&repo.path));
        path.is_dir().then_some(path)
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
}

/// The host's default provider and its providers, as plxd lists them.
async fn read_providers(plxd: &Plxd) -> Result<Loaded, String> {
    let defaults = tokio::time::timeout(
        CALL_TIMEOUT,
        plxd.call::<AccountsDefaultsGet>(AccountsDefaultsGetParams {}),
    )
    .await;
    let backend = match defaults {
        Ok(Ok(defaults)) => match defaults.worker {
            Some(AccountChoice::Subscription { backend }) => Some(backend),
            _ => None,
        },
        _ => None,
    };
    let listed = tokio::time::timeout(
        CALL_TIMEOUT,
        plxd.call::<ProvidersList>(ProvidersListParams { refresh: false }),
    )
    .await
    .map_err(|_| format!("plxd didn't answer providers/list within {CALL_TIMEOUT:?}"))??;
    Ok(Loaded::Providers {
        backend,
        providers: listed.providers,
    })
}

/// The files git sees in the checkout at `folder`, tracked or not but not ignored, and the
/// folders they're in, sorted. Paths come unquoted (`-z`), so names outside ASCII stay as they
/// are.
fn files_in(folder: &Path) -> Vec<String> {
    let listed = std::process::Command::new("git")
        .arg("-C")
        .arg(folder)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(listed) = listed else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&listed.stdout);
    let mut paths = std::collections::BTreeSet::new();
    for file in text
        .split('\0')
        .filter(|file| !file.is_empty())
        .take(MAX_FILES)
    {
        let mut parent = String::new();
        let mut parts: Vec<&str> = file.split('/').collect();
        parts.pop();
        for part in parts {
            parent.push_str(part);
            parent.push('/');
            paths.insert(parent.clone());
        }
        paths.insert(file.to_owned());
    }
    paths.into_iter().collect()
}

/// The top of the git working tree `dir` is in, by git itself, or None outside one.
fn git_top(dir: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let top = String::from_utf8(output.stdout).ok()?;
    PathBuf::from(top.trim_end()).canonicalize().ok()
}

/// `path` with the home folder as `~`.
fn tilde(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.and_then(|home| path.strip_prefix(home).ok().map(Path::to_owned)) {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// How long ago `at` was, as the app's sidebar says it: now, 5m, 2h, 3d.
fn age(now: jiff::Timestamp, at: jiff::Timestamp) -> String {
    let secs = now.duration_since(at).as_secs().max(0);
    match secs {
        0..60 => "now".to_owned(),
        60..3_600 => format!("{}m", secs / 60),
        3_600..86_400 => format!("{}h", secs / 3_600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// What a run of tool calls did, as Claude Code sums one up: "Ran 2 shell commands, edited 1
/// file". Tools are grouped by name across vendors; any other counts as a tool used.
fn summary<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    const KINDS: [(&str, &str, &[&str]); 6] = [
        (
            "ran",
            "shell command",
            &[
                "bash",
                "shell",
                "exec_command",
                "local_shell",
                "command",
                "run_terminal_cmd",
            ],
        ),
        (
            "read",
            "file",
            &["read", "view", "read_file", "notebookread"],
        ),
        (
            "edited",
            "file",
            &[
                "write",
                "edit",
                "multiedit",
                "notebookedit",
                "apply_patch",
                "str_replace",
                "create_file",
                "edit_file",
                "write_file",
            ],
        ),
        (
            "searched",
            "time",
            &[
                "grep",
                "glob",
                "ls",
                "search",
                "find",
                "codebase_search",
                "list_dir",
                "grep_search",
                "file_search",
            ],
        ),
        (
            "fetched",
            "page",
            &["webfetch", "websearch", "web_search", "fetch"],
        ),
        ("updated", "to-do list", &["todowrite", "update_plan"]),
    ];
    let mut counts = [0usize; KINDS.len() + 1];
    for name in names {
        let name = name.to_ascii_lowercase();
        let kind = KINDS
            .iter()
            .position(|(.., names)| names.contains(&name.as_str()));
        counts[kind.unwrap_or(KINDS.len())] += 1;
    }
    let mut parts = Vec::new();
    for (i, &count) in counts.iter().enumerate().filter(|(_, count)| **count > 0) {
        let (verb, noun) = KINDS
            .get(i)
            .map_or(("used", "tool"), |(verb, noun, _)| (*verb, *noun));
        parts.push(match noun {
            "to-do list" => format!("{verb} the to-do list"),
            _ if count == 1 => format!("{verb} 1 {noun}"),
            _ => format!("{verb} {count} {noun}s"),
        });
    }
    let text = parts.join(", ");
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
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
    let mut seen = HashSet::new();
    catalog
        .chain(found)
        .filter(|(id, _)| seen.insert(id.clone()))
        .collect()
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
    use parallax_protocol::{AgentEffort, AgentPermission, ClientInfo, ProviderInfo, Repo};
    use ratatui::crossterm::event::{KeyCode, KeyEvent};

    use super::{App, Draft, age, files_in, summary};
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
    async fn a_new_thread_from_an_empty_sidebar() {
        let mut app = app();
        app.draft = Draft::Here("/tmp".into());
        press(&mut app, &[KeyCode::Left, KeyCode::Char('n')]).await;
        assert!(app.menu.is_none());
        assert_eq!(app.draft, Draft::Chats, "Chats, before plxd made its entry");
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

    #[test]
    fn choices_made_before_providers_arrive_are_fitted_to_them() {
        let codex: ProviderInfo = serde_json::from_value(serde_json::json!({
            "instance": {"id": "codex", "kind": "codex", "name": "Codex", "enabled": true,
                         "args": [], "env": [], "models": []},
            "installed": true, "installing": false, "models": [],
            "permissions": ["edit", "auto"], "efforts": true, "coordinator": false, "loginEnv": [],
        }))
        .unwrap();
        let mut app = app();
        // Shift+Tab to plan mode before the list came, when every mode was offered.
        app.permission = Some(AgentPermission::Plan);
        app.take(super::Loaded::Providers {
            backend: Some("codex".to_owned()),
            providers: vec![codex],
        });
        assert_eq!(app.permission, Some(AgentPermission::Edit));
    }

    #[tokio::test]
    async fn a_model_picked_before_providers_arrive_stays() {
        let codex: ProviderInfo = serde_json::from_value(serde_json::json!({
            "instance": {"id": "codex", "kind": "codex", "name": "Codex", "enabled": true,
                         "args": [], "env": [], "models": []},
            "installed": true, "installing": false, "models": [],
            "permissions": ["edit", "auto"], "efforts": true, "coordinator": false, "loginEnv": [],
        }))
        .unwrap();
        let mut app = app();
        app.model = Some("gpt-6.1-sol".to_owned());
        app.take(super::Loaded::Providers {
            backend: Some("codex".to_owned()),
            providers: vec![codex],
        });
        assert_eq!(app.model.as_deref(), Some("gpt-6.1-sol"));
        // A mode the provider can't run, picked from a list opened before, is refused.
        app.pick(super::Pick::Mode(AgentPermission::Plan)).await;
        assert_eq!(app.permission, None);
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

    #[test]
    fn new_threads_work_in_place_only_in_the_checkout_here() {
        let repo = |id: &str, path: &str, scratch: bool| -> Repo {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": "r", "path": path, "scratch": scratch,
                "createdAt": "2026-10-12T00:00:00Z",
            }))
            .unwrap()
        };
        let (here, other, chats) = (
            "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01",
            "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e02",
            "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e03",
        );
        let mut app = app();
        app.repos = vec![
            repo(here, "/dev/app", false),
            repo(other, "/dev/lib", false),
            repo(chats, "/data/scratch", true),
        ];
        app.here = Some("/dev/app".into());
        let id = |id: &str| Some(id.parse().unwrap());
        assert_eq!(app.draft_for(id(here)), Draft::Here("/dev/app".into()));
        assert_eq!(app.draft_for(id(other)), Draft::Repo(id(other).unwrap()));
        assert_eq!(app.draft_for(id(chats)), Draft::Chats);
        assert_eq!(app.draft_for(None), Draft::Chats);
    }

    #[tokio::test]
    async fn at_offers_files_and_completes_them() {
        let mut app = app();
        app.files = Some((
            "/dev/app".into(),
            vec![
                "daemon/".to_owned(),
                "daemon/src/".to_owned(),
                "daemon/src/tui.rs".to_owned(),
                "daemon/src/threads.rs".to_owned(),
                "README.md".to_owned(),
            ],
        ));
        app.input = "look at @tu".to_owned();
        assert_eq!(app.mentions(), ["daemon/src/tui.rs"]);
        press(&mut app, &[KeyCode::Tab]).await;
        assert_eq!(app.input, "look at @daemon/src/tui.rs ");

        app.input = "@dae".to_owned();
        assert_eq!(
            app.mentions()[0],
            "daemon/",
            "a name that starts with it, shortest first"
        );
        press(&mut app, &[KeyCode::Enter]).await;
        assert_eq!(app.input, "@daemon/", "a folder stays open");

        press(&mut app, &[KeyCode::Esc]).await;
        assert!(app.mentions().is_empty(), "Esc closes the list");
        assert_eq!(app.input, "@daemon/", "and keeps the message");
    }

    #[test]
    fn files_keep_names_outside_ascii() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/café.md"), "").unwrap();
        assert_eq!(files_in(dir.path()), ["docs/", "docs/café.md"]);
    }

    #[test]
    fn tool_runs_sum_up_by_kind() {
        assert_eq!(
            summary(["Bash", "Edit", "Write", "Bash", "Read", "mcp__x__y"]),
            "Ran 2 shell commands, read 1 file, edited 2 files, used 1 tool"
        );
        assert_eq!(summary(["TodoWrite"]), "Updated the to-do list");
    }

    #[test]
    fn ages_read_like_the_sidebar() {
        let now: jiff::Timestamp = "2026-10-12T12:00:00Z".parse().unwrap();
        let ago = |secs: i64| age(now, now - jiff::SignedDuration::from_secs(secs));
        assert_eq!(
            [ago(5), ago(300), ago(7_200), ago(259_200)],
            ["now", "5m", "2h", "3d"]
        );
    }
}
