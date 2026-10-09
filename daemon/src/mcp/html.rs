//! `html_preview` and `html_render` (PLX-639): T3 Code's HTML tools, with its names, inputs, and
//! result shapes.
//!
//! Both take one self-contained page. Its local images, written as absolute paths, are inlined as
//! data URIs, and a bootstrap goes in at the top of its head: the theme as CSS variables named as
//! T3 names them, which the app replaces with its own live theme, and a script that reports the
//! page's height and sends its links to the app. `html_preview` loads the page in the headless
//! browser ([`crate::browser`]) from a made-up origin, served from memory, and answers with a
//! screenshot, the page's height, and its console. `html_render` stores the page with the
//! caller's run through `agent/attach`, and the app shows it inline in the transcript.

use std::time::Duration;

use parallax_protocol::methods::AgentAttach;
use parallax_protocol::{AgentAttachParams, ImageMediaType, PromptImage};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Reply, parse, pretty};
use crate::backend::process::{Environment, Launcher};
use crate::browser::{self, Browser, Event, drive};

/// The tools this module serves.
pub const TOOLS: &[&str] = &["html_preview", "html_render"];

/// The reply column's frame width at the app's default chat width, which previews default to.
const COLUMN_WIDTH: u32 = 728;
const MIN_WIDTH: u32 = 240;
const MAX_WIDTH: u32 = 1_600;
const MIN_HEIGHT: u32 = 80;
const MAX_HEIGHT: u32 = 2_000;
const MAX_TITLE_CHARS: usize = 200;
/// The longest page an agent may pass, as T3 takes it.
const MAX_HTML_BYTES: usize = 512_000;
/// The largest page with its images inlined. It travels in one plxd frame (8 MiB) as base64.
const MAX_PAGE_BYTES: usize = 5 * 1024 * 1024;
const VIEWPORT_HEIGHT: u32 = 800;
const MAX_CAPTURE_HEIGHT: u64 = 4_000;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONSOLE_MESSAGES: usize = 20;
const MAX_CONSOLE_CHARS: usize = 500;

/// Pages load from this made-up origin, never from a file, so a page can't read local files;
/// local images reach it already inlined. `.localhost` keeps it a secure context.
const PAGE_ORIGIN: &str = "http://plx-page.localhost";
const PAGE_URL: &str = "http://plx-page.localhost/page.html";
/// Stack traces name the page this way.
const PAGE_NAME: &str = "page.html";

const PAGE_RULES: &str = "Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src=\"/abs/shot.png\", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.";

const LAYOUT_GUIDE: &str = "The frame is borderless on the thread's background, as wide as the reply column (728px by default, wider if the reader widens the chat), and its left edge lines up with your reply text. The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background. Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply. If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge. Give charts fixed pixel heights rather than heights that scale with width. Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.";

const THEME_GUIDE: &str = "Parallax injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live: --background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring, --primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground, --destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface, --success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground, --chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono. The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.";

/// `tools/list`'s entries for [`TOOLS`].
#[must_use]
pub fn definitions() -> Vec<Value> {
    let html = json!({"type": "string", "minLength": 1, "maxLength": MAX_HTML_BYTES, "description": "A complete, self-contained HTML document."});
    vec![
        json!({
            "name": "html_preview",
            "title": "Preview HTML",
            "description": format!("Render an HTML page in Parallax's headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. The first preview on a machine can report that Parallax is still installing its preview browser; call again a minute later. {PAGE_RULES} The page gets the theme variables and layout described in html_render."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "html": html,
                    "width": {"type": "integer", "description": format!("Viewport width in CSS pixels, {MIN_WIDTH}-{MAX_WIDTH}. Defaults to {COLUMN_WIDTH}, the reply column; use about 390 to check phones.")},
                    "appearance": {"type": "string", "enum": ["dark", "light"], "description": "Theme to preview. Defaults to dark."},
                },
                "required": ["html"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true},
        }),
        json!({
            "name": "html_render",
            "title": "Render HTML",
            "description": format!("Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. Parallax fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. {PAGE_RULES} {LAYOUT_GUIDE} {THEME_GUIDE}"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "html": html,
                    "title": {"type": "string", "minLength": 1, "maxLength": MAX_TITLE_CHARS, "description": "Short name for the page."},
                    "height": {"type": "integer", "description": format!("The frame height in CSS pixels, {MIN_HEIGHT}-{MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.")},
                },
                "required": ["html", "title", "height"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
        }),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewArgs {
    html: String,
    width: Option<i64>,
    appearance: Option<Appearance>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Appearance {
    #[default]
    Dark,
    Light,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderArgs {
    html: String,
    title: String,
    height: i64,
}

/// Runs `name`, one of [`TOOLS`].
///
/// # Errors
///
/// What went wrong, for the model.
pub async fn call(binding: &Binding, name: &str, arguments: Value) -> Result<Reply, String> {
    match name {
        "html_preview" => {
            let args: PreviewArgs = parse(arguments)?;
            check_html(&args.html)?;
            let width = u32::try_from(args.width.unwrap_or(COLUMN_WIDTH.into()))
                .unwrap_or(0)
                .clamp(MIN_WIDTH, MAX_WIDTH);
            let (page, missing) = inline_images(&bootstrap(&args.html))?;
            let launcher = Launcher::new(binding.data_dir.clone(), Environment::inherited());
            let shot =
                preview(&launcher, &page, width, args.appearance.unwrap_or_default()).await?;
            let mut answer = json!({
                "width": width,
                "contentHeight": shot.content_height,
                "capturedHeight": shot.captured_height,
                "consoleMessages": shot.console,
                "screenshot": {"mimeType": "image/png", "width": width, "height": shot.captured_height},
            });
            if !missing.is_empty() {
                answer["missingImages"] = json!(missing);
            }
            Ok(Reply {
                text: pretty(&answer),
                png: crate::images::decode(&shot.png),
            })
        }
        "html_render" => {
            let args: RenderArgs = parse(arguments)?;
            check_html(&args.html)?;
            let title: String = args.title.trim().chars().take(MAX_TITLE_CHARS).collect();
            let title = if title.is_empty() {
                "HTML".to_owned()
            } else {
                title
            };
            let (page, missing) = inline_images(&bootstrap(&args.html))?;
            if !missing.is_empty() {
                return Err(format!(
                    "These local images could not be read: {}. Use absolute paths to existing image files, or remove them.",
                    missing.join(", ")
                ));
            }
            let attached = binding
                .plxd
                .call::<AgentAttach>(AgentAttachParams {
                    run_id: binding.run,
                    attachment: PromptImage {
                        media_type: ImageMediaType::Html,
                        data: crate::images::encode(page.as_bytes()),
                    },
                })
                .await?;
            Ok(pretty(&json!({
                "htmlRender": {
                    "attachmentId": attached.image_id,
                    "title": title,
                    "height": clamp_height(args.height),
                },
                "message": "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
            }))
            .into())
        }
        _ => Err(format!("no tool is named {name:?}")),
    }
}

fn check_html(html: &str) -> Result<(), String> {
    if html.is_empty() || html.len() > MAX_HTML_BYTES {
        return Err(format!("html must be 1 to {MAX_HTML_BYTES} bytes"));
    }
    Ok(())
}

fn clamp_height(height: i64) -> i64 {
    height.clamp(MIN_HEIGHT.into(), MAX_HEIGHT.into())
}

/// Parallax's dark and light themes as T3's variable names, so a page shows themed without the
/// app (a preview, a download). The app replaces them with its live theme.
const DARK: &str = "--background:#0d0d0d;--foreground:#ececec;--muted:#262626;--muted-foreground:#a8a8a8;--card:#171717;--card-foreground:#ececec;--popover:#171717;--popover-foreground:#ececec;--secondary:#262626;--secondary-foreground:#ececec;--border:rgb(255 255 255 / 8%);--input:rgb(255 255 255 / 8%);--ring:#3b82f6;--primary:#ececec;--primary-foreground:#0d0d0d;--accent:#3b82f6;--accent-foreground:#ffffff;--accent-surface:#1a2a44;--accent-surface-foreground:#ececec;--destructive:#ff8f8a;--destructive-foreground:#ff8f8a;--destructive-surface:#3a1d1c;--warning:#f59e0b;--warning-foreground:#fbbf24;--warning-surface:#3a2a0d;--success:#4ade80;--success-foreground:#4ade80;--info:#3b82f6;--info-foreground:#60a5fa;--code-background:#151515;--code-foreground:#ececec;--chart-1:#3b82f6;--chart-2:#2dd4bf;--chart-3:#fbbf24;--chart-4:#c084fc;--chart-5:#fb7185;--chart-6:#a3e635;";
const LIGHT: &str = "--background:#ffffff;--foreground:#181818;--muted:#f2f2f2;--muted-foreground:#4f4f4f;--card:#ffffff;--card-foreground:#181818;--popover:#ffffff;--popover-foreground:#181818;--secondary:#ededed;--secondary-foreground:#181818;--border:rgb(0 0 0 / 9%);--input:rgb(0 0 0 / 9%);--ring:#2563eb;--primary:#181818;--primary-foreground:#ffffff;--accent:#2563eb;--accent-foreground:#ffffff;--accent-surface:#e6eefd;--accent-surface-foreground:#181818;--destructive:#c42b2b;--destructive-foreground:#c42b2b;--destructive-surface:#fbeaea;--warning:#d97706;--warning-foreground:#b45309;--warning-surface:#fdf3e6;--success:#15803d;--success-foreground:#15803d;--info:#3b82f6;--info-foreground:#1d4ed8;--code-background:#f7f7f8;--code-foreground:#181818;--chart-1:#2563eb;--chart-2:#0d9488;--chart-3:#d97706;--chart-4:#9333ea;--chart-5:#e11d48;--chart-6:#65a30d;";
const SHARED: &str = "--radius:0.625rem;--font-sans:-apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif;--font-mono:\"SF Mono\",\"SFMono-Regular\",Menlo,Consolas,\"Liberation Mono\",monospace;";

/// T3's base stylesheet: the page's background, color, and font from the theme, and no scrollbar.
const BASE_CSS: &str = "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

/// T3's bootstrap, renamed: it applies a theme handed over in the URL fragment (`#plx-theme=`)
/// or by a `ui/notifications/host-context-changed` message, sends a clicked link to its client
/// with `ui/open-link` (MCP Apps' JSON-RPC over postMessage), and reports its content height with
/// `ui/notifications/size-changed`.
const BOOTSTRAP_SCRIPT: &str = r##"(function(){var s=document.getElementById("plx-theme"),n=0;if(!s)return;var b=s.dataset.base||"";function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]plx-theme=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method==="ui/notifications/host-context-changed"&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"plx-link-"+(++n),method:"ui/open-link",params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();"##;

/// `html` with the theme bootstrap first in its head: after its doctype, or at the very start.
/// The parser puts what comes before `<html>` and `<head>` into the head, ahead of the page's
/// own styles and scripts, so the first paint is already themed.
fn bootstrap(html: &str) -> String {
    let viewport = if html.to_ascii_lowercase().contains("name=\"viewport\"") {
        ""
    } else {
        r#"<meta name="viewport" content="width=device-width, initial-scale=1">"#
    };
    let base = BASE_CSS.replace('"', "&quot;");
    let markup = format!(
        r#"{viewport}<style id="plx-theme" data-base="{base}">:root{{color-scheme:dark;{DARK}{SHARED}}}@media (prefers-color-scheme: light){{:root{{color-scheme:light;{LIGHT}{SHARED}}}}}{BASE_CSS}</style><script>{BOOTSTRAP_SCRIPT}</script>"#
    );
    let at = doctype_end(html).unwrap_or(0);
    format!("{}{markup}{}", &html[..at], &html[at..])
}

/// Where the doctype ends, if the page opens with one, after whitespace and comments.
fn doctype_end(html: &str) -> Option<usize> {
    let mut at = 0;
    loop {
        let rest = html[at..].trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
        at = html.len() - rest.len();
        if let Some(comment) = rest.strip_prefix("<!--") {
            at += 4 + comment.find("-->")? + 3;
        } else if rest.get(..9)?.eq_ignore_ascii_case("<!doctype") {
            return Some(at + rest.find('>')? + 1);
        } else {
            return None;
        }
    }
}

/// Image types a local path may name, by extension.
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
];

/// Every local image the page names, as T3 finds them: an absolute path to a file with an image
/// extension that is a whole quoted string ("…", '…', `…`) or an unquoted CSS `url(…)`. URLs,
/// `data:`, and relative paths never match. Each is its byte range in `html`.
fn local_images(html: &str) -> Vec<(usize, usize)> {
    let bytes = html.as_bytes();
    let absolute = |at: usize| {
        let rest = &bytes[at..];
        (rest.first() == Some(&b'/') && rest.get(1) != Some(&b'/'))
            || (rest.len() > 2
                && rest[0].is_ascii_alphabetic()
                && rest[1] == b':'
                && matches!(rest[2], b'\\' | b'/'))
    };
    let image = |path: &str| {
        path.rsplit_once('.').is_some_and(|(_, extension)| {
            IMAGE_TYPES
                .iter()
                .any(|(known, _)| extension.eq_ignore_ascii_case(known))
        })
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let (start, end) = match bytes[at] {
            quote @ (b'"' | b'\'' | b'`') if at + 1 < bytes.len() && absolute(at + 1) => {
                let end = bytes[at + 1..]
                    .iter()
                    .take(2049)
                    .position(|&b| b == quote || b == b'\n' || b == b'\r')
                    .filter(|&n| bytes[at + 1 + n] == quote);
                (at + 1, end.map(|n| at + 1 + n))
            }
            b'u' if html[at..].starts_with("url(") => {
                let start = at
                    + 4
                    + bytes[at + 4..]
                        .iter()
                        .take_while(|b| b.is_ascii_whitespace())
                        .count();
                if start < bytes.len() && absolute(start) {
                    let end = bytes[start..]
                        .iter()
                        .take(2049)
                        .position(|&b| {
                            matches!(b, b')' | b'"' | b'\'' | b'`' | b'(')
                                || b.is_ascii_whitespace()
                        })
                        .map(|n| start + n);
                    (start, end)
                } else {
                    (start, None)
                }
            }
            _ => (at, None),
        };
        match end {
            Some(end) if html.is_char_boundary(end) && image(&html[start..end]) => {
                found.push((start, end));
                at = end + 1;
            }
            _ => at += 1,
        }
    }
    found
}

/// `html` with each local image replaced by a data URI, and the paths it couldn't read: missing,
/// not a file, or not an image whatever its name says (so a renamed secret can't ride along).
fn inline_images(html: &str) -> Result<(String, Vec<String>), String> {
    let mut out = String::with_capacity(html.len());
    let mut missing: Vec<String> = Vec::new();
    let mut cursor = 0;
    for (start, end) in local_images(html) {
        let reference = &html[start..end];
        // Inside a JS string, a Windows path's backslashes are escaped.
        let path = if reference.as_bytes()[0] == b'/' {
            reference.to_owned()
        } else {
            reference.replace("\\\\", "\\")
        };
        let bytes = std::fs::metadata(&path)
            .ok()
            .filter(|meta| meta.is_file() && meta.len() <= MAX_PAGE_BYTES as u64)
            .and_then(|_| std::fs::read(&path).ok())
            .filter(|bytes| is_image(bytes));
        let Some(bytes) = bytes else {
            if !missing.contains(&reference.to_owned()) {
                missing.push(reference.to_owned());
            }
            continue;
        };
        let extension = reference.rsplit_once('.').map_or("", |(_, e)| e);
        let mime = IMAGE_TYPES
            .iter()
            .find(|(known, _)| extension.eq_ignore_ascii_case(known))
            .map_or("application/octet-stream", |(_, mime)| mime);
        out.push_str(&html[cursor..start]);
        out.push_str("data:");
        out.push_str(mime);
        out.push_str(";base64,");
        out.push_str(&crate::images::encode(&bytes));
        cursor = end;
        if out.len() > MAX_PAGE_BYTES {
            break;
        }
    }
    out.push_str(&html[cursor..]);
    if out.len() > MAX_PAGE_BYTES {
        return Err(format!(
            "With its images inlined the page is over {} MiB, the limit. Use smaller images.",
            MAX_PAGE_BYTES / (1024 * 1024)
        ));
    }
    Ok((out, missing))
}

/// Whether `bytes` are an image file, by their first bytes, or an SVG document.
fn is_image(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(12)];
    if head.starts_with(b"\x89PNG")
        || head.starts_with(b"\xff\xd8\xff")
        || head.starts_with(b"GIF8")
        || head.starts_with(b"\0\0\x01\0")
        || (head.starts_with(b"BM") && head.get(6..10) == Some(b"\0\0\0\0"))
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP"))
        || matches!(
            head.get(4..12),
            Some(b"ftypavif" | b"ftypavis" | b"ftypmif1")
        )
    {
        return true;
    }
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let mut rest = text.trim_start();
    // Past processing instructions, comments, and a doctype without an internal subset.
    loop {
        let skip = if rest.starts_with("<?") {
            rest.find("?>").map(|n| n + 2)
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|n| n + 3)
        } else if rest
            .get(..9)
            .is_some_and(|d| d.eq_ignore_ascii_case("<!doctype"))
        {
            rest.find('>').map(|n| n + 1)
        } else {
            break;
        };
        let Some(skip) = skip else { return false };
        rest = rest[skip..].trim_start();
    }
    rest.starts_with("<svg")
        && matches!(
            rest.as_bytes().get(4),
            Some(b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'>')
        )
}

/// What a preview found.
struct Shot {
    png: String,
    content_height: u64,
    captured_height: u64,
    console: Vec<Value>,
}

/// What the page has done so far while it loads.
struct Load {
    body: String,
    main_frame: String,
    console: Vec<Value>,
    omitted: usize,
    loaded: Option<tokio::sync::oneshot::Sender<()>>,
}

// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE: &str = "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// The root's scroll height never drops below the viewport, so a short page reports its own box.
const MEASURE: &str = "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

/// Loads `page` in a fresh headless browser at `width`, and screenshots the top of it.
// ponytail: the page can reach this host's network, as the agent that wrote it can with its own
// commands; add T3's public-only proxy if pages ever come from someone else.
async fn preview(
    launcher: &Launcher,
    page: &str,
    width: u32,
    appearance: Appearance,
) -> Result<Shot, String> {
    let executable = browser::executable(launcher).await?;
    let browser = Browser::launch(
        launcher,
        &executable,
        &["--hide-scrollbars", "--block-new-web-contents"],
    )
    .await?;
    let mut tab = browser.page().await?;
    tokio::time::timeout(CAPTURE_TIMEOUT, capture(&mut tab, page, width, appearance))
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "Headless Chrome could not render the page: it did not finish loading within {} seconds.",
                CAPTURE_TIMEOUT.as_secs()
            ))
        })
}

async fn capture(
    tab: &mut browser::Page,
    page: &str,
    width: u32,
    appearance: Appearance,
) -> Result<Shot, String> {
    for method in ["Page.enable", "Runtime.enable", "Log.enable"] {
        tab.call(method, json!({})).await?;
    }
    tab.call(
        "Fetch.enable",
        json!({"patterns": [
            {"urlPattern": format!("{PAGE_ORIGIN}/*")},
            {"urlPattern": "*", "resourceType": "Document"},
        ]}),
    )
    .await?;
    tab.call(
        "Emulation.setDeviceMetricsOverride",
        json!({"width": width, "height": VIEWPORT_HEIGHT, "deviceScaleFactor": 1, "mobile": false}),
    )
    .await?;
    let scheme = match appearance {
        Appearance::Dark => "dark",
        Appearance::Light => "light",
    };
    tab.call(
        "Emulation.setEmulatedMedia",
        json!({"features": [{"name": "prefers-color-scheme", "value": scheme}]}),
    )
    .await?;

    let (loaded, on_load) = tokio::sync::oneshot::channel();
    let mut load = Load {
        body: crate::images::encode(page.as_bytes()),
        main_frame: tab.target.clone(),
        console: Vec::new(),
        omitted: 0,
        loaded: Some(loaded),
    };
    let browser::Page {
        browser,
        session,
        events,
        ..
    } = tab;
    let at = (&*browser, session.as_str());
    let call = |method: &'static str, params: Value| browser.call(method, params, Some(session));
    let navigated = drive(
        at,
        events,
        &mut load,
        async {
            let navigation = call("Page.navigate", json!({"url": PAGE_URL})).await?;
            if navigation["errorText"].is_string() {
                return Err(
                    "Headless Chrome could not render the page: the page could not be opened."
                        .to_owned(),
                );
            }
            on_load
                .await
                .map_err(|_| "The headless browser exited.".to_owned())
        },
        on_event,
    )
    .await;
    navigated?;
    drive(
        at,
        events,
        &mut load,
        call(
            "Runtime.evaluate",
            json!({"expression": SETTLE, "awaitPromise": true}),
        ),
        on_event,
    )
    .await?;
    let measured = drive(
        at,
        events,
        &mut load,
        call(
            "Runtime.evaluate",
            json!({"expression": MEASURE, "returnByValue": true}),
        ),
        on_event,
    )
    .await?;
    let content_height = measured["result"]["value"]
        .as_f64()
        .unwrap_or(0.0)
        .max(0.0)
        .ceil();
    // A height in CSS pixels, well within u64.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a non-negative whole number of pixels"
    )]
    let content_height = content_height as u64;
    let captured_height = content_height.clamp(1, MAX_CAPTURE_HEIGHT);
    let shot = drive(
        at,
        events,
        &mut load,
        call(
            "Page.captureScreenshot",
            json!({
                "format": "png",
                "captureBeyondViewport": true,
                "clip": {"x": 0, "y": 0, "width": width, "height": captured_height, "scale": 1},
            }),
        ),
        on_event,
    )
    .await?;
    let mut console = load.console;
    if load.omitted > 0 {
        console.push(json!({"level": "warning", "text": format!("{} more console messages were omitted.", load.omitted)}));
    }
    Ok(Shot {
        png: shot["data"].as_str().unwrap_or_default().to_owned(),
        content_height,
        captured_height,
        console,
    })
}

/// Serves the page, keeps the main frame on it, and collects its console.
fn on_event(load: &mut Load, event: &Event) -> Option<(&'static str, Value)> {
    let params = &event.params;
    match event.method.as_str() {
        "Page.loadEventFired" => {
            if let Some(loaded) = load.loaded.take() {
                let _ = loaded.send(());
            }
            None
        }
        "Fetch.requestPaused" => {
            let request = params["requestId"].clone();
            let url = params["request"]["url"].as_str().unwrap_or_default();
            let url = url.split('#').next().unwrap_or_default();
            if url == PAGE_URL {
                return Some((
                    "Fetch.fulfillRequest",
                    json!({
                        "requestId": request,
                        "responseCode": 200,
                        "responseHeaders": [{"name": "Content-Type", "value": "text/html; charset=utf-8"}],
                        "body": load.body,
                    }),
                ));
            }
            // A frame inside the page may show another site. The main frame and the page's own
            // origin serve nothing else.
            let other_frame = params["resourceType"] == "Document"
                && params["frameId"].as_str() != Some(&load.main_frame)
                && !url.starts_with(&format!("{PAGE_ORIGIN}/"));
            Some(if other_frame {
                ("Fetch.continueRequest", json!({"requestId": request}))
            } else {
                (
                    "Fetch.failRequest",
                    json!({"requestId": request, "errorReason": "AccessDenied"}),
                )
            })
        }
        method => {
            if let Some((level, text)) = console_message(method, params) {
                if load.console.len() >= MAX_CONSOLE_MESSAGES {
                    load.omitted += 1;
                } else {
                    let text = text.replace(PAGE_URL, PAGE_NAME);
                    let text = match text.char_indices().nth(MAX_CONSOLE_CHARS) {
                        Some((cut, _)) => format!("{}…", &text[..cut]),
                        None => text,
                    };
                    load.console.push(json!({"level": level, "text": text}));
                }
            }
            None
        }
    }
}

/// What the page logged, threw, or the browser reported loading it, as a level and text.
fn console_message(method: &str, params: &Value) -> Option<(&'static str, String)> {
    let text_of = |value: &Value| match &value["value"] {
        Value::String(text) => text.clone(),
        Value::Null => value["description"]
            .as_str()
            .or_else(|| value["type"].as_str())
            .unwrap_or_default()
            .to_owned(),
        other => value["description"]
            .as_str()
            .map_or_else(|| other.to_string(), ToOwned::to_owned),
    };
    match method {
        "Runtime.consoleAPICalled" => {
            let level = match params["type"].as_str()? {
                "log" | "debug" | "dir" | "dirxml" | "table" | "trace" => "log",
                "info" => "info",
                "warning" => "warning",
                "error" | "assert" => "error",
                _ => return None,
            };
            let args = params["args"].as_array()?;
            Some((
                level,
                args.iter().map(text_of).collect::<Vec<_>>().join(" "),
            ))
        }
        "Runtime.exceptionThrown" => {
            let details = &params["exceptionDetails"];
            let text = details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())?;
            Some(("error", text.to_owned()))
        }
        "Log.entryAdded" => {
            let entry = &params["entry"];
            let level = match entry["level"].as_str()? {
                "error" => "error",
                "warning" => "warning",
                _ => return None,
            };
            let text = entry["text"].as_str()?;
            Some((
                level,
                entry["url"]
                    .as_str()
                    .map_or_else(|| text.to_owned(), |url| format!("{text} {url}")),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        Appearance, bootstrap, console_message, inline_images, is_image, local_images, preview,
    };
    use crate::backend::process::{Environment, Launcher};
    use crate::paths::DataDir;

    /// Installs the real headless browser into `PLXD_TEST_DATA_DIR` the first time, about 100 MB.
    #[tokio::test]
    #[ignore = "downloads the headless browser; set PLXD_TEST_DATA_DIR"]
    async fn a_page_previews_with_its_height_console_and_screenshot() {
        let dir = DataDir::new(std::env::var("PLXD_TEST_DATA_DIR").unwrap()).unwrap();
        let launcher = Launcher::new(dir, Environment::inherited());
        let page = bootstrap(
            "<!doctype html><div style=\"height:300px;background:var(--accent)\">x</div><script>console.log('hello', 2); null.x</script>",
        );
        let shot = loop {
            match preview(&launcher, &page, 400, Appearance::Light).await {
                Err(error) if error.contains("Try again") => {}
                other => break other.unwrap(),
            }
        };
        assert_eq!(shot.content_height, 300);
        assert_eq!(shot.console[0]["text"], "hello 2");
        assert_eq!(shot.console[1]["level"], "error");
        let png = crate::images::decode(&shot.png).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        std::fs::write(std::env::temp_dir().join("plx-html-preview.png"), png).unwrap();
    }

    #[test]
    fn the_bootstrap_goes_after_the_doctype_or_first() {
        let page = bootstrap("<!-- hi --><!DOCTYPE html><html><head><title>x</title>");
        assert!(
            page.starts_with("<!-- hi --><!DOCTYPE html><meta name=\"viewport\""),
            "{page}"
        );
        assert!(page.contains("<style id=\"plx-theme\""));
        let bare = bootstrap("<p>hi</p>");
        assert!(bare.starts_with("<meta name=\"viewport\""), "{bare}");
        assert!(bare.ends_with("<p>hi</p>"));
        let own = bootstrap(r#"<meta name="viewport" content="width=400"><p>"#);
        assert!(own.starts_with("<style"), "{own}");
    }

    #[test]
    fn local_images_are_absolute_paths_with_an_image_extension() {
        let html = r#"<img src="/a/b.png"><img src='//cdn/x.png'><img src="rel.png"><div style="background:url( /c/d.WEBP )"></div>`C:\\x\\y.jpg` "/not/image.txt""#;
        let found: Vec<&str> = local_images(html)
            .into_iter()
            .map(|(s, e)| &html[s..e])
            .collect();
        assert_eq!(found, ["/a/b.png", "/c/d.WEBP", r"C:\\x\\y.jpg"]);
    }

    #[test]
    fn images_inline_and_unreadable_ones_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let fake = dir.path().join("secret.png");
        std::fs::write(&fake, b"TOKEN=abc").unwrap();
        let html = format!(
            r#"<img src="{}"><img src="{}"><img src="/nope.gif">"#,
            png.display(),
            fake.display()
        );
        let (page, missing) = inline_images(&html).unwrap();
        assert!(
            page.contains("src=\"data:image/png;base64,iVBORw0KGgpyZXN0\""),
            "{page}"
        );
        assert_eq!(
            missing,
            [fake.display().to_string(), "/nope.gif".to_owned()]
        );
    }

    #[test]
    fn svg_counts_as_an_image_by_its_root() {
        assert!(is_image(
            b"<?xml version=\"1.0\"?><!-- c --><svg xmlns=\"x\"/>"
        ));
        assert!(!is_image(b"<html><svg></svg></html>"));
    }

    #[test]
    fn console_events_become_levels_and_text() {
        let log = json!({"type": "warning", "args": [{"type": "string", "value": "a"}, {"type": "number", "value": 2, "description": "2"}]});
        assert_eq!(
            console_message("Runtime.consoleAPICalled", &log),
            Some(("warning", "a 2".to_owned()))
        );
        let thrown = json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "Error: x\n at page.html:1"}}});
        assert_eq!(
            console_message("Runtime.exceptionThrown", &thrown)
                .unwrap()
                .0,
            "error"
        );
        let info = json!({"entry": {"level": "info", "text": "x"}});
        assert_eq!(console_message("Log.entryAdded", &info), None);
    }
}
