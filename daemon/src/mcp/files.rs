//! `present_files` (PLX-755): shows documents the agent made, from its thread's folder, as cards in
//! the transcript. The app reads each through `agent/file`'s working side and shows it, view-only,
//! in the side panel, with Download.

use std::path::{Component, Path, PathBuf};

use parallax_protocol::methods::{AgentFile, AgentFiles};
use parallax_protocol::{AgentFileParams, AgentFileSide, AgentFilesParams};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Reply, parse, pretty};

/// The tools this module serves.
pub const TOOLS: &[&str] = &["present_files"];

/// What every thread's agent is told at startup, through MCP's `instructions` (PLX-755): without
/// it, agents build files in /tmp, install office suites to convert them, and describe a file
/// instead of showing it.
pub const INSTRUCTIONS: &str = "Parallax shows documents in its chat. When the user wants a document, spreadsheet, slide deck, or PDF, build it in your working folder, not /tmp, with Python libraries, pip-installing any that are missing: python-docx for .docx, openpyxl for .xlsx, python-pptx for .pptx, and reportlab for .pdf. Don't install LibreOffice, pandoc, or another office suite. When the files are done, call present_files with their paths before your final reply. The user previews and downloads them in Parallax, so don't explain how to open them.";

/// The largest file `present_files` takes: `agent/file`'s read cap, which the app reads it through.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The file types the app shows.
const KINDS: &[&str] = &["docx", "xlsx", "pptx", "pdf"];
const MAX_FILES: usize = 10;

/// `tools/list`'s entries for [`TOOLS`].
#[must_use]
pub fn definitions() -> Vec<Value> {
    vec![json!({
        "name": "present_files",
        "title": "Present files",
        "description": "Show finished documents to the reader as cards in this thread, with a preview of each file's first pages. The reader can open a card in Parallax's side panel to read it, and download it. Call it after you create or rebuild the files and before your final reply, which should not repeat what the cards show. Takes .docx, .xlsx, .pptx, and .pdf files of at most 4 MiB. Save them in your working folder; a file elsewhere, such as in /tmp, is copied into its top level first, replacing a file of the same name.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_FILES,
                    "items": {"type": "string", "minLength": 1},
                    "description": "The files, relative to your working folder or absolute, in the order to show them.",
                },
            },
            "required": ["paths"],
            "additionalProperties": false,
        },
        "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
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
    // plxd's word for the thread's folder, since a CLI may start this server elsewhere, as Codex
    // does in plxd's data folder. ponytail: lists the folder's top level to learn its path; add a
    // method of its own if that's ever slow.
    let listed = binding
        .plxd
        .call::<AgentFiles>(AgentFilesParams {
            run_id: binding.run,
            path: None,
        })
        .await?;
    let folder = PathBuf::from(
        listed
            .folder
            .ok_or("this plxd is too old to tell its thread's folder; restart it")?,
    );
    let mut files = Vec::new();
    let mut copied = Vec::new();
    for asked in &args.paths {
        let kind = Path::new(asked)
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .filter(|ext| KINDS.contains(&ext.as_str()))
            .ok_or_else(|| format!("{asked} is not a .docx, .xlsx, .pptx, or .pdf file"))?;
        let path = if let Some(path) = relative(&folder, asked)? {
            path
        } else {
            let path = copy_in(&folder, Path::new(asked))?;
            copied.push(format!("{asked} to {path}"));
            path
        };
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
    let message = if copied.is_empty() {
        "Shown to the reader as cards above your reply.".to_owned()
    } else {
        format!(
            "Shown to the reader as cards above your reply. Copied into your working folder: {}. Work on those copies from now on.",
            copied.join(", ")
        )
    };
    Ok(pretty(&json!({
        "presentedFiles": files,
        "message": message,
    }))
    .into())
}

/// `asked` as a `/`-separated path relative to `folder`, by `agent/file`'s rules, or `None` for an
/// absolute path outside `folder`. A relative path may not climb out of it.
fn relative(folder: &Path, asked: &str) -> Result<Option<String>, String> {
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
        match path.strip_prefix(&folder) {
            Ok(inner) => inner.to_path_buf(),
            Err(_) => return Ok(None),
        }
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
    Ok(Some(parts.join("/")))
}

/// A file saved outside `folder`, copied into its top level under its own name, replacing an
/// earlier copy, so the app can read it. Its name. Never writes through a symlink or over a folder.
fn copy_in(folder: &Path, source: &Path) -> Result<String, String> {
    let shown = source.display();
    let meta = std::fs::metadata(source).map_err(|_| format!("{shown} doesn't exist"))?;
    if !meta.is_file() {
        return Err(format!("{shown} is not a file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("{shown} is over 4 MiB, too large to show"));
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{shown} has no usable file name"))?;
    let target = folder.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(existing) if !existing.is_file() => {
            return Err(format!("{name} in your working folder is not a file"));
        }
        _ => {}
    }
    std::fs::copy(source, &target)
        .map_err(|error| format!("couldn't copy {shown} into your working folder: {error}"))?;
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{copy_in, relative};

    #[test]
    fn paths_resolve_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        std::fs::create_dir(folder.join("out")).unwrap();
        std::fs::write(folder.join("out/a.docx"), b"").unwrap();
        let inside = |asked: &str| relative(folder, asked).unwrap();
        assert_eq!(inside("out/a.docx").as_deref(), Some("out/a.docx"));
        assert_eq!(inside("./out/a.docx").as_deref(), Some("out/a.docx"));
        let absolute = folder.join("out/a.docx");
        assert_eq!(
            inside(absolute.to_str().unwrap()).as_deref(),
            Some("out/a.docx")
        );
        assert!(relative(folder, "../a.docx").is_err());
        assert!(relative(folder, "out/../../a.docx").is_err());
        // Outside the folder, by an absolute path on any OS: copied in, not refused.
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join("b.docx");
        std::fs::write(&outside, b"").unwrap();
        assert_eq!(relative(folder, outside.to_str().unwrap()), Ok(None));
    }

    #[test]
    fn a_file_outside_is_copied_in_but_never_over_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("thread");
        std::fs::create_dir(&folder).unwrap();
        let source = dir.path().join("Summary.docx");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(folder.join("Summary.docx"), b"old").unwrap();
        assert_eq!(copy_in(&folder, &source).unwrap(), "Summary.docx");
        assert_eq!(std::fs::read(folder.join("Summary.docx")).unwrap(), b"new");

        assert!(copy_in(&folder, &dir.path().join("missing.docx")).is_err());
        std::fs::create_dir(folder.join("Folder.docx")).unwrap();
        let named = dir.path().join("Folder.docx");
        std::fs::write(&named, b"new").unwrap();
        assert!(copy_in(&folder, &named).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_never_writes_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("thread");
        std::fs::create_dir(&folder).unwrap();
        let elsewhere = dir.path().join("elsewhere.docx");
        std::fs::write(&elsewhere, b"keep").unwrap();
        let linked = dir.path().join("Linked.docx");
        std::fs::write(&linked, b"new").unwrap();
        std::os::unix::fs::symlink(&elsewhere, folder.join("Linked.docx")).unwrap();
        assert!(copy_in(&folder, &linked).is_err());
        assert_eq!(std::fs::read(&elsewhere).unwrap(), b"keep");
    }
}
