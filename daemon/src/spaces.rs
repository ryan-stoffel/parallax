//! Spaces (0069, PLX-732): `space/create` and `space/delete`, behind the `spaces` capability.
//!
//! A Space is a repo entry with `space` true, whose repository plxd made at
//! `<data folder>/spaces/<id>`. A chat in it is an ordinary thread started with that entry as its
//! `repo`, so it runs in a worktree of the Space's repository and shares the Space's context
//! folder. `repo/update` renames a Space ([`crate::threads::update_repo`]).

use std::path::PathBuf;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, MAX_SPACE_NAME_BYTES, ParallaxEvent, ProjectId, RepoId, SpaceCreateParams,
    SpaceCreateResult, SpaceDeleteParams, SpaceDeleteResult,
};
use parallax_store::RepoFields;
use tracing::{info, warn};
use uuid::Uuid;

use crate::server::Daemon;
use crate::threads::{self, repo_entry, store, store_error};

/// The folder under plxd's data folder that holds Spaces' repositories.
const SPACES_DIR: &str = "spaces";

/// A Space's name as `space/create` and `repo/update` take it: trimmed, 1 to
/// [`MAX_SPACE_NAME_BYTES`] bytes.
pub(crate) fn check_name(name: &str) -> Result<String, ErrorObject> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_SPACE_NAME_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "a Space's name must be 1 to {MAX_SPACE_NAME_BYTES} bytes"
        )));
    }
    Ok(name.to_owned())
}

/// A Space's repository folder under the canonical spaces folder, made if missing, so the path
/// stored is the one git and the sandbox see.
fn space_dir(daemon: &Daemon, id: RepoId) -> Result<PathBuf, ErrorObject> {
    let root = daemon.data_dir.root().join(SPACES_DIR);
    std::fs::create_dir_all(&root)
        .and_then(|()| root.canonicalize())
        .map(|root| root.join(id.to_string()))
        .map_err(|error| {
            ErrorObject::internal_error(format!(
                "could not create the spaces folder {}: {error}",
                root.display()
            ))
        })
}

fn not_found(id: RepoId) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::RepoNotFound, format!("no Space has id {id}"))
}

/// `space/create`: idempotent on the id.
pub(crate) async fn create(
    daemon: &Arc<Daemon>,
    params: SpaceCreateParams,
) -> Result<SpaceCreateResult, ErrorObject> {
    let SpaceCreateParams { id, name, icon } = params;
    let name = check_name(&name)?;
    let icon = icon
        .map(|icon| {
            crate::methods::project::check_icon(&icon)?;
            Ok::<_, ErrorObject>(crate::store::stored_icon(icon))
        })
        .transpose()?;
    let dir = space_dir(daemon, id)?;
    daemon
        .agents
        .worktrees()
        .init_scratch(&dir)
        .await
        .map_err(|error| {
            ErrorObject::parallax(
                ErrorKind::WorktreeFailed,
                format!("could not make the Space's repository: {error}"),
            )
        })?;
    let path = dir.to_string_lossy().into_owned();
    store(daemon, move |db| {
        let key: Uuid = id.into();
        if let Some(existing) = db.get_repo(key).map_err(|e| store_error(&e))? {
            if existing.fields.space && existing.fields.name == name {
                return Ok(SpaceCreateResult {
                    repo: repo_entry(existing)?,
                });
            }
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!("{id} is already in use"),
            ));
        }
        let fields = RepoFields {
            name,
            path,
            scratch: false,
            space: true,
        };
        db.add_repo(key, &fields).map_err(|e| store_error(&e))?;
        if let Some(icon) = &icon {
            db.set_repo_icon(key, icon).map_err(|e| store_error(&e))?;
        }
        let row = db
            .get_repo(key)
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| not_found(id))?;
        let repo = repo_entry(row)?;
        db.stage(
            repo.created_at,
            None,
            ParallaxEvent::RepoAdded { repo: repo.clone() },
        );
        info!(space = %repo.id, "made a Space");
        Ok(SpaceCreateResult { repo })
    })
    .await
}

/// `space/delete`: deletes each chat in the Space through `thread/delete`, then the entry and its
/// folders. Run it detached, as `thread/delete` is, so a dropped connection can't leave it half
/// done: deleting again finishes the job.
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    params: SpaceDeleteParams,
) -> Result<SpaceDeleteResult, ErrorObject> {
    let id = params.space;
    let chats = store(daemon, move |db| {
        db.get_repo(id.into())
            .map_err(|e| store_error(&e))?
            .filter(|repo| repo.fields.space)
            .ok_or_else(|| not_found(id))?;
        Ok(db
            .list_threads()
            .map_err(|e| store_error(&e))?
            .into_iter()
            .filter(|thread| thread.repo_id == Uuid::from(id))
            .map(|thread| thread.id)
            .collect::<Vec<_>>())
    })
    .await?;
    for chat in chats {
        let run = parallax_protocol::RunId::try_from(chat).map_err(|_| {
            ErrorObject::internal_error(format!("the stored thread {chat} has an invalid id"))
        })?;
        threads::delete(daemon, run, None).await?;
    }
    store(daemon, move |db| {
        db.delete_repo(id.into()).map_err(|e| store_error(&e))?;
        db.stage(
            jiff::Timestamp::now(),
            None,
            ParallaxEvent::RepoRemoved { repo: id },
        );
        Ok(())
    })
    .await?;
    if let Ok(dir) = space_dir(daemon, id)
        && let Err(error) = std::fs::remove_dir_all(&dir)
    {
        warn!(space = %id, %error, "could not remove a deleted Space's repository");
    }
    if let Ok(scope) = ProjectId::try_from(Uuid::from(id)) {
        threads::remove_context(daemon, scope);
    }
    info!(space = %id, "deleted a Space");
    Ok(SpaceDeleteResult {})
}
