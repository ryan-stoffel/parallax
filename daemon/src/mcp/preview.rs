//! The `preview_*` browser tools (PLX-639): T3 Code's names, inputs, and results, with
//! `t3_preview_list` and `t3_preview_close` as `preview_list` and `preview_close`. plxd runs them
//! in its headless browser ([`crate::preview`]); this module lists them and forwards each call
//! with `preview/call`.

use parallax_protocol::PreviewCallParams;
use parallax_protocol::methods::PreviewCall;
use serde_json::Value;

use super::Reply;
use super::thread::Binding;

/// The tools this module serves.
pub const TOOLS: &[&str] = &[
    "preview_status",
    "preview_open",
    "preview_dialog",
    "preview_navigate",
    "preview_resize",
    "preview_set_appearance",
    "preview_snapshot",
    "preview_click",
    "preview_type",
    "preview_hover",
    "preview_select",
    "preview_drag",
    "preview_upload",
    "preview_press",
    "preview_scroll",
    "preview_evaluate",
    "preview_wait_for",
    "preview_recording_start",
    "preview_recording_stop",
    "preview_list",
    "preview_close",
];

/// `tools/list`'s entries for [`TOOLS`]: T3's schemas and descriptions, as JSON, which keeps them
/// out of plxd's code.
#[must_use]
pub fn definitions() -> Vec<Value> {
    serde_json::from_str(include_str!("preview/tools.json")).unwrap_or_default()
}

/// Runs `name`, one of [`TOOLS`], in plxd's browser.
///
/// # Errors
///
/// What went wrong, for the model.
pub async fn call(binding: &Binding, name: &str, arguments: Value) -> Result<Reply, String> {
    let result = binding
        .plxd
        .call::<PreviewCall>(PreviewCallParams {
            run_id: binding.run,
            tool: name.to_owned(),
            arguments,
        })
        .await?;
    if result.error {
        return Err(result.text);
    }
    Ok(Reply {
        text: result.text,
        png: result.image.as_deref().and_then(crate::images::decode),
    })
}

#[cfg(test)]
mod tests {
    use super::{TOOLS, definitions};

    #[test]
    fn every_tool_has_one_definition_with_tab_targeting() {
        let tools = definitions();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, TOOLS);
        let click = &tools[7]["inputSchema"]["properties"];
        for field in [
            "tabId",
            "locator",
            "selector",
            "x",
            "y",
            "button",
            "clickCount",
        ] {
            assert!(click.get(field).is_some(), "preview_click lacks {field}");
        }
    }
}
