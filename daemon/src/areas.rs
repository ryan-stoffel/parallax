//! Areas (PLX-789): `area/create`, `area/update`, and `area/delete`, behind the `areas`
//! capability.
//!
//! An area is a named, colored list of top-level threads and Projects from any repo entry,
//! Project, or Space, and of whole repo entries and Spaces behind `areaRepos` (PLX-852). plxd
//! drops member ids that name no top-level thread, Project, or non-scratch repo entry, so an undo
//! that re-creates an area keeps only what still exists. Every change, and deleting a member,
//! appends `areas.changed` with every area.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    Area, AreaCreateParams, AreaDeleteParams, AreaDeleteResult, AreaId, AreaResult,
    AreaUpdateParams, ErrorKind, MAX_AREA_NAME_CHARS, ParallaxEvent, ProjectId, RepoId, RunId,
};
use parallax_store::Store;
use uuid::Uuid;

use crate::methods::project::{MAX_ICON_COLOR_CHARS, check_key};
use crate::server::Daemon;
use crate::store::Tx;
use crate::threads::{store, store_error};

/// An area's name as `area/create` and `area/update` take it: trimmed, 1 to
/// [`MAX_AREA_NAME_CHARS`] characters.
fn check_name(name: &str) -> Result<String, ErrorObject> {
    let name = name.trim();
    if !(1..=MAX_AREA_NAME_CHARS).contains(&name.chars().count()) {
        return Err(ErrorObject::invalid_params(format!(
            "an area's name must be 1 to {MAX_AREA_NAME_CHARS} characters"
        )));
    }
    Ok(name.to_owned())
}

/// Fails if an area other than `id` has `name`, ignoring case.
fn check_unique(db: &Store, id: Uuid, name: &str) -> Result<(), ErrorObject> {
    let lower = name.to_lowercase();
    let areas = db.list_areas().map_err(|e| store_error(&e))?;
    if areas
        .iter()
        .any(|area| area.id != id && area.fields.name.to_lowercase() == lower)
    {
        return Err(ErrorObject::invalid_params(format!(
            "an area named \"{name}\" already exists"
        )));
    }
    Ok(())
}

fn corrupt(id: Uuid) -> ErrorObject {
    ErrorObject::internal_error(format!("the stored area {id} has an invalid id"))
}

fn entry(row: parallax_store::Area) -> Result<Area, ErrorObject> {
    let id = row.id;
    Ok(Area {
        id: AreaId::try_from(id).map_err(|_| corrupt(id))?,
        name: row.fields.name,
        color: row.fields.color,
        threads: row
            .fields
            .threads
            .into_iter()
            .map(|run| RunId::try_from(run).map_err(|_| corrupt(id)))
            .collect::<Result<_, _>>()?,
        projects: row
            .fields
            .projects
            .into_iter()
            .map(|project| ProjectId::try_from(project).map_err(|_| corrupt(id)))
            .collect::<Result<_, _>>()?,
        repos: row
            .fields
            .repos
            .into_iter()
            .map(|repo| RepoId::try_from(repo).map_err(|_| corrupt(id)))
            .collect::<Result<_, _>>()?,
    })
}

/// Every area, oldest first, for `thread/list`, the shell snapshot, and `areas.changed`.
pub(crate) fn list(db: &Store) -> Result<Vec<Area>, ErrorObject> {
    db.list_areas()
        .map_err(|e| store_error(&e))?
        .into_iter()
        .map(entry)
        .collect()
}

/// Stages `areas.changed` with every area as it stands.
pub(crate) fn stage_changed(db: &mut Tx) -> Result<(), ErrorObject> {
    let areas = list(db)?;
    db.stage(
        Timestamp::now(),
        None,
        ParallaxEvent::AreasChanged { areas },
    );
    Ok(())
}

fn uuids<T: Into<Uuid>>(ids: Vec<T>) -> Vec<Uuid> {
    ids.into_iter().map(Into::into).collect()
}

/// `area/create`: idempotent on the id.
pub(crate) async fn create(
    daemon: &Arc<Daemon>,
    params: AreaCreateParams,
) -> Result<AreaResult, ErrorObject> {
    let AreaCreateParams {
        id,
        name,
        color,
        threads,
        projects,
        repos,
    } = params;
    let name = check_name(&name)?;
    check_key("color", &color, MAX_ICON_COLOR_CHARS)?;
    let threads = uuids(threads);
    let projects = uuids(projects);
    let repos = uuids(repos);
    store(daemon, move |db| {
        let key: Uuid = id.into();
        if let Some(existing) = db.get_area(key).map_err(|e| store_error(&e))? {
            if existing.fields.name == name {
                return Ok(AreaResult {
                    area: entry(existing)?,
                });
            }
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!("{id} is already in use"),
            ));
        }
        check_unique(db, key, &name)?;
        let row = db
            .save_area(
                key,
                &name,
                &color,
                Some(&threads),
                Some(&projects),
                Some(&repos),
            )
            .map_err(|e| store_error(&e))?;
        stage_changed(db)?;
        Ok(AreaResult { area: entry(row)? })
    })
    .await
}

/// `area/update`: appends `areas.changed` only when something changed.
pub(crate) async fn update(
    daemon: &Arc<Daemon>,
    params: AreaUpdateParams,
) -> Result<AreaResult, ErrorObject> {
    let AreaUpdateParams {
        area,
        name,
        color,
        threads,
        projects,
        repos,
    } = params;
    let name = name.as_deref().map(check_name).transpose()?;
    if let Some(color) = &color {
        check_key("color", color, MAX_ICON_COLOR_CHARS)?;
    }
    store(daemon, move |db| {
        let key: Uuid = area.into();
        let before = db
            .get_area(key)
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| {
                ErrorObject::parallax(ErrorKind::AreaNotFound, format!("no area has id {area}"))
            })?;
        if let Some(name) = &name {
            check_unique(db, key, name)?;
        }
        let name = name.as_deref().unwrap_or(&before.fields.name);
        let color = color.as_deref().unwrap_or(&before.fields.color);
        let threads = threads.map(uuids);
        let projects = projects.map(uuids);
        let repos = repos.map(uuids);
        let row = db
            .save_area(
                key,
                name,
                color,
                threads.as_deref(),
                projects.as_deref(),
                repos.as_deref(),
            )
            .map_err(|e| store_error(&e))?;
        if row != before {
            stage_changed(db)?;
        }
        Ok(AreaResult { area: entry(row)? })
    })
    .await
}

/// `area/delete`: deleting an unknown area succeeds and appends nothing.
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    params: AreaDeleteParams,
) -> Result<AreaDeleteResult, ErrorObject> {
    let key: Uuid = params.area.into();
    store(daemon, move |db| {
        if db.delete_area(key).map_err(|e| store_error(&e))? {
            stage_changed(db)?;
        }
        Ok(AreaDeleteResult {})
    })
    .await
}
