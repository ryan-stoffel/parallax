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
use crate::methods::memory::{free_path, save};
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
        let Some(text) = super::read_file(dir, &path)
            .ok()
            .and_then(|(bytes, _)| String::from_utf8(bytes).ok())
        else {
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
/// children of, for a file that existed here; `None` when there is nothing to do yet.
fn apply(
    dir: &Path,
    local: Option<&MemorySyncEntry>,
    remote: &MemorySyncEntry,
    text: Option<&str>,
) -> Result<Option<(MemorySyncEntry, Option<Change>)>, String> {
    if !remote.deleted && text.is_none() {
        return Ok(None);
    }
    let existed = local.is_some_and(|local| !local.deleted);
    let (kept, other, local) = match (merge(local, remote), local) {
        (Action::Nothing, _) => return Ok(None),
        (Action::Resolve { remote, other }, Some(local)) => (remote, other, local),
        (Action::Take | Action::Resolve { .. }, _) => {
            write(dir, &remote.path, text)?;
            let change = if remote.deleted {
                Change::Deleted
            } else {
                Change::Updated
            };
            return Ok(Some((remote.clone(), existed.then_some(change))));
        }
    };
    let replaced = kept && local.hash != remote.hash;
    if other {
        let (text, machine) = if kept {
            let (bytes, _) = super::read_file(dir, &remote.path).map_err(|e| e.to_string())?;
            let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
            (synced(&text), &local.machine.name)
        } else {
            (text.unwrap_or_default().to_owned(), &remote.machine.name)
        };
        keep_other(dir, &remote.path, &text, machine)?;
    }
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

/// Keeps `text`, the version of `path` written on `machine` that lost a conflict: an entry's as a
/// proposal that replaces it, which the Memory tab saves or discards, and a knowledge file's as a
/// copy beside it, which syncs as a file of its own, since a proposal needs a kind.
fn keep_other(dir: &Path, path: &str, text: &str, machine: &str) -> Result<(), String> {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("entry");
    let name = format!("{stem}-{}", memory::slug(machine));
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
            (free_path(dir, "proposals", &name), text)
        }
        None => (free_path(dir, "knowledge", &name), text.to_owned()),
    };
    save(dir, &target, &text).map(drop).map_err(|e| e.message)
}

/// The machine that wrote the text of `path` in You folder `dir` now, if `versions` records it.
pub(crate) fn machine(dir: &Path, path: &str, versions: &Versions) -> Option<MemoryMachine> {
    let row = versions.get(path).filter(|row| !row.deleted)?;
    let (bytes, _) = super::read_file(dir, path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
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
            pulled = pull_all(&daemon, &peers) => if let Err(error) = pulled {
                debug!(error = %error.message, "skipped syncing You memory");
            },
        }
    }
}

async fn pull_all(daemon: &Arc<Daemon>, peers: &Peers) -> Result<(), ErrorObject> {
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
    for node in status.own_peers().filter(|node| node.online) {
        if let Err(error) = pull(daemon, &peers.client(&node.id), &me).await {
            debug!(device = %node.host_name, %error, "could not pull You memory");
        }
    }
    Ok(())
}

/// Pulls `peer`'s versions and applies them. The text is read before taking the lock, so two
/// hosts pulling from each other never wait on each other's lock.
async fn pull(daemon: &Arc<Daemon>, peer: &Plxd, me: &MemoryMachine) -> Result<(), String> {
    if !peer.you_sync().await? {
        return Ok(());
    }
    let remote = peer
        .call::<MemorySyncList>(MemorySyncListParams {})
        .await?
        .entries;
    let local = recorded(&daemon.store).await.map_err(|e| e.message)?;
    // A local change only makes a remote version older, so this reads every text the apply
    // below can need.
    let mut texts = HashMap::new();
    for entry in &remote {
        if entry.deleted
            || !syncs(&entry.path)
            || merge(local.get(&entry.path), entry) == Action::Nothing
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

    use super::{Action, Clock, Order, apply, merge, merged, order, scan, synced};

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
    fn clocks_order_by_every_machines_counter() {
        let a1 = clock(&[("a", 1)]);
        let a2b1 = clock(&[("a", 2), ("b", 1)]);
        assert_eq!(order(&a1, &a1), Order::Same);
        assert_eq!(order(&a1, &a2b1), Order::Remote);
        assert_eq!(order(&a2b1, &a1), Order::Local);
        assert_eq!(
            order(&clock(&[("a", 2)]), &clock(&[("a", 1), ("b", 1)])),
            Order::Concurrent
        );
        assert_eq!(
            merged(&clock(&[("a", 2)]), &clock(&[("a", 1), ("b", 1)])),
            a2b1
        );
    }

    #[test]
    fn ordered_versions_take_the_later_and_concurrent_ones_agree_on_a_winner() {
        let base = version("a", "h0", &[("a", 1)], 10);
        let later = version("b", "h1", &[("a", 1), ("b", 1)], 5);
        // The clock decides, not the earlier wall time.
        assert_eq!(merge(Some(&base), &later), Action::Take);
        assert_eq!(merge(Some(&later), &base), Action::Nothing);
        assert_eq!(merge(None, &base), Action::Take);

        let on_a = version("a", "ha", &[("a", 2)], 20);
        let on_b = version("b", "hb", &[("a", 1), ("b", 1)], 30);
        // Both sides keep B's later edit, and keep A's as the other version.
        let keep_b = Action::Resolve {
            remote: true,
            other: true,
        };
        let keep_local_b = Action::Resolve {
            remote: false,
            other: true,
        };
        assert_eq!(merge(Some(&on_a), &on_b), keep_b);
        assert_eq!(merge(Some(&on_b), &on_a), keep_local_b);
        // Same time: the higher node ID.
        let at_once = version("b", "hb", &[("a", 1), ("b", 1)], 20);
        assert_eq!(merge(Some(&on_a), &at_once), keep_b);

        // The same text, or an edit against a deletion: no other version to keep.
        let same = version("b", "ha", &[("a", 1), ("b", 1)], 10);
        assert_eq!(
            merge(Some(&on_a), &same),
            Action::Resolve {
                remote: false,
                other: false
            }
        );
        let deleted = version("b", "", &[("a", 1), ("b", 1)], 99);
        assert_eq!(
            merge(Some(&on_a), &deleted),
            Action::Resolve {
                remote: false,
                other: false
            }
        );
        assert_eq!(
            merge(Some(&deleted), &on_a),
            Action::Resolve {
                remote: true,
                other: false
            }
        );
    }

    #[test]
    fn last_used_and_stale_lines_dont_sync() {
        let entry = "Kind: preference\nTitle: Tabs\n\nUse tabs.\n";
        assert_eq!(synced(entry), entry);
        let stamped =
            "Stale: a.rs\nKind: preference\nTitle: Tabs\nLast used: 2026-10-23\n\nUse tabs.\n";
        assert_eq!(synced(stamped), entry);
        assert_eq!(synced("Last used: 2026-10-23\n\n# Notes\n"), "# Notes\n");
        assert_eq!(
            synced("# Notes\nLast used: in the body\n"),
            "# Notes\nLast used: in the body\n"
        );
    }

    #[test]
    fn a_scan_stamps_edits_new_files_and_deletions_as_this_machines() {
        let dir = tempfile::tempdir().unwrap();
        let me = MemoryMachine {
            id: "a".to_owned(),
            name: "Studio".to_owned(),
        };
        let file = dir.path().join("memory/preference/tabs.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "Title: Tabs\n\nUse tabs.\n").unwrap();
        let first = scan(dir.path(), &super::Versions::new(), &me).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].clock, clock(&[("a", 1)]));
        let versions: super::Versions = first.into_iter().map(|e| (e.path.clone(), e)).collect();

        // An agent's read stamps `Last used:`, which isn't an edit.
        std::fs::write(&file, "Title: Tabs\nLast used: 2026-10-23\n\nUse tabs.\n").unwrap();
        assert!(scan(dir.path(), &versions, &me).unwrap().is_empty());

        std::fs::remove_file(&file).unwrap();
        let gone = scan(dir.path(), &versions, &me).unwrap();
        assert!(gone[0].deleted);
        assert_eq!(gone[0].clock, clock(&[("a", 2)]));
    }

    #[test]
    fn a_conflict_keeps_the_losing_entry_as_a_proposal() {
        let dir = tempfile::tempdir().unwrap();
        let path = "memory/preference/tabs.md";
        let file = dir.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mine = "Title: Tabs\n\nUse tabs.\n";
        std::fs::write(&file, mine).unwrap();
        let local = version("a", &super::hash(mine), &[("a", 2)], 20);
        let theirs = "Title: Tabs\n\nUse spaces.\n";
        let remote = version("b", &super::hash(theirs), &[("a", 1), ("b", 1)], 30);

        let (row, change) = apply(dir.path(), Some(&local), &remote, Some(theirs))
            .unwrap()
            .unwrap();
        assert_eq!(row.machine.id, "b");
        assert_eq!(row.clock, clock(&[("a", 2), ("b", 1)]));
        assert!(change.is_some());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), theirs);
        let proposal =
            std::fs::read_to_string(dir.path().join("proposals/tabs-a-name.md")).unwrap();
        assert!(proposal.contains("Scope: you\nReplaces: memory/preference/tabs.md\n"));
        assert!(proposal.ends_with("\nUse tabs.\n"), "{proposal}");
    }
}
