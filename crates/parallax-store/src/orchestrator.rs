use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::timestamp;
use crate::{Store, StoredImage};

/// The fields of an orchestrator that a caller supplies.
///
/// An orchestrator has no host field: every orchestrator in a store is on the host
/// whose plxd owns that store (decision record 0009).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorFields {
    pub name: String,
    /// Its repository, or `None` for an orchestrator with no repo (0093), stored as `''`.
    pub repo_path: Option<String>,
    pub icon: Option<ChosenIcon>,
    /// The permission mode, `auto` or `bypass` (decision record 0042).
    pub permission: String,
    /// Who answers its children's questions, `ask`, `routine`, or `full` (decision record 0043).
    pub autonomy: String,
    /// The branch its integration branch is cut from and ships into (decision record 0045).
    /// `None` means the repository's default branch, stored once the integration branch is cut,
    /// and a retry that leaves it out matches any.
    pub base_branch: Option<String>,
}

/// An orchestrator's icon, stored as the client sent it and never read
/// (PLX-227, decision record 0032), with an optional uploaded image
/// (PLX-339, decision record 0038).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChosenIcon {
    pub name: String,
    pub color: Option<String>,
    pub image: Option<StoredImage>,
}

/// The icon columns, in [`icon_from_row`]'s order, that the orchestrators and
/// repos tables share.
pub(crate) const ICON_COLUMNS: &str = "icon_name, icon_color, icon_image_type, icon_image_data";

/// The icon in [`ICON_COLUMNS`] starting at column `first`. A NULL name
/// means no icon, and a NULL image type means no image.
pub(crate) fn icon_from_row(row: &Row<'_>, first: usize) -> rusqlite::Result<Option<ChosenIcon>> {
    let name: Option<String> = row.get(first)?;
    let color: Option<String> = row.get(first + 1)?;
    let media_type: Option<String> = row.get(first + 2)?;
    let data: Option<String> = row.get(first + 3)?;
    Ok(name.map(|name| ChosenIcon {
        name,
        color,
        image: media_type
            .zip(data)
            .map(|(media_type, data)| StoredImage { media_type, data }),
    }))
}

/// The values of [`ICON_COLUMNS`] for `icon`, all NULL for none.
pub(crate) fn icon_columns(
    icon: Option<&ChosenIcon>,
) -> (Option<&str>, Option<&str>, Option<&str>, Option<&str>) {
    let image = icon.and_then(|icon| icon.image.as_ref());
    (
        icon.map(|icon| icon.name.as_str()),
        icon.and_then(|icon| icon.color.as_deref()),
        image.map(|image| image.media_type.as_str()),
        image.map(|image| image.data.as_str()),
    )
}

/// What [`Store::update_orchestrator`] changes. A field that is `None` stays as
/// it is, and `icon` replaces the whole icon.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrchestratorEdit {
    pub name: Option<String>,
    pub icon: Option<ChosenIcon>,
    pub permission: Option<String>,
    pub autonomy: Option<String>,
    pub base_branch: Option<String>,
    pub auto_land: Option<bool>,
    pub max_children: Option<u32>,
    pub allow_api_keys: Option<bool>,
    /// The checks command the user confirmed (PLX-411). Empty clears it, and setting it clears
    /// the proposal.
    pub checks: Option<String>,
    /// The checks command its orchestrator proposed (PLX-411). Empty clears it.
    pub proposed_checks: Option<String>,
    /// The Tailscale node ID of the device its children run on (decision record 0057). Empty
    /// clears it.
    pub computer: Option<String>,
}

/// An orchestrator row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orchestrator {
    pub id: Uuid,
    pub name: String,
    /// Its repository, or `None` when it has none (0093).
    pub repo_path: Option<String>,
    pub icon: Option<ChosenIcon>,
    pub permission: String,
    pub autonomy: String,
    pub base_branch: Option<String>,
    /// Its integration branch (decision record 0045), once plxd has cut it.
    pub integration_branch: Option<String>,
    /// Whether its children land without the user's approval (PLX-410, decision record 0045).
    pub auto_land: bool,
    /// How many of its children run at once (decision record 0046), 10 unless set.
    pub max_children: u32,
    /// Whether its children may run on an API key (decision record 0046), off unless set.
    pub allow_api_keys: bool,
    /// The checks command that runs after each landing (PLX-411, decision 0045), if any.
    pub checks: Option<String>,
    /// The checks command its orchestrator proposed, which never runs until the user confirms it.
    pub proposed_checks: Option<String>,
    /// The Tailscale node ID of the device its children run on (decision record 0057), or `None`
    /// for this plxd.
    pub computer: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// An orchestrator row with its id and timestamps still as the TEXT SQLite stored
/// them, before the fallible conversion to [`Orchestrator`].
struct RawOrchestrator {
    id: String,
    name: String,
    repo_path: String,
    icon: Option<ChosenIcon>,
    permission: String,
    autonomy: String,
    base_branch: Option<String>,
    integration_branch: Option<String>,
    auto_land: bool,
    max_children: u32,
    allow_api_keys: bool,
    checks: Option<String>,
    proposed_checks: Option<String>,
    computer: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RawOrchestrator {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            name: row.get(1)?,
            repo_path: row.get(2)?,
            icon: icon_from_row(row, 10)?,
            permission: row.get(5)?,
            autonomy: row.get(8)?,
            base_branch: row.get(6)?,
            integration_branch: row.get(7)?,
            auto_land: row.get(9)?,
            max_children: row.get(14)?,
            allow_api_keys: row.get(15)?,
            checks: row.get(16)?,
            proposed_checks: row.get(17)?,
            computer: row.get(18)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }

    fn matches(&self, fields: &OrchestratorFields) -> bool {
        self.name == fields.name
            && self.repo_path == fields.repo_path.as_deref().unwrap_or("")
            && self.icon == fields.icon
            && self.permission == fields.permission
            && self.autonomy == fields.autonomy
            && (fields.base_branch.is_none() || self.base_branch == fields.base_branch)
    }

    fn into_orchestrator(self) -> Result<Orchestrator, StoreError> {
        Ok(Orchestrator {
            id: Uuid::parse_str(&self.id)?,
            name: self.name,
            repo_path: (!self.repo_path.is_empty()).then_some(self.repo_path),
            icon: self.icon,
            permission: self.permission,
            autonomy: self.autonomy,
            base_branch: self.base_branch,
            integration_branch: self.integration_branch,
            auto_land: self.auto_land,
            max_children: self.max_children,
            allow_api_keys: self.allow_api_keys,
            checks: self.checks,
            proposed_checks: self.proposed_checks,
            computer: self.computer,
            created_at: timestamp::parse(&self.created_at)?,
            updated_at: timestamp::parse(&self.updated_at)?,
        })
    }
}

/// Sets `field` to `value` when they differ, and says whether it did.
fn replace<T: PartialEq + Clone>(field: &mut T, value: &T) -> bool {
    if field == value {
        return false;
    }
    field.clone_from(value);
    true
}

/// A `SELECT` of the orchestrators `rest` picks, in [`RawOrchestrator::from_row`]'s column order.
fn select(rest: &str) -> String {
    format!(
        "SELECT id, name, repo_path, created_at, updated_at, permission, base_branch,
             integration_branch, autonomy, auto_land, {ICON_COLUMNS}, max_children,
             allow_api_keys, checks, proposed_checks, computer
         FROM orchestrators {rest}"
    )
}

fn fetch_raw(conn: &Connection, id_text: &str) -> Result<Option<RawOrchestrator>, StoreError> {
    Ok(conn
        .query_row(
            &select("WHERE id = ?1"),
            params![id_text],
            RawOrchestrator::from_row,
        )
        .optional()?)
}

impl Store {
    /// Creates an orchestrator owned by `id`.
    ///
    /// If an orchestrator with `id` already exists with the same `fields`, this
    /// returns that existing row unchanged instead of creating a second one.
    /// If it exists with different fields, it fails with
    /// [`StoreError::IdConflict`] rather than overwrite it.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdConflict`] as described above, or a database
    /// error.
    pub fn create_orchestrator(
        &mut self,
        id: Uuid,
        fields: &OrchestratorFields,
    ) -> Result<Orchestrator, StoreError> {
        let id_text = id.to_string();

        // A retry that already matches doesn't need the write lock: if
        // nothing else changes it, this snapshot is exactly what a full
        // locked check-then-insert would also return. If another writer is
        // mutating this row concurrently, that's true of any read anyway,
        // and the locked path below is still the one that runs when this
        // fast path can't already tell the answer.
        if let Some(existing) = fetch_raw(&self.conn, &id_text)?
            && existing.matches(fields)
        {
            return existing.into_orchestrator();
        }

        let now = timestamp::now();

        let (icon_name, icon_color, image_type, image_data) = icon_columns(fields.icon.as_ref());
        let tx = self.conn.savepoint()?;
        tx.execute(
            &format!(
                "INSERT INTO orchestrators (id, name, repo_path, created_at, updated_at, permission,
                     base_branch, autonomy, {ICON_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT (id) DO NOTHING"
            ),
            params![
                id_text,
                fields.name,
                fields.repo_path.as_deref().unwrap_or(""),
                now,
                fields.permission,
                fields.base_branch,
                fields.autonomy,
                icon_name,
                icon_color,
                image_type,
                image_data
            ],
        )?;
        let created = tx.changes() == 1;

        // The row must exist now: we either just inserted it, or the
        // INSERT was ignored because it already existed.
        let raw = fetch_raw(&tx, &id_text)?.ok_or(StoreError::NotFound { id })?;

        if !created && !raw.matches(fields) {
            return Err(StoreError::IdConflict { id });
        }

        tx.commit()?;
        raw.into_orchestrator()
    }

    /// Reads an orchestrator by id.
    ///
    /// # Errors
    ///
    /// Returns a database error, or an error if the stored id or timestamps
    /// are corrupt.
    pub fn get_orchestrator(&self, id: Uuid) -> Result<Option<Orchestrator>, StoreError> {
        fetch_raw(&self.conn, &id.to_string())?
            .map(RawOrchestrator::into_orchestrator)
            .transpose()
    }

    /// Lists every orchestrator, oldest first.
    ///
    /// # Errors
    ///
    /// Returns a database error, or an error if a stored id or timestamps
    /// are corrupt.
    pub fn list_orchestrators(&self) -> Result<Vec<Orchestrator>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&select("ORDER BY created_at ASC, id ASC"))?;
        stmt.query_map([], RawOrchestrator::from_row)?
            .map(|row| row?.into_orchestrator())
            .collect()
    }

    /// Renames orchestrator `id`, or sets its icon, permission mode, autonomy level, base branch,
    /// automatic landing, placement settings, checks, or computer, as `edit` says, and returns the
    /// orchestrator with whether anything changed. When nothing would change, it writes nothing.
    ///
    /// `repo_path` never changes, and `updated_at` stays as it is: a rename,
    /// a new icon, a new mode, or a new level is not activity (decision record 0032).
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] if no orchestrator has `id`, or a
    /// database error.
    pub fn update_orchestrator(
        &mut self,
        id: Uuid,
        edit: &OrchestratorEdit,
    ) -> Result<(Orchestrator, bool), StoreError> {
        let id_text = id.to_string();
        let tx = self.conn.savepoint()?;
        let mut raw = fetch_raw(&tx, &id_text)?.ok_or(StoreError::NotFound { id })?;

        let mut changed = false;
        if let Some(name) = &edit.name {
            changed |= replace(&mut raw.name, name);
        }
        if edit.icon.is_some() {
            changed |= replace(&mut raw.icon, &edit.icon);
        }
        if let Some(permission) = &edit.permission {
            changed |= replace(&mut raw.permission, permission);
        }
        if let Some(autonomy) = &edit.autonomy {
            changed |= replace(&mut raw.autonomy, autonomy);
        }
        if edit.base_branch.is_some() {
            changed |= replace(&mut raw.base_branch, &edit.base_branch);
        }
        if let Some(auto_land) = &edit.auto_land {
            changed |= replace(&mut raw.auto_land, auto_land);
        }
        if let Some(max) = &edit.max_children {
            changed |= replace(&mut raw.max_children, max);
        }
        if let Some(allow) = &edit.allow_api_keys {
            changed |= replace(&mut raw.allow_api_keys, allow);
        }
        if let Some(checks) = &edit.checks {
            let checks = (!checks.is_empty()).then(|| checks.clone());
            if checks != raw.checks || raw.proposed_checks.is_some() {
                raw.checks = checks;
                raw.proposed_checks = None;
                changed = true;
            }
        } else if let Some(proposed) = &edit.proposed_checks {
            let proposed = (!proposed.is_empty()).then(|| proposed.clone());
            changed |= replace(&mut raw.proposed_checks, &proposed);
        }
        if let Some(computer) = &edit.computer {
            let computer = (!computer.is_empty()).then(|| computer.clone());
            changed |= replace(&mut raw.computer, &computer);
        }

        if changed {
            let (icon_name, icon_color, image_type, image_data) = icon_columns(raw.icon.as_ref());
            tx.execute(
                "UPDATE orchestrators SET name = ?2, icon_name = ?3, icon_color = ?4,
                     icon_image_type = ?5, icon_image_data = ?6, permission = ?7,
                     base_branch = ?8, autonomy = ?9, auto_land = ?10, max_children = ?11,
                     allow_api_keys = ?12, checks = ?13, proposed_checks = ?14, computer = ?15
                 WHERE id = ?1",
                params![
                    id_text,
                    raw.name,
                    icon_name,
                    icon_color,
                    image_type,
                    image_data,
                    raw.permission,
                    raw.base_branch,
                    raw.autonomy,
                    raw.auto_land,
                    raw.max_children,
                    raw.allow_api_keys,
                    raw.checks,
                    raw.proposed_checks,
                    raw.computer
                ],
            )?;
            tx.commit()?;
        }
        Ok((raw.into_orchestrator()?, changed))
    }

    /// Records orchestrator `id`'s integration branch once plxd has cut it from `base` (decision
    /// record 0045), and `base` as its base branch when it had none. Returns whether a row changed.
    ///
    /// # Errors
    ///
    /// Returns a database error.
    pub fn set_integration_branch(
        &self,
        id: Uuid,
        branch: &str,
        base: &str,
    ) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE orchestrators SET integration_branch = ?2, base_branch = COALESCE(base_branch, ?3)
             WHERE id = ?1 AND (integration_branch IS NOT ?2 OR base_branch IS NULL)",
            params![id.to_string(), branch, base],
        )?;
        Ok(changed > 0)
    }

    /// Deletes an orchestrator by id, if it exists, with its inbox (PLX-401), questions (PLX-402),
    /// landing queue (PLX-410), and children waiting to be placed (PLX-413).
    ///
    /// Returns whether a row was deleted.
    ///
    /// # Errors
    ///
    /// Returns a database error.
    pub fn delete_orchestrator(&self, id: Uuid) -> Result<bool, StoreError> {
        for table in ["inbox", "questions", "landings", "placements"] {
            self.conn.execute(
                &format!("DELETE FROM {table} WHERE orchestrator_id = ?1"),
                params![id.to_string()],
            )?;
        }
        let changed = self.conn.execute(
            "DELETE FROM orchestrators WHERE id = ?1",
            params![id.to_string()],
        )?;
        Ok(changed > 0)
    }
}
