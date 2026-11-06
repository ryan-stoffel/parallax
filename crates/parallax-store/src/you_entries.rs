use jiff::Timestamp;
use rusqlite::params;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// A row in `you_entries`: the version plxd has recorded of one You entry or knowledge file
/// (0082, PLX-946).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YouEntry {
    pub path: String,
    /// SHA-256 of the text that syncs, empty for a deletion.
    pub hash: String,
    /// The version vector, as plxd's JSON.
    pub clock: String,
    /// The node ID and name of the machine that wrote this version.
    pub machine: String,
    pub machine_name: String,
    pub written_at: Timestamp,
    /// A tombstone.
    pub deleted: bool,
}

impl Store {
    /// Every recorded You entry, tombstones included, by path.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn you_entries(&self) -> Result<Vec<YouEntry>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT path, hash, clock, machine, machine_name, written_at, deleted
             FROM you_entries ORDER BY path",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    YouEntry {
                        path: row.get(0)?,
                        hash: row.get(1)?,
                        clock: row.get(2)?,
                        machine: row.get(3)?,
                        machine_name: row.get(4)?,
                        written_at: Timestamp::UNIX_EPOCH,
                        deleted: row.get(6)?,
                    },
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(mut entry, written_at)| {
                entry.written_at = timestamp::parse(&written_at)?;
                Ok(entry)
            })
            .collect()
    }

    /// Records `entry`, replacing the row for its path.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_you_entry(&self, entry: &YouEntry) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO you_entries (path, hash, clock, machine, machine_name, written_at, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (path) DO UPDATE SET hash = ?2, clock = ?3, machine = ?4,
                machine_name = ?5, written_at = ?6, deleted = ?7",
            params![
                entry.path,
                entry.hash,
                entry.clock,
                entry.machine,
                entry.machine_name,
                timestamp::format(entry.written_at),
                entry.deleted
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::YouEntry;
    use crate::Store;

    #[test]
    fn an_entry_is_replaced_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let mut entry = YouEntry {
            path: "memory/preference/tabs.md".to_owned(),
            hash: "h1".to_owned(),
            clock: r#"{"a":1}"#.to_owned(),
            machine: "a".to_owned(),
            machine_name: "Studio".to_owned(),
            written_at: Timestamp::from_second(1_800_000_000).unwrap(),
            deleted: false,
        };
        store.put_you_entry(&entry).unwrap();
        entry.hash = String::new();
        entry.deleted = true;
        store.put_you_entry(&entry).unwrap();
        assert_eq!(store.you_entries().unwrap(), [entry]);
    }
}
