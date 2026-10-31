//! A pull request's guide (0095, PLX-1188): an overview, then its changes in reading order, each
//! with the lines it explains and an optional Mermaid diagram, written by the user's own model.
//!
//! `pr/guide` answers at once from the store, which keeps the newest guide per pull request, and
//! from [`Guides`], which knows the tries under way and the failed ones. With no guide for the
//! head the app shows, none under way, and no failed try, it starts one in the background: one
//! hidden, tool-less CLI call, as a thread's name is written (0058, [`namer`]), over the pull
//! request's title, description, and diff ([`fit`]). The answer is checked ([`checked`]) before it
//! replaces the guide before it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    PrGuide, PrGuideHunk, PrGuideParams, PrGuideResult, PrGuideStep, ThreadNaming,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::backend::{fake, namer};
use crate::server::Daemon;
use crate::threads::{store, store_error};
use crate::worktree::{diff_files, diff_sections, github_pr_urls};

/// How long the model has to answer.
const LIMIT: Duration = Duration::from_mins(10);

/// The most bytes of diff the model reads.
const MAX_DIFF_BYTES: usize = 150_000;

/// The most bytes of one file's diff the model reads, so a generated file doesn't crowd out the
/// rest.
const MAX_FILE_BYTES: usize = 20_000;

/// The most steps a guide keeps.
const MAX_STEPS: usize = 20;

/// The most characters of a step's title, an explanation or the overview, and a diagram.
const MAX_TITLE: usize = 120;
const MAX_TEXT: usize = 4000;
const MAX_DIAGRAM: usize = 4000;

/// What the model is told, before the pull request.
const INSTRUCTIONS: &str = "\
Write a review guide for this GitHub pull request: a walkthrough a reviewer reads before the \
diff, so they understand it quickly.
Return JSON with keys overview, diagram, and steps.

- overview: 2-4 plain sentences. What the pull request does and the main parts it touches.
- diagram: Mermaid source for one diagram of the overall change when a picture helps (a \
flowchart, sequence, or class diagram), else null.
- steps: the changes in the order a reviewer should read them, usually 3-8, at most 20. Group \
related hunks into one step. Each has:
  - title: a few words naming the change.
  - explanation: 1-4 plain sentences on what changed and why. Write for a person, not a \
changelog. No Markdown headings.
  - hunks: the lines it covers, as path (exactly as the diff names the file) and start and end, \
line numbers in the new file. For a deleted file, use 1 and 1.
  - diagram: Mermaid source when a flow, sequence, or structure is easier to see than to read, \
else null. Keep diagrams small, with short labels, and don't style or color them.

Pull request:
";

/// Tries under way and failed ones, by pull request and head.
#[derive(Default)]
pub(crate) struct Guides {
    tries: Mutex<HashMap<Key, Try>>,
}

/// A pull request's repository (`owner/name`), number, and head commit.
type Key = (String, u64, String);

enum Try {
    Running,
    Failed(String),
}

/// `pr/guide`: what plxd has for the pull request, starting a guide for `head_sha` when it
/// needs one.
pub(crate) async fn guide(
    daemon: &Arc<Daemon>,
    params: PrGuideParams,
) -> Result<PrGuideResult, ErrorObject> {
    let (repo, number) = parts(&params.url).ok_or_else(|| {
        ErrorObject::invalid_params(format!("{:?} is not a GitHub pull request URL", params.url))
    })?;
    if params.head_sha.trim().is_empty() {
        return Err(ErrorObject::invalid_params("headSha is empty"));
    }
    let owned = repo.clone();
    let guide = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.pr_guide(&owned, number).map_err(|e| store_error(&e))
        })
        .await?
        .and_then(|payload| {
            serde_json::from_str::<PrGuide>(&payload)
                .inspect_err(|error| warn!(%error, "a stored pull request guide is unreadable"))
                .ok()
        });
    let current = guide
        .as_ref()
        .is_some_and(|guide| guide.head_sha == params.head_sha);
    let key = (repo, number, params.head_sha.clone());
    let start = {
        let mut tries = daemon
            .pr_guides
            .tries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let start = match tries.get(&key) {
            Some(Try::Running) => false,
            Some(Try::Failed(_)) => params.regenerate,
            None => params.regenerate || !current,
        };
        if start {
            tries.insert(key.clone(), Try::Running);
        }
        start
    };
    if start {
        write(daemon, key.clone(), params);
    }
    let tries = daemon
        .pr_guides
        .tries
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    Ok(PrGuideResult {
        guide,
        generating: matches!(tries.get(&key), Some(Try::Running)),
        error: match tries.get(&key) {
            Some(Try::Failed(why)) => Some(why.clone()),
            _ => None,
        },
    })
}

/// Writes `key`'s guide in the background, and keeps it, or why it failed.
fn write(daemon: &Arc<Daemon>, key: Key, params: PrGuideParams) {
    let owned = Arc::clone(daemon);
    daemon.agents.background(async move {
        let written = written(&owned, &key, &params).await;
        let outcome = match written {
            Ok(guide) => keep(&owned, &key, &guide).await,
            Err(error) => Err(error),
        };
        let mut tries = owned
            .pr_guides
            .tries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match outcome {
            Ok(()) => {
                info!(url = %params.url, "wrote a pull request's guide");
                tries.remove(&key);
            }
            Err(error) => {
                warn!(url = %params.url, %error, "could not write a pull request's guide");
                tries.insert(key, Try::Failed(error));
            }
        }
    });
}

/// Stores `guide` as the pull request's newest.
async fn keep(daemon: &Daemon, key: &Key, guide: &PrGuide) -> Result<(), String> {
    let payload = serde_json::to_string(guide).map_err(|error| error.to_string())?;
    let (repo, number) = (key.0.clone(), key.1);
    store(daemon, move |db| {
        db.put_pr_guide(&repo, number, &payload)
            .map_err(|e| store_error(&e))
    })
    .await
    .map_err(|error| error.message)
}

/// The guide the model writes for `key`'s head.
async fn written(daemon: &Daemon, key: &Key, params: &PrGuideParams) -> Result<PrGuide, String> {
    // The app's end-to-end tests run on the fake backend, where a real CLI would answer.
    if std::env::var_os(fake::SCRIPT_ENV).is_some() {
        return Err("guides aren't written on the fake backend".to_owned());
    }
    let pr = crate::pr_watch::view(daemon, &params.url, false)
        .await
        .map_err(|error| format!("could not read the pull request: {error}"))?;
    // Read once per head for every caller. A push between the app's read and this one gives the
    // newer head's diff, kept under the older head until the app asks for the newer one.
    let read = daemon
        .agents
        .worktrees()
        .shared_diff(&params.url)
        .await
        .map_err(|error| format!("could not read the diff: {error}"))?;
    let (diff, mut omitted) = fit(&read.diff, MAX_DIFF_BYTES, MAX_FILE_BYTES);
    if read.truncated {
        let seen: HashSet<String> = diff_sections(&read.diff)
            .iter()
            .filter_map(|section| diff_files(section).last().map(str::to_owned))
            .collect();
        omitted.extend(
            pr.files
                .iter()
                .map(|file| file.path.clone())
                .filter(|path| !seen.contains(path)),
        );
    }
    let mut prompt = format!(
        "{INSTRUCTIONS}Title: {}\n\nDescription:\n{}\n\nDiff:\n{diff}",
        pr.title,
        pr.body.trim()
    );
    if !omitted.is_empty() {
        prompt.push_str(&format!(
            "\n[Left out for size: {}. Don't write steps for them.]\n",
            omitted.join(", ")
        ));
    }
    let answer = ask(daemon, &prompt, &params.model).await?;
    let paths: HashSet<String> = diff_sections(&diff)
        .iter()
        .filter_map(|section| diff_files(section).last().map(str::to_owned))
        .collect();
    checked(answer, &key.2, &paths, omitted, Timestamp::now())
}

/// The model's answer from `model`, on the user's login for its instance.
async fn ask(daemon: &Daemon, prompt: &str, model: &ThreadNaming) -> Result<Answer, String> {
    let temp = daemon.data_dir.temp_dir();
    std::fs::create_dir_all(&temp)
        .map_err(|error| format!("could not make plxd's temp folder: {error}"))?;
    let dir = tempfile::Builder::new()
        .prefix("guide-")
        .tempdir_in(temp)
        .map_err(|error| format!("could not make a folder for the CLI: {error}"))?;
    std::fs::write(dir.path().join(namer::SCHEMA_FILE), schema().to_string())
        .map_err(|error| format!("could not write the answer's schema: {error}"))?;
    let (instance, name) = (&model.backend, &model.model);
    let backend = daemon
        .agents
        .backends()
        .by_backend_name(instance)
        .ok_or_else(|| format!("{instance} isn't on this host"))?
        .1;
    let probe = backend
        .namer(dir.path(), name, model.effort)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            format!("{instance} can't write guides; pick a Claude Code or Codex model")
        })?;
    namer::ask(probe, prompt, LIMIT)
        .await
        .map_err(|error| format!("{instance} ({name}): {error}"))
}

/// `owner/name` and the number of `url`, a GitHub pull request's.
fn parts(url: &str) -> Option<(String, u64)> {
    if github_pr_urls(url) != [url] {
        return None;
    }
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (owner, name, _, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    Some((format!("{owner}/{name}"), number.parse().ok()?))
}

/// `diff` cut to fit a prompt: each file's section cut at a line's end at `per_file` bytes, and
/// whole files left out, by path, once `budget` bytes are used. Later, smaller files still fit.
fn fit(diff: &str, budget: usize, per_file: usize) -> (String, Vec<String>) {
    const CUT: &str = "[The rest of this file's diff is left out for size.]\n";
    let (mut kept, mut omitted) = (String::new(), Vec::new());
    for mut section in diff_sections(diff) {
        if section.len() > per_file {
            let end = section.as_bytes()[..per_file]
                .iter()
                .rposition(|&b| b == b'\n')
                .map_or(0, |at| at + 1);
            section.truncate(end);
            section.push_str(CUT);
        }
        if kept.len() + section.len() > budget {
            if let Some(path) = diff_files(&section).last() {
                omitted.push(path.to_owned());
            }
            continue;
        }
        kept.push_str(&section);
    }
    (kept, omitted)
}

/// What the model answers, in [`schema`]'s shape.
#[derive(Debug, Deserialize)]
struct Answer {
    overview: String,
    diagram: Option<String>,
    steps: Vec<AnswerStep>,
}

#[derive(Debug, Deserialize)]
struct AnswerStep {
    title: String,
    explanation: String,
    hunks: Vec<AnswerHunk>,
    diagram: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnswerHunk {
    path: String,
    start: i64,
    end: i64,
}

/// The JSON schema of [`Answer`]. Every key is required, with `null` for no diagram, as Codex's
/// strict schemas need.
fn schema() -> Value {
    let diagram = json!({"type": ["string", "null"]});
    let hunk = json!({
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "start": {"type": "integer"},
            "end": {"type": "integer"},
        },
        "required": ["path", "start", "end"],
        "additionalProperties": false,
    });
    let step = json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "explanation": {"type": "string"},
            "hunks": {"type": "array", "items": hunk},
            "diagram": diagram,
        },
        "required": ["title", "explanation", "hunks", "diagram"],
        "additionalProperties": false,
    });
    json!({
        "type": "object",
        "properties": {
            "overview": {"type": "string"},
            "diagram": diagram,
            "steps": {"type": "array", "items": step},
        },
        "required": ["overview", "diagram", "steps"],
        "additionalProperties": false,
    })
}

/// `answer` as a guide for `head`: text trimmed and capped, steps without a title or explanation
/// dropped, at most [`MAX_STEPS`], hunks only in files of `paths` with `start` at least 1 and
/// `end` at least `start`, and blank or oversized diagrams dropped.
///
/// # Errors
///
/// An empty overview, or no step left.
fn checked(
    answer: Answer,
    head: &str,
    paths: &HashSet<String>,
    omitted: Vec<String>,
    now: Timestamp,
) -> Result<PrGuide, String> {
    let overview = text(&answer.overview, MAX_TEXT);
    if overview.is_empty() {
        return Err("the model's guide had no overview".to_owned());
    }
    let steps: Vec<PrGuideStep> = answer
        .steps
        .into_iter()
        .filter_map(|step| {
            let title = text(&step.title, MAX_TITLE);
            let explanation = text(&step.explanation, MAX_TEXT);
            if title.is_empty() || explanation.is_empty() {
                return None;
            }
            let hunks = step
                .hunks
                .into_iter()
                .filter(|hunk| paths.contains(&hunk.path))
                .map(|hunk| {
                    let line = |n: i64| u32::try_from(n.max(1)).unwrap_or(u32::MAX);
                    let (start, end) = (line(hunk.start), line(hunk.end));
                    PrGuideHunk {
                        path: hunk.path,
                        start: start.min(end),
                        end: start.max(end),
                    }
                })
                .collect();
            Some(PrGuideStep {
                title,
                explanation,
                hunks,
                diagram: diagram(step.diagram),
            })
        })
        .take(MAX_STEPS)
        .collect();
    if steps.is_empty() {
        return Err("the model's guide had no steps".to_owned());
    }
    Ok(PrGuide {
        head_sha: head.to_owned(),
        overview,
        diagram: diagram(answer.diagram),
        steps,
        omitted,
        created_at: now,
    })
}

/// `raw` trimmed, cut to `max` characters.
fn text(raw: &str, max: usize) -> String {
    let trimmed = raw.trim();
    match trimmed.char_indices().nth(max) {
        Some((at, _)) => trimmed[..at].trim_end().to_owned(),
        None => trimmed.to_owned(),
    }
}

/// A diagram's source, unless it's blank or longer than [`MAX_DIAGRAM`].
fn diagram(raw: Option<String>) -> Option<String> {
    let source = raw?.trim().to_owned();
    (!source.is_empty() && source.chars().count() <= MAX_DIAGRAM).then_some(source)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::time::Duration;

    use jiff::Timestamp;
    use parallax_protocol::{PrGuide, PrGuideParams, ThreadNaming};

    use super::{Answer, checked, fit, guide, parts};
    use crate::server::Daemon;
    use crate::threads::{store, store_error};

    fn answer(json: serde_json::Value) -> Answer {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_guide_keeps_only_hunks_in_the_diff_and_orders_their_lines() {
        let paths = HashSet::from(["src/a.rs".to_owned()]);
        let guide = checked(
            answer(serde_json::json!({
                "overview": "  Adds a thing. ",
                "diagram": "   ",
                "steps": [
                    {"title": "", "explanation": "dropped", "hunks": [], "diagram": null},
                    {
                        "title": "Read a",
                        "explanation": "Why.",
                        "hunks": [
                            {"path": "src/a.rs", "start": 9, "end": 3},
                            {"path": "src/a.rs", "start": -2, "end": 0},
                            {"path": "nope.rs", "start": 1, "end": 2},
                        ],
                        "diagram": "flowchart LR\n  A --> B",
                    },
                ],
            })),
            "abc",
            &paths,
            vec!["Cargo.lock".to_owned()],
            Timestamp::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(guide.overview, "Adds a thing.");
        assert_eq!(guide.diagram, None);
        assert_eq!(guide.steps.len(), 1);
        let step = &guide.steps[0];
        assert_eq!(
            step.hunks
                .iter()
                .map(|h| (h.path.as_str(), h.start, h.end))
                .collect::<Vec<_>>(),
            [("src/a.rs", 3, 9), ("src/a.rs", 1, 1)]
        );
        assert!(step.diagram.is_some());
        assert_eq!(guide.omitted, ["Cargo.lock"]);
        assert_eq!(guide.head_sha, "abc");
    }

    #[test]
    fn a_guide_without_an_overview_or_steps_is_refused() {
        let paths = HashSet::new();
        let empty = |overview: &str, steps: serde_json::Value| {
            checked(
                answer(serde_json::json!({"overview": overview, "diagram": null, "steps": steps})),
                "abc",
                &paths,
                Vec::new(),
                Timestamp::UNIX_EPOCH,
            )
        };
        assert!(empty(" ", serde_json::json!([{"title": "t", "explanation": "e", "hunks": [], "diagram": null}])).is_err());
        assert!(empty("Does a thing.", serde_json::json!([])).is_err());
    }

    #[test]
    fn a_big_diff_is_cut_per_file_and_files_past_the_budget_are_left_out() {
        let file = |path: &str, lines: usize| {
            let mut section = format!(
                "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -0,0 +1,{lines} @@\n"
            );
            for n in 0..lines {
                section.push_str(&format!("+line {n}\n"));
            }
            section
        };
        let diff = [
            file("big.rs", 100),
            file("next.rs", 40),
            file("small.rs", 1),
        ]
        .concat();
        let (kept, omitted) = fit(&diff, 700, 500);
        assert!(kept.contains("diff --git a/big.rs"));
        assert!(kept.contains("left out for size"));
        assert!(!kept.contains("next.rs"));
        assert!(kept.contains("diff --git a/small.rs"));
        assert!(kept.len() <= 700);
        assert_eq!(omitted, ["next.rs"]);
    }

    /// The stored guide serves its head without a new try; another head gets the old guide, out
    /// of date, while one is written; a failed try stays failed until `regenerate`.
    #[tokio::test]
    async fn pr_guide_serves_the_cache_and_writes_once_per_head() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let old = PrGuide {
            head_sha: "old".to_owned(),
            overview: "Does a thing.".to_owned(),
            diagram: None,
            steps: Vec::new(),
            omitted: Vec::new(),
            created_at: Timestamp::UNIX_EPOCH,
        };
        let payload = serde_json::to_string(&old).unwrap();
        store(&daemon, move |db| {
            db.put_pr_guide("o/r", 1, &payload)
                .map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
        let ask = |head: &str, regenerate: bool| {
            guide(
                &daemon,
                PrGuideParams {
                    url: "https://github.com/o/r/pull/1".to_owned(),
                    head_sha: head.to_owned(),
                    model: ThreadNaming {
                        backend: "claude".to_owned(),
                        model: "m".to_owned(),
                        effort: None,
                    },
                    regenerate,
                },
            )
        };

        let current = ask("old", false).await.unwrap();
        assert_eq!(current.guide.as_ref(), Some(&old));
        assert!(!current.generating && current.error.is_none());

        // No `gh` on the test daemon's PATH, so the try fails at its first read.
        let moved = ask("new", false).await.unwrap();
        assert_eq!(moved.guide.as_ref(), Some(&old));
        assert!(moved.generating);
        let failed = loop {
            let read = ask("new", false).await.unwrap();
            if !read.generating {
                break read;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(failed.error.is_some());
        assert_eq!(failed.guide.as_ref(), Some(&old));

        assert!(ask("new", true).await.unwrap().generating);
    }

    #[test]
    fn a_pull_request_url_names_its_repository_and_number() {
        assert_eq!(
            parts("https://github.com/o/r/pull/12"),
            Some(("o/r".to_owned(), 12))
        );
        assert_eq!(parts("https://github.com/o/r/issues/12"), None);
        assert_eq!(parts("https://github.com/o/r/pull/12/files"), None);
    }
}
