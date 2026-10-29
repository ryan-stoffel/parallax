//! `thread/importable` and `thread/import` (PLX-881): past sessions from the Claude, Codex, and
//! Cursor desktop apps, made Parallax threads.
//!
//! Each app's files are read, never written:
//!
//! - Claude: the desktop app's `Claude/claude-code-sessions/<account>/<org>/local_*.json`, under
//!   the app config folder, names each Claude Code session, its folder, and its CLI session, whose
//!   transcript is Claude Code's own, `<config>/projects/<folder>/<session>.jsonl`. A session that
//!   ran with Remote Control, driven from claude.ai or the Claude apps on another device, has no
//!   such record: it's a transcript with a `bridge-session` entry or a `ccr-tip.json` beside it.
//! - Codex: `<CODEX_HOME>/sessions/**/rollout-*.jsonl`, the ones the Codex or `ChatGPT` apps started
//!   (their `session_meta` originator), here or through Remote Control, titled from
//!   `<CODEX_HOME>/session_index.jsonl`.
//! - Cursor: its `state.vscdb`, whose `composerData:<id>` rows list each chat's messages and
//!   `bubbleId:<id>:<message>` rows hold them.
//!
//! An import is a thread shaped like a fork (0050): its prompt is the session's first message,
//! its log the rest of the conversation, the user's messages and the agent's replies, and no CLI
//! runs until the first follow-up. It starts archived. A session in a repository's root works in
//! that checkout, as it did in the app; any other has no repo. Its run id is a version 7 UUID made
//! from the session (its start time, then a hash of its app and id), so importing it again finds
//! the same thread. `thread/importChat` (PLX-883) takes a chat the client read from a `ChatGPT` or
//! `claude.ai` data export instead, which always has no repo and no session.
//!
//! `thread/importable` with `remote` lists instead the Claude Code sessions `claude remote-control`
//! served on any of the user's computers, which `claude.ai` keeps, and `thread/import` with
//! `remote` reads one from there ([`cloud`], PLX-1136). Their follow-ups tell a new session the
//! conversation, as their transcript isn't on this computer.
//!
//! A Codex thread keeps its session, which a follow-up resumes, falling back to a handoff. A Claude
//! one keeps it only in its own folder, where Claude Code looks for it. Every other follow-up tells
//! a new session the conversation (0014).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AgentOutputItem, ChatRole, ImportSource, ImportableSession, MAX_CHAT_MESSAGES,
    MAX_THREAD_TITLE_BYTES, ProjectId, RepoAddParams, RepoId, RunId, ThreadArchiveParams,
    ThreadImportChatParams, ThreadImportParams, ThreadImportableParams, ThreadImportableResult,
    ThreadImportedChatsParams, ThreadImportedChatsResult, ThreadStartResult, TurnId,
};
use parallax_store::ThreadFields;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::agents::convert::{MAX_TEXT_ITEM_BYTES, agent_run, truncate};
use crate::agents::{self, NewFork, NewRun, NewThread, RunOptions};
use crate::server::Daemon;
use crate::threads::{self, store, store_error};

/// The longest prompt an import gets, as `thread/start` takes at most a megabyte.
const MAX_PROMPT_BYTES: usize = 256 * 1024;

/// Where each app keeps its sessions on this computer.
#[derive(Clone, Debug)]
struct Homes {
    /// The Claude desktop app's folder.
    claude_app: Option<PathBuf>,
    /// Claude Code's config folder, `CLAUDE_CONFIG_DIR` or `~/.claude`.
    claude: Option<PathBuf>,
    /// Codex's home, `CODEX_HOME` or `~/.codex`.
    codex: Option<PathBuf>,
    /// Cursor's state database.
    cursor: Option<PathBuf>,
}

impl Homes {
    fn detect() -> Self {
        let home = std::env::home_dir().filter(|home| home.is_absolute());
        let config = crate::paths::app_config_dir();
        let env = |name| std::env::var_os(name).map(PathBuf::from);
        Self {
            claude_app: config.as_ref().map(|dir| dir.join("Claude")),
            claude: env("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude"))),
            codex: env("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
            cursor: config.map(|dir| dir.join("Cursor/User/globalStorage/state.vscdb")),
        }
    }
}

/// A session as its app keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Session {
    source: ImportSource,
    id: String,
    title: String,
    cwd: Option<String>,
    started: Timestamp,
    updated: Timestamp,
    /// The CLI session a follow-up can resume: Claude Code's or Codex's.
    resume: Option<String>,
}

/// One message of a session's conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Message {
    User(String),
    Agent(String),
}

/// `thread/importable`: see the module documentation. With `remote`, the sessions `claude.ai`
/// keeps ([`cloud`]) that the apps' list here doesn't have.
pub(crate) async fn importable(
    daemon: &Arc<Daemon>,
    params: ThreadImportableParams,
) -> Result<ThreadImportableResult, ErrorObject> {
    let homes = Homes::detect();
    let (mut sessions, problem) = if params.remote {
        // The Claude Code sessions here, by their CLI session, which `claude.ai` may keep too.
        let here: HashSet<String> = tokio::task::spawn_blocking(move || {
            claude_sessions(&homes)
                .into_iter()
                .filter_map(|session| session.resume)
                .collect()
        })
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?;
        match cloud::list(daemon).await {
            Ok(listed) => (
                listed
                    .into_iter()
                    .filter(|listed| !listed.local.as_ref().is_some_and(|id| here.contains(id)))
                    .map(|listed| listed.session)
                    .collect(),
                None,
            ),
            Err(problem) => (Vec::new(), Some(problem)),
        }
    } else {
        let listed = tokio::task::spawn_blocking(move || list(&homes))
            .await
            .map_err(|error| ErrorObject::internal_error(error.to_string()))?;
        (listed, None)
    };
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated));
    let ids: Vec<RunId> = sessions.iter().filter_map(run_id).collect();
    let imported: HashSet<RunId> = store(daemon, move |db| {
        let mut found = HashSet::new();
        for id in ids {
            if db
                .get_thread(id.into())
                .map_err(|e| store_error(&e))?
                .is_some()
            {
                found.insert(id);
            }
        }
        Ok(found)
    })
    .await?;
    Ok(ThreadImportableResult {
        sessions: sessions
            .into_iter()
            .map(|session| {
                let thread = run_id(&session).filter(|id| imported.contains(id));
                ImportableSession {
                    source: session.source,
                    id: session.id,
                    title: session.title,
                    cwd: session.cwd,
                    updated_at: session.updated,
                    thread,
                    remote: params.remote,
                }
            })
            .collect(),
        problem,
    })
}

/// `thread/import`: see the module documentation and [`ThreadImportParams`].
pub(crate) async fn import(
    daemon: Arc<Daemon>,
    params: ThreadImportParams,
) -> Result<ThreadStartResult, ErrorObject> {
    let ThreadImportParams {
        source,
        id,
        remote,
        account,
    } = params;
    if remote {
        let loaded = cloud::load(&daemon, &id)
            .await
            .map_err(ErrorObject::invalid_params)?;
        let Some((session, messages)) = loaded else {
            return Err(ErrorObject::invalid_params(format!(
                "claude.ai has no conversation for session {id}"
            )));
        };
        return create(daemon, session, &messages, account).await;
    }
    let homes = Homes::detect();
    let wanted = id.clone();
    let loaded = tokio::task::spawn_blocking(move || load(&homes, source, &wanted))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?;
    let Some((session, messages)) = loaded else {
        return Err(ErrorObject::invalid_params(format!(
            "the {} app has no session {id}",
            app_name(source)
        )));
    };
    create(daemon, session, &messages, account).await
}

/// `thread/importChat` (PLX-883): see [`ThreadImportChatParams`].
pub(crate) async fn import_chat(
    daemon: Arc<Daemon>,
    params: ThreadImportChatParams,
) -> Result<ThreadStartResult, ErrorObject> {
    let ThreadImportChatParams {
        source,
        id,
        title,
        created_at,
        messages,
        account,
    } = params;
    if !matches!(source, ImportSource::Chatgpt | ImportSource::ClaudeChat) {
        return Err(ErrorObject::invalid_params(
            "thread/importChat imports chatgpt and claudeChat chats; use thread/import for the rest",
        ));
    }
    if messages.len() > MAX_CHAT_MESSAGES {
        return Err(ErrorObject::invalid_params(format!(
            "a chat has at most {MAX_CHAT_MESSAGES} messages"
        )));
    }
    let messages: Vec<Message> = messages
        .into_iter()
        .filter(|m| !m.text.trim().is_empty())
        .map(|m| match m.role {
            ChatRole::User => Message::User(m.text),
            ChatRole::Assistant => Message::Agent(m.text),
        })
        .collect();
    let title = title.trim();
    let session = Session {
        source,
        title: if title.is_empty() {
            "Imported chat"
        } else {
            title
        }
        .to_owned(),
        id,
        cwd: None,
        started: created_at,
        updated: created_at,
        resume: None,
    };
    create(daemon, session, &messages, account).await
}

/// `thread/importedChats` (PLX-883): each chat's thread, if it was imported.
pub(crate) async fn imported_chats(
    daemon: &Daemon,
    params: ThreadImportedChatsParams,
) -> Result<ThreadImportedChatsResult, ErrorObject> {
    let ids: Vec<Option<RunId>> = params
        .chats
        .into_iter()
        .map(|chat| {
            run_id(&Session {
                source: chat.source,
                id: chat.id,
                title: String::new(),
                cwd: None,
                started: chat.created_at,
                updated: chat.created_at,
                resume: None,
            })
        })
        .collect();
    store(daemon, move |db| {
        let mut threads = Vec::with_capacity(ids.len());
        for id in ids {
            let found = match id {
                Some(id) => db
                    .get_thread(id.into())
                    .map_err(|e| store_error(&e))?
                    .map(|_| id),
                None => None,
            };
            threads.push(found);
        }
        Ok(ThreadImportedChatsResult { threads })
    })
    .await
}

/// Makes `session`, with its conversation `messages`, an archived thread: in its folder's
/// checkout when that's a repository's root, else with no repo. Returns the thread it already is
/// when it was imported before.
async fn create(
    daemon: Arc<Daemon>,
    session: Session,
    messages: &[Message],
    account: Option<AccountChoice>,
) -> Result<ThreadStartResult, ErrorObject> {
    let source = session.source;
    let Some((prompt, transcript)) = transcript(source, messages) else {
        return Err(ErrorObject::invalid_params(format!(
            "{} has no message from the user to import",
            session.id
        )));
    };
    let run_id = run_id(&session)
        .ok_or_else(|| ErrorObject::internal_error("an import's run id isn't a valid run id"))?;
    // Imported before: its thread as it is now, whatever its follow-ups changed since.
    if let Some(done) = imported(&daemon, run_id).await? {
        return Ok(done);
    }
    let repo = match &session.cwd {
        Some(cwd) => repo_of(&daemon, cwd).await,
        None => None,
    };
    let (scope, scratch) = workspace(&daemon, repo, run_id).await?;
    let title = threads::check_title(&truncate_to(&session.title, MAX_THREAD_TITLE_BYTES))?;
    let new = NewRun {
        run_id,
        scope,
        prompt,
        images: Vec::new(),
        threads: Vec::new(),
        // The session's own app's agent, unless the caller picked one.
        account: account.or_else(|| {
            Some(AccountChoice::Subscription {
                backend: backend_of(source).to_owned(),
            })
        }),
        coordinator_thread: None,
        notify: false,
        options: RunOptions::default(),
        approvals: true,
        explore: false,
        thread: Some(NewThread {
            scratch: scratch.clone(),
            branch_slug: None,
            checkout: repo.is_some(),
            git_ref: None,
            parent: None,
            fields: ThreadFields {
                forked_from: None,
                title,
            },
            fork: Some(NewFork {
                parent_backend: backend_of(source).to_owned(),
                model_given: false,
                keep_permission: false,
                transcript,
            }),
        }),
    };
    let mut created = match agents::create(Arc::clone(&daemon), new).await {
        Ok(created) => created,
        Err(error) => {
            if let Some(dir) = scratch {
                threads::remove_unused_scratch(&daemon, run_id, &dir).await;
            }
            return Err(error);
        }
    };
    let thread = created
        .thread
        .ok_or_else(|| ErrorObject::internal_error("an imported thread has no thread row"))?;
    if let Some(session_id) = resumable(&session, &created.run, repo.is_some()) {
        match keep_session(&daemon, run_id, session_id).await {
            Ok(run) => created.run = run,
            Err(error) => {
                warn!(run = %run_id, error = %error.message, "could not keep an imported session to resume");
            }
        }
    }
    Ok(ThreadStartResult {
        thread: archive(&daemon, run_id, thread).await?,
        run: created.run,
    })
}

/// Archives new import `thread`, so a history brought in all at once doesn't fill the sidebar's
/// Today, and returns it. One that can't be archived is returned as it is.
async fn archive(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    thread: parallax_store::Thread,
) -> Result<parallax_protocol::Thread, ErrorObject> {
    let archived = ThreadArchiveParams {
        run_id,
        archived: true,
    };
    match threads::archive(daemon, archived, None).await {
        Ok(done) => Ok(done.thread),
        Err(error) => {
            warn!(run = %run_id, error = %error.message, "could not archive an imported thread");
            threads::thread_entry(&thread)
        }
    }
}

/// The thread run `id` already imported, if it was.
async fn imported(daemon: &Daemon, id: RunId) -> Result<Option<ThreadStartResult>, ErrorObject> {
    store(daemon, move |db| {
        let error = |e| store_error(&e);
        let (Some(thread), Some(run)) = (
            db.get_thread(id.into()).map_err(error)?,
            db.get_run(id.into()).map_err(error)?,
        ) else {
            return Ok(None);
        };
        let worktree = db.get_worktree(id.into()).map_err(error)?;
        Ok(Some(ThreadStartResult {
            thread: threads::thread_entry(&thread)?,
            run: agent_run(&run, worktree.as_ref())?,
        }))
    })
    .await
}

/// Where an import works: `repo`'s checkout, or else a scratch repository of its own.
async fn workspace(
    daemon: &Arc<Daemon>,
    repo: Option<RepoId>,
    run_id: RunId,
) -> Result<(ProjectId, Option<PathBuf>), ErrorObject> {
    let invalid = |_| ErrorObject::internal_error("a repo entry has an invalid id");
    if let Some(repo) = repo {
        return Ok((
            ProjectId::try_from(uuid::Uuid::from(repo)).map_err(invalid)?,
            None,
        ));
    }
    let entry = threads::start_entry(daemon, None).await?;
    let scope = ProjectId::try_from(entry.id).map_err(invalid)?;
    Ok((
        scope,
        threads::scratch_dir(daemon, &entry, run_id, false).await?,
    ))
}

/// Stores `session_id` as run `id`'s session, which its first follow-up resumes, and returns the
/// run.
async fn keep_session(
    daemon: &Daemon,
    id: RunId,
    session_id: String,
) -> Result<parallax_protocol::AgentRun, ErrorObject> {
    store(daemon, move |db| {
        let error = |e| store_error(&e);
        let mut row = db
            .get_run(id.into())
            .map_err(error)?
            .ok_or_else(|| ErrorObject::internal_error("an imported run is gone"))?;
        row.state.session_id = Some(session_id);
        let row = db.update_run(id.into(), &row.state).map_err(error)?;
        let worktree = db.get_worktree(id.into()).map_err(error)?;
        agent_run(&row, worktree.as_ref())
    })
    .await
}

/// The repo entry for `cwd` when it's a repository's root, registered if it's new. A worktree,
/// whose `.git` is a file, gets none, so an app's own worktrees don't each become a folder.
async fn repo_of(daemon: &Arc<Daemon>, cwd: &str) -> Option<RepoId> {
    if !Path::new(cwd).join(".git").is_dir() {
        return None;
    }
    let params = RepoAddParams {
        id: RepoId::generate(),
        path: cwd.to_owned(),
    };
    threads::add_repo(daemon, params)
        .await
        .map(|added| added.repo.id)
        .ok()
}

/// The session a follow-up resumes: Codex's on its built-in backend, which falls back to a
/// handoff when the session is gone, and Claude Code's on its built-in backend in the folder it
/// ran in, where Claude Code finds it.
// ponytail: a Claude instance with its own config folder can't see the app's session; check the
// instance's `home` if people import onto one.
fn resumable(
    session: &Session,
    run: &parallax_protocol::AgentRun,
    checkout: bool,
) -> Option<String> {
    let backend = backend_of(session.source);
    if run.backend != backend {
        return None;
    }
    match session.source {
        ImportSource::Codex => session.resume.clone(),
        ImportSource::Claude if checkout => session.resume.clone(),
        _ => None,
    }
}

/// The built-in backend a source's sessions ran on.
fn backend_of(source: ImportSource) -> &'static str {
    match source {
        ImportSource::Claude | ImportSource::ClaudeChat => "claude",
        ImportSource::Codex | ImportSource::Chatgpt => "codex",
        ImportSource::Cursor => "cursor",
    }
}

fn app_name(source: ImportSource) -> &'static str {
    match source {
        ImportSource::Claude | ImportSource::ClaudeChat => "Claude",
        ImportSource::Codex => "Codex",
        ImportSource::Cursor => "Cursor",
        ImportSource::Chatgpt => "ChatGPT",
    }
}

/// The run id `session` imports as: version 7, at its start, with a hash of its app and id.
fn run_id(session: &Session) -> Option<RunId> {
    let hash = Sha256::digest(format!(
        "parallax import {:?} {}",
        session.source, session.id
    ));
    let bytes: [u8; 10] = hash[..10].try_into().ok()?;
    let millis = u64::try_from(session.started.as_millisecond()).ok()?;
    RunId::try_from(uuid::Builder::from_unix_timestamp_millis(millis, &bytes).into_uuid()).ok()
}

/// A session's prompt, its first message from the user, and its log after that: a notice that it
/// was imported, then a turn per message from the user with the agent's replies, one item per
/// event. `None` with no message from the user.
fn transcript(
    source: ImportSource,
    messages: &[Message],
) -> Option<(String, Vec<Vec<AgentOutputItem>>)> {
    let (first, prompt) =
        messages
            .iter()
            .enumerate()
            .find_map(|(index, message)| match message {
                Message::User(text) => Some((index, text)),
                Message::Agent(_) => None,
            })?;
    let started = |turn_id, text| AgentOutputItem::TurnStarted {
        turn_id,
        text,
        wake: false,
        from: None,
        images: Vec::new(),
        threads: Vec::new(),
    };
    let mut items = vec![
        AgentOutputItem::Notice {
            detail: match source {
                ImportSource::Chatgpt | ImportSource::ClaudeChat => {
                    format!("Imported from a {} export.", app_name(source))
                }
                _ => format!("Imported from the {} app.", app_name(source)),
            },
        },
        started(None, None),
    ];
    let mut turn = None;
    let finished = |turn_id| AgentOutputItem::TurnFinished {
        turn_id,
        result: None,
        cursor: None,
        session_id: None,
    };
    for message in &messages[first + 1..] {
        match message {
            Message::Agent(text) => items.push(AgentOutputItem::Text {
                message_id: None,
                text: truncate(text, MAX_TEXT_ITEM_BYTES),
            }),
            Message::User(text) => {
                items.push(finished(turn));
                let id = TurnId::generate();
                turn = Some(id);
                items.push(started(Some(id), Some(truncate(text, MAX_TEXT_ITEM_BYTES))));
            }
        }
    }
    items.push(finished(turn));
    Some((
        truncate_to(prompt, MAX_PROMPT_BYTES),
        items.into_iter().map(|item| vec![item]).collect(),
    ))
}

/// `text` cut to at most `max` bytes on a character boundary, with no note.
fn truncate_to(text: &str, max: usize) -> String {
    text[..text.floor_char_boundary(max)].to_owned()
}

/// A title from a session's first message: its first line, cut short.
fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let short = truncate_to(line, 80);
    if short.len() < line.len() {
        format!("{short}…")
    } else {
        short
    }
}

/// Every app's sessions. An app whose files are missing or unreadable adds none.
fn list(homes: &Homes) -> Vec<Session> {
    let mut sessions = claude_sessions(homes);
    sessions.extend(codex_sessions(homes));
    sessions.extend(cursor_sessions(homes).unwrap_or_else(|error| {
        warn!(error = %error, "could not read Cursor's chats");
        Vec::new()
    }));
    sessions
}

/// Session `id` of `source` and its conversation.
fn load(homes: &Homes, source: ImportSource, id: &str) -> Option<(Session, Vec<Message>)> {
    match source {
        ImportSource::Chatgpt | ImportSource::ClaudeChat => None,
        ImportSource::Claude => {
            let session = match claude_app_sessions(homes).into_iter().find(|s| s.id == id) {
                Some(session) => session,
                None => claude_remote_session(&claude_transcript(homes, id)?)?,
            };
            let file = claude_transcript(homes, session.resume.as_deref()?)?;
            Some((session, claude_messages(&fs::read_to_string(file).ok()?)))
        }
        ImportSource::Codex => {
            let (session, path) = codex_rollouts(homes)
                .into_iter()
                .find(|(s, _)| s.id == id)?;
            Some((session, codex_messages(&fs::read_to_string(path).ok()?)))
        }
        ImportSource::Cursor => {
            let session = cursor_sessions(homes)
                .ok()?
                .into_iter()
                .find(|s| s.id == id)?;
            let messages = cursor_messages(homes.cursor.as_deref()?, id).ok()?;
            Some((session, messages))
        }
    }
}

/// The files under `dir`, at most `depth` folders down, whose names `wanted` takes.
fn files(dir: &Path, depth: usize, wanted: &dyn Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth > 0 {
            found.extend(files(&path, depth - 1, wanted));
        } else if kind.is_file() && entry.file_name().to_str().is_some_and(wanted) {
            found.push(path);
        }
    }
    found
}

fn has_extension(name: &str, extension: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|found| found.eq_ignore_ascii_case(extension))
}

fn millis(value: &Value) -> Option<Timestamp> {
    Timestamp::from_millisecond(value.as_i64()?).ok()
}

fn modified(path: &Path) -> Option<Timestamp> {
    let time = fs::metadata(path).ok()?.modified().ok()?;
    Timestamp::try_from(time).ok()
}

// Claude

/// The Claude desktop app's Claude Code sessions, then the Remote Control sessions it doesn't
/// list.
fn claude_sessions(homes: &Homes) -> Vec<Session> {
    let mut sessions = claude_app_sessions(homes);
    let listed: HashSet<String> = sessions.iter().filter_map(|s| s.resume.clone()).collect();
    let Some(projects) = homes.claude.as_ref().map(|dir| dir.join("projects")) else {
        return sessions;
    };
    let transcript = |name: &str| has_extension(name, "jsonl");
    sessions.extend(
        files(&projects, 1, &transcript)
            .iter()
            .filter(|path| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| !listed.contains(stem))
            })
            .filter_map(|path| claude_remote_session(path)),
    );
    sessions
}

/// The Claude desktop app's Claude Code sessions that still have a transcript.
fn claude_app_sessions(homes: &Homes) -> Vec<Session> {
    let Some(app) = &homes.claude_app else {
        return Vec::new();
    };
    let root = app.join("claude-code-sessions");
    let local = |name: &str| name.starts_with("local_") && has_extension(name, "json");
    // One whose transcript Claude Code has since cleaned up has nothing to import.
    files(&root, 2, &local)
        .iter()
        .filter_map(|path| claude_session(&fs::read_to_string(path).ok()?))
        .filter(|session| {
            session
                .resume
                .as_deref()
                .is_some_and(|cli| claude_transcript(homes, cli).is_some())
        })
        .collect()
}

/// A session from the Claude desktop app's record of it.
fn claude_session(json: &str) -> Option<Session> {
    let record: Value = serde_json::from_str(json).ok()?;
    let started = millis(&record["createdAt"])?;
    let title = record["title"].as_str().unwrap_or("").trim();
    Some(Session {
        source: ImportSource::Claude,
        id: record["sessionId"].as_str()?.to_owned(),
        title: if title.is_empty() {
            "Claude Code session"
        } else {
            title
        }
        .to_owned(),
        cwd: record["cwd"].as_str().map(str::to_owned),
        started,
        updated: millis(&record["lastActivityAt"]).unwrap_or(started),
        resume: Some(record["cliSessionId"].as_str()?.to_owned()),
    })
}

/// The Claude Code session in the transcript at `path` when it ran with Remote Control: one with a
/// `bridge-session` entry naming a claude.ai session, as `claude --remote-control` and
/// `/remote-control` write, or a `ccr-tip.json` beside it, as the sessions `claude remote-control`
/// serves keep. Titled as `claude --resume` titles it: its name, else Claude's title for it, else
/// its first message.
fn claude_remote_session(path: &Path) -> Option<Session> {
    let id = path.file_stem()?.to_str()?.to_owned();
    let folder = path.with_extension("");
    let synced =
        folder.join("ccr-tip.json").is_file() || folder.with_extension("ccr-tip.json").is_file();
    // An Agent SDK app's, Parallax's own among them, isn't read through: they're most of the
    // transcripts, and the largest.
    if !synced && claude_entrypoint(path).is_some_and(|entry| entry.starts_with("sdk-")) {
        return None;
    }
    let jsonl = fs::read_to_string(path).ok()?;
    if !synced && !jsonl.contains("\"bridge-session\"") {
        return None;
    }
    let mut bridged = synced;
    let (mut started, mut cwd, mut name, mut ai_title, mut first) = (None, None, None, None, None);
    for line in jsonl.lines() {
        let wanted = started.is_none()
            || cwd.is_none()
            || ["bridge-session", "custom-title", "ai-title"]
                .iter()
                .any(|kind| line.contains(kind))
            || (first.is_none() && line.contains("\"user\""));
        let Some(entry) = wanted
            .then(|| serde_json::from_str::<Value>(line).ok())
            .flatten()
        else {
            continue;
        };
        let text = |key: &str| {
            entry[key]
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        started = started.or_else(|| entry["timestamp"].as_str()?.parse::<Timestamp>().ok());
        cwd = cwd.or_else(|| text("cwd"));
        match entry["type"].as_str() {
            Some("bridge-session") => bridged |= text("bridgeSessionId").is_some(),
            Some("custom-title") => name = text("customTitle").or(name),
            Some("ai-title") => ai_title = text("aiTitle").or(ai_title),
            Some("user") if first.is_none() => {
                first = claude_messages(line).into_iter().find_map(|m| match m {
                    Message::User(text) => Some(title_from(&text)),
                    Message::Agent(_) => None,
                });
            }
            _ => {}
        }
    }
    if !bridged {
        return None;
    }
    let started = started?;
    Some(Session {
        source: ImportSource::Claude,
        title: name
            .or(ai_title)
            .or(first)
            .unwrap_or_else(|| "Claude Code session".to_owned()),
        cwd,
        started,
        updated: modified(path).unwrap_or(started),
        resume: Some(id.clone()),
        id,
    })
}

/// The entrypoint a Claude Code transcript's first entries name, such as `cli` or `sdk-ts`.
fn claude_entrypoint(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .take(50)
        .map_while(Result::ok)
        .find_map(|line| {
            let entry: Value = serde_json::from_str(&line).ok()?;
            entry["entrypoint"].as_str().map(str::to_owned)
        })
}

/// Claude Code's transcript of CLI session `session`, in whichever project folder has it.
fn claude_transcript(homes: &Homes, session: &str) -> Option<PathBuf> {
    let projects = homes.claude.as_ref()?.join("projects");
    let name = format!("{session}.jsonl");
    fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&name))
        .find(|path| path.is_file())
}

/// The conversation in a Claude Code transcript: the user's own messages, not tool results,
/// Claude Code's notes, or its subagents', and the text of Claude's replies.
fn claude_messages(jsonl: &str) -> Vec<Message> {
    let mut messages = Vec::new();
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let skipped = ["isMeta", "isSidechain", "isCompactSummary"]
            .iter()
            .any(|flag| entry[flag].as_bool() == Some(true));
        if skipped {
            continue;
        }
        let content = &entry["message"]["content"];
        let text = match content {
            Value::String(text) => text.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
            _ => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        match entry["type"].as_str() {
            Some("user")
                if !text.starts_with("<command-") && !text.starts_with("<local-command") =>
            {
                messages.push(Message::User(text));
            }
            Some("assistant") => messages.push(Message::Agent(text)),
            _ => {}
        }
    }
    messages
}

// Codex

/// The originators of the sessions the Codex and `ChatGPT` apps start: on this computer, or on
/// another through Remote Control, from `ChatGPT` on the web or a phone.
const CODEX_APPS: [&str; 4] = [
    "Codex Desktop",
    "codex_work_desktop",
    "codex_work_web",
    "codex_work_mobile",
];

fn codex_sessions(homes: &Homes) -> Vec<Session> {
    codex_rollouts(homes)
        .into_iter()
        .map(|(session, _)| session)
        .collect()
}

/// The Codex and `ChatGPT` apps' sessions, each with its rollout file. Archived ones are left out.
fn codex_rollouts(homes: &Homes) -> Vec<(Session, PathBuf)> {
    let Some(home) = &homes.codex else {
        return Vec::new();
    };
    let titles =
        codex_titles(&fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default());
    let rollout = |name: &str| name.starts_with("rollout-") && has_extension(name, "jsonl");
    files(&home.join("sessions"), 3, &rollout)
        .into_iter()
        .filter_map(|path| {
            let file = fs::File::open(&path).ok()?;
            let mut session = codex_session(BufReader::new(file), &titles)?;
            session.updated = modified(&path).unwrap_or(session.started);
            Some((session, path))
        })
        .collect()
}

/// `session_index.jsonl`'s titles by session id, the latest of each.
fn codex_titles(jsonl: &str) -> HashMap<String, String> {
    jsonl
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| {
            let id = entry["id"].as_str()?.to_owned();
            let name = entry["thread_name"].as_str()?.trim().to_owned();
            (!name.is_empty()).then_some((id, name))
        })
        .collect()
}

/// A rollout's session, when one of the apps started it and it isn't a subagent's: from its
/// first line, `session_meta`, titled from `titles` or else its first message from the user.
fn codex_session(rollout: impl BufRead, titles: &HashMap<String, String>) -> Option<Session> {
    let mut lines = rollout.lines();
    let meta: Value = serde_json::from_str(&lines.next()?.ok()?).ok()?;
    let meta = &meta["payload"];
    let originator = meta["originator"].as_str()?;
    // A subagent's `source` is an object naming its parent.
    if !CODEX_APPS.contains(&originator) || !meta["source"].is_string() {
        return None;
    }
    let id = meta["id"].as_str()?.to_owned();
    let started: Timestamp = meta["timestamp"].as_str()?.parse().ok()?;
    let title = match titles.get(&id) {
        Some(title) => title.clone(),
        None => lines
            .map_while(Result::ok)
            .find_map(|line| match codex_message(&line) {
                Some(Message::User(text)) => Some(title_from(&text)),
                _ => None,
            })
            .unwrap_or_else(|| "Codex session".to_owned()),
    };
    Some(Session {
        source: ImportSource::Codex,
        resume: Some(id.clone()),
        id,
        title,
        cwd: meta["cwd"].as_str().map(str::to_owned),
        started,
        updated: started,
    })
}

/// The conversation in a Codex rollout.
fn codex_messages(jsonl: &str) -> Vec<Message> {
    jsonl.lines().filter_map(codex_message).collect()
}

/// The message on one rollout line, if it has one: a completed user or agent message item, or
/// the `user_message` and `agent_message` events of older rollouts.
fn codex_message(line: &str) -> Option<Message> {
    let entry: Value = serde_json::from_str(line).ok()?;
    if entry["type"] != "event_msg" {
        return None;
    }
    let payload = &entry["payload"];
    let message = match payload["type"].as_str()? {
        "item_completed" => {
            let item = &payload["item"];
            let text = item["content"]
                .as_array()?
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            match item["type"].as_str()? {
                "UserMessage" => Message::User(text),
                "AgentMessage" => Message::Agent(text),
                _ => return None,
            }
        }
        "user_message" => Message::User(payload["message"].as_str()?.to_owned()),
        "agent_message" => Message::Agent(payload["message"].as_str()?.to_owned()),
        _ => return None,
    };
    match &message {
        Message::User(text) | Message::Agent(text) if text.trim().is_empty() => None,
        _ => Some(message),
    }
}

// Cursor

fn open_cursor(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// Cursor's chats that have messages, but not its subagents'.
fn cursor_sessions(homes: &Homes) -> rusqlite::Result<Vec<Session>> {
    let Some(path) = homes.cursor.as_deref().filter(|path| path.is_file()) else {
        return Ok(Vec::new());
    };
    let db = open_cursor(path)?;
    // Older Cursor has no headers table, and no subagents.
    let subagents: HashSet<String> = db
        .prepare("SELECT composerId FROM composerHeaders WHERE isSubagent = 1")
        .and_then(|mut query| {
            query
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap_or_default();
    let mut query = db.prepare(
        "SELECT substr(c.key, 14), json_extract(c.value, '$.name'),
                json_extract(c.value, '$.createdAt'), json_extract(c.value, '$.lastUpdatedAt'),
                coalesce(json_extract(c.value, '$.workspaceIdentifier.uri.fsPath'),
                         json_extract(c.value, '$.trackedGitRepos[0].repoPath')),
                json_extract(b.value, '$.text')
         FROM cursorDiskKV c
         LEFT JOIN cursorDiskKV b ON b.key = 'bubbleId:' || substr(c.key, 14) || ':'
             || json_extract(c.value, '$.fullConversationHeadersOnly[0].bubbleId')
         WHERE c.key LIKE 'composerData:%'
           AND json_array_length(c.value, '$.fullConversationHeadersOnly') > 0",
    )?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut sessions = Vec::new();
    for row in rows {
        let (id, name, created, updated, cwd, first) = row?;
        if subagents.contains(&id) {
            continue;
        }
        let Some(started) = created.and_then(|ms| Timestamp::from_millisecond(ms).ok()) else {
            continue;
        };
        let title = name
            .filter(|name| !name.trim().is_empty())
            .or_else(|| first.map(|text| title_from(&text)))
            .unwrap_or_else(|| "Cursor chat".to_owned());
        sessions.push(Session {
            source: ImportSource::Cursor,
            id,
            title,
            cwd,
            started,
            updated: updated
                .and_then(|ms| Timestamp::from_millisecond(ms).ok())
                .unwrap_or(started),
            resume: None,
        });
    }
    Ok(sessions)
}

/// Chat `id`'s messages in order: the user's (type 1) and the agent's (type 2) that have text.
fn cursor_messages(path: &Path, id: &str) -> rusqlite::Result<Vec<Message>> {
    let db = open_cursor(path)?;
    let mut query = db.prepare(
        "SELECT json_extract(h.value, '$.type'), json_extract(b.value, '$.text')
         FROM cursorDiskKV c, json_each(c.value, '$.fullConversationHeadersOnly') h
         JOIN cursorDiskKV b ON b.key = 'bubbleId:' || ?1 || ':' || json_extract(h.value, '$.bubbleId')
         WHERE c.key = 'composerData:' || ?1
         ORDER BY h.key",
    )?;
    let rows = query.query_map([id], |row| {
        Ok((
            row.get::<_, Option<i64>>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?;
    let mut messages = Vec::new();
    for row in rows {
        let (kind, text) = row?;
        let Some(text) = text.filter(|text| !text.trim().is_empty()) else {
            continue;
        };
        match kind {
            Some(1) => messages.push(Message::User(text)),
            Some(2) => messages.push(Message::Agent(text)),
            _ => {}
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests;

mod cloud;
