//! Projects (0069, PLX-732): `project/create` and `project/delete`, behind the `projects` capability.
//!
//! A Project is a repo entry with `project` true, whose repository plxd made at
//! `<data folder>/projects/<id>`. A chat in it is an ordinary thread started with that entry as its
//! `repo`, so it runs in a worktree of the Project's repository and shares the Project's context
//! folder. `repo/update` renames a Project and sets its instructions and files
//! ([`crate::threads::update_repo`]), which every thread in it gets in its system prompt (0090).
//! `thread/setProject` adds a thread started elsewhere to a Project, where it keeps working where it
//! was, and gets the Project's instructions and files too.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, MAX_PROJECT_FILES, MAX_PROJECT_INSTRUCTIONS_BYTES, MAX_PROJECT_NAME_BYTES,
    ParallaxEvent, ProjectCreateParams, ProjectCreateResult, ProjectDeleteParams,
    ProjectDeleteResult, RepoId, ScopeId, ThreadSetProjectParams, ThreadSetProjectResult,
};
use parallax_store::RepoFields;
use tracing::{info, warn};
use uuid::Uuid;

use crate::server::Daemon;
use crate::threads::{self, repo_entry, store, store_error};

/// The folder under plxd's data folder that holds Projects' repositories. It keeps its name from
/// when Projects were Spaces (0093), since stored repo entries name paths in it.
const PROJECTS_DIR: &str = "spaces";

/// A Project's name as `project/create` and `repo/update` take it: trimmed, 1 to
/// [`MAX_PROJECT_NAME_BYTES`] bytes.
pub(crate) fn check_name(name: &str) -> Result<String, ErrorObject> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_PROJECT_NAME_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "a Project's name must be 1 to {MAX_PROJECT_NAME_BYTES} bytes"
        )));
    }
    Ok(name.to_owned())
}

/// A Project's repository folder under the canonical spaces folder, made if missing, so the path
/// stored is the one git and the sandbox see.
fn project_dir(daemon: &Daemon, id: RepoId) -> Result<PathBuf, ErrorObject> {
    let root = daemon.data_dir.root().join(PROJECTS_DIR);
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

/// A Project's instructions as `repo/update` takes them: trimmed, at most
/// [`MAX_PROJECT_INSTRUCTIONS_BYTES`] bytes. Empty clears them.
pub(crate) fn check_instructions(instructions: &str) -> Result<String, ErrorObject> {
    let instructions = instructions.trim();
    if instructions.len() > MAX_PROJECT_INSTRUCTIONS_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "a Project's instructions must be at most {MAX_PROJECT_INSTRUCTIONS_BYTES} bytes"
        )));
    }
    Ok(instructions.to_owned())
}

/// A Project's files as `repo/update` takes them: at most [`MAX_PROJECT_FILES`], each a file inside
/// `uploads` once links are followed, so a thread's sandbox can read it (0071). Returns their
/// canonical paths, in order, without repeats.
pub(crate) fn check_files(uploads: &Path, files: &[String]) -> Result<Vec<String>, ErrorObject> {
    if files.len() > MAX_PROJECT_FILES {
        return Err(ErrorObject::invalid_params(format!(
            "a Project keeps at most {MAX_PROJECT_FILES} files"
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

/// The system prompt a thread in a Project gets for the Project's instructions and files (0090), or
/// `None` when it has neither.
pub(crate) fn thread_instructions(project: &parallax_store::Repo) -> Option<String> {
    if !project.fields.project || (project.instructions.is_none() && project.files.is_empty()) {
        return None;
    }
    let mut text = format!(
        "This thread is in the Project \"{}\". The user set what follows for every thread in it.",
        project.fields.name
    );
    if let Some(instructions) = &project.instructions {
        text.push_str("\n\n<project_instructions>\n");
        text.push_str(instructions);
        text.push_str("\n</project_instructions>");
    }
    if !project.files.is_empty() {
        text.push_str(
            "\n\nThe Project's files, which you can read when they help with the user's request:",
        );
        for file in &project.files {
            text.push_str("\n- ");
            text.push_str(file);
        }
    }
    Some(text)
}

fn not_found(id: RepoId) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::RepoNotFound, format!("no Project has id {id}"))
}

/// `project/create`: idempotent on the id.
pub(crate) async fn create(
    daemon: &Arc<Daemon>,
    params: ProjectCreateParams,
) -> Result<ProjectCreateResult, ErrorObject> {
    let ProjectCreateParams { id, name, icon } = params;
    let name = check_name(&name)?;
    let icon = icon
        .map(|icon| {
            crate::methods::orchestrator::check_icon(&icon)?;
            Ok::<_, ErrorObject>(crate::store::stored_icon(icon))
        })
        .transpose()?;
    let dir = project_dir(daemon, id)?;
    daemon
        .agents
        .worktrees()
        .init_scratch(&dir)
        .await
        .map_err(|error| {
            ErrorObject::parallax(
                ErrorKind::WorktreeFailed,
                format!("could not make the Project's repository: {error}"),
            )
        })?;
    let path = dir.to_string_lossy().into_owned();
    store(daemon, move |db| {
        let key: Uuid = id.into();
        if let Some(existing) = db.get_repo(key).map_err(|e| store_error(&e))? {
            if existing.fields.project && existing.fields.name == name {
                return Ok(ProjectCreateResult {
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
            project: true,
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
        info!(project = %repo.id, "made a Project");
        Ok(ProjectCreateResult { repo })
    })
    .await
}

/// `thread/setProject`: adds each thread to the Project, or takes it out of its Project, appending
/// `thread.updated` for each that changed. A thread started in a Project lives in its repository, and
/// an orchestrator's thread in its orchestrator, so neither moves.
pub(crate) async fn set_project(
    daemon: &Arc<Daemon>,
    params: ThreadSetProjectParams,
) -> Result<ThreadSetProjectResult, ErrorObject> {
    let ThreadSetProjectParams { threads, project } = params;
    if threads.is_empty() {
        return Err(ErrorObject::invalid_params(
            "thread/setProject needs a thread",
        ));
    }
    store(daemon, move |db| {
        let error = |e| store_error(&e);
        if let Some(project) = project {
            db.get_repo(project.into())
                .map_err(error)?
                .filter(|repo| repo.fields.project)
                .ok_or_else(|| not_found(project))?;
        }
        let mut changed = Vec::with_capacity(threads.len());
        for run in &threads {
            let thread = db
                .get_thread((*run).into())
                .map_err(error)?
                .ok_or_else(|| threads::thread_not_found(*run))?;
            let home = db.get_repo(thread.repo_id).map_err(error)?;
            match home {
                Some(home) if home.fields.project => {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {run} started in a Project, so it stays there"
                    )));
                }
                None => {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {run} is an orchestrator's, so it can't join a Project"
                    )));
                }
                Some(_) => {}
            }
            let (thread, moved) = db
                .set_thread_project(thread.id, project.map(Uuid::from))
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
        Ok(ThreadSetProjectResult { threads: changed })
    })
    .await
}

/// `project/delete`: deletes each chat in the Project through `thread/delete`, takes the threads added
/// to it out, then deletes the entry and its folders. Run it detached, as `thread/delete` is, so a dropped connection can't leave it half
/// done: deleting again finishes the job.
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    params: ProjectDeleteParams,
) -> Result<ProjectDeleteResult, ErrorObject> {
    let id = params.project;
    let chats = store(daemon, move |db| {
        db.get_repo(id.into())
            .map_err(|e| store_error(&e))?
            .filter(|repo| repo.fields.project)
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
        // A thread added to it goes back to working where it was, in no Project.
        let added = db
            .list_threads()
            .map_err(|e| store_error(&e))?
            .into_iter()
            .filter(|thread| thread.project_id == Some(Uuid::from(id)));
        for thread in added {
            let (thread, _) = db
                .set_thread_project(thread.id, None)
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
    if let Ok(dir) = project_dir(daemon, id)
        && let Err(error) = std::fs::remove_dir_all(&dir)
    {
        warn!(project = %id, %error, "could not remove a deleted Project's repository");
    }
    if let Ok(scope) = ScopeId::try_from(Uuid::from(id)) {
        threads::remove_context(daemon, scope);
    }
    info!(project = %id, "deleted a Project");
    Ok(ProjectDeleteResult {})
}

#[cfg(test)]
mod tests {
    use parallax_store::{Repo, RepoFields};
    use uuid::Uuid;

    use super::{check_files, thread_instructions};

    #[test]
    fn a_project_takes_only_files_uploaded_to_this_host() {
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
    fn a_thread_in_a_project_gets_its_instructions_and_files() {
        let mut project = Repo {
            id: Uuid::now_v7(),
            fields: RepoFields {
                name: "Thesis".to_owned(),
                path: "/data/projects/x".to_owned(),
                scratch: false,
                project: true,
            },
            icon: None,
            created_at: jiff::Timestamp::now(),
            instructions: None,
            files: Vec::new(),
        };
        assert_eq!(thread_instructions(&project), None, "nothing to add");

        project.instructions = Some("Answer in British English.".to_owned());
        project.files = vec!["/data/uploads/a/brief.pdf".to_owned()];
        let text = thread_instructions(&project).unwrap();
        assert!(text.contains("\"Thesis\""), "{text}");
        assert!(
            text.contains(
                "<project_instructions>\nAnswer in British English.\n</project_instructions>"
            ),
            "{text}"
        );
        assert!(text.contains("\n- /data/uploads/a/brief.pdf"), "{text}");

        project.fields.project = false;
        assert_eq!(
            thread_instructions(&project),
            None,
            "only a Project's threads"
        );
    }
}
