//! `memory/list`, `memory/read`, `memory/write`, `memory/delete`, and `memory/propose` (PLX-405,
//! decision 0044), behind the `memory` capability.
//!
//! Memory lives in a scope's context folder ([`crate::context`]): You in `context/you`, a repo
//! entry's in `context/<repo id>`, a Project's in `context/<project id>`. The app writes as the
//! user. A thread's Parallax tools name their run in `from`: only a Project's current coordinator
//! writes, and its write adds a `learned` item to the Project's inbox (0043). A proposal is saved
//! as `proposals/<slug>.md`: a Project's child's in the Project's folder, naming the scope it is
//! for, until its coordinator's next wake-up carries it, and a plain thread's in its repository's
//! folder, for the user.

use std::path::{Path, PathBuf};

use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::methods::{
    MemoryDelete, MemoryList, MemoryPropose, MemoryRead, MemoryWrite, RequestMethod,
};
use parallax_protocol::{
    ErrorKind, InboxKind, MemoryDeleteParams, MemoryDeleteResult, MemoryFile, MemoryListParams,
    MemoryListResult, MemoryProposalTo, MemoryProposeParams, MemoryProposeResult, MemoryReadParams,
    MemoryReadResult, MemoryScope, MemoryWriteParams, MemoryWriteResult, ProjectId, RunId,
};
use serde_json::Value;
use uuid::Uuid;

use super::{Context, handle};
use crate::context::{self, memory};
use crate::store::store_error;

/// The longest title, in bytes.
const MAX_TITLE_BYTES: usize = 256;

/// The longest proposal, in bytes: an entry is a short, lasting fact (0044).
pub(crate) const MAX_PROPOSAL_BYTES: usize = 4 * 1024;

/// Answers a `memory/*` method.
pub(crate) async fn dispatch(context: &Context, request: &Request) -> Result<Value, ErrorObject> {
    match request.method.as_str() {
        MemoryList::NAME => handle::<MemoryList, _, _>(request, |p| list(context, p)).await,
        MemoryRead::NAME => handle::<MemoryRead, _, _>(request, |p| read(context, p)).await,
        MemoryWrite::NAME => handle::<MemoryWrite, _, _>(request, |p| write(context, p)).await,
        MemoryDelete::NAME => handle::<MemoryDelete, _, _>(request, |p| delete(context, p)).await,
        MemoryPropose::NAME => {
            handle::<MemoryPropose, _, _>(request, |p| propose(context, p)).await
        }
        other => Err(ErrorObject::method_not_found(other)),
    }
}

/// What a path holds, by its folder.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    Brief,
    Entry,
    Knowledge,
    Proposal,
    History,
    /// Any other shared context file, such as the coordinator's `notes.md` board.
    Other,
}

fn place(path: &str) -> Place {
    match path.split_once('/') {
        None if path == "brief.md" => Place::Brief,
        Some(("memory", _)) => Place::Entry,
        Some(("knowledge", _)) => Place::Knowledge,
        Some(("proposals", _)) => Place::Proposal,
        Some(("history", _)) => Place::History,
        _ => Place::Other,
    }
}

/// `path`, checked as a shared context path and as one of `allowed`'s places.
fn checked<'a>(path: &'a str, allowed: &[Place], method: &str) -> Result<&'a str, ErrorObject> {
    let path = context::validate_relative_path(path)?;
    if !allowed.contains(&place(path)) {
        return Err(ErrorObject::invalid_params(format!(
            "memory/{method} doesn't take {path}; memory is brief.md, memory/<kind>/<slug>.md, \
             and knowledge/<slug>.md"
        )));
    }
    Ok(path)
}

async fn list(
    context: &Context,
    params: MemoryListParams,
) -> Result<MemoryListResult, ErrorObject> {
    let dir = scope_dir(context, params.scope).await?;
    run_blocking(move || {
        let mut files = Vec::new();
        for (path, metadata) in context::list_files(&dir).map_err(io_error(""))? {
            if matches!(place(&path), Place::History | Place::Other) {
                continue;
            }
            let header = header_of(&dir, &path);
            files.push(memory_file(&path, &metadata, header));
        }
        Ok(MemoryListResult { files })
    })
    .await
}

async fn read(
    context: &Context,
    params: MemoryReadParams,
) -> Result<MemoryReadResult, ErrorObject> {
    let all = [
        Place::Brief,
        Place::Entry,
        Place::Knowledge,
        Place::Proposal,
        Place::History,
    ];
    let path = checked(&params.path, &all, "read")?.to_owned();
    let dir = scope_dir(context, params.scope).await?;
    run_blocking(move || {
        let (bytes, metadata) = context::read_file(&dir, &path).map_err(io_error(&path))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| ErrorObject::internal_error(format!("{path} is not valid UTF-8 text")))?;
        if has_header(&path) {
            let (header, body) = memory::parse(&text);
            let file = memory_file(&path, &metadata, header);
            return Ok(MemoryReadResult {
                file,
                content: body.to_owned(),
            });
        }
        let file = memory_file(&path, &metadata, memory::Header::default());
        Ok(MemoryReadResult {
            file,
            content: text,
        })
    })
    .await
}

async fn write(
    context: &Context,
    params: MemoryWriteParams,
) -> Result<MemoryWriteResult, ErrorObject> {
    let MemoryWriteParams {
        scope,
        path,
        content,
        title,
        source,
        from,
    } = params;
    let allowed = [Place::Brief, Place::Entry, Place::Knowledge];
    let path = checked(&path, &allowed, "write")?.to_owned();
    let entry = memory::entry_kind(&path);
    let title = match (entry, title) {
        (Some(_), Some(title)) => Some(check_title(&title)?),
        (Some(_), None) => {
            return Err(ErrorObject::invalid_params("an entry needs a title"));
        }
        (None, _) => None,
    };
    let writer = match from {
        Some(from) => {
            let project = coordinator_project(context, from).await?;
            Some((from, project))
        }
        None => None,
    };
    let dir = scope_dir(context, scope).await?;
    let text = match (entry, &title) {
        (Some(kind), Some(title)) => {
            let (who, default_source) = match writer {
                Some((from, _)) => (format!("coordinator {from}"), format!("run {from}")),
                None => ("user".to_owned(), "user".to_owned()),
            };
            let source = source.unwrap_or(default_source);
            memory::render(kind, title, &source, &today(), &who, None, &content)
        }
        _ => content,
    };
    let written_path = path.clone();
    let file = run_blocking(move || save(&dir, &written_path, &text)).await?;
    if let Some((from, project)) = writer {
        let what = title.as_deref().unwrap_or(&path);
        let text = format!("Memory: {what} ({} scope)", scope_name(scope));
        super::inbox::add(&context.daemon, project, from, InboxKind::Learned, text).await;
    }
    Ok(MemoryWriteResult { file })
}

async fn delete(
    context: &Context,
    params: MemoryDeleteParams,
) -> Result<MemoryDeleteResult, ErrorObject> {
    let allowed = [
        Place::Brief,
        Place::Entry,
        Place::Knowledge,
        Place::Proposal,
    ];
    let path = checked(&params.path, &allowed, "delete")?.to_owned();
    let dir = scope_dir(context, params.scope).await?;
    run_blocking(move || {
        context::delete_file(&dir, &path).map_err(io_error(&path))?;
        Ok(MemoryDeleteResult {})
    })
    .await
}

async fn propose(
    context: &Context,
    params: MemoryProposeParams,
) -> Result<MemoryProposeResult, ErrorObject> {
    let MemoryProposeParams {
        from,
        scope,
        kind,
        title,
        content,
    } = params;
    let title = check_title(&title)?;
    if memory::kind_name(kind).is_none() {
        return Err(ErrorObject::invalid_params("unknown memory kind"));
    }
    if content.trim().is_empty() || content.len() > MAX_PROPOSAL_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "a proposal needs content of at most {MAX_PROPOSAL_BYTES} bytes"
        )));
    }
    // A child's proposal waits in its Project's folder, naming the scope it is for, until the
    // coordinator's next wake-up carries it ([`crate::agents::wake`]); a plain thread's waits in
    // its repository's for the user.
    let (folder, for_scope, to) = match proposer(context, from).await? {
        Proposer::Child { project } => (
            MemoryScope::Project { id: project },
            Some(scope_name(scope)),
            MemoryProposalTo::Coordinator,
        ),
        Proposer::Thread { repo } => {
            if scope != (MemoryScope::Repo { id: repo }) {
                return Err(ErrorObject::invalid_params(
                    "a thread outside a Project proposes only at its repository's scope",
                ));
            }
            (scope, None, MemoryProposalTo::User)
        }
    };
    let dir = scope_dir(context, folder).await?;
    let writer = format!("thread {from}");
    let text = memory::render(
        kind,
        &title,
        &writer,
        &today(),
        &writer,
        for_scope,
        &content,
    );
    let slug = memory::slug(&title);
    let file = run_blocking(move || {
        let path = free_path(&dir, &slug);
        save(&dir, &path, &text)
    })
    .await?;
    Ok(MemoryProposeResult {
        to,
        file: Some(file),
    })
}

/// Who proposes, by its run.
enum Proposer {
    /// A Project's run other than its coordinator.
    Child { project: ProjectId },
    /// A thread in a repo entry with a repository.
    Thread { repo: parallax_protocol::RepoId },
}

async fn proposer(context: &Context, from: RunId) -> Result<Proposer, ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let run = db
                .get_run(from.into())
                .map_err(|e| store_error(&e))?
                .ok_or_else(|| crate::agents::run_not_found(from))?;
            let project = run.fields.project_id;
            if db
                .get_project(project)
                .map_err(|e| store_error(&e))?
                .is_some()
            {
                if crate::agents::coordinator::coordinator_of(db, project)? == Some(from) {
                    return Err(ErrorObject::invalid_params(
                        "a Project's coordinator writes memory itself, with memory_write",
                    ));
                }
                let project = ProjectId::try_from(project).map_err(|_| corrupt(project))?;
                return Ok(Proposer::Child { project });
            }
            let repo = db
                .get_thread(from.into())
                .map_err(|e| store_error(&e))?
                .map(|thread| thread.repo_id);
            let repo = match repo {
                Some(repo) => db.get_repo(repo).map_err(|e| store_error(&e))?,
                None => None,
            };
            match repo {
                Some(repo) if !repo.fields.scratch => Ok(Proposer::Thread {
                    repo: parallax_protocol::RepoId::try_from(repo.id)
                        .map_err(|_| corrupt(repo.id))?,
                }),
                _ => Err(ErrorObject::invalid_params(
                    "only a Project's child or a thread in a repository proposes memory",
                )),
            }
        })
        .await
}

/// The Project whose current coordinator run `from` is, or `invalidParams`: only a coordinator
/// writes memory (0044).
async fn coordinator_project(context: &Context, from: RunId) -> Result<ProjectId, ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let run = db
                .get_run(from.into())
                .map_err(|e| store_error(&e))?
                .ok_or_else(|| crate::agents::run_not_found(from))?;
            let project = run.fields.project_id;
            let coordinator = match db.get_project(project).map_err(|e| store_error(&e))? {
                Some(_) => crate::agents::coordinator::coordinator_of(db, project)?,
                None => None,
            };
            if coordinator != Some(from) {
                return Err(ErrorObject::invalid_params(
                    "only a Project's coordinator writes memory; propose it with memory_propose",
                ));
            }
            ProjectId::try_from(project).map_err(|_| corrupt(project))
        })
        .await
}

fn scope_name(scope: MemoryScope) -> &'static str {
    match scope {
        MemoryScope::You => "you",
        MemoryScope::Repo { .. } => "repo",
        MemoryScope::Project { .. } => "project",
    }
}

/// `scope`'s folder, created if it doesn't exist yet, once its repo entry or Project is found.
async fn scope_dir(context: &Context, scope: MemoryScope) -> Result<PathBuf, ErrorObject> {
    let data_dir = &context.daemon.data_dir;
    let dir = match scope {
        MemoryScope::You => context::you_dir(data_dir),
        MemoryScope::Repo { id } => {
            let found = context
                .daemon
                .store
                .run(&context.cancel, move |db| {
                    Ok(db
                        .get_repo(id.into())
                        .map_err(|e| store_error(&e))?
                        .is_some_and(|repo| !repo.fields.scratch))
                })
                .await?;
            if !found {
                return Err(ErrorObject::parallax(
                    ErrorKind::RepoNotFound,
                    format!("no repo entry with a repository has id {id}"),
                ));
            }
            data_dir.context_dir(ProjectId::try_from(Uuid::from(id)).map_err(|_| corrupt(id))?)
        }
        MemoryScope::Project { id } => {
            let found = context
                .daemon
                .store
                .run(&context.cancel, move |db| {
                    Ok(db
                        .get_project(id.into())
                        .map_err(|e| store_error(&e))?
                        .is_some())
                })
                .await?;
            if !found {
                return Err(ErrorObject::parallax(
                    ErrorKind::ProjectNotFound,
                    format!("no project has id {id}"),
                ));
            }
            data_dir.context_dir(id)
        }
    };
    run_blocking(move || context::ensure(dir).map_err(io_error(""))).await
}

/// Writes `text` to `path` in `dir` within the shared context caps, and returns it.
fn save(dir: &Path, path: &str, text: &str) -> Result<MemoryFile, ErrorObject> {
    let size = text.len() as u64;
    let other = context::other_files_total(dir, path).map_err(io_error(path))?;
    if size > context::MAX_FILE_BYTES || other + size > context::MAX_PROJECT_BYTES {
        return Err(ErrorObject::parallax(
            ErrorKind::ContextTooLarge,
            format!("{path} would be over the shared context size cap"),
        ));
    }
    let metadata = context::write_file(dir, path, text.as_bytes()).map_err(io_error(path))?;
    let header = if has_header(path) {
        memory::parse(text).0
    } else {
        memory::Header::default()
    };
    Ok(memory_file(path, &metadata, header))
}

/// A proposal path for `slug` that no file has yet in `dir`.
fn free_path(dir: &Path, slug: &str) -> String {
    let taken = |path: &str| std::fs::symlink_metadata(dir.join(path)).is_ok();
    let mut path = format!("proposals/{slug}.md");
    let mut n = 2;
    while taken(&path) {
        path = format!("proposals/{slug}-{n}.md");
        n += 1;
    }
    path
}

fn has_header(path: &str) -> bool {
    matches!(place(path), Place::Entry | Place::Proposal)
}

/// The header of `path` in `dir`, for an entry or proposal; empty for any other file, or one that
/// can't be read.
fn header_of(dir: &Path, path: &str) -> memory::Header {
    if !has_header(path) {
        return memory::Header::default();
    }
    context::read_file(dir, path)
        .ok()
        .and_then(|(bytes, _)| String::from_utf8(bytes).ok())
        .map(|text| memory::parse(&text).0)
        .unwrap_or_default()
}

fn memory_file(path: &str, metadata: &std::fs::Metadata, header: memory::Header) -> MemoryFile {
    MemoryFile {
        path: path.to_owned(),
        size: metadata.len(),
        modified_at: context::modified_at(metadata),
        kind: header.kind,
        title: header.title,
        source: header.source,
        date: header.date,
        writer: header.writer,
    }
}

/// A title, trimmed, one line, and at most [`MAX_TITLE_BYTES`].
fn check_title(title: &str) -> Result<String, ErrorObject> {
    let title = title.trim();
    if title.is_empty() || title.len() > MAX_TITLE_BYTES || title.contains(['\n', '\r']) {
        return Err(ErrorObject::invalid_params(format!(
            "a title must be one line of 1 to {MAX_TITLE_BYTES} bytes"
        )));
    }
    Ok(title.to_owned())
}

/// Today's date in UTC, as an entry's header gives it.
fn today() -> String {
    jiff::Timestamp::now()
        .to_zoned(jiff::tz::TimeZone::UTC)
        .date()
        .to_string()
}

fn corrupt(id: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::internal_error(format!("the stored id {id} is invalid"))
}

/// Runs `job` on tokio's blocking pool, as `context/*` does.
async fn run_blocking<T, F>(job: F) -> Result<T, ErrorObject>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ErrorObject> + Send + 'static,
{
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result,
        Err(error) => Err(ErrorObject::internal_error(format!(
            "memory task failed: {error}"
        ))),
    }
}

fn io_error(path: &str) -> impl Fn(std::io::Error) -> ErrorObject {
    let path = path.to_owned();
    move |error| context::io_error(&path, &error)
}
