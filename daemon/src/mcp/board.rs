//! An orchestrator's board tools (PLX-940, decision 0081): `board_add`, `board_update`,
//! and `board_remove`, each one change to one item of the status board, through `board/*`.
//! Parallax renders `notes.md` from the items, so these are the only way to change it. Only a
//! orchestrator gets them.

use parallax_protocol::methods::{BoardAdd, BoardList, BoardRemove, BoardUpdate};
use parallax_protocol::{
    BoardAddParams, BoardLinks, BoardListParams, BoardRemoveParams, BoardSection, BoardStatus,
    BoardUpdateParams, RunId, ScopeId,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{object, parse, pretty, tool};

/// The tools an orchestrator gets from this module.
pub const TOOLS: &[&str] = &["board_add", "board_update", "board_remove"];

/// [`TOOLS`] for an orchestrator, and none for anyone else.
#[must_use]
pub fn tools(orchestrator_run: bool) -> &'static [&'static str] {
    if orchestrator_run { TOOLS } else { &[] }
}

/// The definitions of [`tools`], in its order.
#[must_use]
pub fn definitions(orchestrator_run: bool) -> Vec<Value> {
    if !orchestrator_run {
        return Vec::new();
    }
    let id = json!({"type": "integer", "description": "The item's id, which ends its line in notes.md as `id N`."});
    let text = json!({"type": "string", "description": "One line of Markdown: a short bold lead, then a detail, such as `**Search command**: one subagent adds it, with tests`."});
    let section = json!({"type": "string", "enum": ["now", "next", "risks"], "description": "now for work under way, next for what's planned, risks for blockers and open questions."});
    let status = json!({"type": "string", "enum": ["open", "done"]});
    let threads = json!({"type": "array", "items": {"type": "string"}, "maxItems": 20, "description": "Run ids of the threads doing or tracking it."});
    let pull_request = json!({"type": "string", "description": "Its pull request's https:// URL. Only one you know; never make one up. An empty string clears it."});
    let files = json!({"type": "array", "items": {"type": "string"}, "maxItems": 20, "description": "Files it concerns: repository paths or shared context files such as plan.md."});
    vec![
        tool(
            "board_add",
            "Add an item to the orchestrator's status board, which Parallax renders as notes.md. Returns the item with its id.",
            object(
                json!({
                    "text": text,
                    "section": section,
                    "status": status,
                    "threads": threads,
                    "pullRequest": pull_request,
                    "files": files,
                }),
                &["text", "section"],
            ),
            false,
        ),
        tool(
            "board_update",
            "Change one board item: only the fields you pass. Mark finished work done rather than removing it; Parallax moves done items older than seven days to archived.md. Each link field you pass replaces that field.",
            object(
                json!({
                    "id": id,
                    "text": text,
                    "section": section,
                    "status": status,
                    "threads": threads,
                    "pullRequest": pull_request,
                    "files": files,
                }),
                &["id"],
            ),
            false,
        ),
        tool(
            "board_remove",
            "Remove one board item that no longer belongs on it, such as a plan dropped or a duplicate.",
            object(json!({"id": id}), &["id"]),
            false,
        ),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ItemArgs {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    section: Option<BoardSection>,
    #[serde(default)]
    status: Option<BoardStatus>,
    #[serde(default)]
    threads: Option<Vec<RunId>>,
    #[serde(default)]
    pull_request: Option<String>,
    #[serde(default)]
    files: Option<Vec<String>>,
}

impl ItemArgs {
    fn has_links(&self) -> bool {
        self.threads.is_some() || self.pull_request.is_some() || self.files.is_some()
    }

    /// `links` with each link field these arguments name replaced.
    fn links(&mut self, links: BoardLinks) -> BoardLinks {
        BoardLinks {
            threads: self.threads.take().unwrap_or(links.threads),
            pull_request: match self.pull_request.take() {
                Some(url) if url.is_empty() => None,
                Some(url) => Some(url),
                None => links.pull_request,
            },
            files: self.files.take().unwrap_or(links.files),
        }
    }
}

/// A board tool on `orchestrator`, the caller's Orchestrator when it is its orchestrator.
pub(super) async fn call(
    binding: &Binding,
    orchestrator: Option<ScopeId>,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    let orchestrator = orchestrator.ok_or("only an orchestrator edits its board")?;
    let mut args: ItemArgs = parse(arguments)?;
    let plxd = &binding.plxd;
    match name {
        "board_add" => {
            let text = args.text.take().ok_or("text is required")?;
            let section = args.section.take().ok_or("section is required")?;
            let links = args.has_links().then(|| args.links(BoardLinks::default()));
            let item = plxd
                .call::<BoardAdd>(BoardAddParams {
                    orchestrator,
                    text,
                    section,
                    status: args.status,
                    links,
                })
                .await?
                .item;
            Ok(pretty(&item))
        }
        "board_update" => {
            let id = args.id.ok_or("id is required")?;
            let links = if args.has_links() {
                let items = plxd
                    .call::<BoardList>(BoardListParams { orchestrator })
                    .await?
                    .items;
                let item = items
                    .into_iter()
                    .find(|item| item.id == id)
                    .ok_or_else(|| format!("the board has no item {id}"))?;
                Some(args.links(item.links))
            } else {
                None
            };
            let item = plxd
                .call::<BoardUpdate>(BoardUpdateParams {
                    orchestrator,
                    id,
                    text: args.text,
                    section: args.section,
                    status: args.status,
                    links,
                })
                .await?
                .item;
            Ok(pretty(&item))
        }
        "board_remove" => {
            let id = args.id.ok_or("id is required")?;
            let removed = plxd
                .call::<BoardRemove>(BoardRemoveParams { orchestrator, id })
                .await?
                .removed;
            if removed {
                Ok(format!("Removed item {id}."))
            } else {
                Err(format!("the board has no item {id}"))
            }
        }
        other => Err(format!("no tool is named {other:?}")),
    }
}
