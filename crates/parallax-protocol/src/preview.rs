//! Agents' browser tabs (PLX-639): T3 Code's `preview_*` tools, which a thread's `plxd mcp` runs
//! with `preview/call`, and the app's view of them in its side panel: `preview/list`,
//! `preview/frame`, and `preview/input`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::RunId;

/// Params of `preview/call`: one of thread `runId`'s `preview_*` tools, as its MCP call named it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCallParams {
    /// The calling thread.
    pub run_id: RunId,
    /// The tool, such as `preview_click`.
    pub tool: String,
    /// The tool's arguments.
    pub arguments: Value,
}

/// Result of `preview/call`: what the tool answers the model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCallResult {
    /// The text, JSON in T3's shape when the tool worked.
    pub text: String,
    /// A PNG of the page, in base64, when the tool returns one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub image: Option<String>,
    /// Whether `text` says why the tool failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub error: bool,
}

/// Params of `preview/list`: one thread's tabs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListParams {
    /// The thread.
    pub run_id: RunId,
}

/// Result of `preview/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListResult {
    /// The thread's tabs, oldest first.
    pub tabs: Vec<PreviewTab>,
}

/// An agent's browser tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTab {
    /// Its id within its thread, such as `tab-1`.
    pub tab_id: String,
    /// The page it shows.
    pub url: String,
    /// The page's title, when known.
    pub title: String,
    /// Whether the page is loading.
    pub loading: bool,
    /// Whether the user controls it, so the agent's actions wait.
    pub human: bool,
    /// Whether the agent is recording it.
    pub recording: bool,
}

/// Params of `preview/frame`: the tab's newest frame after `after`. plxd waits up to 10 s for
/// one, then answers with the last.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrameParams {
    /// The thread.
    pub run_id: RunId,
    /// The tab.
    pub tab_id: String,
    /// The last frame's `seq` the caller has, 0 for none.
    pub after: u64,
}

/// Result of `preview/frame`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrameResult {
    /// The frame's number, 0 before the first.
    pub seq: u64,
    /// The frame, a JPEG in base64, empty before the first.
    pub data: String,
    /// The page's width in CSS pixels, which input coordinates use.
    pub width: u32,
    /// The page's height in CSS pixels.
    pub height: u32,
    /// The tab as it stands.
    pub tab: PreviewTab,
}

/// Params of `preview/input`: the user's input to a tab. Anything but handing control back or
/// sizing the viewport takes control first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInputParams {
    /// The thread.
    pub run_id: RunId,
    /// The tab.
    pub tab_id: String,
    /// The input.
    pub input: PreviewInput,
}

/// One piece of the user's input. Coordinates are the page's CSS pixels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PreviewInput {
    /// Takes control of the tab, or hands it back to the agent.
    Control {
        /// True to take it.
        take: bool,
    },
    /// A mouse button or move.
    Mouse {
        /// Down, up, or a move.
        event: PreviewMouse,
        /// Where, from the page's left.
        x: f64,
        /// Where, from the page's top.
        y: f64,
        /// `left`, `middle`, or `right`, for a press or release.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        button: Option<String>,
        /// 1 for a click, 2 for a double-click.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        click_count: Option<u8>,
        /// Alt 1, Control 2, Meta 4, Shift 8, as `DevTools` adds them.
        modifiers: u8,
    },
    /// A wheel turn.
    Wheel {
        /// Where, from the page's left.
        x: f64,
        /// Where, from the page's top.
        y: f64,
        /// How far right, in CSS pixels.
        delta_x: f64,
        /// How far down, in CSS pixels.
        delta_y: f64,
    },
    /// A key going down or up.
    Key {
        /// True going down, false coming up.
        down: bool,
        /// The key as the DOM names it, such as `a` or `Enter`.
        key: String,
        /// The physical key, such as `KeyA`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<String>,
        /// What it types, for a key that types.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
        /// Alt 1, Control 2, Meta 4, Shift 8.
        modifiers: u8,
    },
    /// The size the app shows the tab at, in CSS pixels, which a tab in fill mode takes as its
    /// viewport, as T3's fill follows its panel.
    Viewport {
        /// The width.
        width: u32,
        /// The height.
        height: u32,
    },
    /// The address bar: opens a page.
    Navigate {
        /// The page, as the address bar's text.
        url: String,
    },
}

/// A mouse event's kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PreviewMouse {
    /// A button goes down.
    Down,
    /// A button comes up.
    Up,
    /// The pointer moves.
    Move,
}

/// Result of `preview/input`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInputResult {}
