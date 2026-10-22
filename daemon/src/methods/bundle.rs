//! `bundle/*` and `git/startMerge` (0057), behind the `peerGit` capability: what a device's plxd
//! answers so the home plxd can move a run's commits across with no credentials, `origin`
//! branches, or SSH. The git side is [`crate::worktree::Bundled`]'s module, and the home plxd's
//! transfer is [`crate::peer::Plxd::receive_bundle`] and [`crate::peer::Plxd::send_bundle`].
//!
//! A bundle is a file in the data folder's `tmp/bundles/`, which `serve` empties at startup. Only
//! a run id and hex object ids come from the caller: the branch and repository are the run's own,
//! and the one ref `bundle/apply` writes is `refs/parallax-sync/<run id>`.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    BundleApplyParams, BundleBeginParams, BundleBeginResult, BundleDropParams, BundleFile,
    BundleId, BundleOkResult, BundlePrepareParams, BundlePrepareResult, BundleReadParams,
    BundleReadResult, BundleWriteParams, ErrorKind, GitStartMergeParams, RunId,
};
use parallax_store::Worktree;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};
use tokio_util::sync::CancellationToken;

use super::host::CHUNK_BYTES;
use crate::server::Daemon;
use crate::store::store_error;
use crate::worktree::WorktreeError;

/// The largest bundle either direction takes.
pub(crate) const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// How long a bundle no call has read or written stays.
const EXPIRES_AFTER: Duration = Duration::from_mins(10);

/// The most commits `bundle/prepare`'s `exclude` names.
const MAX_EXCLUDED: usize = 256;

/// The bundle files this plxd holds, by id.
pub(crate) struct Bundles {
    dir: PathBuf,
    max_bytes: u64,
    open: Mutex<HashMap<BundleId, Open>>,
}

/// A bundle file and when a call last used it.
struct Open {
    path: PathBuf,
    used: Instant,
    /// Set for a bundle `bundle/begin` opened.
    incoming: Option<Incoming>,
}

/// What `bundle/begin` promised about a bundle, and how much of it is written.
struct Incoming {
    run: RunId,
    size: u64,
    sha256: String,
    written: u64,
}

impl Bundles {
    /// Bundles in `dir`, each at most `max_bytes`.
    pub(crate) fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes,
            open: Mutex::default(),
        }
    }

    /// The table, after removing every bundle unused since [`EXPIRES_AFTER`] before `now`.
    fn table(&self, now: Instant) -> MutexGuard<'_, HashMap<BundleId, Open>> {
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.retain(|_, bundle| {
            let live = now.duration_since(bundle.used) < EXPIRES_AFTER;
            if !live {
                let _ = std::fs::remove_file(&bundle.path);
            }
            live
        });
        open
    }

    /// Removes the bundles that expired. `agents::cleanup` runs it about every 15 minutes, and
    /// every `bundle/*` call does too.
    pub(crate) fn sweep(&self) {
        drop(self.table(Instant::now()));
    }

    /// A new bundle's id and its path, which doesn't exist yet.
    async fn new_file(&self) -> Result<(BundleId, PathBuf), ErrorObject> {
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| {
                ErrorObject::internal_error(format!("can't make a bundle: {error}"))
            })?;
        let id = BundleId::generate();
        Ok((id, self.dir.join(format!("{id}.bundle"))))
    }

    fn too_large(&self, size: u64) -> ErrorObject {
        ErrorObject::parallax(
            ErrorKind::BundleTooLarge,
            format!(
                "The commits are {size} bytes as a bundle, over the {} MiB limit.",
                self.max_bytes / 1024 / 1024
            ),
        )
    }

    /// Removes bundle `id` and its file.
    fn remove(&self, id: BundleId) {
        if let Some(bundle) = self.table(Instant::now()).remove(&id) {
            let _ = std::fs::remove_file(&bundle.path);
        }
    }
}

fn bundle_failed(message: impl Into<String>) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::BundleFailed, message)
}

fn gone(id: BundleId) -> ErrorObject {
    bundle_failed(format!("No bundle has id {id}: it expired or was dropped."))
}

fn worktree_failed(error: &WorktreeError) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string())
}

/// `id` if it is a full object id, 40 hex digits for SHA-1 or 64 for SHA-256, in lowercase.
fn object_id<'a>(name: &str, id: &'a str) -> Result<&'a str, ErrorObject> {
    let hex = id
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if hex && matches!(id.len(), 40 | 64) {
        Ok(id)
    } else {
        Err(ErrorObject::invalid_params(format!(
            "{name} must be a full lowercase hex object id"
        )))
    }
}

/// Run `run`'s worktree row.
async fn worktree(daemon: &Arc<Daemon>, run: RunId) -> Result<Worktree, ErrorObject> {
    daemon
        .store
        .run(&CancellationToken::new(), move |store| {
            store
                .get_worktree(run.into())
                .map_err(|e| store_error(&e))?
                .ok_or_else(|| ErrorObject::invalid_params(format!("run {run} has no worktree")))
        })
        .await
}

/// `bundle/prepare`: bundles run `run`'s branch, leaving out `exclude`.
pub(crate) async fn prepare(
    daemon: &Arc<Daemon>,
    params: BundlePrepareParams,
) -> Result<BundlePrepareResult, ErrorObject> {
    if params.exclude.len() > MAX_EXCLUDED {
        return Err(ErrorObject::invalid_params(format!(
            "exclude names {} commits; it may name at most {MAX_EXCLUDED}",
            params.exclude.len()
        )));
    }
    for id in &params.exclude {
        object_id("exclude", id)?;
    }
    let row = worktree(daemon, params.run).await?;
    let bundles = &daemon.bundles;
    let (id, path) = bundles.new_file().await?;
    let reference = format!("refs/heads/{}", row.branch);
    let made = daemon
        .agents
        .worktrees()
        .create_bundle(row.repo_path.as_ref(), &reference, &params.exclude, &path)
        .await;
    let made = match made {
        Ok(made) => made,
        Err(error) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(worktree_failed(&error));
        }
    };
    if !made.written {
        return Ok(BundlePrepareResult {
            tip: made.tip,
            bundle: None,
        });
    }
    let size = tokio::fs::metadata(&path).await.map(|meta| meta.len());
    let read = match size {
        Ok(size) if size > bundles.max_bytes => Err(bundles.too_large(size)),
        _ => tokio::fs::read(&path).await.map_err(|error| {
            ErrorObject::internal_error(format!("can't read the bundle: {error}"))
        }),
    };
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(error);
        }
    };
    bundles.table(Instant::now()).insert(
        id,
        Open {
            path,
            used: Instant::now(),
            incoming: None,
        },
    );
    Ok(BundlePrepareResult {
        tip: made.tip,
        bundle: Some(BundleFile {
            id,
            size: bytes.len() as u64,
            sha256: crate::sha256_hex(&bytes),
        }),
    })
}

/// `bundle/read`: `length` bytes of bundle `id` from `offset`.
pub(crate) async fn read(
    daemon: &Arc<Daemon>,
    params: BundleReadParams,
) -> Result<BundleReadResult, ErrorObject> {
    let BundleReadParams { id, offset, length } = params;
    if length > CHUNK_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "length is {length}; a chunk is at most {CHUNK_BYTES} bytes"
        )));
    }
    let path = {
        let now = Instant::now();
        let mut table = daemon.bundles.table(now);
        let bundle = table.get_mut(&id).ok_or_else(|| gone(id))?;
        bundle.used = now;
        bundle.path.clone()
    };
    let cant = |error: std::io::Error| bundle_failed(format!("Can't read bundle {id}: {error}"));
    let mut file = tokio::fs::File::open(&path).await.map_err(cant)?;
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(offset)).await.map_err(cant)?;
    file.take(length)
        .read_to_end(&mut bytes)
        .await
        .map_err(cant)?;
    Ok(BundleReadResult {
        data: crate::images::encode(&bytes),
    })
}

/// `bundle/drop`: removes bundle `id`.
pub(crate) fn drop_bundle(daemon: &Daemon, params: &BundleDropParams) -> BundleOkResult {
    daemon.bundles.remove(params.id);
    BundleOkResult {}
}

/// `bundle/begin`: opens an empty bundle file for run `run`'s repository.
pub(crate) async fn begin(
    daemon: &Arc<Daemon>,
    params: BundleBeginParams,
) -> Result<BundleBeginResult, ErrorObject> {
    let BundleBeginParams { run, size, sha256 } = params;
    if sha256.len() != 64 || object_id("sha256", &sha256).is_err() {
        return Err(ErrorObject::invalid_params(
            "sha256 must be 64 lowercase hex digits",
        ));
    }
    let bundles = &daemon.bundles;
    if size > bundles.max_bytes {
        return Err(bundles.too_large(size));
    }
    worktree(daemon, run).await?;
    let (id, path) = bundles.new_file().await?;
    tokio::fs::File::create_new(&path)
        .await
        .map_err(|error| ErrorObject::internal_error(format!("can't make a bundle: {error}")))?;
    bundles.table(Instant::now()).insert(
        id,
        Open {
            path,
            used: Instant::now(),
            incoming: Some(Incoming {
                run,
                size,
                sha256,
                written: 0,
            }),
        },
    );
    Ok(BundleBeginResult { id })
}

/// `bundle/write`: writes a chunk of bundle `id` at `offset`, the length written so far.
pub(crate) async fn write(
    daemon: &Arc<Daemon>,
    params: BundleWriteParams,
) -> Result<BundleOkResult, ErrorObject> {
    let BundleWriteParams { id, offset, data } = params;
    let bytes = crate::images::decode(&data)
        .ok_or_else(|| ErrorObject::invalid_params("data is not standard base64 with padding"))?;
    let length = bytes.len() as u64;
    if length > CHUNK_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "the chunk is {length} bytes; it must be at most {CHUNK_BYTES}"
        )));
    }
    // The chunk's place is taken before it's written, so the next chunk can follow at once.
    let path = {
        let now = Instant::now();
        let mut table = daemon.bundles.table(now);
        let bundle = table.get_mut(&id).ok_or_else(|| gone(id))?;
        let Some(incoming) = bundle.incoming.as_mut() else {
            return Err(ErrorObject::invalid_params(format!(
                "bundle {id} is one to read, not write"
            )));
        };
        if offset != incoming.written {
            return Err(ErrorObject::invalid_params(format!(
                "bundle {id} has {} bytes, so its next chunk starts there, not at {offset}",
                incoming.written
            )));
        }
        if offset + length > incoming.size {
            return Err(ErrorObject::invalid_params(format!(
                "bundle {id} would be over the {} bytes bundle/begin gave",
                incoming.size
            )));
        }
        incoming.written += length;
        bundle.used = now;
        bundle.path.clone()
    };
    let written = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await?;
        file.seek(SeekFrom::Start(offset)).await?;
        file.write_all(&bytes).await?;
        file.flush().await
    }
    .await;
    if let Err(error) = written {
        // Its length is unknown now, so it can only start again.
        daemon.bundles.remove(id);
        return Err(ErrorObject::internal_error(format!(
            "can't write bundle {id}: {error}"
        )));
    }
    Ok(BundleOkResult {})
}

/// `bundle/apply`: checks bundle `id` and points `refs/parallax-sync/<run id>` at `tip`. The
/// bundle is removed either way.
pub(crate) async fn apply(
    daemon: &Arc<Daemon>,
    params: BundleApplyParams,
) -> Result<BundleOkResult, ErrorObject> {
    let BundleApplyParams { id, tip } = params;
    let tip = object_id("tip", &tip)?;
    let Some(bundle) = daemon.bundles.table(Instant::now()).remove(&id) else {
        return Err(gone(id));
    };
    let applied = apply_file(daemon, id, &bundle, tip).await;
    let _ = tokio::fs::remove_file(&bundle.path).await;
    applied.map(|()| BundleOkResult {})
}

async fn apply_file(
    daemon: &Arc<Daemon>,
    id: BundleId,
    bundle: &Open,
    tip: &str,
) -> Result<(), ErrorObject> {
    let Some(incoming) = &bundle.incoming else {
        return Err(ErrorObject::invalid_params(format!(
            "bundle {id} is one to read, not apply"
        )));
    };
    if incoming.written != incoming.size {
        return Err(bundle_failed(format!(
            "Bundle {id} has {} of its {} bytes.",
            incoming.written, incoming.size
        )));
    }
    let bytes = tokio::fs::read(&bundle.path)
        .await
        .map_err(|error| bundle_failed(format!("Can't read bundle {id}: {error}")))?;
    if crate::sha256_hex(&bytes) != incoming.sha256 {
        return Err(bundle_failed(format!(
            "Bundle {id} doesn't have the SHA-256 bundle/begin gave, so it changed on the way."
        )));
    }
    let row = worktree(daemon, incoming.run).await?;
    let target = format!("refs/parallax-sync/{}", incoming.run);
    daemon
        .agents
        .worktrees()
        .apply_bundle(row.repo_path.as_ref(), &bundle.path, &target, tip)
        .await
        .map_err(|error| bundle_failed(error.to_string()))
}

/// `git/startMerge`: starts merging `tip` into run `run`'s worktree, unless the run is working.
pub(crate) async fn start_merge(
    daemon: &Arc<Daemon>,
    params: GitStartMergeParams,
) -> Result<BundleOkResult, ErrorObject> {
    let GitStartMergeParams { run, tip } = params;
    let tip = object_id("tip", &tip)?;
    if super::land::working(daemon, run).await? {
        return Err(ErrorObject::parallax(
            ErrorKind::RunBusy,
            format!("Run {run} is working, so plxd won't start a merge in its worktree."),
        ));
    }
    let row = worktree(daemon, run).await?;
    if row.git_dir.is_empty() {
        return Err(ErrorObject::parallax(
            ErrorKind::WorktreeFailed,
            format!("run {run}'s worktree has no recorded git folder, so plxd can't merge there"),
        ));
    }
    daemon
        .agents
        .worktrees()
        .start_merge(row.path.as_ref(), row.git_dir.as_ref(), tip)
        .await
        .map_err(|error| worktree_failed(&error))?;
    Ok(BundleOkResult {})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_unused_for_ten_minutes_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = Bundles::new(dir.path().to_owned(), MAX_BYTES);
        let path = dir.path().join("old.bundle");
        std::fs::write(&path, b"bundle").unwrap();
        let id = BundleId::generate();
        let used = Instant::now();
        bundles.table(used).insert(
            id,
            Open {
                path: path.clone(),
                used,
                incoming: None,
            },
        );
        assert!(
            bundles
                .table(used + Duration::from_mins(9))
                .contains_key(&id)
        );
        assert!(path.exists());
        assert!(!bundles.table(used + EXPIRES_AFTER).contains_key(&id));
        assert!(!path.exists());
    }

    #[test]
    fn only_full_lowercase_hex_is_an_object_id() {
        let sha1 = "0123456789abcdef0123456789abcdef01234567";
        assert!(object_id("tip", sha1).is_ok());
        assert!(object_id("tip", &"a".repeat(64)).is_ok());
        for bad in [
            "",
            "HEAD",
            "-q",
            "refs/heads/main",
            &sha1[..39],
            &sha1.to_uppercase(),
            &format!("{}g", &sha1[..39]),
            &"a".repeat(41),
        ] {
            assert!(object_id("tip", bad).is_err(), "{bad:?}");
        }
    }
}
