//! `pr/uploadMedia` (PLX-1020): commits screenshots and recordings for pull request bodies, as the
//! `upload-media-pr` skill's `upload.sh` did, so agents stop spending the shared GitHub quota on
//! parallel, retried, and repeated uploads.
//!
//! Storage matches the script, so its embeds keep working: each file is one contents API commit
//! to the repository's [`BRANCH`] branch, created from the default branch on first use, at
//! `pr-media/<YYYYMMDD-HHMMSS>-<hash>-<name>`. The link is
//! `raw.githubusercontent.com/<repo>/<commit>/<path>`, pinned to the commit; the script's
//! `blob/...?raw=true` links render broken. Raw links carry no sign-in, so they don't render for a
//! private repository.
//!
//! The index in the data folder's [`INDEX`] maps each repository's uploaded SHA-256s to their
//! links, so the same bytes again cost no GitHub call and never wait, across restarts. A hit isn't
//! checked against GitHub: if someone deletes the `pr-media` branch, its links break and the index
//! keeps handing them out until [`INDEX`] is deleted.
//!
//! Uploads wait their turn in [`QUEUE`], one at a time per host. plxd drops a connection silent
//! for 90 s and `plxd mcp` sends nothing while a call waits, so a call ends within [`BUDGET`]: it
//! waits at most [`QUEUE_WAIT`] for its turn, fails at once on a used-up rate limit, naming when it
//! resets, and backs off a secondary limit with [`BACKOFF`] only while the budget lasts.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{PrMediaFile, PrMediaUploaded, PrUploadMediaParams, PrUploadMediaResult};
use tokio::time::Instant;
use tracing::warn;

use crate::server::Daemon;
use crate::worktree::{PrError, WorktreeManager, github_pr_urls};

/// The branch, and the folder on it, that the files go to, as `upload.sh` uses.
const BRANCH: &str = "pr-media";

/// The largest file uploaded.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Extensions embedded as images, and those linked as videos, lowercase.
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const VIDEOS: &[&str] = &["mp4", "mov", "webm"];

/// The longest a call takes, under the 60 s other long tools keep to (`agent/wait`), well inside
/// plxd's 90 s limit on a silent connection.
const BUDGET: Duration = Duration::from_secs(55);

/// The longest a call waits for its turn in [`QUEUE`].
const QUEUE_WAIT: Duration = Duration::from_secs(40);

/// Waits before each retry of a call GitHub refused for a secondary rate limit, each taken only
/// if it ends inside the call's [`BUDGET`].
const BACKOFF: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(20)];

/// The dedupe index's file in the data folder: `{ "<owner>/<repo>": { "<sha256>": "<url>" } }`.
const INDEX: &str = "pr-media.json";

/// The host's upload queue: held from a call's first upload to its end, so uploads run one at a
/// time.
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

/// `pr/uploadMedia`: checks every file, then answers each from the index or uploads it, within
/// [`BUDGET`].
pub(crate) async fn upload(
    daemon: &Daemon,
    params: PrUploadMediaParams,
) -> Result<PrUploadMediaResult, ErrorObject> {
    let deadline = Instant::now() + BUDGET;
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
    let gh = daemon.agents.worktrees();
    let index = daemon.data_dir.root().join(INDEX);
    let now = jiff::Zoned::now().strftime("%Y%m%d-%H%M%S").to_string();
    let uploads = upload_all(&index, &repo, files, &now, turn(&QUEUE), |path, bytes| {
        put(gh, &repo, path, bytes, deadline)
    });
    let files = tokio::time::timeout_at(deadline, uploads)
        .await
        .unwrap_or_else(|_| {
            Err(PrError::Gh(format!(
                "uploading took over {BUDGET:?}; the files that finished are kept, so call again \
                 for the rest"
            )))
        })
        .map_err(|error| crate::agents::pr_error(&error))?;
    Ok(PrUploadMediaResult { files })
}

/// This call's turn in `queue`, or after [`QUEUE_WAIT`] an error saying to call again.
async fn turn(queue: &tokio::sync::Mutex<()>) -> Result<tokio::sync::MutexGuard<'_, ()>, PrError> {
    tokio::time::timeout(QUEUE_WAIT, queue.lock())
        .await
        .map_err(|_| {
            PrError::Gh(format!(
                "uploads are busy: others have held the host's upload queue for {QUEUE_WAIT:?}; \
                 call upload_pr_media again"
            ))
        })
}

/// Answers each of `files` from the index at `index` when it has the same bytes for `repo`, and
/// otherwise, once `turn` is had, uploads it with `put`, which commits bytes at a path and returns
/// the commit. A call whose files are all known never waits for `turn`. Each upload is recorded as
/// soon as `put` returns, so a failure or cancel part way keeps the ones before it.
async fn upload_all<T, F>(
    index: &Path,
    repo: &str,
    files: Vec<Media>,
    now: &str,
    turn: impl Future<Output = Result<T, PrError>>,
    mut put: impl FnMut(String, Vec<u8>) -> F,
) -> Result<Vec<PrMediaUploaded>, PrError>
where
    F: Future<Output = Result<String, PrError>>,
{
    let mut known = load(index);
    let key = repo.to_ascii_lowercase();
    let mut turn = Some(turn);
    let mut held = None;
    let mut uploaded = Vec::with_capacity(files.len());
    for media in files {
        let bytes = tokio::fs::read(&media.asked)
            .await
            .map_err(|error| PrError::Gh(format!("could not read {}: {error}", media.asked)))?;
        let hash = crate::sha256_hex(&bytes);
        let found = |known: &Index| known.get(&key).and_then(|urls| urls.get(&hash)).cloned();
        let mut hit = found(&known);
        if hit.is_none()
            && let Some(turn) = turn.take()
        {
            held = Some(turn.await?);
            // Whoever held the queue may have uploaded the same bytes.
            known = load(index);
            hit = found(&known);
        }
        let reused = hit.is_some();
        let url = if let Some(url) = hit {
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
    drop(held);
    Ok(uploaded)
}

/// A file that can be uploaded: an absolute path to an image or video of at most [`MAX_BYTES`],
/// not a symlink.
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
    // Not following a symlink, so a link in a worktree can't upload a file it points out to.
    let size = std::fs::symlink_metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)
        .ok_or_else(|| format!("{} is not a file (symlinks aren't followed)", file.path))?
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
    deadline: Instant,
) -> Result<String, PrError> {
    let failed =
        |error: std::io::Error| PrError::Gh(format!("could not write the upload: {error}"));
    // The body goes through a file: a 25 MB file's base64 is past any argument limit.
    let mut body = tempfile::NamedTempFile::new().map_err(failed)?;
    serde_json::to_writer(
        &mut body,
        &serde_json::json!({
            "message": format!("pr media: {path}"),
            "branch": BRANCH,
            "content": data_encoding::BASE64.encode(&bytes),
        }),
    )
    .map_err(|error| failed(error.into()))?;
    body.flush().map_err(failed)?;
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
    let commit = match call(gh, &args, deadline).await {
        Err(error) if branch_missing(&error.to_string()) => {
            create_branch(gh, repo, deadline).await?;
            call(gh, &args, deadline).await?
        }
        answer => answer?,
    };
    Ok(commit.trim().to_owned())
}

/// Creates [`BRANCH`] at the head of `repo`'s default branch. One made meanwhile is fine.
async fn create_branch(gh: &WorktreeManager, repo: &str, deadline: Instant) -> Result<(), PrError> {
    let commits = format!("repos/{repo}/commits/HEAD");
    let head = call(gh, &["api", &commits, "--jq", ".sha"], deadline).await?;
    let refs = format!("repos/{repo}/git/refs");
    let branch = format!("ref=refs/heads/{BRANCH}");
    let sha = format!("sha={}", head.trim());
    match call(gh, &["api", &refs, "-f", &branch, "-f", &sha], deadline).await {
        Err(error) if error.to_string().contains("already exists") => Ok(()),
        created => created.map(drop),
    }
}

/// Runs `gh args`, backing off a secondary rate limit with [`backoff`], and failing at once on a
/// used-up primary one, saying when it resets.
async fn call(gh: &WorktreeManager, args: &[&str], deadline: Instant) -> Result<String, PrError> {
    let temp = std::env::temp_dir();
    match backoff(deadline, || gh.gh(&temp, args)).await {
        Err(PrError::Gh(error)) if limit(&error) == Some(Limit::Primary) => {
            // Reading `rate_limit` doesn't count against it.
            let reset = gh
                .gh(
                    &temp,
                    &["api", "rate_limit", "--jq", ".resources.core.reset"],
                )
                .await
                .ok()
                .and_then(|reset| reset.trim().parse().ok())
                .and_then(|reset| jiff::Timestamp::from_second(reset).ok())
                .map_or_else(|| "it resets".to_owned(), |reset| reset.to_string());
            Err(PrError::Gh(format!(
                "GitHub's API rate limit is used up; call upload_pr_media again after {reset}: \
                 {error}"
            )))
        }
        answer => answer,
    }
}

/// Runs `attempt`, and again after each of [`BACKOFF`] that ends before `deadline` while it fails
/// for a secondary rate limit. Then fails saying when to call again.
async fn backoff<F>(deadline: Instant, mut attempt: impl FnMut() -> F) -> Result<String, PrError>
where
    F: Future<Output = Result<String, PrError>>,
{
    let mut waits = BACKOFF.into_iter();
    loop {
        match attempt().await {
            Err(PrError::Gh(error)) if limit(&error) == Some(Limit::Secondary) => {
                let Some(wait) = waits
                    .next()
                    .filter(|wait| Instant::now() + *wait < deadline)
                else {
                    return Err(PrError::Gh(format!(
                        "GitHub's secondary rate limit is on; call upload_pr_media again in a \
                         minute or two: {error}"
                    )));
                };
                warn!(%error, ?wait, "GitHub is rate limiting pull request media uploads");
                tokio::time::sleep(wait).await;
            }
            answer => return answer,
        }
    }
}

/// Which rate limit a gh error is. `crate::pr_write` shares it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Limit {
    /// The hourly quota is used up, until it resets.
    Primary,
    /// Too many requests too fast: a secondary limit, its older "abuse detection" wording, a
    /// 429, or GraphQL's "was submitted too quickly" for a comment.
    Secondary,
}

/// The rate limit gh's `error` reports, if any.
pub(crate) fn limit(error: &str) -> Option<Limit> {
    let error = error.to_ascii_lowercase();
    if error.contains("secondary rate limit")
        || error.contains("abuse detection")
        || error.contains("http 429")
        || error.contains("submitted too quickly")
    {
        Some(Limit::Secondary)
    } else if error.contains("rate limit") {
        Some(Limit::Primary)
    } else {
        None
    }
}

/// Whether gh's error says [`BRANCH`] doesn't exist, as the contents API answers before the first
/// upload to a repository.
fn branch_missing(error: &str) -> bool {
    error.contains(&format!("Branch {BRANCH} not found"))
}

#[cfg(test)]
mod tests;
