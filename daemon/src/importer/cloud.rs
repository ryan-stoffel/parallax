//! The Claude Code sessions `claude remote-control` served on the user's computers, which
//! `claude.ai` keeps (PLX-1136), read through Claude Code's own sign-in.
//!
//! plxd starts `claude -p` in stream-json ([`Control`]) and asks it `list_cloud_sessions`, then
//! `get_cloud_session_transcript` for each Remote Control session, up to four at once, as Claude
//! Code reads at most four in parallel. A session `claude.ai` returns no conversation for is left
//! out: one that had Remote Control turned on in an open session is only streamed through
//! `claude.ai`, so its transcript is only on its computer. So is one whose transcript is on this
//! computer too, which the apps' list has: its entries name that local session. Claude Code
//! answers these requests only for the program that started it, and refuses them inside a Claude
//! Code session. Listing finds none, quietly, when Claude Code isn't set up, isn't signed in to
//! `claude.ai`, or runs on another provider, as there is nothing to fix.
//!
//! A session imported from here keeps its `claude.ai` id as the session its follow-ups resume,
//! so they go to it as a Claude Remote Control run (PLX-1140). [`crate::remote_control`] lists
//! them to import new ones on its own.

use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::ImportSource;
use serde_json::{Value, json};

use super::{Message, Session, claude_messages, title_from};
use crate::backend::claude::control::{Control, text};
use crate::server::Daemon;

/// How long listing, or reading one session, may take in all.
const LIMIT: Duration = Duration::from_secs(120);

/// The most transcript pages one session reads, at up to a thousand entries each.
const MAX_PAGES: usize = 50;

/// A Remote Control session as `claude.ai` lists it (`environment_kind` `bridge`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Listed {
    /// Its `session_` id.
    pub id: String,
    pub title: Option<String>,
    pub updated: Option<Timestamp>,
    /// `running`, `idle`, `requires_action`, `archived`, `pending`, or `failed`, when given.
    pub status: Option<String>,
    /// `owner/name`, when it worked in a GitHub repository ([`repository`]).
    pub repository: Option<String>,
    pub branch: Option<String>,
}

impl Listed {
    /// The Remote Control session `entry` of `list_cloud_sessions` names, if it is one.
    fn of(entry: &Value) -> Option<Self> {
        if entry["environment_kind"] != "bridge" {
            return None;
        }
        Some(Self {
            id: text(&entry["id"])?,
            title: text(&entry["title"]),
            updated: entry["updated_at"].as_str().and_then(|at| at.parse().ok()),
            status: text(&entry["status"]),
            repository: repository(&entry["repository"]),
            branch: text(&entry["branch"]),
        })
    }
}

/// A `claude.ai` session to import, with the local session its entries name.
pub(super) struct Importable {
    pub session: Session,
    pub local: Option<String>,
}

/// What [`list`] found: the sessions, and how many it couldn't read.
pub(super) struct Listing {
    pub sessions: Vec<Importable>,
    pub unread: usize,
}

/// A `claude -p` that has answered `initialize`, on the login of the instance named `claude`.
///
/// # Errors
///
/// Why it couldn't start, in words, such as Claude Code not being set up in Parallax.
pub(crate) async fn start(daemon: &Arc<Daemon>) -> Result<Control, String> {
    let home = std::env::home_dir()
        .filter(|home| home.is_absolute())
        .ok_or("the home folder is unknown")?;
    let claude = daemon
        .agents
        .backends()
        .by_name()
        .into_iter()
        .find_map(|(name, backend)| (name == "claude").then_some(backend))
        .ok_or("Claude Code isn't set up in Parallax")?;
    let process = claude
        .control(&home)
        .map_err(|error| error.to_string())?
        .ok_or("Claude Code can't read claude.ai's sessions")?;
    let mut control = Control::new(process)?;
    control.ask(json!({"subtype": "initialize"})).await?;
    Ok(control)
}

/// The Remote Control sessions `claude.ai` lists, newest first, as it orders them: for a person
/// asking now when `user_initiated`, else a background reload.
///
/// # Errors
///
/// Why they couldn't be listed, such as Claude Code not being signed in to `claude.ai`.
pub(crate) async fn listed(
    control: &mut Control,
    user_initiated: bool,
) -> Result<Vec<Listed>, String> {
    let answer = control
        .ask(json!({"subtype": "list_cloud_sessions", "user_initiated": user_initiated}))
        .await?;
    Ok(answer["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Listed::of)
        .collect())
}

/// What a session's first transcript page holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Conversation {
    /// No conversation, as for a session that had Remote Control turned on in an open session.
    None,
    /// A conversation, with the local Claude Code session its entries name, which may be on this
    /// computer too.
    Some { local: Option<String> },
}

/// What `claude.ai` keeps of sessions `ids`, in their order. One that couldn't be read has none.
pub(crate) async fn conversations(control: &mut Control, ids: &[String]) -> Vec<Conversation> {
    let pages = control
        .ask_all(
            ids.iter()
                .map(|id| json!({"subtype": "get_cloud_session_transcript", "session_id": id}))
                .collect(),
        )
        .await;
    ids.iter()
        .zip(pages)
        .map(|(id, page)| {
            let Some(entries) = page
                .ok()
                .and_then(|page| page["entries"].as_array().cloned())
            else {
                return Conversation::None;
            };
            match session(id, &entries) {
                Some(_) => Conversation::Some {
                    local: entries.iter().find_map(|e| text(&e["sessionId"])),
                },
                None => Conversation::None,
            }
        })
        .collect()
}

/// The Remote Control sessions `claude.ai` keeps a conversation for, newest first. None, quietly,
/// when Claude Code isn't installed or set up in Parallax, isn't signed in to `claude.ai`, or runs
/// on another provider, as there is nothing to fix.
///
/// # Errors
///
/// Why they couldn't be listed, in words.
pub(super) async fn list(daemon: &Arc<Daemon>) -> Result<Listing, String> {
    let none = || Listing {
        sessions: Vec::new(),
        unread: 0,
    };
    tokio::time::timeout(LIMIT, async {
        let Ok(mut claude) = start(daemon).await else {
            return Ok(none());
        };
        let remote = match listed(&mut claude, true).await {
            Ok(remote) => remote,
            Err(_) if claude.quiet() => return Ok(none()),
            Err(error) => return Err(error),
        };
        let pages = claude
            .ask_all(
                remote
                    .iter()
                    .map(|s| json!({"subtype": "get_cloud_session_transcript", "session_id": s.id}))
                    .collect(),
            )
            .await;
        let unread = pages.iter().filter(|page| page.is_err()).count();
        let sessions = remote
            .into_iter()
            .zip(pages)
            .filter_map(|(listed, page)| {
                let entries = page.ok()?["entries"].as_array()?.clone();
                let mut session = session(&listed.id, &entries)?;
                if let Some(title) = listed.title {
                    session.title = title;
                }
                if let Some(at) = listed.updated {
                    session.updated = at;
                }
                let local = entries.iter().find_map(|e| text(&e["sessionId"]));
                Some(Importable { session, local })
            })
            .collect();
        Ok(Listing { sessions, unread })
    })
    .await
    .unwrap_or_else(|_| Err("claude.ai's sessions took too long to list".to_owned()))
}

/// A `claude.ai` session read whole: its conversation, and the GitHub repository it worked in.
pub(super) struct Loaded {
    pub session: Session,
    pub messages: Vec<Message>,
    /// `owner/name`, as `claude.ai` lists it, when the session worked in a GitHub repository.
    pub repository: Option<String>,
}

/// Session `id` from `claude.ai` and its whole conversation, or `None` when it has none.
///
/// # Errors
///
/// Why it couldn't be read, in words.
pub(super) async fn load(daemon: &Arc<Daemon>, id: &str) -> Result<Option<Loaded>, String> {
    tokio::time::timeout(LIMIT, async {
        let mut claude = start(daemon).await?;
        let about = claude
            .ask(json!({"subtype": "get_cloud_session", "session_id": id}))
            .await?;
        // Only the list names a session's repository.
        let repository = listed(&mut claude, true)
            .await?
            .into_iter()
            .find(|s| s.id == id)
            .and_then(|s| s.repository);
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut request = json!({"subtype": "get_cloud_session_transcript", "session_id": id});
            if let Some(cursor) = &cursor {
                request["cursor"] = json!(cursor);
            }
            let page = claude.ask(request).await?;
            entries.extend(page["entries"].as_array().into_iter().flatten().cloned());
            cursor = text(&page["next_cursor"]);
            if cursor.is_none() {
                break;
            }
        }
        let Some(mut session) = session(id, &entries) else {
            return Ok(None);
        };
        if let Some(title) = text(&about["title"]) {
            session.title = title;
        }
        Ok(Some(Loaded {
            session,
            messages: messages(&entries),
            repository,
        }))
    })
    .await
    .unwrap_or_else(|_| Err("claude.ai's session took too long to read".to_owned()))
}

/// The session `entries` from `claude.ai` hold, titled by its first message from the user: `None`
/// when they hold none. It resumes its own `claude.ai` id, as a Claude Remote Control run.
fn session(id: &str, entries: &[Value]) -> Option<Session> {
    let first = messages(entries).into_iter().find_map(|m| match m {
        Message::User(text) => Some(text),
        Message::Agent(_) => None,
    })?;
    let at = |e: &Value| e["timestamp"].as_str()?.parse::<Timestamp>().ok();
    let started = entries.iter().find_map(at)?;
    Some(Session {
        source: ImportSource::Claude,
        id: id.to_owned(),
        title: title_from(&first),
        cwd: entries.iter().find_map(|e| text(&e["cwd"])),
        started,
        updated: entries.iter().rev().find_map(at).unwrap_or(started),
        resume: Some(id.to_owned()),
    })
}

/// `owner/name` from `claude.ai`'s `{owner, name}`, when both are a GitHub name: letters, digits,
/// `-`, `_`, and `.`, never only dots.
fn repository(value: &Value) -> Option<String> {
    let part = |key: &str| {
        let text = value[key].as_str()?;
        let valid = !text.is_empty()
            && text.len() <= 100
            && text.chars().any(|c| c != '.')
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        valid.then_some(text)
    };
    Some(format!("{}/{}", part("owner")?, part("name")?))
}

/// The conversation in transcript `entries`, as Claude Code's own transcript file reads.
fn messages(entries: &[Value]) -> Vec<Message> {
    let jsonl: String = entries.iter().map(|e| e.to_string() + "\n").collect();
    claude_messages(&jsonl)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A page of transcript entries as `claude.ai` serves a `claude remote-control` session's.
    fn page() -> Vec<Value> {
        vec![
            json!({"type": "queue-operation", "timestamp": "2026-10-29T03:43:05.680Z", "sessionId": "5c5f05dc"}),
            json!({
                "type": "user", "sessionId": "5c5f05dc", "cwd": "/Users/ryan/Developer/learn-rust",
                "timestamp": "2026-10-29T03:43:05.702Z",
                "message": {"role": "user", "content": "hello from claude rc"},
            }),
            json!({
                "type": "user", "isMeta": true, "timestamp": "2026-10-29T03:43:06.000Z",
                "message": {"role": "user", "content": "Another Claude session sent a message"},
            }),
            json!({
                "type": "assistant", "timestamp": "2026-10-29T03:43:09.100Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Hi Ryan."}]},
            }),
        ]
    }

    #[test]
    fn a_page_with_a_conversation_is_a_session_titled_by_its_first_message() {
        let entries = page();
        let session = session("session_018aq", &entries).unwrap();
        assert_eq!(session.id, "session_018aq");
        assert_eq!(session.title, "hello from claude rc");
        assert_eq!(
            session.cwd.as_deref(),
            Some("/Users/ryan/Developer/learn-rust")
        );
        assert_eq!(
            session.started,
            "2026-10-29T03:43:05.680Z".parse::<Timestamp>().unwrap()
        );
        assert_eq!(
            session.updated,
            "2026-10-29T03:43:09.100Z".parse::<Timestamp>().unwrap()
        );
        assert_eq!(session.resume.as_deref(), Some("session_018aq"));
        assert_eq!(
            messages(&entries),
            [
                Message::User("hello from claude rc".to_owned()),
                Message::Agent("Hi Ryan.".to_owned()),
            ]
        );
    }

    #[test]
    fn a_repository_is_owner_and_name_only_when_both_are_github_names() {
        let named = |owner: &str, name: &str| repository(&json!({"owner": owner, "name": name}));
        assert_eq!(
            named("ryan-stoffel", "learn-rust").as_deref(),
            Some("ryan-stoffel/learn-rust")
        );
        assert_eq!(named("a.b_c", "x.y").as_deref(), Some("a.b_c/x.y"));
        assert_eq!(named("ryan", "../etc"), None);
        assert_eq!(named("ryan", ".."), None);
        assert_eq!(named("", "learn-rust"), None);
        assert_eq!(repository(&json!(null)), None);
    }

    /// A session that had Remote Control turned on in an open session: `claude.ai` serves no
    /// entries for it.
    #[test]
    fn an_empty_page_or_one_without_a_message_from_the_user_is_no_session() {
        assert_eq!(session("session_1", &[]), None);
        assert_eq!(session("session_2", &page()[2..]), None);
    }
}
