//! You memory between the user's Connect devices (0082, PLX-946).
//!
//! Each You entry and knowledge file has a row in the store's `you_entries`: the hash of the text
//! that syncs ([`synced`]), a version vector, the machine that wrote that version, and a
//! tombstone for a deletion. A scan ([`record`]) compares the folder with the rows and stamps
//! what changed as this machine's, so a write through plxd, an edit on disk, and an edit made
//! while plxd was down all count the same. While `connect` is on, [`run`] scans, then pulls each
//! online Connect device's rows with `memory/syncList`, reads the text of the ones this host
//! lacks with `memory/syncRead`, and applies them by [`merge`]'s rules. A peer's `memory/syncList`
//! scans first too ([`list`]), so it always sees the latest.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::methods::{MemorySyncList, MemorySyncRead};
use parallax_protocol::{
    MemoryMachine, MemoryScope, MemorySyncEntry, MemorySyncListParams, MemorySyncListResult,
    MemorySyncReadParams, MemorySyncReadResult,
};
use parallax_store::YouEntry;
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::corrections::{self, Change};
use super::memory;
use crate::methods::memory::save;
use crate::peer::{Peers, Plxd};
use crate::server::Daemon;
use crate::store::{StoreHandle, store_error};
use crate::tailnet::Status;

/// A version vector: each machine's node ID, and how many local changes it made.
type Clock = BTreeMap<String, u64>;

/// The recorded versions, by path.
pub(crate) type Versions = BTreeMap<String, MemorySyncEntry>;

/// Whether `path` in the You folder syncs: an entry, `memory/<kind>/<name>.md`, or knowledge.
fn syncs(path: &str) -> bool {
    super::validate_relative_path(path).is_ok()
        && (memory::entry_kind(path).is_some() || path.starts_with("knowledge/"))
}

/// The text of a file that syncs: without its header's `Last used:` and `Stale:` lines, which
/// each host keeps for itself, and otherwise as it is.
fn synced(text: &str) -> String {
    let (_, body) = memory::parse(text);
    let head = &text[..text.len() - body.len()];
    let local = |line: &str| line.starts_with("Last used:") || line.starts_with("Stale:");
    if !head.lines().any(local) {
        return text.to_owned();
    }
    let kept: Vec<&str> = head
        .lines()
        .filter(|line| !line.trim().is_empty() && !local(line))
        .collect();
    if kept.is_empty() {
        return body.to_owned();
    }
    format!("{}\n\n{body}", kept.join("\n"))
}

fn hash(text: &str) -> String {
    crate::sha256_hex(synced(text).as_bytes())
}

/// Which of two versions is newer by their clocks.
#[derive(Debug, PartialEq, Eq)]
enum Order {
    Same,
    Local,
    Remote,
    /// Neither covers the other: both changed since they last agreed.
    Concurrent,
}

fn order(local: &Clock, remote: &Clock) -> Order {
    let ahead = |a: &Clock, b: &Clock| a.iter().any(|(id, n)| b.get(id).is_none_or(|m| n > m));
    match (ahead(local, remote), ahead(remote, local)) {
        (false, false) => Order::Same,
        (true, false) => Order::Local,
        (false, true) => Order::Remote,
        (true, true) => Order::Concurrent,
    }
}

/// The clock that covers both `a` and `b`: each machine's higher counter.
fn merged(a: &Clock, b: &Clock) -> Clock {
    let mut clock = a.clone();
    for (id, n) in b {
        let counter = clock.entry(id.clone()).or_default();
        *counter = (*counter).max(*n);
    }
    clock
}

/// What a pull does with one remote version (0082's conflict rules).
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Nothing: this host has it, or a newer version.
    Nothing,
    /// Take the remote version, the later writer: its text or its deletion, and its row.
    Take,
    /// The versions are concurrent. Keep the remote one (`remote`) or the local one, under the
    /// merged clock, so every other host takes it with no second conflict. `other` keeps the
    /// losing version too, when both are different edits.
    Resolve { remote: bool, other: bool },
}

fn merge(local: Option<&MemorySyncEntry>, remote: &MemorySyncEntry) -> Action {
    let Some(local) = local else {
        return Action::Take;
    };
    match order(&local.clock, &remote.clock) {
        Order::Same | Order::Local => Action::Nothing,
        Order::Remote => Action::Take,
        Order::Concurrent => {
            // An edit beats a deletion, since keeping it loses nothing. Otherwise the later
            // write is kept, ties going to the higher node ID, so every host picks the same.
            let remote_kept = if local.deleted == remote.deleted {
                (remote.written_at, &remote.machine.id) > (local.written_at, &local.machine.id)
            } else {
                local.deleted
            };
            let other = !local.deleted && !remote.deleted && local.hash != remote.hash;
            Action::Resolve {
                remote: remote_kept,
                other,
            }
        }
    }
}

/// What changed in You folder `dir` since `versions`, each stamped as `me`'s: a file whose text
/// differs from its row, a new file, and a row whose file is gone. A file that can't be read as
/// UTF-8 text is left as it was.
fn scan(
    dir: &Path,
    versions: &Versions,
    me: &MemoryMachine,
) -> std::io::Result<Vec<MemorySyncEntry>> {
    let mut changed = Vec::new();
    let mut seen = HashSet::new();
    for (path, metadata) in super::list_files(dir)? {
        if !syncs(&path) {
            continue;
        }
        seen.insert(path.clone());
        let Some(text) = super::read_text(dir, &path) else {
            continue;
        };
        let hash = hash(&text);
        let row = versions.get(&path);
        if row.is_some_and(|row| !row.deleted && row.hash == hash) {
            continue;
        }
        let at = super::modified_at(&metadata);
        changed.push(stamp(row, &path, hash, me, at, false));
    }
    for row in versions.values() {
        if !row.deleted && !seen.contains(&row.path) {
            let now = Timestamp::now();
            changed.push(stamp(Some(row), &row.path, String::new(), me, now, true));
        }
    }
    Ok(changed)
}

/// A new local version of `path`, after `row`'s.
fn stamp(
    row: Option<&MemorySyncEntry>,
    path: &str,
    hash: String,
    me: &MemoryMachine,
    written_at: Timestamp,
    deleted: bool,
) -> MemorySyncEntry {
    let mut clock = row.map(|row| row.clock.clone()).unwrap_or_default();
    *clock.entry(me.id.clone()).or_default() += 1;
    MemorySyncEntry {
        path: path.to_owned(),
        hash,
        clock,
        machine: me.clone(),
        written_at,
        deleted,
    }
}

/// Applies `remote` to You folder `dir`, where `local` is this host's version and `text` the
/// remote's text, if it was read. Returns the row to record, and the change to tell running
/// children of, for a file that existed here; `None` when there is nothing to do yet. It is safe
/// to retry: a step that fails records nothing, and the next pull writes the same files again.
fn apply(
    dir: &Path,
    local: Option<&MemorySyncEntry>,
    remote: &MemorySyncEntry,
    text: Option<&str>,
) -> Result<Option<(MemorySyncEntry, Option<Change>)>, String> {
    let action = merge(local, remote);
    // The same text, or both deleted: only the row changes, so the file keeps its `Last used:`
    // and `Stale:` lines, and running children hear of no change.
    let same =
        local.is_some_and(|local| local.deleted == remote.deleted && local.hash == remote.hash);
    if action == Action::Nothing
        || (!same && !remote.deleted && text.is_none())
        // A file edited on disk since the scan waits for the next pull, which records it.
        || !unchanged(dir, &remote.path, local)
    {
        return Ok(None);
    }
    let existed = local.is_some_and(|local| !local.deleted);
    let (
        Action::Resolve {
            remote: kept,
            other,
        },
        Some(local),
    ) = (action, local)
    else {
        // Take the remote version.
        if same {
            return Ok(Some((remote.clone(), None)));
        }
        write(dir, &remote.path, text)?;
        let change = if remote.deleted {
            Change::Deleted
        } else {
            Change::Updated
        };
        return Ok(Some((remote.clone(), existed.then_some(change))));
    };
    if other {
        let (loser, text) = if kept {
            let (bytes, _) = super::read_file(dir, &remote.path).map_err(|e| e.to_string())?;
            let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
            (local, synced(&text))
        } else {
            (remote, text.unwrap_or_default().to_owned())
        };
        keep_other(dir, &remote.path, &text, loser)?;
    }
    let replaced = kept && !same;
    if replaced {
        write(dir, &remote.path, text)?;
    }
    let mut row = if kept { remote.clone() } else { local.clone() };
    row.clock = merged(&local.clock, &remote.clock);
    Ok(Some((
        row,
        (replaced && existed).then_some(Change::Updated),
    )))
}

/// Whether `path` in `dir` still holds `local`'s version: its text, or no file for a deletion
/// or a path this host never had.
fn unchanged(dir: &Path, path: &str, local: Option<&MemorySyncEntry>) -> bool {
    let current = match super::read_file(dir, path) {
        Ok((bytes, _)) => Some(
            String::from_utf8(bytes)
                .map(|text| hash(&text))
                .unwrap_or_default(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return false,
    };
    match local.filter(|local| !local.deleted) {
        Some(local) => current.as_deref() == Some(local.hash.as_str()),
        None => current.is_none(),
    }
}

/// Writes `text` to `path`, or deletes it for `None`.
fn write(dir: &Path, path: &str, text: Option<&str>) -> Result<(), String> {
    match text {
        Some(text) => save(dir, path, text).map(drop).map_err(|e| e.message),
        None => match super::delete_file(dir, path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        },
    }
}

/// Keeps `text`, the version `loser` of `path` that lost a conflict: an entry's as a proposal that
/// replaces it, which the Memory tab saves or discards, and a knowledge file's as a copy beside it,
/// which syncs as a file of its own, since a proposal needs a kind. The name comes from the
/// losing version, its writer's node ID and counter, so a retry or another pull that sees the same
/// conflict writes the same file again instead of adding one.
fn keep_other(dir: &Path, path: &str, text: &str, loser: &MemorySyncEntry) -> Result<(), String> {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("entry");
    let node = &loser.machine.id;
    let version = loser.clock.get(node).copied().unwrap_or_default();
    let tag = format!("{stem}-{}-{version}", memory::slug(node));
    let (target, text) = match memory::entry_kind(path) {
        Some(kind) => {
            let (header, body) = memory::parse(text);
            let title = header.title.unwrap_or_else(|| stem.to_owned());
            let field = |value: Option<String>| value.unwrap_or_default();
            let extra = [("Scope", "you"), ("Replaces", path)];
            let text = memory::render(
                kind,
                &title,
                &field(header.source),
                &field(header.date),
                &field(header.writer),
                &extra,
                body,
            );
            let kind = memory::kind_name(kind).unwrap_or("entry");
            (format!("proposals/{kind}-{tag}.md"), text)
        }
        None => (format!("knowledge/{tag}.md"), text.to_owned()),
    };
    save(dir, &target, &text).map(drop).map_err(|e| e.message)
}

/// The machine that wrote the text of `path` in You folder `dir` now, if `versions` records it.
pub(crate) fn machine(dir: &Path, path: &str, versions: &Versions) -> Option<MemoryMachine> {
    let row = versions.get(path).filter(|row| !row.deleted)?;
    let text = super::read_text(dir, path)?;
    (hash(&text) == row.hash).then(|| row.machine.clone())
}

/// The recorded versions, read through `store`.
pub(crate) async fn recorded(store: &StoreHandle) -> Result<Versions, ErrorObject> {
    store
        .run(&CancellationToken::new(), |db| {
            let rows = db.you_entries().map_err(|e| store_error(&e))?;
            Ok(rows
                .into_iter()
                .map(|row| (row.path.clone(), version(row)))
                .collect())
        })
        .await
}

fn version(row: YouEntry) -> MemorySyncEntry {
    MemorySyncEntry {
        // A clock that doesn't parse is empty, so any other version is newer.
        clock: serde_json::from_str(&row.clock).unwrap_or_default(),
        path: row.path,
        hash: row.hash,
        machine: MemoryMachine {
            id: row.machine,
            name: row.machine_name,
        },
        written_at: row.written_at,
        deleted: row.deleted,
    }
}

async fn put(daemon: &Daemon, versions: Vec<MemorySyncEntry>) -> Result<(), ErrorObject> {
    if versions.is_empty() {
        return Ok(());
    }
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            for entry in versions {
                let row = YouEntry {
                    clock: serde_json::to_string(&entry.clock).unwrap_or_default(),
                    path: entry.path,
                    hash: entry.hash,
                    machine: entry.machine.id,
                    machine_name: entry.machine.name,
                    written_at: entry.written_at,
                    deleted: entry.deleted,
                };
                db.put_you_entry(&row).map_err(|e| store_error(&e))?;
            }
            Ok(())
        })
        .await
}

/// Scans You and records what changed as `me`'s, then returns every version. The caller holds
/// [`Daemon::you_sync`].
async fn record(daemon: &Daemon, me: &MemoryMachine) -> Result<Versions, ErrorObject> {
    let mut versions = recorded(&daemon.store).await?;
    let dir = super::you_dir(&daemon.data_dir);
    let (seen, me) = (versions.clone(), me.clone());
    let changed = blocking(move || scan(&dir, &seen, &me).map_err(|e| e.to_string())).await?;
    put(daemon, changed.clone()).await?;
    versions.extend(changed.into_iter().map(|entry| (entry.path.clone(), entry)));
    Ok(versions)
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, ErrorObject> {
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result.map_err(ErrorObject::internal_error),
        Err(error) => Err(ErrorObject::internal_error(error.to_string())),
    }
}

/// This node's tailnet status, and this machine as You's versions name it.
async fn this_machine(daemon: &Daemon) -> Result<(Status, MemoryMachine), ErrorObject> {
    let status = daemon
        .connect
        .tailnet
        .status()
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?;
    let name = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.device_name().map_err(|e| store_error(&e))
        })
        .await?;
    let machine = MemoryMachine {
        id: status.this.id.clone(),
        name: name.unwrap_or_else(|| status.this.host_name.clone()),
    };
    Ok((status, machine))
}

/// `memory/syncList`: scans You, then lists every version.
pub(crate) async fn list(daemon: &Daemon) -> Result<MemorySyncListResult, ErrorObject> {
    let (_, me) = this_machine(daemon).await?;
    let _sync = daemon.you_sync.lock().await;
    let versions = record(daemon, &me).await?;
    Ok(MemorySyncListResult {
        entries: versions.into_values().collect(),
    })
}

/// `memory/syncRead`: the text of `path` that syncs.
pub(crate) async fn read(
    daemon: &Daemon,
    path: String,
) -> Result<MemorySyncReadResult, ErrorObject> {
    if !syncs(&path) {
        return Err(ErrorObject::invalid_params(format!(
            "{path} doesn't sync; You syncs memory/<kind>/<slug>.md and knowledge/<slug>.md"
        )));
    }
    let dir = super::you_dir(&daemon.data_dir);
    let read = tokio::task::spawn_blocking(move || {
        let (bytes, _) = super::read_file(&dir, &path).map_err(|e| super::io_error(&path, &e))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| ErrorObject::internal_error(format!("{path} is not valid UTF-8 text")))?;
        Ok(MemorySyncReadResult {
            content: synced(&text),
        })
    })
    .await;
    read.unwrap_or_else(|error| Err(ErrorObject::internal_error(error.to_string())))
}

/// Pulls You memory from the user's other Connect devices, at their Connect listener's `port`,
/// every `every` while `connect` is on, until `stop`. The first pull is one `every` after start,
/// once the Connect listener has had its first check.
pub(crate) async fn run(daemon: Arc<Daemon>, every: Duration, port: u16, stop: CancellationToken) {
    let peers = Peers::new(Arc::clone(&daemon.connect.tailnet), port);
    let mut tick = time::interval_at(time::Instant::now() + every, every);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            _ = tick.tick() => {}
        }
        tokio::select! {
            () = stop.cancelled() => return,
            pulled = pull_all(&daemon, &peers, every) => if let Err(error) = pulled {
                debug!(error = %error.message, "skipped syncing You memory");
            },
        }
    }
}

/// A peer's versions, and the texts read for them, by path.
type Fetched = (Vec<MemorySyncEntry>, HashMap<String, String>);

/// Scans, then pulls every online device at once, each device's calls within `every`, so a
/// device that went to sleep mid-call can't hold up the others.
async fn pull_all(daemon: &Arc<Daemon>, peers: &Peers, every: Duration) -> Result<(), ErrorObject> {
    let on = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.connect().map_err(|e| store_error(&e))
        })
        .await?;
    if !on {
        return Ok(());
    }
    let (status, me) = this_machine(daemon).await?;
    {
        let _sync = daemon.you_sync.lock().await;
        record(daemon, &me).await?;
    }
    let pulls = status.own_peers().filter(|node| node.online).map(|node| {
        let (client, me) = (peers.client(&node.id), &me);
        async move {
            if let Err(error) = pull(daemon, &client, me, every).await {
                debug!(device = %node.host_name, %error, "could not pull You memory");
            }
        }
    });
    futures_util::future::join_all(pulls).await;
    Ok(())
}

/// `peer`'s versions, and the text of each one this host may take, or `None` for a peer without
/// `youSync`. It runs before the lock is taken, so two hosts pulling from each other never wait
/// on each other's lock.
async fn fetch(daemon: &Daemon, peer: &Plxd) -> Result<Option<Fetched>, String> {
    if !peer.you_sync().await? {
        return Ok(None);
    }
    let remote = peer
        .call::<MemorySyncList>(MemorySyncListParams {})
        .await?
        .entries;
    let local = recorded(&daemon.store).await.map_err(|e| e.message)?;
    // A local change only makes a remote version older, so this reads every text the apply
    // below can need. Text this host already has isn't read.
    let mut texts = HashMap::new();
    for entry in &remote {
        let row = local.get(&entry.path);
        if entry.deleted
            || !syncs(&entry.path)
            || row.is_some_and(|row| !row.deleted && row.hash == entry.hash)
            || merge(row, entry) == Action::Nothing
        {
            continue;
        }
        let path = entry.path.clone();
        match peer
            .call::<MemorySyncRead>(MemorySyncReadParams { path })
            .await
        {
            Ok(read) if crate::sha256_hex(read.content.as_bytes()) == entry.hash => {
                texts.insert(entry.path.clone(), read.content);
            }
            // It changed since the list: the next pull takes it.
            Ok(_) => {}
            Err(error) => debug!(path = %entry.path, %error, "could not read a You entry"),
        }
    }
    Ok(Some((remote, texts)))
}

/// Pulls `peer`'s versions and applies them. Only the calls to `peer` have to finish within
/// `every`: the apply always runs to the end, so no file is written without its row.
async fn pull(
    daemon: &Arc<Daemon>,
    peer: &Plxd,
    me: &MemoryMachine,
    every: Duration,
) -> Result<(), String> {
    let fetched = time::timeout(every, fetch(daemon, peer))
        .await
        .map_err(|_| format!("no answer within {every:?}"))??;
    let Some((remote, texts)) = fetched else {
        return Ok(());
    };
    let _sync = daemon.you_sync.lock().await;
    let local = record(daemon, me).await.map_err(|e| e.message)?;
    let dir = super::you_dir(&daemon.data_dir);
    let applied = blocking(move || {
        let mut applied = Vec::new();
        for entry in remote.iter().filter(|entry| syncs(&entry.path)) {
            let text = texts.get(&entry.path).map(String::as_str);
            match apply(&dir, local.get(&entry.path), entry, text) {
                Ok(Some(done)) => applied.push(done),
                Ok(None) => {}
                Err(error) => warn!(path = %entry.path, %error, "could not apply a You entry"),
            }
        }
        Ok(applied)
    })
    .await
    .map_err(|e| e.message)?;
    let tell: Vec<(String, Change)> = applied
        .iter()
        .filter_map(|(entry, change)| Some((entry.path.clone(), (*change)?)))
        .collect();
    put(
        daemon,
        applied.into_iter().map(|(entry, _)| entry).collect(),
    )
    .await
    .map_err(|e| e.message)?;
    for (path, change) in tell {
        corrections::tell(daemon, MemoryScope::You, &path, None, change);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use parallax_protocol::{MemoryMachine, MemorySyncEntry};

    use super::{Clock, apply};

    fn clock(counts: &[(&str, u64)]) -> Clock {
        counts
            .iter()
            .map(|(id, n)| ((*id).to_owned(), *n))
            .collect()
    }

    fn version(machine: &str, hash: &str, counts: &[(&str, u64)], at: i64) -> MemorySyncEntry {
        MemorySyncEntry {
            path: "memory/preference/tabs.md".to_owned(),
            hash: hash.to_owned(),
            clock: clock(counts),
            machine: MemoryMachine {
                id: machine.to_owned(),
                name: format!("{machine}-name"),
            },
            written_at: Timestamp::from_second(at).unwrap(),
            deleted: hash.is_empty(),
        }
    }

    #[test]
    fn the_same_text_records_only_the_row_and_an_edit_since_the_scan_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = "memory/preference/tabs.md";
        let file = dir.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let text = "Title: Tabs\nLast used: 2026-10-23\n\nUse tabs.\n";
        std::fs::write(&file, text).unwrap();
        let local = version("a", &super::hash(text), &[("a", 1)], 10);
        let merged = version("b", &super::hash(text), &[("a", 1), ("b", 1)], 20);
        let (row, change) = apply(dir.path(), Some(&local), &merged, None)
            .unwrap()
            .unwrap();
        assert_eq!((row.clock, change), (merged.clock.clone(), None));
        // The file keeps its `Last used:` line.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);

        // An edit on disk since the scan isn't overwritten.
        std::fs::write(&file, "Title: Tabs\n\nUse tabs, width 2.\n").unwrap();
        let theirs = "Title: Tabs\n\nUse spaces.\n";
        let newer = version("b", &super::hash(theirs), &[("a", 1), ("b", 2)], 30);
        assert_eq!(
            apply(dir.path(), Some(&local), &newer, Some(theirs)),
            Ok(None)
        );
        assert!(std::fs::read_to_string(&file).unwrap().contains("width 2"));
    }
}
