//! Areas (PLX-789): named, colored lists of top-level threads and Projects. A member's row goes
//! with its area, thread, or Project, by foreign key.

use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// An area's name, color, and members, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AreaFields {
    pub name: String,
    pub color: String,
    /// Its threads, in the order they were added.
    pub threads: Vec<Uuid>,
    /// Its Projects, in the order they were added.
    pub projects: Vec<Uuid>,
}

/// An area row with its members, each list in the order it was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Area {
    pub id: Uuid,
    pub fields: AreaFields,
    pub created_at: Timestamp,
}

fn members(
    conn: &Connection,
    table: &str,
    column: &str,
    id: &str,
) -> Result<Vec<Uuid>, StoreError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {column} FROM {table} WHERE area_id = ?1 ORDER BY position"
    ))?;
    let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(Uuid::parse_str(&row?)?);
    }
    Ok(ids)
}

fn area(conn: &Connection, row: (String, String, String, String)) -> Result<Area, StoreError> {
    let (id, name, color, created_at) = row;
    Ok(Area {
        fields: AreaFields {
            name,
            color,
            threads: members(conn, "area_threads", "thread_id", &id)?,
            projects: members(conn, "area_projects", "project_id", &id)?,
        },
        id: Uuid::parse_str(&id)?,
        created_at: timestamp::parse(&created_at)?,
    })
}

impl Store {
    /// Every area, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn list_areas(&self) -> Result<Vec<Area>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, color, created_at FROM areas ORDER BY created_at, id")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|row| area(&self.conn, row)).collect()
    }

    /// Reads an area.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn get_area(&self, id: Uuid) -> Result<Option<Area>, StoreError> {
        self.conn
            .query_row(
                "SELECT id, name, color, created_at FROM areas WHERE id = ?1",
                params![id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .map(|row| area(&self.conn, row))
            .transpose()
    }

    /// Creates area `id`, or sets its name and color, keeping its creation time. Replaces its
    /// threads or Projects only when given, dropping ids that name no top-level thread or
    /// Project, and repeats; a list not given keeps its stored members, even a thread that has
    /// since gained a parent. Returns the area as stored.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn save_area(
        &mut self,
        id: Uuid,
        name: &str,
        color: &str,
        threads: Option<&[Uuid]>,
        projects: Option<&[Uuid]>,
    ) -> Result<Area, StoreError> {
        let tx = self.conn.savepoint()?;
        let key = id.to_string();
        tx.execute(
            "INSERT INTO areas (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color",
            params![key, name, color, timestamp::now()],
        )?;
        if let Some(threads) = threads {
            tx.execute("DELETE FROM area_threads WHERE area_id = ?1", params![key])?;
            for (position, thread) in threads.iter().enumerate() {
                tx.execute(
                    "INSERT OR IGNORE INTO area_threads (area_id, thread_id, position)
                     SELECT ?1, id, ?3 FROM threads WHERE id = ?2
                        AND (SELECT parent FROM runs WHERE runs.id = threads.id) IS NULL",
                    params![key, thread.to_string(), position],
                )?;
            }
        }
        if let Some(projects) = projects {
            tx.execute("DELETE FROM area_projects WHERE area_id = ?1", params![key])?;
            for (position, project) in projects.iter().enumerate() {
                tx.execute(
                    "INSERT OR IGNORE INTO area_projects (area_id, project_id, position)
                     SELECT ?1, id, ?3 FROM projects WHERE id = ?2",
                    params![key, project.to_string(), position],
                )?;
            }
        }
        tx.commit()?;
        self.get_area(id)?.ok_or(StoreError::NotFound { id })
    }

    /// Deletes area `id`, leaving its threads and Projects. Returns whether it existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_area(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .execute("DELETE FROM areas WHERE id = ?1", params![id.to_string()])?
            > 0)
    }

    /// Whether thread or Project `id` is in any area, so deleting it changes one.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn in_area(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM area_threads WHERE thread_id = ?1)
                OR EXISTS (SELECT 1 FROM area_projects WHERE project_id = ?1)",
            params![id.to_string()],
            |row| row.get(0),
        )?)
    }
}
