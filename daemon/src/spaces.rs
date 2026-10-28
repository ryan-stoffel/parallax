//! Spaces (0069, PLX-732): `space/create` and `space/delete`, behind the `spaces` capability.
//!
//! A Space is a repo entry with `space` true, whose repository plxd made at
//! `<data folder>/spaces/<id>`. A chat in it is an ordinary thread started with that entry as its
//! `repo`, so it runs in a worktree of the Space's repository and shares the Space's context
//! folder. `repo/update` renames a Space and sets its instructions and files
//! ([`crate::threads::update_repo`]), which every thread in it gets in its system prompt (0090).
//! `thread/setSpace` adds a thread started elsewhere to a Space, where it keeps working where it
//! was, and gets the Space's instructions and files too.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, MAX_SPACE_FILES, MAX_SPACE_INSTRUCTIONS_BYTES, MAX_SPACE_NAME_BYTES, ParallaxEvent,
    ProjectId, RepoId, SpaceCreateParams, SpaceCreateResult, SpaceDeleteParams, SpaceDeleteResult,
    ThreadSetSpaceParams, ThreadSetSpaceResult,
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

/// A Space's instructions as `repo/update` takes them: trimmed, at most
/// [`MAX_SPACE_INSTRUCTIONS_BYTES`] bytes. Empty clears them.
pub(crate) fn check_instructions(instructions: &str) -> Result<String, ErrorObject> {
    let instructions = instructions.trim();
    if instructions.len() > MAX_SPACE_INSTRUCTIONS_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "a Space's instructions must be at most {MAX_SPACE_INSTRUCTIONS_BYTES} bytes"
        )));
    }
    Ok(instructions.to_owned())
}

/// A Space's files as `repo/update` takes them: at most [`MAX_SPACE_FILES`], each a file inside
/// `uploads` once links are followed, so a thread's sandbox can read it (0071). Returns their
/// canonical paths, in order, without repeats.
pub(crate) fn check_files(uploads: &Path, files: &[String]) -> Result<Vec<String>, ErrorObject> {
    if files.len() > MAX_SPACE_FILES {
        return Err(ErrorObject::invalid_params(format!(
            "a Space keeps at most {MAX_SPACE_FILES} files"
        )));
    }
    let refuse = |path: &str| {
        ErrorObject::invalid_params(format!("{path:?} is not a file uploaded to this host"))
    };
    // Canonical, without Windows' `\\?\` prefix, so a stored path is the one the app and a worker
    // read, as `host/upload` returned it.
    let canonical = |path: &Path| {
        path.canonicalize()
            .ok()
            .and_then(|path| crate::paths::without_verbatim_prefix(&path))
    };
    let root = canonical(uploads).ok_or_else(|| refuse(""))?;
    let mut checked: Vec<String> = Vec::with_capacity(files.len());
    for path in files {
        let file = canonical(Path::new(path)).ok_or_else(|| refuse(path))?;
        let file = file
            .to_str()
            .filter(|_| file.starts_with(&root) && file.is_file())
            .filter(|file| !file.contains('\n'))
            .ok_or_else(|| refuse(path))?
            .to_owned();
        if !checked.contains(&file) {
            checked.push(file);
        }
    }
    Ok(checked)
}

/// The system prompt a thread in a Space gets for the Space's instructions and files (0090), or
/// `None` when it has neither.
pub(crate) fn thread_instructions(space: &parallax_store::Repo) -> Option<String> {
    if !space.fields.space || (space.instructions.is_none() && space.files.is_empty()) {
        return None;
    }
    let mut text = format!(
        "This thread is in the Space \"{}\". The user set what follows for every thread in it.",
        space.fields.name
    );
    if let Some(instructions) = &space.instructions {
        text.push_str("\n\n<space_instructions>\n");
        text.push_str(instructions);
        text.push_str("\n</space_instructions>");
    }
    if !space.files.is_empty() {
        text.push_str(
            "\n\nThe Space's files, which you can read when they help with the user's request:",
        );
        for file in &space.files {
            text.push_str("\n- ");
            text.push_str(file);
        }
    }
    Some(text)
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

/// `thread/setSpace`: adds each thread to the Space, or takes it out of its Space, appending
/// `thread.updated` for each that changed. A thread started in a Space lives in its repository, and
/// a Project's thread in its Project, so neither moves.
pub(crate) async fn set_space(
    daemon: &Arc<Daemon>,
    params: ThreadSetSpaceParams,
) -> Result<ThreadSetSpaceResult, ErrorObject> {
    let ThreadSetSpaceParams { threads, space } = params;
    if threads.is_empty() {
        return Err(ErrorObject::invalid_params(
            "thread/setSpace needs a thread",
        ));
    }
    store(daemon, move |db| {
        let error = |e| store_error(&e);
        if let Some(space) = space {
            db.get_repo(space.into())
                .map_err(error)?
                .filter(|repo| repo.fields.space)
                .ok_or_else(|| not_found(space))?;
        }
        let mut changed = Vec::with_capacity(threads.len());
        for run in &threads {
            let thread = db
                .get_thread((*run).into())
                .map_err(error)?
                .ok_or_else(|| threads::thread_not_found(*run))?;
            let home = db.get_repo(thread.repo_id).map_err(error)?;
            match home {
                Some(home) if home.fields.space => {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {run} started in a Space, so it stays there"
                    )));
                }
                None => {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {run} is a Project's, so it can't join a Space"
                    )));
                }
                Some(_) => {}
            }
            let (thread, moved) = db
                .set_thread_space(thread.id, space.map(Uuid::from))
                .map_err(error)?;
            let thread = threads::thread_entry(&thread)?;
            if moved {
                db.stage(
                    jiff::Timestamp::now(),
                    None,
                    ParallaxEvent::ThreadUpdated {
                        thread: thread.clone(),
                    },
                );
            }
            changed.push(thread);
        }
        Ok(ThreadSetSpaceResult { threads: changed })
    })
    .await
}

/// `space/delete`: deletes each chat in the Space through `thread/delete`, takes the threads added
/// to it out, then deletes the entry and its folders. Run it detached, as `thread/delete` is, so a dropped connection can't leave it half
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
        // A thread added to it goes back to working where it was, in no Space.
        let added = db
            .list_threads()
            .map_err(|e| store_error(&e))?
            .into_iter()
            .filter(|thread| thread.space_id == Some(Uuid::from(id)));
        for thread in added {
            let (thread, _) = db
                .set_thread_space(thread.id, None)
                .map_err(|e| store_error(&e))?;
            db.stage(
                jiff::Timestamp::now(),
                None,
                ParallaxEvent::ThreadUpdated {
                    thread: threads::thread_entry(&thread)?,
                },
            );
        }
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

#[cfg(test)]
mod tests {
    use parallax_store::{Repo, RepoFields};
    use uuid::Uuid;

    use super::{check_files, thread_instructions};

    #[test]
    fn a_space_takes_only_files_uploaded_to_this_host() {
        let data = tempfile::tempdir().unwrap();
        let uploads = data.path().join("uploads");
        std::fs::create_dir_all(uploads.join("a")).unwrap();
        let brief = uploads.join("a/brief.pdf");
        std::fs::write(&brief, b"%PDF").unwrap();
        let outside = data.path().join("secret.txt");
        std::fs::write(&outside, b"no").unwrap();
        let brief = brief.to_str().unwrap().to_owned();

        let kept = check_files(&uploads, &[brief.clone(), brief.clone()]).unwrap();
        assert_eq!(kept.len(), 1, "a repeat is kept once");
        assert!(kept[0].ends_with("brief.pdf"));
        for refused in [
            outside.to_str().unwrap().to_owned(),
            uploads.join("a/missing.pdf").to_str().unwrap().to_owned(),
            uploads.join("a").to_str().unwrap().to_owned(),
        ] {
            assert!(
                check_files(&uploads, std::slice::from_ref(&refused)).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn a_thread_in_a_space_gets_its_instructions_and_files() {
        let mut space = Repo {
            id: Uuid::now_v7(),
            fields: RepoFields {
                name: "Thesis".to_owned(),
                path: "/data/spaces/x".to_owned(),
                scratch: false,
                space: true,
            },
            icon: None,
            created_at: jiff::Timestamp::now(),
            instructions: None,
            files: Vec::new(),
        };
        assert_eq!(thread_instructions(&space), None, "nothing to add");

        space.instructions = Some("Answer in British English.".to_owned());
        space.files = vec!["/data/uploads/a/brief.pdf".to_owned()];
        let text = thread_instructions(&space).unwrap();
        assert!(text.contains("\"Thesis\""), "{text}");
        assert!(
            text.contains(
                "<space_instructions>\nAnswer in British English.\n</space_instructions>"
            ),
            "{text}"
        );
        assert!(text.contains("\n- /data/uploads/a/brief.pdf"), "{text}");

        space.fields.space = false;
        assert_eq!(thread_instructions(&space), None, "only a Space's threads");
    }
}
