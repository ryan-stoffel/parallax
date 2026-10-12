//! `plxd tui`: Parallax in a terminal (PLX-740), laid out like Claude Code and Codex: one column
//! with the transcript under a header, the prompt between two rules, and a status line. It is
//! another client of the plxd the app attaches to, so its threads, Spaces, Projects, and messages
//! are the app's, live, both ways.
//!
//! - Threads come from `orchestration/subscribeShell`; ← on an empty prompt or `/threads` lists
//!   them.
//! - The open thread is `orchestration/subscribeThread`, folded by [`transcript`].
//! - A message is `message.dispatch`, queued after the turn under way, carrying any `/model`,
//!   `/effort`, or Shift+Tab change made since the last one, as the app's composer does. The
//!   first message of a new thread is `thread/start`. Esc is `run.interrupt`.
//! - `host/health` every 10 s keeps the connection open and finds one that dropped; its
//!   replacement subscribes again from fresh snapshots.

mod markdown;
mod transcript;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parallax_protocol::methods::{
    AccountsDefaultsGet, AgentApprove, EventsUnsubscribe, HostHealth, OrchestrationDispatch,
    OrchestrationSubscribeShell, OrchestrationSubscribeThread, ProvidersList, ThreadStart,
    ThreadUpdate,
};
use parallax_protocol::{
    AccountChoice, AccountsDefaultsGetParams, AgentApprovalAnswer, AgentApproveParams, AgentEffort,
    AgentPermission, AgentRun, AgentStatus, AgentToolStatus, DispatchMode, EventsEventParams,
    EventsUnsubscribeParams, HostHealthParams, LoggedEvent, OrchestrationCommand, ParallaxEvent,
    Project, ProvidersListParams, Repo, RepoId, RunId, SubscribeShellParams, SubscribeThreadParams,
    SubscriptionId, Thread, ThreadStartParams, ThreadUpdateParams, TurnId,
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

/// How often the screen redraws on its own while a turn runs, for the spinner and its timer.
const FRAME: Duration = Duration::from_millis(120);

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
    ("/threads", "switch threads, Spaces, and Projects (also ←)"),
    (
        "/model",
        "list models, or use the one named from the next message",
    ),
    (
        "/effort",
        "low, medium, high, xhigh, or max, from the next message",
    ),
    ("/stop", "stop the turn under way (also Esc)"),
    ("/clear", "start a new thread, as /new"),
    ("/resume", "switch threads, as /threads"),
    ("/help", "show commands and keys"),
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
    app.load_models().await;
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

/// A row of the thread list.
enum Row {
    /// A repo or Space: Enter starts a thread in it. `None` is the threads with no repo.
    Group { repo: Option<RepoId>, name: String },
    /// A thread, or a Project's coordinator.
    Run { run: RunId, label: String },
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
    /// The backend new threads run on, from the host's defaults.
    default_backend: Option<String>,
    /// Models' names by id, as their providers give them.
    model_names: HashMap<String, String>,
    shell: Option<SubscriptionId>,
    projects: Vec<Project>,
    repos: Vec<Repo>,
    threads: Vec<Thread>,
    runs: HashMap<RunId, AgentRun>,
    open: Option<Open>,
    /// With no thread open, the next message starts one in this repo or Space, or in none.
    draft: Option<RepoId>,
    /// The thread list's selected row, while it shows.
    picker: Option<usize>,
    input: String,
    /// Messages sent from here, oldest first, and the one Up recalled.
    history: Vec<String>,
    recalled: Option<usize>,
    /// What the next message changes: `/model`, `/effort`, Shift+Tab.
    model: Option<String>,
    effort: Option<AgentEffort>,
    permission: Option<AgentPermission>,
    /// The highlighted answer to a permission request.
    choice: usize,
    /// Lines scrolled up from the transcript's end.
    scroll: u16,
    /// A command's answer, shown above the prompt until the next message.
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
            model_names: HashMap::new(),
            shell: None,
            projects: Vec::new(),
            repos: Vec::new(),
            threads: Vec::new(),
            runs: HashMap::new(),
            open: None,
            draft: None,
            picker: None,
            input: String::new(),
            history: Vec::new(),
            recalled: None,
            model: None,
            effort: None,
            permission: None,
            choice: 0,
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
                    if let Err(error) = self.plxd.call::<HostHealth>(HostHealthParams {}).await {
                        self.error = Some(error);
                        self.dirty = true;
                    }
                }
            }
        }
        Ok(())
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
            .plxd
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
                .plxd
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
            .plxd
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
            .plxd
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
        if self.picker.is_some() {
            return self.picker_key(key.code).await;
        }
        if let Some(pending) = self.pending().cloned() {
            return self.approval_key(key.code, &pending).await;
        }
        match key.code {
            KeyCode::Esc if self.working_since.is_some() => self.stop().await,
            KeyCode::Esc => {
                self.input.clear();
                self.notice = None;
            }
            KeyCode::Left if self.input.is_empty() => self.picker = Some(self.selected_row()),
            KeyCode::BackTab => self.cycle_mode(),
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::ALT) => self.input.push('\n'),
            // A trailing backslash continues the message on a new line, as in Claude Code.
            KeyCode::Enter if self.input.ends_with('\\') => {
                self.input.pop();
                self.input.push('\n');
            }
            KeyCode::Enter => self.submit().await,
            KeyCode::Tab if self.input.starts_with('/') => {
                if let Some((name, _)) = self.suggestions().first() {
                    self.input = format!("{name} ");
                }
            }
            KeyCode::Up if !self.input.contains('\n') => self.recall(true),
            KeyCode::Down if !self.input.contains('\n') => self.recall(false),
            KeyCode::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => self.input.push(c),
            _ => {}
        }
    }

    /// Steps through the messages sent from here: older with `back`, newer otherwise.
    fn recall(&mut self, back: bool) {
        let last = self.history.len().checked_sub(1);
        self.recalled = match (self.recalled, back) {
            (None, true) => last,
            (Some(i), true) => Some(i.saturating_sub(1)),
            (Some(i), false) if Some(i) < last => Some(i + 1),
            _ => None,
        };
        self.input = self
            .recalled
            .map(|i| self.history[i].clone())
            .unwrap_or_default();
    }

    fn cycle_mode(&mut self) {
        let now = self.mode();
        let at = MODES.iter().position(|(mode, _)| *mode == now).unwrap_or(0);
        self.permission = Some(MODES[(at + 1) % MODES.len()].0);
    }

    /// The mode the next message runs in.
    fn mode(&self) -> AgentPermission {
        self.permission
            .or_else(|| self.open_run()?.permission)
            .unwrap_or(AgentPermission::Edit)
    }

    async fn picker_key(&mut self, code: KeyCode) {
        let rows = self.rows();
        let Some(selected) = self.picker else { return };
        match code {
            KeyCode::Esc | KeyCode::Left | KeyCode::Right => self.picker = None,
            KeyCode::Up | KeyCode::Char('k') => self.picker = Some(selected.saturating_sub(1)),
            KeyCode::Down | KeyCode::Char('j') => {
                self.picker = Some((selected + 1).min(rows.len().saturating_sub(1)));
            }
            KeyCode::Enter => match rows.get(selected) {
                Some(Row::Run { run, .. }) => {
                    let run = *run;
                    match self.open(run).await {
                        Ok(()) => self.picker = None,
                        Err(error) => self.error = Some(error),
                    }
                }
                Some(Row::Group { repo, .. }) => {
                    let repo = *repo;
                    self.new_thread(repo).await;
                }
                None => {}
            },
            KeyCode::Char('n') => {
                // The selected group's, or the selected thread's.
                let repo = rows
                    .iter()
                    .take(selected + 1)
                    .rev()
                    .find_map(|row| match row {
                        Row::Group { repo, .. } => Some(*repo),
                        Row::Run { .. } => None,
                    })
                    .flatten();
                self.new_thread(repo).await;
            }
            _ => {}
        }
    }

    async fn approval_key(&mut self, code: KeyCode, pending: &Pending) {
        let answers = if pending.always { 3 } else { 2 };
        let answer = match code {
            KeyCode::Up => {
                self.choice = self.choice.saturating_sub(1);
                return;
            }
            KeyCode::Down => {
                self.choice = (self.choice + 1).min(answers - 1);
                return;
            }
            KeyCode::Enter => self.choice,
            KeyCode::Esc => answers - 1,
            KeyCode::Char(c @ '1'..='3') => (c as usize - '1' as usize).min(answers - 1),
            _ => return,
        };
        self.choice = 0;
        let (decision, always) = match (answer, pending.always) {
            (0, _) => (AgentApprovalAnswer::Allow, false),
            (1, true) => (AgentApprovalAnswer::Allow, true),
            _ => (AgentApprovalAnswer::Deny, false),
        };
        let Some(run_id) = self.open.as_ref().map(|open| open.run) else {
            return;
        };
        let answered = self
            .plxd
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

    /// The open thread's oldest permission request.
    fn pending(&self) -> Option<&Pending> {
        self.open.as_ref()?.transcript.pending.first()
    }

    /// Leaves the open thread for a new one in `repo`, which the next message starts.
    async fn new_thread(&mut self, repo: Option<RepoId>) {
        self.close().await;
        self.draft = repo;
        self.picker = None;
    }

    async fn submit(&mut self) {
        let text = self.input.trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.recalled = None;
        if text.starts_with('/') {
            self.input.clear();
            return self.command(&text).await;
        }
        self.notice = None;
        let sent = if let Some(thread_id) = self.open.as_ref().map(|open| open.run) {
            self.dispatch(OrchestrationCommand::MessageDispatch {
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
                account: None,
                dispatch_mode: DispatchMode::QueueAfterActive,
            })
            .await
        } else {
            self.start(self.draft, text.clone()).await
        };
        match sent {
            Ok(()) => {
                self.history.push(text);
                self.input.clear();
                self.scroll = 0;
                (self.model, self.effort, self.permission) = (None, None, None);
            }
            Err(error) => self.error = Some(error),
        }
    }

    async fn command(&mut self, line: &str) {
        let (name, argument) = line.split_once(' ').unwrap_or((line, ""));
        let argument = argument.trim();
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
            "/threads" | "/resume" => self.picker = Some(self.selected_row()),
            "/model" if argument.is_empty() => self.list_models().await,
            "/model" => {
                self.model = Some(argument.to_owned());
                self.notice = Some(format!("Model {argument} from the next message."));
            }
            "/effort" => match serde_json::from_value::<AgentEffort>(argument.into()) {
                Ok(effort) if effort != AgentEffort::Unknown => {
                    self.effort = Some(effort);
                    self.notice = Some(format!("Effort {argument} from the next message."));
                }
                _ => self.error = Some("effort is low, medium, high, xhigh, or max".to_owned()),
            },
            "/stop" => self.stop().await,
            "/help" => {
                let mut help: Vec<String> = COMMANDS
                    .iter()
                    .map(|(name, what)| format!("{name:<10} {what}"))
                    .collect();
                help.push(String::new());
                help.push(
                    "Shift+Tab mode · \\ or Alt+Enter new line · ↑↓ history · PgUp/PgDn scroll"
                        .to_owned(),
                );
                self.notice = Some(help.join("\n"));
            }
            "/quit" | "/exit" => self.done = true,
            _ => self.error = Some(format!("{name} isn't a command; /help lists them")),
        }
    }

    /// Lists the models of the open thread's backend, or of every signed-in one.
    async fn list_models(&mut self) {
        let listed = self
            .plxd
            .call::<ProvidersList>(ProvidersListParams { refresh: false })
            .await;
        let providers = match listed {
            Ok(listed) => listed.providers,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let backend = self.open_run().map(|run| run.backend.clone());
        let lines: Vec<String> = providers
            .iter()
            .filter(|provider| match &backend {
                Some(backend) => provider.instance.id == *backend,
                None => provider.signed_in == Some(true),
            })
            .flat_map(|provider| {
                provider
                    .models
                    .iter()
                    .map(move |model| format!("{:<12} {}", provider.instance.id, model.id))
            })
            .collect();
        self.notice = Some(if lines.is_empty() {
            "No models listed. /model <id> still sends one.".to_owned()
        } else {
            format!("{}\n\n/model <id> to use one.", lines.join("\n"))
        });
    }

    /// Starts a thread with the host's defaults and the changes made here, asking here before
    /// tools run, as the app's threads do.
    async fn start(&mut self, repo: Option<RepoId>, prompt: String) -> Result<(), String> {
        let started = self
            .plxd
            .call::<ThreadStart>(ThreadStartParams {
                run_id: RunId::generate(),
                repo,
                project: None,
                parent: None,
                notify: None,
                title: None,
                prompt,
                account: None,
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
        if let Err(error) = self.dispatch(command).await {
            self.error = Some(error);
        }
    }

    async fn dispatch(&self, command: OrchestrationCommand) -> Result<(), String> {
        self.plxd
            .call::<OrchestrationDispatch>(command)
            .await
            .map(drop)
    }

    /// The thread list: each Project's coordinator, then each repo and Space with its threads,
    /// newest first.
    fn rows(&self) -> Vec<Row> {
        let mut rows: Vec<Row> = self
            .projects
            .iter()
            .filter_map(|project| {
                Some(Row::Run {
                    run: project.coordinator?,
                    label: format!("◆ {}", project.name),
                })
            })
            .collect();
        for repo in &self.repos {
            let mut threads: Vec<&Thread> = self
                .threads
                .iter()
                .filter(|thread| thread.repo == repo.id && !thread.archived)
                .collect();
            threads.sort_by_key(|thread| {
                std::cmp::Reverse(thread.last_prompt_at.unwrap_or(thread.created_at))
            });
            rows.push(Row::Group {
                repo: (!repo.scratch).then_some(repo.id),
                name: group_name(repo),
            });
            rows.extend(threads.into_iter().map(|thread| Row::Run {
                run: thread.id,
                label: self.title(thread.id),
            }));
        }
        rows
    }

    /// The thread list's row for the open thread, or the first.
    fn selected_row(&self) -> usize {
        let open = self.open.as_ref().map(|open| open.run);
        self.rows()
            .iter()
            .position(|row| matches!(row, Row::Run { run, .. } if Some(*run) == open))
            .unwrap_or(0)
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

    fn working(&self, run: RunId) -> bool {
        self.runs.get(&run).is_some_and(|run| {
            matches!(
                run.status,
                AgentStatus::Starting | AgentStatus::Running | AgentStatus::Waiting
            )
        })
    }

    /// The slash commands that start with what's typed.
    fn suggestions(&self) -> Vec<(&'static str, &'static str)> {
        if !self.input.starts_with('/') || self.input.contains(' ') {
            return Vec::new();
        }
        COMMANDS
            .iter()
            .filter(|(name, _)| name.starts_with(self.input.as_str()))
            .copied()
            .collect()
    }

    /// Reads the host's default backend and its models' names. Without them, models show by id.
    async fn load_models(&mut self) {
        let defaults = self
            .plxd
            .call::<AccountsDefaultsGet>(AccountsDefaultsGetParams {})
            .await;
        if let Ok(defaults) = defaults
            && let Some(AccountChoice::Subscription { backend }) = defaults.worker
        {
            self.default_backend = Some(backend);
        }
        let listed = self
            .plxd
            .call::<ProvidersList>(ProvidersListParams { refresh: false })
            .await;
        if let Ok(listed) = listed {
            self.model_names = listed
                .providers
                .into_iter()
                .flat_map(|provider| provider.models)
                .map(|model| (model.id, model.name))
                .collect();
        }
    }

    /// The model the next message runs on, by its provider's name for it: a `/model` change,
    /// the thread's own, or the one its session last reported. Otherwise the backend's default.
    fn model_label(&self) -> String {
        let id = self
            .model
            .clone()
            .or_else(|| self.open_run()?.model.clone())
            .or_else(|| self.open.as_ref()?.transcript.model.clone());
        match id {
            Some(id) => self.model_names.get(&id).cloned().unwrap_or(id),
            None => format!("{} default model", self.backend().unwrap_or("host")),
        }
    }

    /// The open thread's backend, or the one new threads run on.
    fn backend(&self) -> Option<&str> {
        self.open_run()
            .map(|run| run.backend.as_str())
            .or(self.default_backend.as_deref())
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
        let below = if suggestions.is_empty() {
            2
        } else {
            suggestions.len()
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
        match self.picker {
            Some(selected) => self.draw_picker(frame, body, selected),
            None => self.draw_transcript(frame, body),
        }
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
        if suggestions.is_empty() {
            self.draw_footer(frame, footer);
        } else {
            let lines: Vec<Line> = suggestions
                .into_iter()
                .map(|(name, what)| {
                    Line::from(vec![
                        Span::from(format!("{name:<10} ")).fg(BLUE),
                        Span::from(what).dark_gray(),
                    ])
                })
                .collect();
            frame.render_widget(Paragraph::new(lines), footer);
        }
    }

    /// The header: the mark beside the version, the model, the account and mode, and where the
    /// thread works.
    fn header(&self) -> Vec<Line<'static>> {
        let account = self
            .open_run()
            .map(|run| run.account_id.clone())
            .or_else(|| self.default_backend.clone())
            .unwrap_or_else(|| "host defaults".to_owned());
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
            vec![Span::from(format!("{account} · {}", mode_name(self.mode()))).dark_gray()],
            vec![Span::from(format!("{} › {title}", self.place())).dark_gray()],
            vec![Span::from("/help for commands · ← for threads").dark_gray()],
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

    fn draw_picker(&self, frame: &mut Frame, area: Rect, selected: usize) {
        let mut lines = vec![
            Line::from(vec![
                Span::from("Threads  ").bold(),
                Span::from("↑↓ select · enter open · n new here · esc back").dark_gray(),
            ]),
            Line::default(),
        ];
        for (i, row) in self.rows().into_iter().enumerate() {
            let pointer = Span::from(if i == selected { "❯ " } else { "  " }).fg(BLUE);
            let line = match row {
                Row::Group { name, .. } => Line::from(vec![pointer, Span::from(name).bold()]),
                Row::Run { run, label } => {
                    let mut spans = vec![pointer, Span::from(format!("  {label}"))];
                    if self.working(run) {
                        spans.push(Span::from("  ● working").fg(CORAL));
                    }
                    if self.open.as_ref().is_some_and(|open| open.run == run) {
                        spans.push(Span::from("  (open)").dark_gray());
                    }
                    Line::from(spans)
                }
            };
            lines.push(if i == selected { line.bold() } else { line });
        }
        // Keeps the selected row on screen.
        let skip = (selected + 3).saturating_sub(usize::from(area.height));
        let shown: Vec<Line> = lines.into_iter().skip(skip).collect();
        frame.render_widget(Paragraph::new(shown), area);
    }

    /// Above the prompt: what the next message changes on the left, the effort on the right.
    fn draw_meta(&self, frame: &mut Frame, area: Rect) {
        let changes: Vec<String> = [
            self.model.as_ref().map(|model| format!("model {model}")),
            self.effort
                .map(|effort| format!("effort {}", effort_name(effort))),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !changes.is_empty() {
            let left = format!("next message: {}", changes.join(" · "));
            frame.render_widget(Paragraph::new(left).dark_gray(), area);
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
            lines.push(if i == self.choice {
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
        let first = Line::from(vec![
            Span::from(self.model_label()).bold(),
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
        let name = mode_name(self.mode());
        let second = if self.quitting {
            Line::from("Press Ctrl-C again to exit").dark_gray()
        } else {
            Line::from(vec![
                Span::from(format!("▸▸ {name} on ")).fg(CORAL),
                Span::from("(shift+tab to cycle) · ← for threads").dark_gray(),
            ])
        };
        frame.render_widget(Paragraph::new(vec![first, second]), area);
    }
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
