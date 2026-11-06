//! Codex's computer use tools (PLX-897, decision 0077), prefixed `computer_`, on macOS:
//! `list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `scroll`, `drag`,
//! `type_text`, `press_key`, and `set_value`, with Codex's inputs.
//!
//! `computer_get_app_state` reads the app's front window as a numbered accessibility tree and a
//! screenshot, and every action answers with the state after it, so the agent sees what it did.
//! An action names an element by its number in the latest state, or a point in pixels of the
//! latest screenshot. Clicks, keys, and scrolls are posted to the app's process, so the user's
//! pointer and focus stay where they are.
//!
//! Before a thread first uses an app, `computer/ask` asks the user in its transcript, unless they
//! always allow it. The apps a thread was allowed, and each app's latest state, last as long as
//! its `plxd mcp`.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use parallax_protocol::methods::ComputerAsk;
use parallax_protocol::{ComputerAnswer, ComputerAskParams};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Reply, parse};
use crate::computer::macos::{self, Button, Element};
use crate::computer::{self, App, Info, Point, Rect};

/// The tools this module serves.
pub const TOOLS: &[&str] = &[
    "computer_list_apps",
    "computer_get_app_state",
    "computer_click",
    "computer_perform_secondary_action",
    "computer_scroll",
    "computer_drag",
    "computer_type_text",
    "computer_press_key",
    "computer_set_value",
];

/// What the CLI puts in the model's instructions with these tools.
pub const INSTRUCTIONS: &str = "Parallax can operate the user's Mac apps with the computer_* tools. Use them when a task needs a desktop app and no direct tool fits: prefer a CLI, an API, or the preview_* tools for a website. Start with computer_get_app_state, act on elements by element_index where you can, and check the state each action returns before the next one. The first time you use an app, Parallax asks the user; if they don't allow it, don't ask again. Never type passwords, and don't buy, pay, send messages, or delete data unless the user asked for that in this thread.";

/// The most elements the tree shows, and the most it reads looking for them.
const MAX_SHOWN: usize = 600;
const MAX_READ: usize = 3000;
/// The longest side of a screenshot, in pixels: the longest a model sees without downscaling.
const MAX_SIDE: u32 = 1568;
/// How long an app gets to draw what an action did before the state after it is read.
const SETTLE: Duration = Duration::from_millis(350);
/// How long a launched app gets to show a window.
const LAUNCH: Duration = Duration::from_secs(10);
/// The longest text `computer_type_text` types.
const MAX_TEXT_CHARS: usize = 10_000;

/// `tools/list`'s entries for [`TOOLS`].
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one schema per tool, read side by side"
)]
pub fn definitions() -> Vec<Value> {
    let app = json!({"type": "string", "description": "The app's name or bundle id, as computer_list_apps shows it, such as Notes or com.apple.Notes."});
    let index = json!({"type": "integer", "minimum": 0, "description": "An element's number in the latest computer_get_app_state tree."});
    let coordinate = |what: &str| json!({"type": "number", "description": what});
    let tool = |name: &str,
                title: &str,
                description: &str,
                properties: Value,
                required: &[&str],
                read_only: bool| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
            "annotations": {
                "title": title,
                "readOnlyHint": read_only,
                "destructiveHint": !read_only,
                "openWorldHint": true,
            },
        })
    };
    vec![
        tool(
            "computer_list_apps",
            "List apps",
            "List the apps running on the user's Mac, each with its name and bundle id. computer_get_app_state also opens an app that isn't running.",
            json!({}),
            &[],
            true,
        ),
        tool(
            "computer_get_app_state",
            "Look at app",
            "Read an app's front window: its accessibility tree, each element numbered, and a screenshot. Opens the app if it isn't running. Call it before acting on an app, and again whenever the numbers may have changed.",
            json!({"app": app}),
            &["app"],
            true,
        ),
        tool(
            "computer_click",
            "Click",
            "Click an element, by element_index, or a point, by x and y in pixels of the latest screenshot. Returns the app's state after the click.",
            json!({
                "app": app,
                "element_index": index,
                "x": coordinate("Pixels from the screenshot's left edge."),
                "y": coordinate("Pixels from the screenshot's top edge."),
                "click_count": {"type": "integer", "minimum": 1, "maximum": 3, "description": "2 for a double click. Default 1."},
                "mouse_button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Default left."},
            }),
            &["app"],
            false,
        ),
        tool(
            "computer_perform_secondary_action",
            "Use element action",
            "Perform one of an element's secondary actions, as its line in the tree lists them, such as ShowMenu, Increment, Decrement, Raise, Pick, or Cancel. Returns the app's state after it.",
            json!({
                "app": app,
                "element_index": index,
                "action": {"type": "string", "description": "The action's name, such as ShowMenu."},
            }),
            &["app", "element_index", "action"],
            false,
        ),
        tool(
            "computer_scroll",
            "Scroll",
            "Scroll an element, or the point at x and y in the latest screenshot, or else the window's middle, by pages. Returns the app's state after it.",
            json!({
                "app": app,
                "element_index": index,
                "x": coordinate("Pixels from the screenshot's left edge."),
                "y": coordinate("Pixels from the screenshot's top edge."),
                "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                "pages": {"type": "number", "exclusiveMinimum": 0, "maximum": 20, "description": "How far, in the scrolled area's heights or widths. Default 1."},
            }),
            &["app", "direction"],
            false,
        ),
        tool(
            "computer_drag",
            "Drag",
            "Drag with the left button from one point to another, in pixels of the latest screenshot. Returns the app's state after it.",
            json!({
                "app": app,
                "from_x": coordinate("Where the drag starts, from the screenshot's left edge."),
                "from_y": coordinate("Where the drag starts, from the screenshot's top edge."),
                "to_x": coordinate("Where it ends, from the left edge."),
                "to_y": coordinate("Where it ends, from the top edge."),
            }),
            &["app", "from_x", "from_y", "to_x", "to_y"],
            false,
        ),
        tool(
            "computer_type_text",
            "Type",
            "Type text into the app's focused element, as the keyboard would. Click or focus a field first. Returns the app's state after it.",
            json!({
                "app": app,
                "text": {"type": "string", "description": "The text, at most 10,000 characters. A newline presses Return."},
            }),
            &["app", "text"],
            false,
        ),
        tool(
            "computer_press_key",
            "Press key",
            "Press a key or shortcut in the app, in xdotool's style: Return, Tab, Escape, BackSpace, Delete, Up, Page_Down, F5, a, or a combination such as super+c, cmd+shift+4, or ctrl+alt+Right. super and cmd are Command. Returns the app's state after it.",
            json!({
                "app": app,
                "key": {"type": "string", "description": "The key, such as Return or cmd+s."},
            }),
            &["app", "key"],
            false,
        ),
        tool(
            "computer_set_value",
            "Set value",
            "Set an element's value directly, such as a text field's text or a slider's position, replacing what it has. Returns the app's state after it.",
            json!({
                "app": app,
                "element_index": index,
                "value": {"type": "string"},
            }),
            &["app", "element_index", "value"],
            false,
        ),
    ]
}

/// What the latest state of one app was.
#[derive(Clone)]
struct Snapshot {
    pid: i32,
    /// The window's frame, in points.
    window: Rect,
    /// The screenshot's size in pixels, which `x` and `y` count in. The window's size in points
    /// when there was none.
    image: (u32, u32),
    /// The tree's elements, by number.
    elements: Vec<Element>,
}

/// One thread's computer use: the apps it may use, and each app's latest state.
#[derive(Default)]
pub struct Computer {
    allowed: Mutex<HashSet<String>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppArgs {
    app: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClickArgs {
    app: String,
    element_index: Option<usize>,
    x: Option<f64>,
    y: Option<f64>,
    click_count: Option<u32>,
    mouse_button: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionArgs {
    app: String,
    element_index: usize,
    action: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScrollArgs {
    app: String,
    element_index: Option<usize>,
    x: Option<f64>,
    y: Option<f64>,
    direction: String,
    pages: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DragArgs {
    app: String,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextArgs {
    app: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyArgs {
    app: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValueArgs {
    app: String,
    element_index: usize,
    value: String,
}

/// What an action does once its app is found and allowed.
enum Action {
    Click {
        target: Target,
        button: Button,
        count: u32,
    },
    Secondary {
        index: usize,
        action: String,
    },
    Scroll {
        target: Target,
        direction: String,
        pages: f64,
    },
    Drag {
        from: (f64, f64),
        to: (f64, f64),
    },
    Type(String),
    Key(String),
    SetValue {
        index: usize,
        value: String,
    },
}

/// Where an action happens, once its target is found: an element, whose frame is read off the
/// async runtime since that asks its app, or a point on screen in an area.
enum Place {
    Element(Element),
    Fixed(Point, Rect),
}

impl Place {
    /// The window's middle, in place of its corner.
    fn centered(self) -> Self {
        match self {
            Self::Fixed(_, area) => Self::Fixed(area.center(), area),
            element @ Self::Element(_) => element,
        }
    }

    /// The point to act at, and the area around it, which a scroll moves by.
    fn resolve(self) -> Result<(Point, Rect), String> {
        match self {
            Self::Element(element) => {
                let frame = element
                    .frame()
                    .ok_or("The element has no place on screen.")?;
                Ok((frame.center(), frame))
            }
            Self::Fixed(at, area) => Ok((at, area)),
        }
    }
}

/// Where an action happens: an element, a point in the screenshot, or the window's middle.
enum Target {
    Element(usize),
    Point(f64, f64),
    Window,
}

fn target(index: Option<usize>, x: Option<f64>, y: Option<f64>) -> Result<Target, String> {
    match (index, x, y) {
        (Some(index), None, None) => Ok(Target::Element(index)),
        (None, Some(x), Some(y)) => Ok(Target::Point(x, y)),
        (None, None, None) => Ok(Target::Window),
        _ => Err("Pass element_index, or both x and y.".to_owned()),
    }
}

impl Computer {
    /// Runs tool `name`, one of [`TOOLS`].
    ///
    /// # Errors
    ///
    /// Why the tool failed, for the model.
    pub async fn call(
        &self,
        binding: &Binding,
        name: &str,
        arguments: Value,
    ) -> Result<Reply, String> {
        let (app, action) = match name {
            "computer_list_apps" => return list_apps().await.map(Reply::from),
            "computer_get_app_state" => (parse::<AppArgs>(arguments)?.app, None),
            "computer_click" => {
                let args: ClickArgs = parse(arguments)?;
                let button = match args.mouse_button.as_deref() {
                    None | Some("left") => Button::Left,
                    Some("right") => Button::Right,
                    Some("middle") => Button::Middle,
                    Some(other) => return Err(format!("{other:?} isn't left, right, or middle.")),
                };
                let target = target(args.element_index, args.x, args.y)?;
                if matches!(target, Target::Window) {
                    return Err("Pass element_index, or both x and y.".to_owned());
                }
                let count = args.click_count.unwrap_or(1).clamp(1, 3);
                (
                    args.app,
                    Some(Action::Click {
                        target,
                        button,
                        count,
                    }),
                )
            }
            "computer_perform_secondary_action" => {
                let args: ActionArgs = parse(arguments)?;
                let action = Action::Secondary {
                    index: args.element_index,
                    action: args.action,
                };
                (args.app, Some(action))
            }
            "computer_scroll" => {
                let args: ScrollArgs = parse(arguments)?;
                if !["up", "down", "left", "right"].contains(&args.direction.as_str()) {
                    return Err("direction is up, down, left, or right.".to_owned());
                }
                let action = Action::Scroll {
                    target: target(args.element_index, args.x, args.y)?,
                    direction: args.direction,
                    pages: args.pages.unwrap_or(1.0).clamp(0.1, 20.0),
                };
                (args.app, Some(action))
            }
            "computer_drag" => {
                let args: DragArgs = parse(arguments)?;
                let action = Action::Drag {
                    from: (args.from_x, args.from_y),
                    to: (args.to_x, args.to_y),
                };
                (args.app, Some(action))
            }
            "computer_type_text" => {
                let args: TextArgs = parse(arguments)?;
                if args.text.chars().count() > MAX_TEXT_CHARS {
                    return Err(format!("text must be at most {MAX_TEXT_CHARS} characters."));
                }
                (args.app, Some(Action::Type(args.text)))
            }
            "computer_press_key" => {
                let args: KeyArgs = parse(arguments)?;
                computer::parse_key(&args.key)?;
                (args.app, Some(Action::Key(args.key)))
            }
            "computer_set_value" => {
                let args: ValueArgs = parse(arguments)?;
                let action = Action::SetValue {
                    index: args.element_index,
                    value: args.value,
                };
                (args.app, Some(action))
            }
            other => return Err(format!("no tool is named {other:?}")),
        };
        if !macos::accessibility(false) {
            return Err(computer::NO_ACCESSIBILITY.to_owned());
        }
        let app = self.open(binding, &app).await?;
        if let Some(action) = action {
            self.act(&app, action).await?;
            tokio::time::sleep(SETTLE).await;
        }
        self.state(&app).await
    }

    /// The running app `wanted` names, opened if it isn't running, once the user allows it. A
    /// blocked or unallowed app is never opened.
    async fn open(&self, binding: &Binding, wanted: &str) -> Result<App, String> {
        if let Some(app) = computer::find(&running().await?, wanted).cloned() {
            refuse_blocked(&app.name, &app.bundle_id)?;
            self.allow(binding, &app.name).await?;
            return Ok(app);
        }
        let wanted = wanted.trim().trim_end_matches(".app");
        // Its real name, which the user is asked about and Always allow keeps, even when the
        // model named it by bundle id.
        let (id, name) = installed(wanted).await.ok_or_else(|| {
            format!(
                "No app named {wanted} is installed. Call computer_list_apps for the apps running."
            )
        })?;
        refuse_blocked(&name, &id)?;
        self.allow(binding, &name).await?;
        launch(&id).await?;
        let deadline = tokio::time::Instant::now() + LAUNCH;
        loop {
            if let Some(app) = computer::find(&running().await?, &id).cloned() {
                refuse_blocked(&app.name, &app.bundle_id)?;
                self.lock_allowed().insert(app.name.clone());
                return Ok(app);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "{name} didn't open. Call computer_list_apps for the apps running."
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Asks the user, once per thread, whether it may use `app`, waiting as long as they take.
    async fn allow(&self, binding: &Binding, app: &str) -> Result<(), String> {
        if self.lock_allowed().contains(app) {
            return Ok(());
        }
        let answer = loop {
            // Each call waits at most 50 s, under plxd's idle timeout, and the same request
            // keeps waiting on the next.
            let answer = binding
                .plxd
                .call::<ComputerAsk>(ComputerAskParams {
                    run_id: binding.run,
                    app: app.to_owned(),
                    wait_ms: 50_000,
                })
                .await?;
            if answer.status != ComputerAnswer::Pending {
                break answer.status;
            }
        };
        if answer == ComputerAnswer::Stopped {
            return Err(format!(
                "The turn ended before the user answered whether Parallax may use {app}."
            ));
        }
        if !matches!(answer, ComputerAnswer::Allowed | ComputerAnswer::Always) {
            return Err(format!(
                "The user didn't allow Parallax to use {app}. Don't ask again; do the task another way or tell the user what you need."
            ));
        }
        self.lock_allowed().insert(app.to_owned());
        Ok(())
    }

    fn lock_allowed(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.allowed.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_snapshots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Snapshot>> {
        self.snapshots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Does `action` in `app`, against its latest state.
    #[expect(clippy::too_many_lines, reason = "one arm per action")]
    async fn act(&self, app: &App, action: Action) -> Result<(), String> {
        let snapshot = self.lock_snapshots().get(&app.name).cloned();
        let Some(snapshot) = snapshot.filter(|snapshot| snapshot.pid == app.pid) else {
            return Err(format!(
                "Call computer_get_app_state for {} first.",
                app.name
            ));
        };
        let element = |index: usize| {
            snapshot.elements.get(index).cloned().ok_or_else(|| {
                format!(
                    "No element {index} in {}'s latest state. Call computer_get_app_state again.",
                    app.name
                )
            })
        };
        let window = snapshot.window;
        // A point in the screenshot, on screen.
        let screen = |(x, y): (f64, f64)| {
            if window.width <= 0.0 || window.height <= 0.0 {
                return Err("The window has no place on screen. Use element_index.".to_owned());
            }
            Ok(Point {
                x: window.x + x * window.width / f64::from(snapshot.image.0),
                y: window.y + y * window.height / f64::from(snapshot.image.1),
            })
        };
        let pid = app.pid;
        let place = |target: &Target| -> Result<Place, String> {
            Ok(match target {
                Target::Element(index) => Place::Element(element(*index)?),
                Target::Point(x, y) => Place::Fixed(screen((*x, *y))?, window),
                Target::Window => Place::Fixed(screen((0.0, 0.0))?, window).centered(),
            })
        };
        let work: Box<dyn FnOnce() -> Result<(), String> + Send> = match action {
            Action::Click {
                target,
                button,
                count,
            } => {
                let place = place(&target)?;
                Box::new(move || {
                    // Pressing an element is what a plain click means, and needs no pointer.
                    if let Place::Element(element) = &place
                        && button == Button::Left
                        && count == 1
                        && element.actions().iter().any(|action| action == "AXPress")
                    {
                        return element.perform("AXPress");
                    }
                    let (at, _) = place.resolve()?;
                    macos::click(pid, at, button, count, 0);
                    Ok(())
                })
            }
            Action::Secondary { index, action } => {
                let element = element(index)?;
                Box::new(move || {
                    // The tree's name for it, such as ShowMenu or an app's own Copy, or the raw
                    // name macOS gives it.
                    let wanted = action.trim_start_matches("AX");
                    let raw = element
                        .actions()
                        .into_iter()
                        .find(|raw| {
                            raw == &action
                                || computer::action_name(raw).eq_ignore_ascii_case(wanted)
                        })
                        .ok_or_else(|| format!("The element has no action named {action}."))?;
                    element.perform(&raw)
                })
            }
            Action::Scroll {
                target,
                direction,
                pages,
            } => {
                let place = place(&target)?;
                Box::new(move || {
                    let (at, area) = place.resolve()?;
                    #[expect(
                        clippy::cast_possible_truncation,
                        reason = "a scroll is far less than i32::MAX pixels"
                    )]
                    let by = |side: f64| (side * pages * 0.9).round() as i32;
                    let (dx, dy) = match direction.as_str() {
                        "up" => (0, by(area.height)),
                        "down" => (0, -by(area.height)),
                        "left" => (by(area.width), 0),
                        _ => (-by(area.width), 0),
                    };
                    macos::scroll(pid, at, dx, dy);
                    Ok(())
                })
            }
            Action::Drag { from, to } => {
                let (from, to) = (screen(from)?, screen(to)?);
                Box::new(move || {
                    macos::drag(pid, from, to);
                    Ok(())
                })
            }
            Action::Type(text) => Box::new(move || {
                // A newline is Return, which a typed "\n" isn't to most apps.
                for (n, line) in text.split('\n').enumerate() {
                    if n > 0 {
                        macos::key(pid, 36, 0);
                    }
                    macos::type_text(pid, line);
                }
                Ok(())
            }),
            Action::Key(key) => {
                let (code, flags) = computer::parse_key(&key)?;
                Box::new(move || {
                    macos::key(pid, code, flags);
                    Ok(())
                })
            }
            Action::SetValue { index, value } => {
                let element = element(index)?;
                Box::new(move || element.set_value(&value))
            }
        };
        blocking(work).await
    }

    /// Reads `app`'s front window, keeps it as its latest state, and answers with its tree and
    /// screenshot.
    async fn state(&self, app: &App) -> Result<Reply, String> {
        let pid = app.pid;
        let (window, nodes) = blocking(move || Ok(read_window(pid))).await?;
        let Some(window) = window else {
            self.lock_snapshots().remove(&app.name);
            return Ok(Reply::from(format!(
                "{} ({}) has no open window. Open one, such as with computer_press_key cmd+n, or ask the user to.",
                app.name, app.bundle_id
            )));
        };
        let frame = window.frame;
        let shot = match frame {
            Some(frame) if macos::screen_recording(false) => screenshot(pid, frame).await,
            Some(_) => Err("Parallax doesn't have the Screen Recording permission, so this state has no screenshot. Ask the user to turn on plxd in System Settings > Privacy & Security > Screen & System Audio Recording.".to_owned()),
            None => Err("The window has no place on screen.".to_owned()),
        };
        let frame = frame.unwrap_or_default();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a window is a few thousand points"
        )]
        let points = (frame.width.max(1.0) as u32, frame.height.max(1.0) as u32);
        let image = shot
            .as_ref()
            .map_or(points, |png| super::device::png_size(png).unwrap_or(points));
        let mut text = format!("App: {} ({}), pid {}\n", app.name, app.bundle_id, app.pid);
        let title = window.info.title.clone();
        let _ = write!(
            text,
            "Window: {}, {}×{} points.",
            if title.is_empty() {
                "untitled".to_owned()
            } else {
                format!("\"{title}\"")
            },
            frame.width.round(),
            frame.height.round(),
        );
        match &shot {
            Ok(_) => {
                let (width, height) = image;
                let _ = writeln!(
                    text,
                    " The screenshot is {width}×{height} pixels; x and y count in it."
                );
            }
            Err(why) => {
                let _ = writeln!(text, " {why}");
            }
        }
        text.push('\n');
        let mut elements = Vec::with_capacity(nodes.len());
        for (index, node) in nodes.into_iter().enumerate() {
            text.push_str(&computer::line(index, node.depth, &node.info));
            text.push('\n');
            elements.push(node.element);
        }
        if elements.len() >= MAX_SHOWN {
            let _ = writeln!(
                text,
                "[The tree stops at {MAX_SHOWN} elements. Scroll or use the screenshot for the rest.]"
            );
        }
        self.lock_snapshots().insert(
            app.name.clone(),
            Snapshot {
                pid,
                window: frame,
                image,
                elements,
            },
        );
        Ok(Reply {
            text,
            png: shot.ok(),
        })
    }
}

/// Runs `work` off the async runtime, since Accessibility and Quartz calls wait on the app.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// One element of the tree, at `depth`.
struct Node {
    depth: usize,
    info: Info,
    element: Element,
}

/// The front window of app `pid`, read as the tree shows it.
struct Window {
    info: Info,
    frame: Option<Rect>,
}

/// The app's focused window, or its main or first, and its shown elements in order.
fn read_window(pid: i32) -> (Option<Window>, Vec<Node>) {
    let app = macos::application(pid);
    let Some(window) = app
        .element("AXFocusedWindow")
        .or_else(|| app.element("AXMainWindow"))
        .or_else(|| app.elements("AXWindows").into_iter().next())
    else {
        return (None, Vec::new());
    };
    let mut nodes = Vec::new();
    let mut stack = vec![(window.clone(), 0)];
    let mut read = 0;
    while let Some((element, depth)) = stack.pop() {
        if nodes.len() >= MAX_SHOWN || read >= MAX_READ {
            break;
        }
        read += 1;
        let info = element.info();
        // The window itself is always the tree's first line.
        let shown = (depth == 0 && nodes.is_empty()) || computer::shown(&info);
        let children = element.elements("AXChildren");
        let below = if shown { depth + 1 } else { depth };
        stack.extend(children.into_iter().rev().map(|child| (child, below)));
        if shown {
            nodes.push(Node {
                depth,
                info,
                element,
            });
        }
    }
    let info = nodes
        .first()
        .map(|node| node.info.clone())
        .unwrap_or_default();
    let frame = window.frame();
    (Some(Window { info, frame }), nodes)
}

/// A PNG of app `pid`'s window at `frame`, at most [`MAX_SIDE`] pixels on its longest side.
async fn screenshot(pid: i32, frame: Rect) -> Result<Vec<u8>, String> {
    let windows = blocking(move || Ok(macos::windows(pid))).await?;
    // The window server's window at the Accessibility window's frame, or the app's front one.
    let distance = |bounds: &Rect| {
        (bounds.x - frame.x).abs()
            + (bounds.y - frame.y).abs()
            + (bounds.width - frame.width).abs()
            + (bounds.height - frame.height).abs()
    };
    let number = windows
        .iter()
        .min_by(|a, b| distance(&a.bounds).total_cmp(&distance(&b.bounds)))
        .map(|window| window.number)
        .ok_or("The window isn't on screen, so there is no screenshot.")?;
    let file = tempfile::Builder::new()
        .prefix("plxd-computer-")
        .suffix(".png")
        .tempfile()
        .map_err(|error| format!("could not make a file for the screenshot: {error}"))?;
    let path = file.path().to_owned();
    blocking(move || {
        // -x: no sound, -o: no shadow, -l: just this window.
        run(
            "/usr/sbin/screencapture",
            &["-x", "-o", &format!("-l{number}"), "-t", "png"],
            &path,
        )?;
        let read = || {
            std::fs::read(&path).map_err(|error| format!("could not read the screenshot: {error}"))
        };
        // sips -Z enlarges a smaller image too, so only a larger one goes through it.
        let large = super::device::png_size(&read()?)
            .is_some_and(|(width, height)| width.max(height) > MAX_SIDE);
        if large {
            run("/usr/bin/sips", &["-Z", &MAX_SIDE.to_string()], &path)?;
        }
        read()
    })
    .await
}

/// Runs `program` with `args` and then `path`.
fn run(program: &str, args: &[&str], path: &Path) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not run {program}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// The apps in the Dock.
async fn running() -> Result<Vec<App>, String> {
    let output = blocking(|| {
        Command::new("/usr/bin/lsappinfo")
            .arg("list")
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("could not list the running apps: {error}"))
    })
    .await?;
    Ok(computer::parse_apps(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

async fn list_apps() -> Result<String, String> {
    let apps: Vec<Value> = running()
        .await?
        .into_iter()
        .filter(|app| computer::blocked(&app.bundle_id).is_none())
        .map(|app| json!({"name": app.name, "bundleId": app.bundle_id}))
        .collect();
    Ok(super::pretty(&json!({"apps": apps})))
}

/// Refuses an app computer use never controls.
fn refuse_blocked(name: &str, bundle_id: &str) -> Result<(), String> {
    match computer::blocked(bundle_id) {
        Some(why) => Err(format!(
            "{name} is {why}, which computer use can't control."
        )),
        None => Ok(()),
    }
}

/// The bundle id and name of the installed app `wanted` names, by name or bundle id, read
/// without opening it, or `None` when no app has that name.
async fn installed(wanted: &str) -> Option<(String, String)> {
    let wanted = wanted.replace(['"', '\\'], "");
    let script = if wanted.contains('.') {
        format!("tell application id \"{wanted}\" to return (id as text) & linefeed & name")
    } else {
        format!("tell application \"{wanted}\" to return (id as text) & linefeed & name")
    };
    let output = blocking(move || {
        Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| error.to_string())
    })
    .await
    .ok()
    .filter(|output| output.status.success())?;
    let found = String::from_utf8_lossy(&output.stdout);
    let (id, name) = found.trim().split_once('\n')?;
    Some((id.to_owned(), name.to_owned()))
}

/// Opens the app `wanted` names, by bundle id or name.
async fn launch(wanted: &str) -> Result<(), String> {
    // A bundle id, such as com.apple.Notes, or else a name.
    let flag = if wanted.contains('.') && !wanted.to_ascii_lowercase().ends_with(".app") {
        "-b"
    } else {
        "-a"
    };
    let name = wanted.to_owned();
    // -g: in the background, so the user's focus stays where it is.
    let output = blocking(move || {
        Command::new("/usr/bin/open")
            .args(["-g", flag, &name])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("could not open {name}: {error}"))
    })
    .await?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "No app named {wanted} is installed. Call computer_list_apps for the apps running."
    ))
}
