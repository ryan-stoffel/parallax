//! Agents' browser tabs (PLX-639): T3 Code's `preview_*` tools, run in plxd's headless browser
//! ([`crate::browser`]).
//!
//! - **Tabs** are keyed by thread (its run) and tab id. A thread's `plxd mcp` sends each tool call
//!   here with `preview/call`, and a thread acts only on its own tabs. One browser serves every
//!   tab, started with the first and stopped with the last, with one profile for plxd's lifetime.
//! - **Network**: the browser goes out through [`crate::public_proxy`], which reaches public
//!   addresses and this host's loopback, for the thread's dev servers, but never its networks,
//!   cloud metadata, or this host's other addresses. WebRTC is off.
//! - **Watching**: each tab screencasts JPEG frames, which the app's side panel long-polls with
//!   `preview/frame`. The user's mouse, wheel, and keys come back with `preview/input`; the first
//!   one takes control of the tab, and the agent's actions are refused until the user hands it
//!   back, as in T3.
//! - **Targets**: a `locator` is `aria-ref=<ref>` from the latest `preview_snapshot`,
//!   `role=<role>[name='…']`, `text=…`, or a CSS selector; `selector` is CSS. It must match one
//!   element. Actions go through real input events at the element's center.
//! - **Recording** draws the screencast's frames onto a canvas in a second page and records it
//!   with `MediaRecorder`, as T3 does. Stopping keeps the `WebM` with the run's images, for the
//!   transcript, and writes it to a file the agent can read.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    PreviewCallParams, PreviewCallResult, PreviewFrameParams, PreviewFrameResult, PreviewInput,
    PreviewInputParams, PreviewInputResult, PreviewListParams, PreviewListResult, PreviewMouse,
    PreviewTab, RunId,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::backend::process::Launcher;
use crate::browser::{self, Browser, Event, Page};

/// How long `preview/frame` waits for a new frame before answering with the last one.
const FRAME_WAIT: Duration = Duration::from_secs(10);
/// How long a tab counts as watched after the app last asked for a frame.
const WATCHED_FOR: Duration = Duration::from_secs(5);
/// The viewport of a tab in fill mode until the app shows it, and the screencast's largest frame.
const FILL: (u32, u32) = (1280, 800);
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
/// The most console and network entries a tab keeps, and a snapshot shows.
const MAX_ENTRIES: usize = 100;
const SNAPSHOT_ENTRIES: usize = 20;
/// About how much text a snapshot carries.
const MAX_SNAPSHOT_BYTES: usize = 20 * 1024;
const MAX_EVALUATE_BYTES: usize = 64 * 1024;
/// The largest recording, as base64: it travels in one plxd frame (8 MiB).
const MAX_RECORDING_BASE64: usize = 7 * 1024 * 1024;

/// Every thread's tabs, and the browser they run in.
pub(crate) struct Previews {
    launcher: Launcher,
    state: tokio::sync::Mutex<State>,
}

#[derive(Default)]
struct State {
    browser: Option<Browser>,
    tabs: Vec<Arc<Tab>>,
    /// The last tab number given out.
    numbered: u32,
    /// Each thread's current tab: the one it opened or used last.
    current: HashMap<RunId, String>,
}

struct Tab {
    run: RunId,
    id: String,
    page: Page,
    live: Arc<Mutex<Live>>,
    frames: watch::Receiver<Frame>,
    /// Held while an agent's action runs, so a thread's actions on a tab go one at a time.
    acting: tokio::sync::Mutex<()>,
}

/// What a tab's events have told plxd so far.
#[derive(Default)]
struct Live {
    url: String,
    title: String,
    loading: bool,
    /// Whether the user controls the tab, and how often control has changed hands.
    human: bool,
    generation: u64,
    watched: Option<Instant>,
    console: VecDeque<Value>,
    network: VecDeque<Value>,
    timeline: VecDeque<Value>,
    dialog: Option<Value>,
    /// The file picker the page opened: its input's node and whether it takes several files.
    chooser: Option<(u64, bool)>,
    setting: Value,
    viewport: (u32, u32),
    /// Where the app last showed the tab, which fill mode follows.
    panel: Option<(u32, u32)>,
    color_scheme: &'static str,
    recording: Option<Recording>,
}

struct Recording {
    encoder: Page,
    started: Timestamp,
}

#[derive(Clone, Default)]
struct Frame {
    seq: u64,
    data: Arc<String>,
    width: u32,
    height: u32,
}

fn lock(live: &Mutex<Live>) -> MutexGuard<'_, Live> {
    live.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Previews {
    pub(crate) fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            state: tokio::sync::Mutex::default(),
        }
    }

    /// `preview/list`: a thread's tabs.
    pub(crate) async fn list(&self, params: PreviewListParams) -> PreviewListResult {
        let state = self.state.lock().await;
        PreviewListResult {
            tabs: state
                .tabs
                .iter()
                .filter(|tab| tab.run == params.run_id)
                .map(|tab| tab.summary())
                .collect(),
        }
    }

    async fn tab(&self, run: RunId, id: Option<&str>) -> Result<Arc<Tab>, String> {
        let state = self.state.lock().await;
        let id = id.or_else(|| state.current.get(&run).map(String::as_str));
        let Some(id) = id else {
            return Err("This thread has no browser tab. Open one with preview_open.".to_owned());
        };
        state
            .tabs
            .iter()
            .find(|tab| tab.run == run && tab.id == id)
            .cloned()
            .ok_or_else(|| format!("This thread has no browser tab {id:?}. See preview_status."))
    }

    /// `preview/frame`: the tab's newest frame after `after`, waiting up to [`FRAME_WAIT`].
    pub(crate) async fn frame(
        &self,
        params: PreviewFrameParams,
    ) -> Result<PreviewFrameResult, ErrorObject> {
        let tab = self
            .tab(params.run_id, Some(&params.tab_id))
            .await
            .map_err(ErrorObject::invalid_params)?;
        lock(&tab.live).watched = Some(Instant::now());
        let mut frames = tab.frames.clone();
        let _ = tokio::time::timeout(
            FRAME_WAIT,
            frames.wait_for(|frame| frame.seq > params.after),
        )
        .await;
        let frame = frames.borrow().clone();
        Ok(PreviewFrameResult {
            seq: frame.seq,
            data: (*frame.data).clone(),
            width: frame.width,
            height: frame.height,
            tab: tab.summary(),
        })
    }

    /// `preview/input`: the user's control, mouse, wheel, keys, or address bar. Anything but
    /// handing control back takes control first.
    pub(crate) async fn input(
        &self,
        params: PreviewInputParams,
    ) -> Result<PreviewInputResult, ErrorObject> {
        let tab = self
            .tab(params.run_id, Some(&params.tab_id))
            .await
            .map_err(ErrorObject::invalid_params)?;
        let take = !matches!(
            params.input,
            PreviewInput::Control { take: false } | PreviewInput::Viewport { .. }
        );
        {
            let mut live = lock(&tab.live);
            if live.human != take {
                live.human = take;
                live.generation += 1;
            }
        }
        let page = &tab.page;
        let done = match params.input {
            PreviewInput::Control { .. } => Ok(Value::Null),
            PreviewInput::Viewport { width, height } => {
                tab.fill(width, height).await.map(|()| Value::Null)
            }
            PreviewInput::Mouse {
                event,
                x,
                y,
                button,
                click_count,
                modifiers,
            } => {
                let kind = match event {
                    PreviewMouse::Down => "mousePressed",
                    PreviewMouse::Up => "mouseReleased",
                    PreviewMouse::Move => "mouseMoved",
                };
                page.call(
                    "Input.dispatchMouseEvent",
                    json!({"type": kind, "x": x, "y": y, "button": button.as_deref().unwrap_or("none"), "clickCount": click_count.unwrap_or(0), "modifiers": modifiers}),
                )
                .await
            }
            PreviewInput::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                page.call(
                    "Input.dispatchMouseEvent",
                    json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y}),
                )
                .await
            }
            PreviewInput::Key {
                down,
                key,
                code,
                text,
                modifiers,
            } => {
                let (_, code_default, key_code, _) = key_info(&key);
                let mut event = json!({
                    "type": if down { if text.is_some() { "keyDown" } else { "rawKeyDown" } } else { "keyUp" },
                    "key": key,
                    "code": code.unwrap_or(code_default),
                    "windowsVirtualKeyCode": key_code,
                    "modifiers": modifiers,
                });
                if let (true, Some(text)) = (down, text) {
                    event["text"] = text.into();
                }
                page.call("Input.dispatchKeyEvent", event).await
            }
            PreviewInput::Navigate { url } => match normalize_url(&url) {
                Ok(url) => page.call("Page.navigate", json!({"url": url})).await,
                Err(error) => Err(error),
            },
        };
        done.map(|_| PreviewInputResult {})
            .map_err(ErrorObject::invalid_params)
    }

    /// `preview/call`: one of a thread's `preview_*` tools, from its `plxd mcp`.
    pub(crate) async fn call(
        &self,
        daemon: &Arc<crate::server::Daemon>,
        params: PreviewCallParams,
    ) -> PreviewCallResult {
        let PreviewCallParams {
            run_id,
            tool,
            arguments,
        } = params;
        match self.run_tool(daemon, run_id, &tool, arguments).await {
            Ok((text, image)) => PreviewCallResult {
                text,
                image,
                error: false,
            },
            Err(text) => PreviewCallResult {
                text,
                image: None,
                error: true,
            },
        }
    }

    async fn run_tool(
        &self,
        daemon: &Arc<crate::server::Daemon>,
        run: RunId,
        tool: &str,
        arguments: Value,
    ) -> Result<(String, Option<String>), String> {
        let target: Target = parse(arguments.clone())?;
        match tool {
            "preview_open" => {
                return self
                    .open(run, parse(arguments)?)
                    .await
                    .map(|value| text(&value));
            }
            "preview_list" => {
                let args: ListArgs = parse(arguments)?;
                let tabs = self.list(PreviewListParams { run_id: run }).await.tabs;
                let start = args.cursor.unwrap_or(0);
                let end = start.saturating_add(args.limit.unwrap_or(20).clamp(1, 50));
                return Ok(text(&json!({
                    "sessions": tabs.iter().skip(start).take(end - start).collect::<Vec<_>>(),
                    "nextCursor": (end < tabs.len()).then_some(end),
                })));
            }
            "preview_close" => {
                let args: CloseArgs = parse(arguments)?;
                return self
                    .close(run, &args.tab_id)
                    .await
                    .map(|()| text(&json!({})));
            }
            _ => {}
        }
        let tab = self.tab(run, target.tab_id.as_deref()).await?;
        self.state.lock().await.current.insert(run, tab.id.clone());
        // Reading never needs control; acting does.
        if !matches!(tool, "preview_status" | "preview_snapshot") && lock(&tab.live).human {
            return Err("The user controls this tab now. Wait for them to hand it back, or work in another tab with preview_open reuseExistingTab=false.".to_owned());
        }
        let _acting = tab.acting.lock().await;
        let started = Timestamp::now();
        let done = tab.act(daemon, tool, arguments).await;
        if !matches!(tool, "preview_status" | "preview_snapshot") {
            let mut live = lock(&tab.live);
            if live.timeline.len() == MAX_ENTRIES {
                live.timeline.pop_front();
            }
            let mut event = json!({
                "id": format!("a{}", started.as_millisecond()),
                "action": tool.trim_start_matches("preview_"),
                "status": if done.is_ok() { "succeeded" } else { "failed" },
                "startedAt": started.to_string(),
                "completedAt": Timestamp::now().to_string(),
            });
            if let Err(error) = &done {
                event["error"] = error.as_str().into();
            }
            live.timeline.push_back(event);
        }
        if tool == "preview_status" {
            let mut status = done?.0;
            let state = self.state.lock().await;
            status["tabs"] = state
                .tabs
                .iter()
                .filter(|other| other.run == run)
                .map(|other| {
                    let live = lock(&other.live);
                    json!({
                        "tabId": other.id,
                        "url": live.url,
                        "owner": if live.human { "human" } else { "agent" },
                        "ownedByCaller": true,
                        "visible": live.watched.is_some_and(|at| at.elapsed() < WATCHED_FOR),
                    })
                })
                .collect();
            return Ok((pretty(&status), None));
        }
        done.map(|(value, image)| (pretty(&value), image))
    }

    async fn open(&self, run: RunId, args: OpenArgs) -> Result<Value, String> {
        let reuse = args.reuse_existing_tab.unwrap_or(true);
        if args.tab_id.is_some() && !reuse {
            return Err("tabId cannot be combined with reuseExistingTab=false.".to_owned());
        }
        let url = args.url.as_deref().map(normalize_url).transpose()?;
        let existing = if reuse {
            self.tab(run, args.tab_id.as_deref()).await.ok()
        } else {
            None
        };
        if existing.is_none() && args.tab_id.is_some() {
            return Err(format!("This thread has no browser tab {:?}.", args.tab_id));
        }
        let tab = match existing {
            Some(tab) => tab,
            None => self.new_tab(run).await?,
        };
        self.state.lock().await.current.insert(run, tab.id.clone());
        if let Some(url) = url {
            tab.navigate(&url, "load", DEFAULT_TIMEOUT_MS).await?;
        }
        tab.status().await
    }

    async fn new_tab(&self, run: RunId) -> Result<Arc<Tab>, String> {
        let mut state = self.state.lock().await;
        let browser = match &state.browser {
            Some(browser) if !browser.closed() => browser.clone(),
            _ => {
                let executable = browser::executable(&self.launcher).await?;
                // Tabs reach public addresses and this host's loopback, for the thread's own dev
                // servers, never its networks.
                let browser = Browser::launch(&self.launcher, &executable, &[], true).await?;
                state.browser = Some(browser.clone());
                browser
            }
        };
        state.numbered += 1;
        let id = format!("tab-{}", state.numbered);
        let mut page = browser.page().await?;
        for method in ["Page.enable", "Runtime.enable", "Network.enable"] {
            page.call(method, json!({})).await?;
        }
        page.call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": crate::mcp::html::NO_WEBRTC, "runImmediately": true}),
        )
        .await?;
        page.call(
            "Page.setInterceptFileChooserDialog",
            json!({"enabled": true}),
        )
        .await?;
        page.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width": FILL.0, "height": FILL.1, "deviceScaleFactor": 1, "mobile": false}),
        )
        .await?;
        // ponytail: a tab screencasts and stays open until preview_close or plxd exits; stop
        // the screencast while nobody watches or records, and close idle tabs, if memory or CPU
        // show it.
        page.call(
            "Page.startScreencast",
            json!({"format": "jpeg", "quality": 70, "maxWidth": FILL.0, "maxHeight": FILL.0}),
        )
        .await?;
        let live = Arc::new(Mutex::new(Live {
            url: "about:blank".to_owned(),
            setting: json!({"mode": "fill"}),
            viewport: FILL,
            color_scheme: "system",
            ..Live::default()
        }));
        let (frames_tx, frames) = watch::channel(Frame::default());
        let events = std::mem::replace(&mut page.events, mpsc::unbounded_channel().1);
        tokio::spawn(watch_tab(
            page.browser.clone(),
            page.session.clone(),
            page.target.clone(),
            events,
            Arc::clone(&live),
            frames_tx,
        ));
        let tab = Arc::new(Tab {
            run,
            id,
            page,
            live,
            frames,
            acting: tokio::sync::Mutex::new(()),
        });
        state.tabs.push(Arc::clone(&tab));
        Ok(tab)
    }

    async fn close(&self, run: RunId, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let before = state.tabs.len();
        state.tabs.retain(|tab| !(tab.run == run && tab.id == id));
        if state.tabs.len() == before {
            return Err(format!("This thread has no browser tab {id:?}."));
        }
        if state.current.get(&run).is_some_and(|current| current == id) {
            let next = state
                .tabs
                .iter()
                .rfind(|tab| tab.run == run)
                .map(|tab| tab.id.clone());
            match next {
                Some(next) => state.current.insert(run, next),
                None => state.current.remove(&run),
            };
        }
        // The browser stops with its last tab.
        if state.tabs.is_empty() {
            state.browser = None;
        }
        Ok(())
    }
}

impl Tab {
    /// Sizes the viewport to where the app shows the tab, while the tab is in fill mode.
    async fn fill(&self, width: u32, height: u32) -> Result<(), String> {
        let (width, height) = (width.clamp(200, 4096), height.clamp(200, 4096));
        {
            let mut live = lock(&self.live);
            live.panel = Some((width, height));
            if live.setting["mode"] != "fill" || live.viewport == (width, height) {
                return Ok(());
            }
            live.viewport = (width, height);
        }
        self.page
            .call(
                "Emulation.setDeviceMetricsOverride",
                json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}),
            )
            .await
            .map(|_| ())
    }

    fn summary(&self) -> PreviewTab {
        let live = lock(&self.live);
        PreviewTab {
            tab_id: self.id.clone(),
            url: live.url.clone(),
            title: live.title.clone(),
            loading: live.loading,
            human: live.human,
            recording: live.recording.is_some(),
        }
    }

    async fn status(&self) -> Result<Value, String> {
        let info = self
            .page
            .browser
            .call(
                "Target.getTargetInfo",
                json!({"targetId": self.page.target}),
                None,
            )
            .await
            .unwrap_or_default();
        let mut live = lock(&self.live);
        if let Some(title) = info["targetInfo"]["title"].as_str() {
            title.clone_into(&mut live.title);
        }
        Ok(json!({
            "available": true,
            "visible": live.watched.is_some_and(|at| at.elapsed() < WATCHED_FOR),
            "tabId": self.id,
            "url": live.url,
            "title": live.title,
            "loading": live.loading,
            "control": {
                "owner": if live.human { "human" } else { "agent" },
                "ownedByCaller": true,
                "generation": live.generation,
            },
            "dialog": live.dialog,
            "viewportSetting": live.setting,
            "viewport": {"width": live.viewport.0, "height": live.viewport.1},
            "fileChooser": live.chooser.map(|(_, multiple)| json!({"multiple": multiple, "accept": ""})),
        }))
    }

    /// Runs one tool on this tab: its result, and an image for the model when it has one.
    #[expect(clippy::too_many_lines, reason = "one arm per tool, read side by side")]
    async fn act(
        &self,
        daemon: &Arc<crate::server::Daemon>,
        tool: &str,
        arguments: Value,
    ) -> Result<(Value, Option<String>), String> {
        let ok = || Ok((json!({}), None));
        match tool {
            "preview_status" => Ok((self.status().await?, None)),
            "preview_navigate" => {
                let args: NavigateArgs = parse(arguments)?;
                let url = match (args.url, args.target) {
                    (Some(url), None) => normalize_url(&url)?,
                    (None, Some(target)) => target.url()?,
                    _ => return Err("Provide exactly one of url or target.".to_owned()),
                };
                let readiness = args.readiness.as_deref().unwrap_or("load");
                self.navigate(&url, readiness, timeout(args.timeout_ms))
                    .await?;
                Ok((self.status().await?, None))
            }
            "preview_resize" => {
                let args: ResizeArgs = parse(arguments)?;
                let (setting, (width, height)) = args.resolve()?;
                let (width, height) = match lock(&self.live).panel {
                    Some(panel) if setting["mode"] == "fill" => panel,
                    _ => (width, height),
                };
                self.page
                    .call(
                        "Emulation.setDeviceMetricsOverride",
                        json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": setting["mode"] == "preset"}),
                    )
                    .await?;
                let mut live = lock(&self.live);
                live.setting = setting.clone();
                live.viewport = (width, height);
                Ok((
                    json!({"tabId": self.id, "setting": setting, "viewport": {"width": width, "height": height}}),
                    None,
                ))
            }
            "preview_set_appearance" => {
                let args: AppearanceArgs = parse(arguments)?;
                let scheme = match args.color_scheme.as_str() {
                    "light" => "light",
                    "dark" => "dark",
                    "system" => "system",
                    other => {
                        return Err(format!(
                            "colorScheme must be light, dark, or system, not {other:?}"
                        ));
                    }
                };
                let features = if scheme == "system" {
                    json!([])
                } else {
                    json!([{"name": "prefers-color-scheme", "value": scheme}])
                };
                self.page
                    .call("Emulation.setEmulatedMedia", json!({"features": features}))
                    .await?;
                lock(&self.live).color_scheme = scheme;
                Ok((json!({"tabId": self.id, "colorScheme": scheme}), None))
            }
            "preview_snapshot" => self.snapshot(parse(arguments)?).await,
            "preview_click" => {
                let args: ClickArgs = parse(arguments)?;
                let (x, y) = self.point(&args.target).await?;
                let button = args.button.as_deref().unwrap_or("left");
                let count = args.click_count.unwrap_or(1).clamp(1, 3);
                self.mouse("mouseMoved", x, y, "none", 0).await?;
                self.mouse("mousePressed", x, y, button, count).await?;
                self.mouse("mouseReleased", x, y, button, count).await?;
                ok()
            }
            "preview_hover" => {
                let args: PointerArgs = parse(arguments)?;
                let (x, y) = self.point(&args).await?;
                self.mouse("mouseMoved", x, y, "none", 0).await?;
                ok()
            }
            "preview_drag" => {
                let args: DragArgs = parse(arguments)?;
                let (from, to) = (
                    self.point(&PointerArgs::locator(args.source)).await?,
                    self.point(&PointerArgs::locator(args.target)).await?,
                );
                self.mouse("mouseMoved", from.0, from.1, "none", 0).await?;
                self.mouse("mousePressed", from.0, from.1, "left", 1)
                    .await?;
                for step in 1..=10 {
                    let t = f64::from(step) / 10.0;
                    let (x, y) = (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
                    self.mouse("mouseMoved", x, y, "left", 0).await?;
                }
                self.mouse("mouseReleased", to.0, to.1, "left", 1).await?;
                ok()
            }
            "preview_type" => {
                let args: TypeArgs = parse(arguments)?;
                if args.locator.is_some() || args.selector.is_some() {
                    let target = PointerArgs {
                        locator: args.locator,
                        selector: args.selector,
                        ..PointerArgs::default()
                    };
                    let (x, y) = self.point(&target).await?;
                    self.mouse("mousePressed", x, y, "left", 1).await?;
                    self.mouse("mouseReleased", x, y, "left", 1).await?;
                }
                if args.clear.unwrap_or(false) {
                    self.eval("(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); else document.execCommand('selectAll'); })()")
                        .await?;
                    self.page
                        .call("Input.dispatchKeyEvent", json!({"type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}))
                        .await?;
                    self.page
                        .call("Input.dispatchKeyEvent", json!({"type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}))
                        .await?;
                }
                self.page
                    .call("Input.insertText", json!({"text": args.text}))
                    .await?;
                ok()
            }
            "preview_press" => {
                let args: PressArgs = parse(arguments)?;
                let modifiers: u8 = args.modifiers.iter().fold(0, |bits, modifier| {
                    bits | match modifier.as_str() {
                        "Alt" => 1,
                        "Control" => 2,
                        "Meta" => 4,
                        "Shift" => 8,
                        _ => 0,
                    }
                });
                let (key, code, key_code, text) = key_info(&args.key);
                // A shortcut types nothing.
                let text = text.filter(|_| modifiers.trailing_zeros() >= 3);
                let mut down = json!({"type": if text.is_some() { "keyDown" } else { "rawKeyDown" }, "key": key, "code": code, "windowsVirtualKeyCode": key_code, "modifiers": modifiers});
                if let Some(text) = text {
                    down["text"] = text.into();
                }
                self.page.call("Input.dispatchKeyEvent", down).await?;
                self.page
                    .call(
                        "Input.dispatchKeyEvent",
                        json!({"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": key_code, "modifiers": modifiers}),
                    )
                    .await?;
                ok()
            }
            "preview_scroll" => {
                let args: ScrollArgs = parse(arguments)?;
                if args.delta_x.is_none() && args.delta_y.is_none() {
                    return Err("Provide deltaX or deltaY.".to_owned());
                }
                let (x, y) = if args.target.locator.is_some() || args.target.selector.is_some() {
                    self.point(&args.target).await?
                } else {
                    let (width, height) = lock(&self.live).viewport;
                    (f64::from(width) / 2.0, f64::from(height) / 2.0)
                };
                self.page
                    .call(
                        "Input.dispatchMouseEvent",
                        json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": args.delta_x.unwrap_or(0.0), "deltaY": args.delta_y.unwrap_or(0.0)}),
                    )
                    .await?;
                ok()
            }
            "preview_select" => {
                let args: SelectArgs = parse(arguments)?;
                let find = find_expression(args.locator.as_deref(), args.selector.as_deref());
                let selected = self
                    .eval(&format!(
                        "(() => {{ const el = {find}; if (el.tagName !== 'SELECT') throw new Error('That is not a <select>; click custom dropdowns open and click the option.'); const want = {values}; for (const o of el.options) o.selected = want.includes(o.value) || want.includes(o.label.trim()); el.dispatchEvent(new Event('input', {{bubbles: true}})); el.dispatchEvent(new Event('change', {{bubbles: true}})); return [...el.selectedOptions].map(o => o.value); }})()",
                        values = json!(args.values),
                    ))
                    .await?;
                Ok((json!({"selected": selected}), None))
            }
            "preview_upload" => {
                let args: UploadArgs = parse(arguments)?;
                if args.locator.is_some() || args.selector.is_some() {
                    let find = find_expression(args.locator.as_deref(), args.selector.as_deref());
                    let found = self
                        .page
                        .call("Runtime.evaluate", json!({"expression": find}))
                        .await?;
                    let object = found["result"]["objectId"]
                        .as_str()
                        .ok_or("Nothing matches that locator.")?;
                    self.page
                        .call(
                            "DOM.setFileInputFiles",
                            json!({"files": args.paths, "objectId": object}),
                        )
                        .await?;
                } else {
                    let Some((node, _)) = lock(&self.live).chooser.take() else {
                        return Err("No file picker is open. Click the upload control first, or pass a locator for the <input type=file>.".to_owned());
                    };
                    self.page
                        .call(
                            "DOM.setFileInputFiles",
                            json!({"files": args.paths, "backendNodeId": node}),
                        )
                        .await?;
                }
                ok()
            }
            "preview_dialog" => {
                let args: DialogArgs = parse(arguments)?;
                let mut params = json!({"accept": args.accept});
                if let Some(text) = args.prompt_text {
                    params["promptText"] = text.into();
                }
                self.page
                    .call("Page.handleJavaScriptDialog", params)
                    .await?;
                lock(&self.live).dialog = None;
                Ok((self.status().await?, None))
            }
            "preview_evaluate" => {
                let args: EvaluateArgs = parse(arguments)?;
                let evaluated = self
                    .page
                    .call(
                        "Runtime.evaluate",
                        json!({"expression": args.expression, "awaitPromise": args.await_promise.unwrap_or(true), "returnByValue": args.return_by_value.unwrap_or(true)}),
                    )
                    .await?;
                if let Some(error) = exception(&evaluated) {
                    return Err(error);
                }
                let value = evaluated["result"]["value"].clone();
                if value.to_string().len() > MAX_EVALUATE_BYTES {
                    return Err(format!(
                        "The value is over {} KB; return less.",
                        MAX_EVALUATE_BYTES / 1024
                    ));
                }
                Ok((json!({"value": value}), None))
            }
            "preview_wait_for" => {
                let args: WaitArgs = parse(arguments)?;
                let mut checks = Vec::new();
                if args.locator.is_some() || args.selector.is_some() {
                    checks.push(format!(
                        "(() => {{ try {{ {}; return true; }} catch {{ return false; }} }})()",
                        find_expression(args.locator.as_deref(), args.selector.as_deref())
                    ));
                }
                if let Some(text) = &args.text {
                    checks.push(format!(
                        "(document.body?.innerText ?? '').includes({})",
                        json!(text)
                    ));
                }
                if let Some(url) = &args.url_includes {
                    checks.push(format!("location.href.includes({})", json!(url)));
                }
                if checks.is_empty() {
                    return Err("Provide at least one wait condition.".to_owned());
                }
                let all = checks.join(" && ");
                self.until(&all, timeout(args.timeout_ms)).await?;
                ok()
            }
            "preview_recording_start" => {
                if lock(&self.live).recording.is_some() {
                    return Err("This tab is already recording.".to_owned());
                }
                let encoder = self.page.browser.page().await?;
                let started = encoder
                    .call(
                        "Runtime.evaluate",
                        json!({"expression": RECORDER, "awaitPromise": true}),
                    )
                    .await?;
                if let Some(error) = exception(&started) {
                    return Err(format!("The recorder could not start: {error}"));
                }
                let now = Timestamp::now();
                lock(&self.live).recording = Some(Recording {
                    encoder,
                    started: now,
                });
                // A frame now, so a still page records from the start.
                let _ = self.page.call("Page.stopScreencast", json!({})).await;
                let _ = self
                    .page
                    .call("Page.startScreencast", json!({"format": "jpeg", "quality": 70, "maxWidth": FILL.0, "maxHeight": FILL.0}))
                    .await;
                Ok((
                    json!({"tabId": self.id, "recording": true, "startedAt": now.to_string()}),
                    None,
                ))
            }
            "preview_recording_stop" => {
                self.stop_recording(daemon).await.map(|value| (value, None))
            }
            other => Err(format!("no tool is named {other:?}")),
        }
    }

    async fn stop_recording(&self, daemon: &Arc<crate::server::Daemon>) -> Result<Value, String> {
        let Some(recording) = lock(&self.live).recording.take() else {
            return Err("No recording is active for this tab.".to_owned());
        };
        let stopped = recording
            .encoder
            .call(
                "Runtime.evaluate",
                json!({"expression": "window.__plxRecorder.stop()", "awaitPromise": true, "returnByValue": true}),
            )
            .await?;
        if let Some(error) = exception(&stopped) {
            return Err(format!("The recording failed: {error}"));
        }
        let data = stopped["result"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if data.is_empty() {
            return Err("The recording captured no frames.".to_owned());
        }
        if data.len() > MAX_RECORDING_BASE64 {
            return Err("The recording is over 5 MB. Record a shorter clip.".to_owned());
        }
        let bytes = crate::images::decode(&data).ok_or("The recording came back unreadable.")?;
        let id = crate::agents::attach(
            daemon,
            parallax_protocol::AgentAttachParams {
                run_id: self.run,
                attachment: parallax_protocol::PromptImage {
                    media_type: parallax_protocol::ImageMediaType::Webm,
                    data,
                },
            },
        )
        .await
        .map_err(|error| error.message)?
        .image_id;
        let path = evidence_dir(self.run).join(format!("{id}.webm"));
        std::fs::write(&path, &bytes)
            .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
        Ok(json!({
            "id": id,
            "tabId": self.id,
            "path": path,
            "mimeType": "video/webm",
            "sizeBytes": bytes.len(),
            "createdAt": recording.started.to_string(),
        }))
    }

    async fn snapshot(&self, args: SnapshotArgs) -> Result<(Value, Option<String>), String> {
        let shot = self
            .page
            .call("Page.captureScreenshot", json!({"format": "png"}))
            .await?;
        let png = shot["data"].as_str().unwrap_or_default().to_owned();
        let (width, height) = lock(&self.live).viewport;
        if args.save.unwrap_or(false) {
            let bytes =
                crate::images::decode(&png).ok_or("The screenshot came back unreadable.")?;
            let path = evidence_dir(self.run).join(format!(
                "{}-{}.png",
                self.id,
                Timestamp::now().as_millisecond()
            ));
            std::fs::write(&path, bytes)
                .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
            let url = lock(&self.live).url.clone();
            let image = args.include_image.unwrap_or(false).then_some(png);
            return Ok((json!({"url": url, "screenshotPath": path}), image));
        }
        let mut page = self
            .eval(&format!("{HELPER}; window.__plx.snapshot()"))
            .await?;
        {
            let live = lock(&self.live);
            let recent = |entries: &VecDeque<Value>| {
                entries
                    .iter()
                    .rev()
                    .take(SNAPSHOT_ENTRIES)
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>()
            };
            page["consoleEntries"] = recent(&live.console).into();
            page["networkEntries"] = recent(&live.network).into();
            page["actionTimeline"] = recent(&live.timeline).into();
        }
        page["screenshot"] = json!({"mimeType": "image/png", "width": width, "height": height});
        // Cut the visible text, the bulk of a long page, to fit.
        let size = page.to_string().len();
        if size > MAX_SNAPSHOT_BYTES
            && let Some(text) = page["visibleText"].as_str()
        {
            let keep = text.len().saturating_sub(size - MAX_SNAPSHOT_BYTES);
            let cut = text.floor_char_boundary(keep);
            page["visibleText"] = format!(
                "{}\n[cut: {} of {} characters shown; read more with preview_evaluate]",
                &text[..cut],
                cut,
                text.len()
            )
            .into();
        }
        let image = args.include_image.unwrap_or(false).then_some(png);
        Ok((page, image))
    }

    async fn navigate(&self, url: &str, readiness: &str, timeout_ms: u64) -> Result<(), String> {
        let navigated = self.page.call("Page.navigate", json!({"url": url})).await?;
        if let Some(error) = navigated["errorText"].as_str() {
            return Err(format!("Couldn't open {url}: {error}"));
        }
        match readiness {
            "none" => Ok(()),
            "domContentLoaded" => {
                self.until("document.readyState !== 'loading'", timeout_ms)
                    .await
            }
            _ => {
                self.until("document.readyState === 'complete'", timeout_ms)
                    .await
            }
        }
    }

    /// Waits until `condition`, a JavaScript expression, is true in the page.
    async fn until(&self, condition: &str, timeout_ms: u64) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if self.eval(condition).await.ok() == Some(Value::Bool(true)) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("The page didn't get there within {timeout_ms} ms."));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    /// The viewport point at the center of the one element `target` names, scrolled into view.
    async fn point(&self, target: &PointerArgs) -> Result<(f64, f64), String> {
        match (target.x, target.y, &target.locator, &target.selector) {
            (Some(x), Some(y), None, None) => Ok((x, y)),
            (None, None, Some(_), None) | (None, None, None, Some(_)) => {
                let find = find_expression(target.locator.as_deref(), target.selector.as_deref());
                let at = self.eval(&format!("window.__plx.point({find})")).await?;
                Ok((
                    at["x"].as_f64().unwrap_or(0.0),
                    at["y"].as_f64().unwrap_or(0.0),
                ))
            }
            (Some(_), None, ..) | (None, Some(_), ..) => {
                Err("Coordinates require both x and y.".to_owned())
            }
            _ => Err("Provide exactly one of locator, selector, or x and y.".to_owned()),
        }
    }

    async fn mouse(
        &self,
        kind: &str,
        x: f64,
        y: f64,
        button: &str,
        count: u8,
    ) -> Result<(), String> {
        self.page
            .call(
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x, "y": y, "button": button, "clickCount": count}),
            )
            .await
            .map(|_| ())
    }

    /// Evaluates `expression` in the page, with the helper loaded, and returns its value.
    async fn eval(&self, expression: &str) -> Result<Value, String> {
        let evaluated = self
            .page
            .call(
                "Runtime.evaluate",
                json!({"expression": format!("{HELPER};\n{expression}"), "awaitPromise": true, "returnByValue": true}),
            )
            .await?;
        match exception(&evaluated) {
            Some(error) => Err(error),
            None => Ok(evaluated["result"]["value"].clone()),
        }
    }
}

/// Follows a tab's events: its frames (acknowledged, and fed to a recording), where it is, its
/// dialogs and file pickers, and its console and network.
#[expect(clippy::too_many_lines, reason = "one arm per event")]
async fn watch_tab(
    browser: Browser,
    session: String,
    target: String,
    mut events: mpsc::UnboundedReceiver<Event>,
    live: Arc<Mutex<Live>>,
    frames: watch::Sender<Frame>,
) {
    let mut requests: HashMap<String, usize> = HashMap::new();
    let mut dropped = 0;
    while let Some(Event { method, params }) = events.recv().await {
        let now = Timestamp::now().to_string();
        match method.as_str() {
            "Page.screencastFrame" => {
                browser
                    .post(
                        "Page.screencastFrameAck",
                        json!({"sessionId": params["sessionId"]}),
                        &session,
                    )
                    .await;
                let data = params["data"].as_str().unwrap_or_default().to_owned();
                // A page's size in CSS pixels, a whole number DevTools sends as a float.
                let size = |name: &str| {
                    params["metadata"][name].as_u64().or_else(|| {
                        params["metadata"][name]
                            .as_f64()
                            .map(|n| n.round().to_string().parse().unwrap_or(0))
                    })
                };
                let size = |name: &str| u32::try_from(size(name).unwrap_or(0)).unwrap_or(0);
                let (width, height) = (size("deviceWidth"), size("deviceHeight"));
                let encoder = lock(&live)
                    .recording
                    .as_ref()
                    .map(|r| r.encoder.session.clone());
                if let Some(encoder) = encoder {
                    browser
                        .post(
                            "Runtime.evaluate",
                            json!({"expression": format!("window.__plxRecorder.frame({})", json!(data))}),
                            &encoder,
                        )
                        .await;
                }
                frames.send_modify(|frame| {
                    *frame = Frame {
                        seq: frame.seq + 1,
                        data: Arc::new(data),
                        width,
                        height,
                    };
                });
            }
            "Page.frameNavigated" if params["frame"]["parentId"].is_null() => {
                let mut live = lock(&live);
                params["frame"]["url"]
                    .as_str()
                    .unwrap_or_default()
                    .clone_into(&mut live.url);
                live.title.clear();
            }
            "Page.navigatedWithinDocument" if params["frameId"] == target.as_str() => {
                params["url"]
                    .as_str()
                    .unwrap_or_default()
                    .clone_into(&mut lock(&live).url);
            }
            "Page.frameStartedLoading" if params["frameId"] == target.as_str() => {
                lock(&live).loading = true;
            }
            "Page.frameStoppedLoading" if params["frameId"] == target.as_str() => {
                lock(&live).loading = false;
                let info = browser
                    .call("Target.getTargetInfo", json!({"targetId": target}), None)
                    .await;
                if let Ok(info) = info
                    && let Some(title) = info["targetInfo"]["title"].as_str()
                {
                    title.clone_into(&mut lock(&live).title);
                }
            }
            "Page.javascriptDialogOpening" => {
                lock(&live).dialog = Some(json!({
                    "type": params["type"],
                    "message": params["message"],
                    "defaultValue": params["defaultPrompt"].as_str().unwrap_or_default(),
                }));
            }
            "Page.javascriptDialogClosed" => lock(&live).dialog = None,
            "Page.fileChooserOpened" => {
                if let Some(node) = params["backendNodeId"].as_u64() {
                    lock(&live).chooser = Some((node, params["mode"] == "selectMultiple"));
                }
            }
            "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" => {
                let (level, text) = match method.as_str() {
                    "Runtime.consoleAPICalled" => (
                        params["type"].as_str().unwrap_or("log").to_owned(),
                        params["args"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|arg| {
                                arg["value"].as_str().map_or_else(
                                    || arg["description"].as_str().unwrap_or_default().to_owned(),
                                    ToOwned::to_owned,
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    _ => (
                        "error".to_owned(),
                        params["exceptionDetails"]["exception"]["description"]
                            .as_str()
                            .or_else(|| params["exceptionDetails"]["text"].as_str())
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                };
                let text: String = text.chars().take(500).collect();
                push(
                    &mut lock(&live).console,
                    json!({"level": level, "text": text, "timestamp": now}),
                );
            }
            "Network.requestWillBeSent" => {
                let mut live = lock(&live);
                if live.network.len() == MAX_ENTRIES {
                    dropped += 1;
                }
                push(
                    &mut live.network,
                    json!({"url": params["request"]["url"], "method": params["request"]["method"], "status": null, "failed": false, "timestamp": now}),
                );
                if let Some(id) = params["requestId"].as_str() {
                    requests.insert(id.to_owned(), dropped + live.network.len() - 1);
                }
            }
            "Network.responseReceived" | "Network.loadingFailed" => {
                let Some(at) = params["requestId"]
                    .as_str()
                    .and_then(|id| requests.remove(id))
                else {
                    continue;
                };
                let mut live = lock(&live);
                let Some(entry) = at
                    .checked_sub(dropped)
                    .and_then(|i| live.network.get_mut(i))
                else {
                    continue;
                };
                if method == "Network.responseReceived" {
                    entry["status"] = params["response"]["status"].clone();
                } else {
                    entry["failed"] = true.into();
                    entry["errorText"] = params["errorText"].clone();
                }
            }
            _ => {}
        }
    }
}

fn push(entries: &mut VecDeque<Value>, entry: Value) {
    if entries.len() == MAX_ENTRIES {
        entries.pop_front();
    }
    entries.push_back(entry);
}

/// Where a thread's saved screenshots and recordings go: a folder in the system's temp folder,
/// which the agent's sandbox can read.
fn evidence_dir(run: RunId) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("plxd-preview")
        .join(run.to_string());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The error a `Runtime.evaluate` result reports, if any.
fn exception(evaluated: &Value) -> Option<String> {
    let details = evaluated.get("exceptionDetails")?;
    Some(
        details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .unwrap_or("The expression threw.")
            .lines()
            .next()
            .unwrap_or_default()
            .trim_start_matches("Error: ")
            .to_owned(),
    )
}

/// An expression for the one element `locator` or `selector` names.
fn find_expression(locator: Option<&str>, selector: Option<&str>) -> String {
    format!("window.__plx.find({}, {})", json!(locator), json!(selector))
}

/// A URL as T3 takes one: absolute http(s), or a host without a scheme, which is https unless it's
/// loopback.
fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 2048 {
        return Err("url must be 1 to 2048 characters.".to_owned());
    }
    if let Some((scheme, _)) = url.split_once("://") {
        return if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
            Ok(url.to_owned())
        } else {
            Err(format!("Only http and https pages open, not {scheme}:."))
        };
    }
    if url == "about:blank" {
        return Ok(url.to_owned());
    }
    let host = url.split(['/', ':', '?', '#']).next().unwrap_or_default();
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || host.starts_with("127.")
        || host == "0.0.0.0"
        || url.starts_with('[');
    Ok(format!(
        "{}://{url}",
        if loopback { "http" } else { "https" }
    ))
}

/// A key's `DevTools` name, code, Windows key code, and the text it types, if any.
fn key_info(key: &str) -> (String, String, u32, Option<String>) {
    let named = |code: &str, key_code: u32, text: Option<&str>| {
        (
            key.to_owned(),
            code.to_owned(),
            key_code,
            text.map(ToOwned::to_owned),
        )
    };
    match key {
        "Enter" => named("Enter", 13, Some("\r")),
        "Tab" => named("Tab", 9, None),
        "Escape" => named("Escape", 27, None),
        "Backspace" => named("Backspace", 8, None),
        "Delete" => named("Delete", 46, None),
        " " | "Space" => (" ".to_owned(), "Space".to_owned(), 32, Some(" ".to_owned())),
        "ArrowUp" => named("ArrowUp", 38, None),
        "ArrowDown" => named("ArrowDown", 40, None),
        "ArrowLeft" => named("ArrowLeft", 37, None),
        "ArrowRight" => named("ArrowRight", 39, None),
        "Home" => named("Home", 36, None),
        "End" => named("End", 35, None),
        "PageUp" => named("PageUp", 33, None),
        "PageDown" => named("PageDown", 34, None),
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => {
                    let upper = c.to_ascii_uppercase();
                    let code = if c.is_ascii_alphabetic() {
                        format!("Key{upper}")
                    } else if c.is_ascii_digit() {
                        format!("Digit{c}")
                    } else {
                        String::new()
                    };
                    let key_code = if c.is_ascii_alphanumeric() {
                        u32::from(upper)
                    } else {
                        0
                    };
                    (key.to_owned(), code, key_code, Some(key.to_owned()))
                }
                _ => (key.to_owned(), key.to_owned(), 0, None),
            }
        }
    }
}

fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|error| format!("invalid arguments: {error}"))
}

fn text(value: &Value) -> (String, Option<String>) {
    (pretty(value), None)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn timeout(ms: Option<u64>) -> u64 {
    ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    tab_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenArgs {
    tab_id: Option<String>,
    url: Option<String>,
    #[expect(
        dead_code,
        reason = "the app shows the tab whether or not it's asked to"
    )]
    open: Option<bool>,
    #[expect(dead_code, reason = "T3's deprecated alias for open")]
    show: Option<bool>,
    reuse_existing_tab: Option<bool>,
    #[expect(dead_code, reason = "Parallax has one browser profile")]
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    cursor: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseArgs {
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NavigateArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    url: Option<String>,
    target: Option<NavigationTarget>,
    readiness: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum NavigationTarget {
    Url {
        url: String,
    },
    EnvironmentPort {
        port: u16,
        protocol: Option<String>,
        path: Option<String>,
    },
}

impl NavigationTarget {
    fn url(self) -> Result<String, String> {
        match self {
            Self::Url { url } => normalize_url(&url),
            Self::EnvironmentPort {
                port,
                protocol,
                path,
            } => {
                let scheme = protocol.as_deref().unwrap_or("http");
                if scheme != "http" && scheme != "https" {
                    return Err("protocol must be http or https.".to_owned());
                }
                let path = path.unwrap_or_default();
                let slash = if path.is_empty() || path.starts_with('/') {
                    ""
                } else {
                    "/"
                };
                Ok(format!("{scheme}://localhost:{port}{slash}{path}"))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    mode: String,
    preset: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    orientation: Option<String>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

/// T3's device presets: Chrome `DevTools`' catalog, in portrait.
const PRESETS: &[(&str, u32, u32)] = &[
    ("iphone-se", 375, 667),
    ("iphone-xr", 414, 896),
    ("iphone-12-pro", 390, 844),
    ("iphone-14-pro-max", 430, 932),
    ("pixel-7", 412, 915),
    ("samsung-galaxy-s8-plus", 360, 740),
    ("samsung-galaxy-s20-ultra", 412, 915),
    ("ipad-mini", 768, 1024),
    ("ipad-air", 820, 1180),
    ("ipad-pro", 1024, 1366),
    ("surface-pro-7", 912, 1368),
    ("surface-duo", 540, 720),
    ("galaxy-z-fold-5", 344, 882),
    ("asus-zenbook-fold", 853, 1280),
    ("samsung-galaxy-a51-71", 412, 914),
    ("nest-hub", 1024, 600),
    ("nest-hub-max", 1280, 800),
];

impl ResizeArgs {
    /// The setting as `preview_status` reports it, and the viewport it gives.
    fn resolve(self) -> Result<(Value, (u32, u32)), String> {
        match (self.mode.as_str(), self.preset, self.width, self.height) {
            ("fill", None, None, None) if self.orientation.is_none() => {
                Ok((json!({"mode": "fill"}), FILL))
            }
            ("freeform", None, Some(width), Some(height)) if self.orientation.is_none() => {
                if !(1..=4096).contains(&width) || !(1..=4096).contains(&height) {
                    return Err("width and height must be 1 to 4096.".to_owned());
                }
                Ok((json!({"mode": "freeform", "width": width, "height": height}), (width, height)))
            }
            ("preset", Some(preset), None, None) => {
                let &(_, width, height) = PRESETS
                    .iter()
                    .find(|(id, ..)| *id == preset)
                    .ok_or_else(|| format!("No preset is named {preset:?}."))?;
                let portrait = height >= width;
                let wanted = self.orientation.as_deref().unwrap_or(if portrait { "portrait" } else { "landscape" });
                let size = if (wanted == "portrait") == portrait { (width, height) } else { (height, width) };
                Ok((json!({"mode": "preset", "preset": preset, "orientation": wanted}), size))
            }
            ("fill", ..) => Err("Fill mode does not accept a preset, dimensions, or orientation.".to_owned()),
            ("freeform", ..) => Err("Freeform mode requires width and height and does not accept a preset or orientation.".to_owned()),
            ("preset", ..) => Err("Preset mode requires a preset and does not accept custom dimensions.".to_owned()),
            (other, ..) => Err(format!("mode must be fill, freeform, or preset, not {other:?}.")),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    color_scheme: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    include_image: Option<bool>,
    save: Option<bool>,
}

/// One element, or a point: exactly one of `locator`, `selector`, or `x` with `y`.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PointerArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    locator: Option<String>,
    selector: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

impl PointerArgs {
    fn locator(locator: String) -> Self {
        Self {
            locator: Some(locator),
            ..Self::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickArgs {
    #[serde(flatten)]
    target: PointerArgs,
    button: Option<String>,
    click_count: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DragArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    source: String,
    target: String,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TypeArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    text: String,
    locator: Option<String>,
    selector: Option<String>,
    clear: Option<bool>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PressArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    key: String,
    #[serde(default)]
    modifiers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollArgs {
    #[serde(flatten)]
    target: PointerArgs,
    delta_x: Option<f64>,
    delta_y: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    locator: Option<String>,
    selector: Option<String>,
    values: Vec<String>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    paths: Vec<String>,
    locator: Option<String>,
    selector: Option<String>,
    #[serde(rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DialogArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    accept: bool,
    prompt_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluateArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    expression: String,
    await_promise: Option<bool>,
    return_by_value: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitArgs {
    #[serde(rename = "tabId")]
    _tab_id: Option<String>,
    locator: Option<String>,
    selector: Option<String>,
    text: Option<String>,
    url_includes: Option<String>,
    timeout_ms: Option<u64>,
}

/// Loaded into the page before each action: finds elements by locator, and snapshots the page.
const HELPER: &str = include_str!("preview/helper.js");

/// The recorder page's script: `frame(base64)` draws a screencast frame, and `stop()` resolves to
/// the `WebM` in base64.
const RECORDER: &str = include_str!("preview/recorder.js");

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Previews, ResizeArgs, key_info, normalize_url, parse};
    use crate::backend::process::{Environment, Launcher};
    use crate::paths::DataDir;

    /// Drives a real tab: the headless browser installs into `PLXD_TEST_DATA_DIR` the first time.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads the headless browser; set PLXD_TEST_DATA_DIR"]
    async fn an_agent_types_clicks_and_reads_a_page() {
        let dir = DataDir::new(std::env::var("PLXD_TEST_DATA_DIR").unwrap()).unwrap();
        let previews = Previews::new(Launcher::new(dir, Environment::inherited()));
        let scratch = tempfile::tempdir().unwrap();
        let daemon = crate::server::Daemon::for_tests(
            scratch.path(),
            100,
            std::time::Duration::from_secs(60),
        );
        let run = parallax_protocol::RunId::generate();
        let call = async |tool: &str, arguments: serde_json::Value| loop {
            let (text, image) = match previews
                .run_tool(&daemon, run, tool, arguments.clone())
                .await
            {
                Err(error) if error.contains("Try again") => continue,
                done => done.unwrap(),
            };
            break (
                serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                image,
            );
        };
        let (opened, _) = call("preview_open", json!({})).await;
        assert_eq!(opened["tabId"], "tab-1");
        call(
            "preview_evaluate",
            json!({"expression": "document.body.innerHTML = '<input aria-label=Name><button onclick=\"document.title = document.querySelector(\\'input\\').value\">Save</button>'"}),
        )
        .await;
        let (snapshot, image) = call("preview_snapshot", json!({"includeImage": true})).await;
        assert!(image.is_some());
        let tree = snapshot["accessibilityTree"].as_str().unwrap();
        assert!(tree.contains(r#"button "Save" [ref=e2]"#), "{tree}");
        call(
            "preview_type",
            json!({"locator": "aria-ref=e1", "text": "Ada"}),
        )
        .await;
        call(
            "preview_click",
            json!({"locator": "role=button[name='Save']"}),
        )
        .await;
        let (title, _) = call("preview_evaluate", json!({"expression": "document.title"})).await;
        assert_eq!(title["value"], "Ada");
        let missing = previews
            .run_tool(
                &daemon,
                run,
                "preview_click",
                json!({"locator": "text=Nope"}),
            )
            .await
            .unwrap_err();
        assert!(missing.contains("Nothing matches"), "{missing}");
        // A dev server on this host's loopback opens, through the browser's proxy.
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
            while let Ok((mut socket, _)) = server.accept().await {
                let mut request = [0; 1024];
                let _ = socket.read(&mut request).await;
                let body = "<title>Dev server</title>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let (status, _) = call(
            "preview_navigate",
            json!({"target": {"kind": "environment-port", "port": port}}),
        )
        .await;
        assert_eq!(status["title"], "Dev server", "{status}");
        call("preview_close", json!({"tabId": "tab-1"})).await;
    }

    #[test]
    fn urls_take_t3s_defaults() {
        assert_eq!(normalize_url("t3.chat").unwrap(), "https://t3.chat");
        assert_eq!(
            normalize_url("localhost:5173/x").unwrap(),
            "http://localhost:5173/x"
        );
        assert_eq!(normalize_url("http://a.b").unwrap(), "http://a.b");
        assert!(normalize_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn resize_modes_check_their_fields() {
        let resolve = |args| parse::<ResizeArgs>(args).unwrap().resolve();
        assert_eq!(resolve(json!({"mode": "fill"})).unwrap().1, (1280, 800));
        let (setting, size) = resolve(
            json!({"mode": "preset", "preset": "iphone-12-pro", "orientation": "landscape"}),
        )
        .unwrap();
        assert_eq!(size, (844, 390));
        assert_eq!(setting["orientation"], "landscape");
        assert!(resolve(json!({"mode": "freeform", "width": 300})).is_err());
        assert!(resolve(json!({"mode": "fill", "width": 300, "height": 200})).is_err());
    }

    #[test]
    fn keys_carry_their_codes_and_text() {
        assert_eq!(key_info("Enter").3.as_deref(), Some("\r"));
        assert_eq!(key_info("a").1, "KeyA");
        assert_eq!(key_info("ArrowDown").2, 40);
    }
}
