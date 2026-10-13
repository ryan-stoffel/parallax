//! `present_files` (PLX-755): shows documents the agent made, from its thread's folder, as cards in
//! the transcript. The app reads each through `agent/file`'s working side, opens it in the side
//! panel, and saves the user's edits with `agent/fileWrite`, then tells the thread what changed.

use std::path::{Component, Path};

use parallax_protocol::methods::AgentFile;
use parallax_protocol::{AgentFileParams, AgentFileSide};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Reply, parse, pretty};

/// The tools this module serves.
pub const TOOLS: &[&str] = &["present_files"];

/// The file types the app shows. docx and xlsx are editable there; pptx and pdf are view-only.
const KINDS: &[&str] = &["docx", "xlsx", "pptx", "pdf"];
const MAX_FILES: usize = 10;

/// `tools/list`'s entries for [`TOOLS`].
#[must_use]
pub fn definitions() -> Vec<Value> {
    vec![json!({
        "name": "present_files",
        "title": "Present files",
        "description": "Show finished documents to the reader as cards in this thread, with a preview of each file's first pages. The reader can open a card in Parallax's side panel to read it, edit .docx and .xlsx files there, and download any of them. Call it after you create or rebuild the files and before your final reply, which should not repeat what the cards show. Takes .docx, .xlsx, .pptx, and .pdf files of at most 4 MiB inside your working folder; save files there, not in /tmp. When the reader saves an edit, you get a message naming the file and what changed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_FILES,
                    "items": {"type": "string", "minLength": 1},
                    "description": "The files, relative to your working folder or absolute inside it, in the order to show them.",
                },
            },
            "required": ["paths"],
            "additionalProperties": false,
        },
        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
    })]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresentArgs {
    paths: Vec<String>,
}

/// Runs `name`, one of [`TOOLS`].
///
/// # Errors
///
/// What went wrong, for the model.
pub async fn call(binding: &Binding, name: &str, arguments: Value) -> Result<Reply, String> {
    if name != "present_files" {
        return Err(format!("no tool is named {name:?}"));
    }
    let args: PresentArgs = parse(arguments)?;
    if args.paths.is_empty() || args.paths.len() > MAX_FILES {
        return Err(format!("paths must list 1 to {MAX_FILES} files"));
    }
    // The CLI starts this server in the thread's folder.
    let folder = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for asked in &args.paths {
        let path = relative(&folder, asked)?;
        let kind = Path::new(&path)
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .filter(|ext| KINDS.contains(&ext.as_str()))
            .ok_or_else(|| format!("{asked} is not a .docx, .xlsx, .pptx, or .pdf file"))?;
        let file = binding
            .plxd
            .call::<AgentFile>(AgentFileParams {
                run_id: binding.run,
                path: path.clone(),
                side: AgentFileSide::Working,
                size_only: Some(true),
            })
            .await?;
        if !file.exists {
            return Err(format!("{asked} isn't in your working folder"));
        }
        if file.too_large {
            return Err(format!("{asked} is over 4 MiB, too large to show"));
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        files.push(json!({"path": path, "name": name, "kind": kind}));
    }
    Ok(pretty(&json!({
        "presentedFiles": files,
        "message": "Shown to the reader as cards above your reply.",
    }))
    .into())
}

/// `asked` as a `/`-separated path relative to `folder`, by `agent/file`'s rules: absolute paths
/// must be inside `folder`, and no path may climb out of it.
fn relative(folder: &Path, asked: &str) -> Result<String, String> {
    let outside = || {
        format!(
            "{asked} is outside your working folder {}",
            folder.display()
        )
    };
    let path = Path::new(asked);
    let inner = if path.is_absolute() {
        // Either side may run through a symlink, such as macOS's /var.
        let folder = folder
            .canonicalize()
            .unwrap_or_else(|_| folder.to_path_buf());
        let path = path
            .canonicalize()
            .map_err(|_| format!("{asked} doesn't exist"))?;
        path.strip_prefix(&folder)
            .map_err(|_| outside())?
            .to_path_buf()
    } else {
        path.to_path_buf()
    };
    let mut parts = Vec::new();
    for part in inner.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(outside()),
        }
    }
    if parts.is_empty() {
        return Err(outside());
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::relative;
    use std::path::Path;

    #[test]
    fn paths_resolve_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        std::fs::create_dir(folder.join("out")).unwrap();
        std::fs::write(folder.join("out/a.docx"), b"").unwrap();
        assert_eq!(relative(folder, "out/a.docx").unwrap(), "out/a.docx");
        assert_eq!(relative(folder, "./out/a.docx").unwrap(), "out/a.docx");
        let absolute = folder.join("out/a.docx");
        assert_eq!(
            relative(folder, absolute.to_str().unwrap()).unwrap(),
            "out/a.docx"
        );
        assert!(relative(folder, "../a.docx").is_err());
        assert!(relative(folder, "out/../../a.docx").is_err());
        assert!(relative(Path::new("/nonexistent-folder"), "/etc/hosts").is_err());
    }
}
