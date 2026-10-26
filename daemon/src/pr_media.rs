//! `pr/uploadMedia` (PLX-1020): commits screenshots and recordings for pull request bodies, as the
//! `upload-media-pr` skill's `upload.sh` did, so agents stop spending the shared GitHub quota on
//! parallel, retried, and repeated uploads.
//!
//! Storage matches the script, so its embeds keep working: each file is one contents API commit
//! to the repository's [`BRANCH`] branch, created from the default branch on first use, at
//! `pr-media/<YYYYMMDD-HHMMSS>-<hash>-<name>`. The link is
//! `raw.githubusercontent.com/<repo>/<commit>/<path>`, pinned to the commit; the script's
//! `blob/...?raw=true` links render broken.
//!
//! Uploads wait their turn in [`QUEUE`], one at a time per host, and wait out a rate limit with
//! [`BACKOFF`]. The index in the data folder's [`INDEX`] maps each repository's uploaded SHA-256s
//! to their links, so the same bytes again cost no GitHub call, across restarts.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{PrMediaFile, PrMediaUploaded, PrUploadMediaParams, PrUploadMediaResult};
use tracing::warn;

use crate::server::Daemon;
use crate::worktree::{WorktreeManager, github_pr_urls};

/// The branch, and the folder on it, that the files go to, as `upload.sh` uses.
const BRANCH: &str = "pr-media";

/// The largest file uploaded.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Extensions embedded as images, and those linked as videos, lowercase.
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const VIDEOS: &[&str] = &["mp4", "mov", "webm"];

/// Waits before each retry of a call GitHub refused for a rate limit, primary or secondary.
/// GitHub asks for at least a minute after a secondary limit.
const BACKOFF: [Duration; 3] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
];

/// The dedupe index's file in the data folder: `{ "<owner>/<repo>": { "<sha256>": "<url>" } }`.
const INDEX: &str = "pr-media.json";

/// The host's upload queue: held for a whole call, so uploads run one at a time.
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Repository, lowercase, to SHA-256 to link.
type Index = BTreeMap<String, BTreeMap<String, String>>;

/// A file checked for upload.
#[derive(Debug)]
struct Media {
    /// The path as asked.
    asked: String,
    /// Its name, reduced to `[A-Za-z0-9._-]` so the path needs no URL encoding.
    name: String,
    caption: String,
    video: bool,
}

/// `pr/uploadMedia`: checks every file, then uploads them in order once it is this call's turn.
pub(crate) async fn upload(
    daemon: &Daemon,
    params: PrUploadMediaParams,
) -> Result<PrUploadMediaResult, ErrorObject> {
    let repo = repository(&params.url).ok_or_else(|| {
        ErrorObject::invalid_params(format!("{:?} is not a GitHub pull request URL", params.url))
    })?;
    if params.files.is_empty() {
        return Err(ErrorObject::invalid_params("pass at least one file"));
    }
    let files = params
        .files
        .iter()
        .map(check)
        .collect::<Result<Vec<_>, _>>()
        .map_err(ErrorObject::invalid_params)?;
    let _turn = QUEUE.lock().await;
    let gh = daemon.agents.worktrees();
    let index = daemon.data_dir.root().join(INDEX);
    let now = jiff::Zoned::now().strftime("%Y%m%d-%H%M%S").to_string();
    let files = upload_all(&index, &repo, files, &now, |path, bytes| {
        put(gh, &repo, path, bytes)
    })
    .await
    .map_err(|error| ErrorObject::invalid_params(format!("could not upload: {error}")))?;
    Ok(PrUploadMediaResult { files })
}

/// Uploads each of `files` to `repo` with `put`, which commits bytes at a path and returns the
/// commit, unless the index at `index` has the same bytes for `repo`. Records each upload as it
/// lands, so a failure part way keeps the ones before it.
async fn upload_all<F: Future<Output = Result<String, String>>>(
    index: &Path,
    repo: &str,
    files: Vec<Media>,
    now: &str,
    mut put: impl FnMut(String, Vec<u8>) -> F,
) -> Result<Vec<PrMediaUploaded>, String> {
    let mut known = load(index);
    let key = repo.to_ascii_lowercase();
    let mut uploaded = Vec::with_capacity(files.len());
    for media in files {
        let bytes = tokio::fs::read(&media.asked)
            .await
            .map_err(|error| format!("could not read {}: {error}", media.asked))?;
        let hash = crate::sha256_hex(&bytes);
        let found = known.get(&key).and_then(|urls| urls.get(&hash)).cloned();
        let reused = found.is_some();
        let url = if let Some(url) = found {
            url
        } else {
            let path = media_path(now, &hash, &media.name);
            let commit = put(path.clone(), bytes).await?;
            let url = raw_url(repo, &commit, &path);
            known
                .entry(key.clone())
                .or_default()
                .insert(hash, url.clone());
            if let Err(error) = save(index, &known) {
                warn!(%error, "could not save the pull request media index");
            }
            url
        };
        uploaded.push(PrMediaUploaded {
            markdown: embed(&media.caption, &url, media.video),
            path: media.asked,
            url,
            reused,
        });
    }
    Ok(uploaded)
}

/// A file that can be uploaded: an absolute path to an image or video of at most [`MAX_BYTES`].
fn check(file: &PrMediaFile) -> Result<Media, String> {
    let path = Path::new(&file.path);
    if !path.is_absolute() {
        return Err(format!("{:?} is not an absolute path", file.path));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let video = VIDEOS.contains(&extension.as_str());
    if !video && !IMAGES.contains(&extension.as_str()) {
        return Err(format!(
            "{} is not an image or video; pass {} or {} files",
            file.path,
            IMAGES.join(", "),
            VIDEOS.join(", ")
        ));
    }
    let size = std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)
        .ok_or_else(|| format!("{} is not a file", file.path))?
        .len();
    if size > MAX_BYTES {
        return Err(format!(
            "{} is {size} bytes, over the {MAX_BYTES}-byte cap; lower its frame rate or size",
            file.path
        ));
    }
    let original = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = original
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let caption = file
        .caption
        .as_deref()
        .map(str::trim)
        .filter(|caption| !caption.is_empty())
        .unwrap_or(&original)
        .replace(['[', ']', '\n', '\r'], " ");
    Ok(Media {
        asked: file.path.clone(),
        name,
        caption,
        video,
    })
}

/// `owner/repo` of pull request `url`.
fn repository(url: &str) -> Option<String> {
    if github_pr_urls(url) != [url] {
        return None;
    }
    let mut parts = url.strip_prefix("https://github.com/")?.split('/');
    Some(format!("{}/{}", parts.next()?, parts.next()?))
}

/// Where a file goes on [`BRANCH`]: `upload.sh`'s `pr-media/<time>-<name>`, with the hash's
/// first 8 digits between, so two same-named files in one second don't collide.
fn media_path(now: &str, hash: &str, name: &str) -> String {
    format!("{BRANCH}/{now}-{}-{name}", &hash[..8])
}

/// The file at `path` in `repo`, pinned to `commit`.
fn raw_url(repo: &str, commit: &str, path: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/{commit}/{path}")
}

/// The Markdown to paste: an image embed, or for a video a link, since GitHub plays only the
/// videos it hosts.
fn embed(caption: &str, url: &str, video: bool) -> String {
    if video {
        format!("[{caption}]({url})")
    } else {
        format!("![{caption}]({url})")
    }
}

/// The index at `path`. A missing or unreadable one is empty, which only costs re-uploads.
fn load(path: &Path) -> Index {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Writes the index to `path` through a temp file beside it, so a crash leaves the old one.
fn save(path: &Path, index: &Index) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or(Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(folder)?;
    serde_json::to_writer(&mut file, index)?;
    file.persist(path)?;
    Ok(())
}

/// Commits `bytes` at `path` on `repo`'s [`BRANCH`] with one contents API call, creating the
/// branch from the default branch's head first if GitHub says it is missing. Returns the commit.
async fn put(
    gh: &WorktreeManager,
    repo: &str,
    path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    // The body goes through a file: a 25 MB file's base64 is past any argument limit.
    let mut body = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
    serde_json::to_writer(
        &mut body,
        &serde_json::json!({
            "message": format!("pr media: {path}"),
            "branch": BRANCH,
            "content": data_encoding::BASE64.encode(&bytes),
        }),
    )
    .map_err(|error| error.to_string())?;
    body.flush().map_err(|error| error.to_string())?;
    let endpoint = format!("repos/{repo}/contents/{path}");
    let input = body.path().to_string_lossy();
    let args = [
        "api",
        "-X",
        "PUT",
        &endpoint,
        "--input",
        &input,
        "--jq",
        ".commit.sha",
    ];
    let commit = match call(gh, &args).await {
        Err(error) if branch_missing(&error) => {
            create_branch(gh, repo).await?;
            call(gh, &args).await?
        }
        answer => answer?,
    };
    Ok(commit.trim().to_owned())
}

/// Creates [`BRANCH`] at the head of `repo`'s default branch. One made meanwhile is fine.
async fn create_branch(gh: &WorktreeManager, repo: &str) -> Result<(), String> {
    let head = call(
        gh,
        &["api", &format!("repos/{repo}/commits/HEAD"), "--jq", ".sha"],
    )
    .await?;
    let created = call(
        gh,
        &[
            "api",
            &format!("repos/{repo}/git/refs"),
            "-f",
            &format!("ref=refs/heads/{BRANCH}"),
            "-f",
            &format!("sha={}", head.trim()),
        ],
    )
    .await;
    match created {
        Err(error) if error.contains("already exists") => Ok(()),
        created => created.map(drop),
    }
}

/// Runs `gh args`, retrying after each of [`BACKOFF`] while GitHub answers with a rate limit.
async fn call(gh: &WorktreeManager, args: &[&str]) -> Result<String, String> {
    let temp = std::env::temp_dir();
    for wait in BACKOFF {
        match gh.gh(&temp, args).await {
            Err(error) if limited(&error.to_string()) => {
                warn!(%error, ?wait, "GitHub is rate limiting pull request media uploads");
                tokio::time::sleep(wait).await;
            }
            answer => return answer.map_err(|error| error.to_string()),
        }
    }
    gh.gh(&temp, args).await.map_err(|error| error.to_string())
}

/// Whether gh's error is a primary or secondary rate limit.
fn limited(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("rate limit") || error.contains("http 429")
}

/// Whether gh's error says [`BRANCH`] doesn't exist, as the contents API answers before the first
/// upload to a repository.
fn branch_missing(error: &str) -> bool {
    error.contains(&format!("Branch {BRANCH} not found"))
}

#[cfg(test)]
mod tests;
