//! A `claude -p` in stream-json that answers Claude Code SDK control requests
//! ([`Backend::control`](crate::backend::Backend::control)): `claude.ai`'s cloud sessions, read
//! with Claude Code's own sign-in, for importing them (PLX-1136) and for following a Claude
//! Remote Control session's transcript (PLX-1140).

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt as _;

use crate::backend::process::{Output, Process, StdinPipe};

/// The most requests in flight, as many as Claude Code reads in parallel.
const IN_FLIGHT: usize = 4;

/// What a request Claude Code turned away as busy answers, to be asked again once.
const BUSY: &str = "Claude Code is busy";

/// How long requests in flight wait for their next answer after Claude Code wrote a line too big to
/// read, which was one of their answers: then they fail, and the rest go on. Longer than the 25 s
/// Claude Code gives each request, so by then only the cut one is left.
const OVERSIZED_WAIT: Duration = Duration::from_secs(30);

/// Why Claude Code can't read `claude.ai`'s sessions that aren't a fault to report: it isn't signed
/// in to `claude.ai`, or it runs on another provider ([`Control::quiet`]).
const QUIET_REASONS: [&str; 2] = ["not_signed_in", "provider"];

/// A `claude -p` answering control requests: each written as a line, answered in a
/// `control_response` carrying its `request_id`.
pub(crate) struct Control {
    process: Process,
    stdin: StdinPipe,
    next: u64,
    /// Claude Code answered with one of [`QUIET_REASONS`].
    quiet: bool,
    /// It wrote a line too big to read since what was in flight last failed.
    oversized: bool,
}

impl Control {
    /// Takes `process`, which [`Backend::control`](crate::backend::Backend::control) started.
    ///
    /// # Errors
    ///
    /// When its stdin was already taken.
    pub(crate) fn new(mut process: Process) -> Result<Self, String> {
        let stdin = process.take_stdin().ok_or("Claude Code has no stdin")?;
        Ok(Self {
            process,
            stdin,
            next: 0,
            quiet: false,
            oversized: false,
        })
    }

    /// Whether Claude Code turned a request away for a reason that isn't a fault to report: it
    /// isn't signed in to `claude.ai`, or it runs on another provider.
    pub(crate) fn quiet(&self) -> bool {
        self.quiet
    }

    async fn send(&mut self, request: &Value) -> Result<String, String> {
        self.next += 1;
        let id = format!("plxd-{}", self.next);
        let line = json!({"type": "control_request", "request_id": id, "request": request});
        self.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|_| "Claude Code stopped".to_owned())?;
        Ok(id)
    }

    /// The answer to one request.
    ///
    /// # Errors
    ///
    /// Why it wasn't answered, in words.
    pub(crate) async fn ask(&mut self, request: Value) -> Result<Value, String> {
        let mut answers = self.ask_all(vec![request]).await;
        answers
            .pop()
            .unwrap_or_else(|| Err("Claude Code didn't answer".to_owned()))
    }

    /// The answers to `requests`, in their order, with at most [`IN_FLIGHT`] asked at once. One
    /// Claude Code turns away as busy is asked again.
    pub(crate) async fn ask_all(&mut self, requests: Vec<Value>) -> Vec<Result<Value, String>> {
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
                Ok(Some(answered)) => answered,
                Ok(None) => {
                    self.oversized = true;
                    continue;
                }
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

    /// The next `control_response`: its `request_id`, and its answer or why there is none. `None`
    /// when Claude Code wrote a line too big to read, a page whose request goes unanswered.
    async fn answer(&mut self) -> Result<Option<(String, Result<Value, String>)>, String> {
        loop {
            let line = match self.process.next().await {
                Some(Output::Line(line)) => line,
                Some(Output::Oversized { .. }) => return Ok(None),
                Some(Output::Exited(exit)) => {
                    return Err(format!("Claude Code stopped: {}", exit.stderr_tail.trim()));
                }
                None => return Err("Claude Code stopped".to_owned()),
            };
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if message["type"] != "control_response" {
                continue;
            }
            let response = &message["response"];
            let Some(id) = response["request_id"].as_str() else {
                continue;
            };
            let answer = answer(response);
            let reason = &response["response"]["reason"];
            if answer.is_err() && QUIET_REASONS.iter().any(|quiet| reason == *quiet) {
                self.quiet = true;
            }
            return Ok(Some((id.to_owned(), answer)));
        }
    }
}

/// A `control_response`'s `response`: its body, or why it has none.
fn answer(response: &Value) -> Result<Value, String> {
    if response["subtype"] == "error" {
        return Err(text(&response["error"]).unwrap_or_else(|| "Claude Code refused".to_owned()));
    }
    let body = &response["response"];
    match body["status"].as_str() {
        Some("ok") | None => Ok(body.clone()),
        Some(_) if body["reason"] == "temporarily_unavailable" => Err(BUSY.to_owned()),
        Some(_) => Err(text(&body["message"])
            .unwrap_or_else(|| "claude.ai's sessions aren't available".to_owned())),
    }
}

/// `value`'s text, trimmed, when it has some.
pub(crate) fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn an_answer_too_big_to_read_fails_only_its_request() {
        use crate::backend::process::{
            Environment, Launcher, OutputLimits, ProcessSpec, StdinMode,
        };
        use crate::paths::DataDir;

        let ok = r#"{"type":"control_response","response":{"subtype":"success","request_id":"plxd-1","response":{"ok":1}}}"#;
        let mut spec = ProcessSpec::new("sh", "/");
        spec.args = vec![
            "-c".into(),
            format!(
                "printf '%s\\n%s\\n' '{ok}' \"$(head -c 2000 /dev/zero | tr '\\0' x)\"; sleep 60"
            )
            .into(),
        ];
        spec.stdin = StdinMode::Piped;
        spec.limits = OutputLimits {
            max_line_bytes: 1024,
            ..OutputLimits::default()
        };
        let base: Environment = [("PATH", "/usr/bin:/bin")].into_iter().collect();
        let launcher = Launcher::new(DataDir::new("/tmp/plxd-test-data").unwrap(), base);
        let mut claude = Control::new(launcher.spawn(&spec).unwrap()).unwrap();

        let answers = claude.ask_all(vec![json!({"a": 1}), json!({"b": 2})]).await;
        assert_eq!(
            answers,
            [
                Ok(json!({"ok": 1})),
                Err("a session was too large to read".to_owned())
            ]
        );
    }

    #[test]
    fn an_answer_is_its_body_or_why_it_has_none() {
        let ok = json!({"subtype": "success", "response": {"status": "ok", "sessions": []}});
        assert_eq!(answer(&ok), Ok(json!({"status": "ok", "sessions": []})));
        let busy = json!({"response": {"status": "error", "reason": "temporarily_unavailable"}});
        assert_eq!(answer(&busy), Err(BUSY.to_owned()));
        let refused = json!({"response": {"status": "error", "reason": "started_by_session",
            "message": "Not inside a Claude Code session."}});
        assert_eq!(
            answer(&refused),
            Err("Not inside a Claude Code session.".to_owned())
        );
        let error = json!({"subtype": "error", "error": "unknown subtype"});
        assert_eq!(answer(&error), Err("unknown subtype".to_owned()));
    }
}
