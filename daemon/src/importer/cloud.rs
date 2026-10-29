//! The Claude Code sessions `claude remote-control` served on the user's computers, which
//! `claude.ai` keeps (PLX-1136), read through Claude Code's own sign-in.
//!
//! plxd starts `claude -p` in stream-json ([`Backend::control`]) and asks it
//! `list_cloud_sessions`, then `get_cloud_session_transcript` for each Remote Control session, up
//! to four at once, as Claude Code reads at most four in parallel. A session `claude.ai` returns
//! no conversation for is left out: one that had Remote Control turned on in an open session is
//! only streamed through `claude.ai`, so its transcript is only on its computer. So is one whose
//! transcript is on this computer too, which the apps' list has: its entries name that local
//! session. Claude Code answers these requests only for the program that started it, and refuses
//! them inside a Claude Code session.
//!
//! [`Backend::control`]: crate::backend::Backend::control

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::ImportSource;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt as _;

use super::{Message, Session, claude_messages, title_from};
use crate::backend::process::{Output, Process};
use crate::server::Daemon;

/// The most requests in flight, as many as Claude Code reads in parallel.
const IN_FLIGHT: usize = 4;

/// How long listing, or reading one session, may take in all.
const LIMIT: Duration = Duration::from_secs(120);

/// The most transcript pages one session reads, at up to a thousand entries each.
const MAX_PAGES: usize = 50;

/// How long requests in flight wait after Claude Code wrote a line too big to read, which was
/// one of their answers: then they fail, and the rest go on.
const OVERSIZED_WAIT: Duration = Duration::from_secs(20);

/// Why Claude Code can't read `claude.ai`'s sessions that aren't a fault to report: it isn't signed
/// in to `claude.ai`, or it runs on another provider. Listing then finds none, quietly.
const QUIET_REASONS: [&str; 2] = ["not_signed_in", "provider"];

/// What [`list`] found: the sessions, and how many it couldn't read.
pub(super) struct Listing {
    pub sessions: Vec<Listed>,
    pub unread: usize,
}

/// A `claude.ai` session to import, with the local session its entries name.
pub(super) struct Listed {
    pub session: Session,
    pub local: Option<String>,
}

/// The Remote Control sessions `claude.ai` keeps a conversation for, newest first. None, quietly,
/// when Claude Code isn't installed or set up in Parallax, isn't signed in to `claude.ai`, or runs
/// on another provider, as there is nothing to fix.
///
/// # Errors
///
/// Why they couldn't be listed, in words.
pub(super) async fn list(daemon: &Arc<Daemon>) -> Result<Listing, String> {
    let none = Listing {
        sessions: Vec::new(),
        unread: 0,
    };
    let Ok(mut claude) = Control::start(daemon) else {
        return Ok(none);
    };
    tokio::time::timeout(LIMIT, async {
        claude.ask(json!({"subtype": "initialize"})).await?;
        let listed = match claude
            .ask(json!({"subtype": "list_cloud_sessions", "user_initiated": true}))
            .await
        {
            Ok(listed) => listed,
            Err(_) if claude.quiet => return Ok(none),
            Err(error) => return Err(error),
        };
        let remote: Vec<Value> = listed["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| s["environment_kind"] == "bridge" && s["id"].is_string())
            .cloned()
            .collect();
        let pages = claude
            .ask_all(
                remote
                    .iter()
                    .map(|s| json!({"subtype": "get_cloud_session_transcript", "session_id": s["id"]}))
                    .collect(),
            )
            .await;
        let unread = pages.iter().filter(|page| page.is_err()).count();
        let sessions = remote
            .iter()
            .zip(pages)
            .filter_map(|(listed, page)| {
                let entries = page.ok()?["entries"].as_array()?.clone();
                let mut session = session(listed["id"].as_str()?, &entries)?;
                if let Some(title) = text(&listed["title"]) {
                    session.title = title;
                }
                if let Some(at) = listed["updated_at"].as_str().and_then(|at| at.parse().ok()) {
                    session.updated = at;
                }
                let local = entries.iter().find_map(|e| text(&e["sessionId"]));
                Some(Listed { session, local })
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
    let mut claude = Control::start(daemon)?;
    tokio::time::timeout(LIMIT, async {
        claude.ask(json!({"subtype": "initialize"})).await?;
        let about = claude
            .ask(json!({"subtype": "get_cloud_session", "session_id": id}))
            .await?;
        // Only the list names a session's repository.
        let listed = claude
            .ask(json!({"subtype": "list_cloud_sessions", "user_initiated": true}))
            .await?;
        let repository = listed["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["id"] == id)
            .and_then(|s| repository(&s["repository"]));
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
/// when they hold none.
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
        resume: None,
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

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A `claude -p` answering control requests: each written as a line, answered in a
/// `control_response` carrying its `request_id`.
struct Control {
    process: Process,
    stdin: crate::backend::process::StdinPipe,
    next: u64,
    /// Claude Code answered with one of [`QUIET_REASONS`].
    quiet: bool,
    /// It wrote a line too big to read since the last answer.
    oversized: bool,
}

impl Control {
    fn start(daemon: &Arc<Daemon>) -> Result<Self, String> {
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
        let mut process = claude
            .control(&home)
            .map_err(|error| error.to_string())?
            .ok_or("Claude Code can't read claude.ai's sessions")?;
        let stdin = process.take_stdin().ok_or("Claude Code has no stdin")?;
        Ok(Self {
            process,
            stdin,
            next: 0,
            quiet: false,
            oversized: false,
        })
    }

    async fn send(&mut self, request: &Value) -> Result<String, String> {
        self.next += 1;
        let id = format!("import-{}", self.next);
        let line = json!({"type": "control_request", "request_id": id, "request": request});
        self.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|_| "Claude Code stopped".to_owned())?;
        Ok(id)
    }

    /// The answer to one request.
    async fn ask(&mut self, request: Value) -> Result<Value, String> {
        let mut answers = self.ask_all(vec![request]).await;
        answers
            .pop()
            .unwrap_or_else(|| Err("Claude Code didn't answer".to_owned()))
    }

    /// The answers to `requests`, in their order, with at most [`IN_FLIGHT`] asked at once. One
    /// Claude Code turns away as busy is asked again.
    async fn ask_all(&mut self, requests: Vec<Value>) -> Vec<Result<Value, String>> {
        let mut answers: Vec<Option<Result<Value, String>>> = vec![None; requests.len()];
        let mut waiting: VecDeque<usize> = (0..requests.len()).collect();
        let mut asked: HashMap<String, usize> = HashMap::new();
        let mut busy: HashSet<usize> = HashSet::new();
        while answers.iter().any(Option::is_none) {
            while asked.len() < IN_FLIGHT {
                let Some(index) = waiting.pop_front() else {
                    break;
                };
                match self.send(&requests[index]).await {
                    Ok(id) => {
                        asked.insert(id, index);
                    }
                    Err(error) => answers[index] = Some(Err(error)),
                }
            }
            if asked.is_empty() {
                break;
            }
            // An answer too big to read never arrives: once one was cut, what's in flight waits a
            // while longer, then fails, so one huge session can't hold up the rest.
            let next = if self.oversized {
                tokio::time::timeout(OVERSIZED_WAIT, self.answer()).await
            } else {
                Ok(self.answer().await)
            };
            let Ok(next) = next else {
                self.oversized = false;
                for index in asked.drain().map(|(_, index)| index) {
                    answers[index] = Some(Err("a session was too large to read".to_owned()));
                }
                continue;
            };
            let (id, answer) = match next {
                Ok(answered) => answered,
                Err(error) => {
                    for index in asked.into_values().chain(waiting) {
                        answers[index] = Some(Err(error.clone()));
                    }
                    break;
                }
            };
            let Some(index) = asked.remove(&id) else {
                continue;
            };
            if answer.as_ref().is_err_and(|why| why == BUSY) && busy.insert(index) {
                waiting.push_back(index);
            } else {
                answers[index] = Some(answer);
            }
        }
        answers
            .into_iter()
            .map(|a| a.unwrap_or_else(|| Err("Claude Code didn't answer".to_owned())))
            .collect()
    }

    /// The next `control_response`: its `request_id`, and its answer or why there is none.
    async fn answer(&mut self) -> Result<(String, Result<Value, String>), String> {
        loop {
            let line = match self.process.next().await {
                Some(Output::Line(line)) => line,
                // A page too big to read: its request goes unanswered (see `ask_all`).
                Some(Output::Oversized { .. }) => {
                    self.oversized = true;
                    continue;
                }
                Some(Output::Exited(exit)) => {
                    return Err(format!("Claude Code stopped: {}", exit.stderr_tail.trim()));
                }
                None => return Err("Claude Code stopped".to_owned()),
            };
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let response = &message["response"];
            if message["type"] != "control_response" {
                continue;
            }
            let Some(id) = response["request_id"].as_str() else {
                continue;
            };
            let answer = if response["subtype"] == "error" {
                Err(text(&response["error"]).unwrap_or_else(|| "Claude Code refused".to_owned()))
            } else {
                let body = &response["response"];
                match body["status"].as_str() {
                    Some("ok") | None => Ok(body.clone()),
                    Some(_) if body["reason"] == "temporarily_unavailable" => Err(BUSY.to_owned()),
                    Some(_) if QUIET_REASONS.iter().any(|reason| body["reason"] == *reason) => {
                        self.quiet = true;
                        Err(text(&body["message"]).unwrap_or_default())
                    }
                    Some(_) => Err(text(&body["message"])
                        .unwrap_or_else(|| "claude.ai's sessions aren't available".to_owned())),
                }
            };
            return Ok((id.to_owned(), answer));
        }
    }
}

/// What a request Claude Code turned away as busy answers, to be asked again once.
const BUSY: &str = "Claude Code is busy";

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
        assert_eq!(session.resume, None);
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
