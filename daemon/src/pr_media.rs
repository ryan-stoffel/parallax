//! `pr/uploadMedia` (PLX-1020): uploads screenshots and recordings for pull request bodies, so
//! agents stop spending the shared GitHub quota on parallel, retried, and repeated uploads.
//!
//! Files go to the host's secret media gist (PLX-1137), never to a repository branch. The data
//! folder's [`GIST`] names it as `owner/id`; when it is missing, the first upload creates the gist
//! with `gh gist create` and records it. A gist holds binary files only through git, so plxd keeps
//! a bare, blobless clone of each gist in [`CLONES`] and adds each file with git plumbing, never
//! checking out the files already there, then pushes with gh's sign-in. A file is stored as
//! `<sha256 prefix>-<name>`, as the `upload-media` skill's `upload.sh` stores it, and linked as
//! `gist.githubusercontent.com/<owner>/<id>/raw/<blob>/<name>`, pinned to its git blob. A secret
//! gist is unlisted but open to anyone with a link, so its links render in any repository's pull
//! requests, private ones included.
//!
//! The index in the data folder's [`INDEX`] maps each gist's uploaded SHA-256s to their links, so
//! the same bytes again cost no push and never wait, across restarts. Entries for other gists, or
//! for the `pr-media` branches uploads used to go to, are never handed out.
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

/// The dedupe index's file in the data folder: `{ "<owner>/<gist id>": { "<sha256>": "<url>" } }`.
const INDEX: &str = "pr-media.json";

/// The data folder's file naming the host's media gist as `owner/id`.
const GIST: &str = "pr-media-gist";

/// The data folder's folder of bare, blobless clones of media gists, one `<id>.git` each.
const CLONES: &str = "pr-media-gists";

/// Who plxd's commits to the gist are by. The push is still the gh user's.
const AUTHOR: [&str; 4] = [
    "-c",
    "user.name=Parallax",
    "-c",
    "user.email=noreply@parallax.codes",
];

/// The host's upload queue: held from a call's first upload to its end, so uploads run one at a
/// time.
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Gist, as `owner/id`, to SHA-256 to link.
type Index = BTreeMap<String, BTreeMap<String, String>>;

/// A file checked for upload.
#[derive(Debug)]
struct Media {
    /// The path as asked.
    asked: String,
    /// Its name, reduced to `[A-Za-z0-9._-]` so the link needs no URL encoding.
    name: String,
    caption: String,
    video: bool,
}

/// The host's media gist.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Gist {
    owner: String,
    id: String,
}

impl Gist {
    /// `owner/id`, as [`GIST`] holds it and [`Index`] keys it.
    fn key(&self) -> String {
        format!("{}/{}", self.owner, self.id)
    }

    /// Its git remote.
    fn remote(&self) -> String {
        format!("https://gist.github.com/{}.git", self.id)
    }

    /// Its clone in `root`'s [`CLONES`], so a link always names the gist its file went to.
    fn clone_in(&self, root: &Path) -> std::path::PathBuf {
        root.join(CLONES).join(format!("{}.git", self.id))
    }

    /// The link to file `name`, pinned to its git `blob`.
    fn raw_url(&self, blob: &str, name: &str) -> String {
        format!(
            "https://gist.githubusercontent.com/{}/{}/raw/{blob}/{name}",
            self.owner, self.id
        )
    }
}

/// `pr/uploadMedia`: checks every file, then answers each from the index or uploads it, within
/// [`BUDGET`].
pub(crate) async fn upload(
    daemon: &Daemon,
    params: PrUploadMediaParams,
) -> Result<PrUploadMediaResult, ErrorObject> {
    let deadline = Instant::now() + BUDGET;
    if repository(&params.url).is_none() {
        return Err(ErrorObject::invalid_params(format!(
            "{:?} is not a GitHub pull request URL",
            params.url
        )));
    }
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
    let root = daemon.data_dir.root();
    let index = root.join(INDEX);
    let uploads = async {
        let gist = host_gist(gh, root, deadline).await?;
        let clone = gist.clone_in(root);
        let (gist, clone) = (&gist, &clone);
        upload_all(
            &index,
            &gist.key(),
            files,
            turn(&QUEUE),
            |name, bytes| async move {
                let blob = put(gh, clone, &gist.remote(), &name, bytes).await?;
                Ok(gist.raw_url(&blob, &name))
            },
        )
        .await
    };
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

/// Answers each of `files` from the index at `index` when it has the same bytes for the gist
/// `key`, and otherwise, once `turn` is had, uploads it with `put`, which stores bytes under a
/// file name and returns its link. A call whose files are all known never waits for `turn`. Each
/// upload is recorded as soon as `put` returns, so a failure or cancel part way keeps the ones
/// before it.
async fn upload_all<T, F>(
    index: &Path,
    key: &str,
    files: Vec<Media>,
    turn: impl Future<Output = Result<T, PrError>>,
    mut put: impl FnMut(String, Vec<u8>) -> F,
) -> Result<Vec<PrMediaUploaded>, PrError>
where
    F: Future<Output = Result<String, PrError>>,
{
    let mut known = load(index);
    let key = key.to_owned();
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
            let url = put(media_name(&hash, &media.name), bytes).await?;
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

/// A file's name in the gist: its SHA-256's first 12 digits, then its own name, as `upload.sh`
/// names it, so different files never share a name.
fn media_name(hash: &str, name: &str) -> String {
    format!("{}-{name}", &hash[..12])
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

/// The gist recorded in `root`'s [`GIST`], or else one made now. Making one waits for a turn in
/// [`QUEUE`] and reads [`GIST`] again, so two first uploads make one gist.
async fn host_gist(gh: &WorktreeManager, root: &Path, deadline: Instant) -> Result<Gist, PrError> {
    let path = root.join(GIST);
    if let Some(gist) = read_gist(&path) {
        return Ok(gist);
    }
    let _turn = turn(&QUEUE).await?;
    if let Some(gist) = read_gist(&path) {
        return Ok(gist);
    }
    let failed =
        |error: std::io::Error| PrError::Gh(format!("could not make the media gist: {error}"));
    let folder = tempfile::tempdir().map_err(failed)?;
    let readme = folder.path().join("README.md");
    std::fs::write(
        &readme,
        "# Pull request media\n\nScreenshots and recordings Parallax uploaded for pull requests.\n",
    )
    .map_err(failed)?;
    let readme = readme.to_string_lossy();
    let args = ["gist", "create", "--desc", "Pull request media", &readme];
    let made = call(gh, &args, deadline).await?;
    let gist = made
        .lines()
        .rev()
        .find_map(|line| parse_gist(line.trim().strip_prefix("https://gist.github.com/")?))
        .ok_or_else(|| PrError::Gh(format!("gh gist create printed no gist: {made}")))?;
    std::fs::write(&path, format!("{}\n", gist.key())).map_err(failed)?;
    Ok(gist)
}

/// The gist `owner/id` at `path` names, if it holds one.
fn read_gist(path: &Path) -> Option<Gist> {
    parse_gist(std::fs::read_to_string(path).ok()?.trim())
}

/// `owner/id`, checked to be a GitHub login and a hex gist id, so neither can reach a URL or a git
/// argument as anything else.
fn parse_gist(text: &str) -> Option<Gist> {
    let (owner, id) = text.split_once('/')?;
    let login = !owner.is_empty() && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let hex = !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit());
    (login && hex).then(|| Gist {
        owner: owner.to_owned(),
        id: id.to_owned(),
    })
}

/// Adds `bytes` to the gist at `remote` as file `name` and returns its blob: in `clone`, a bare,
/// blobless clone made on first use, it fetches the gist's branch, builds a commit on it from the
/// tree alone, and pushes it. A push another uploader beat is tried once more on the new head.
/// A file already there with the same bytes needs no commit. Only a caller holding its turn in
/// [`QUEUE`] calls it, and only plxd uses `clone`, so no other git runs there meanwhile.
async fn put(
    gh: &WorktreeManager,
    clone: &Path,
    remote: &str,
    name: &str,
    bytes: Vec<u8>,
) -> Result<String, PrError> {
    let failed =
        |error: std::io::Error| PrError::Gh(format!("could not write the upload: {error}"));
    if !clone.join("HEAD").is_file() {
        // Cloned beside it and moved in whole, so a clone cut off part way is never taken for one.
        let parent = clone.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent).map_err(failed)?;
        let partial = tempfile::tempdir_in(parent).map_err(failed)?;
        let target = partial.path().join("gist.git");
        let target_arg = target.to_string_lossy();
        let args = [
            "clone",
            "--bare",
            "--quiet",
            "--filter=blob:none",
            remote,
            &target_arg,
        ];
        gh.gist_git(parent, &args).await?;
        let _ = std::fs::remove_dir_all(clone);
        std::fs::rename(&target, clone).map_err(failed)?;
    }
    clear_locks(clone);
    let branch = gh
        .gist_git(clone, &["symbolic-ref", "--short", "HEAD"])
        .await?;
    let branch = branch.trim();
    let mut file = tempfile::NamedTempFile::new_in(clone).map_err(failed)?;
    file.write_all(&bytes).map_err(failed)?;
    let path = file.path().to_string_lossy().into_owned();
    let blob = gh.gist_git(clone, &["hash-object", "-w", &path]).await?;
    let blob = blob.trim();
    let fetch = format!("+{branch}:{branch}");
    let entry = format!("100644,{blob},{name}");
    let message = format!("Add {name}");
    let mut tries = 2;
    loop {
        tries -= 1;
        gh.gist_git(clone, &["fetch", "--quiet", "origin", &fetch])
            .await?;
        if gh
            .gist_git(clone, &["ls-tree", branch, "--", name])
            .await?
            .contains(blob)
        {
            return Ok(blob.to_owned());
        }
        gh.gist_git(clone, &["read-tree", branch]).await?;
        gh.gist_git(clone, &["update-index", "--add", "--cacheinfo", &entry])
            .await?;
        // Without --missing-ok, write-tree checks every blob and fetches the whole gist.
        let tree = gh.gist_git(clone, &["write-tree", "--missing-ok"]).await?;
        let mut commit = AUTHOR.to_vec();
        commit.extend(["commit-tree", tree.trim(), "-p", branch, "-m", &message]);
        let commit = gh.gist_git(clone, &commit).await?;
        let commit = commit.trim();
        let refspec = format!("{commit}:refs/heads/{branch}");
        match gh
            .gist_git(clone, &["push", "--quiet", "origin", &refspec])
            .await
        {
            Ok(_) => {
                gh.gist_git(
                    clone,
                    &["update-ref", &format!("refs/heads/{branch}"), commit],
                )
                .await?;
                return Ok(blob.to_owned());
            }
            Err(error) if tries == 0 => return Err(error),
            Err(error) => warn!(%error, "another upload moved the media gist; trying again"),
        }
    }
}

/// Removes the lock files a git that plxd killed part way, such as at [`BUDGET`], left in `clone`,
/// which would fail every later upload. Safe because no other git runs there: see [`put`].
fn clear_locks(clone: &Path) {
    for folder in [clone.to_path_buf(), clone.join("refs").join("heads")] {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".lock") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
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

#[cfg(test)]
mod tests;
