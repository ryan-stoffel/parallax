//! `present_files` (PLX-755): shows documents the agent made, from its thread's folder, as cards in
//! the transcript, images and videos large in it (PLX-785), and any other file as one to download
//! (0074). The app reads each through `agent/file`'s working side, in slices, and shows it,
//! view-only, with Download. A Project's child's files are also copied into the Project's
//! `artifacts/<thread>/`, so they outlive its worktree (PLX-941).

use std::path::{Component, Path, PathBuf};

use parallax_protocol::methods::{AgentFile, AgentFiles, ContextSaveArtifact};
use parallax_protocol::{
    AgentFileParams, AgentFileSide, AgentFilesParams, ContextSaveArtifactParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Reply, parse, pretty};

/// The tools this module serves.
pub const TOOLS: &[&str] = &["present_files"];

/// What every thread's agent is told at startup, through MCP's `instructions` (PLX-755): without
/// it, agents build files in /tmp, install office suites to convert them, and describe a file
/// instead of showing it.
pub const INSTRUCTIONS: &str = "Parallax shows documents in its chat. When the user wants a document, spreadsheet, slide deck, or PDF, build it in your working folder, not /tmp, with Python libraries, pip-installing any that are missing: python-docx for .docx, openpyxl for .xlsx, python-pptx for .pptx, and reportlab for .pdf. Don't install LibreOffice, pandoc, or another office suite. When the files are done, call present_files with their paths before your final reply. Present images and videos you make for the user, such as screenshots and recordings, the same way. The user previews and downloads them in Parallax, so don't explain how to open them.";

/// The largest file `present_files` takes, which the app reads in `agent/file` slices (0074).
const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// The file types the app shows: documents as cards, images and videos inline. Any other file's
/// kind is `file`.
const KINDS: &[&str] = &[
    "docx", "xlsx", "pptx", "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov",
];
const MAX_FILES: usize = 10;

/// `tools/list`'s entries for [`TOOLS`].
#[must_use]
pub fn definitions() -> Vec<Value> {
    vec![json!({
        "name": "present_files",
        "title": "Present files",
        "description": "Show finished files to the reader in this thread. A document (.docx, .xlsx, .pptx, .pdf) shows as a card with a preview of its first pages, which the reader can open in Parallax's side panel; an image or video (.png, .jpg, .jpeg, .gif, .webp, .mp4, .webm, .mov) shows full width, playable; any other file, such as a .zip or .csv, shows as a file to download. The reader can download each. Call it after you create or rebuild the files and before your final reply, which should not repeat what they show. Takes files of at most 256 MiB. Save them in your working folder; a document, image, or video elsewhere, such as in /tmp, is copied into its top level first, replacing a file of the same name.",
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

/// Runs `name`, one of [`TOOLS`], for a Project's child when `child` is set.
///
/// # Errors
///
/// What went wrong, for the model.
pub async fn call(
    binding: &Binding,
    child: bool,
    name: &str,
    arguments: Value,
) -> Result<Reply, String> {
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
        let known = Path::new(asked)
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .filter(|ext| KINDS.contains(&ext.as_str()));
        let path = if let Some(path) = relative(&folder, asked)? {
            path
        } else {
            // Only the kinds it always copied in, so a call can't pull a key or a credentials
            // file into the folder, where the next commit would take it.
            if known.is_none() {
                return Err(format!(
                    "{asked} is outside your working folder; copy it in first, since only a document, image, or video is copied in for you"
                ));
            }
            // Up to 256 MiB, so off this server's one thread, where other calls run.
            let (into, source) = (folder.clone(), PathBuf::from(asked));
            let path = tokio::task::spawn_blocking(move || copy_in(&into, &source))
                .await
                .map_err(|error| {
                    format!("couldn't copy {asked} into your working folder: {error}")
                })??;
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
                offset: None,
                length: None,
            })
            .await?;
        if !file.exists {
            return Err(format!("{asked} isn't in your working folder"));
        }
        if file.size.unwrap_or(0) > MAX_BYTES {
            return Err(format!("{asked} is over 256 MiB, too large to show"));
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let kind = known.unwrap_or_else(|| "file".to_owned());
        files.push(json!({"path": path, "name": name, "kind": kind}));
    }
    let mut message = if copied.is_empty() {
        "Shown to the reader above your reply.".to_owned()
    } else {
        format!(
            "Shown to the reader above your reply. Copied into your working folder: {}. Work on those copies from now on.",
            copied.join(", ")
        )
    };
    if child {
        message.push_str(&save_artifacts(binding, &files).await);
    }
    Ok(pretty(&json!({
        "presentedFiles": files,
        "message": message,
    }))
    .into())
}

/// Copies each of `files` into the Project's `artifacts/<thread>/`, and what to tell the model
/// about it. A failure doesn't fail the presentation, which already happened.
async fn save_artifacts(binding: &Binding, files: &[Value]) -> String {
    let mut failed = Vec::new();
    for path in files.iter().filter_map(|file| file["path"].as_str()) {
        let params = ContextSaveArtifactParams {
            run_id: binding.run,
            path: path.to_owned(),
        };
        if let Err(error) = binding.plxd.call::<ContextSaveArtifact>(params).await {
            failed.push(format!("{path} ({error})"));
        }
    }
    if failed.is_empty() {
        " Saved in your Project's artifacts.".to_owned()
    } else {
        format!(
            " Not saved in your Project's artifacts: {}.",
            failed.join(", ")
        )
    }
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
        return Err(format!("{shown} is over 256 MiB, too large to show"));
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
    use super::relative;

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
}
