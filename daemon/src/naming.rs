//! Names a new thread and its branch with the user's own model (decision record 0058).
//!
//! `thread/start` with `naming` starts the thread at once, on the branch its prompt's words
//! name and with no title, then calls [`start`]. In the background, one CLI call asks the model
//! for a title and a branch name ([`prompt`]), and plxd sets the title unless the thread has one
//! by then, and renames the branch through the run's actor while it has no upstream. The chosen
//! model goes first. When its instance isn't on the host, can't name threads, or fails, the
//! default model of the thread's own instance goes next ([`default_model`]). A call that fails,
//! or takes longer than [`LIMIT`], is only logged, and the thread keeps its first name.

use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::{
    AgentEffort, AgentRun, MAX_THREAD_TITLE_BYTES, ParallaxEvent, ProviderKind, RunId, ThreadNaming,
};
use parallax_store::ThreadUpdate;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::agents;
use crate::backend::fake;
use crate::backend::namer::{self, Name};
use crate::server::Daemon;
use crate::threads::thread_entry;
use crate::worktree::valid_branch_slug;

/// How long one model has to answer.
const LIMIT: Duration = Duration::from_secs(60);

/// The most bytes of the user's message the model reads: the start and end, around a marker.
const MAX_MESSAGE_BYTES: usize = 8000;

/// What the model is told, before the user's message. T3 Code's rules for a new thread's title
/// (`TextGenerationPrompts.ts`), without those for tools and attachments, which this call has
/// none of, and its rules for a branch name.
const INSTRUCTIONS: &str = "\
Name this Parallax thread so the user can recognize it weeks later, and name the git branch \
its work goes on.
Return JSON with keys title and branch.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Title rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the \
title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing \
punctuation.
- If the message names a PR or issue you can't read, use the user's stated action plus its \
number, such as \"Take Over PR 8588\".

Branch rules:
- Describe the requested work in 2-6 lowercase words joined by hyphens, such as \
login-empty-password-crash.
- No prefix, slash, or namespace: Parallax adds its own.

User message:
";

/// Names thread `run`, just started with `naming`, in the background.
pub(crate) fn start(daemon: &Arc<Daemon>, run: &AgentRun, naming: ThreadNaming) {
    // The app's end-to-end tests run threads on the fake backend, where a real CLI on the
    // developer's machine would rename them mid-test.
    if run.prompt.trim().is_empty() || std::env::var_os(fake::SCRIPT_ENV).is_some() {
        return;
    }
    let (run_id, backend, prompt) = (run.id, run.backend.clone(), prompt(&run.prompt));
    let owned = Arc::clone(daemon);
    daemon.agents.background(async move {
        let name = match ask(&owned, &prompt, naming, &backend).await {
            Ok(name) => name,
            Err(error) => {
                warn!(run = %run_id, %error, "could not name a thread");
                return;
            }
        };
        if let Err(error) = apply(&owned, run_id, name).await {
            warn!(run = %run_id, %error, "could not apply a thread's name");
        }
    });
}

/// The model's whole prompt for the user's message `message`.
fn prompt(message: &str) -> String {
    format!("{INSTRUCTIONS}{}", limit(message.trim()))
}

/// `message`, or its start and end around a marker when it's longer than [`MAX_MESSAGE_BYTES`],
/// which keeps a request's last constraints.
fn limit(message: &str) -> String {
    const MARKER: &str = "\n[Content truncated]\n";
    if message.len() <= MAX_MESSAGE_BYTES {
        return message.to_owned();
    }
    let half = (MAX_MESSAGE_BYTES - MARKER.len()) / 2;
    let head = message.floor_char_boundary(half);
    let tail = message.ceil_char_boundary(message.len() - half);
    format!("{}{MARKER}{}", &message[..head], &message[tail..])
}

/// The default naming model of an instance of `kind`, as T3 Code's: Haiku for Claude Code, and
/// GPT-6 Luna for Codex. `None` for any other kind.
fn default_model(kind: ProviderKind) -> Option<&'static str> {
    match kind {
        ProviderKind::Claude => Some("claude-haiku-4-5"),
        ProviderKind::Codex => Some("gpt-6-luna"),
        _ => None,
    }
}

/// The name from the first model that answers: `naming`'s, then the default of `backend`, the
/// thread's own instance.
async fn ask(
    daemon: &Daemon,
    prompt: &str,
    naming: ThreadNaming,
    backend: &str,
) -> Result<Name, String> {
    let dir = tempfile::Builder::new()
        .prefix("namer-")
        .tempdir_in(ensure(daemon.data_dir.temp_dir())?)
        .map_err(|error| format!("could not make a folder for the CLI: {error}"))?;
    std::fs::write(
        dir.path().join(namer::SCHEMA_FILE),
        namer::schema().to_string(),
    )
    .map_err(|error| format!("could not write the answer's schema: {error}"))?;
    let mut models = vec![(naming.backend, naming.model, naming.effort)];
    if let Some(model) = daemon.providers.kind(backend).await.and_then(default_model)
        && !models
            .iter()
            .any(|(chosen, same, _)| chosen == backend && same == model)
    {
        models.push((backend.to_owned(), model.to_owned(), Some(AgentEffort::Low)));
    }
    let mut errors = Vec::new();
    for (instance, model, effort) in models {
        let found = daemon.agents.backends().by_backend_name(&instance);
        let answer = match found.map(|(_, b)| b.namer(dir.path(), &model, effort)) {
            None => Err("isn't on this host".to_owned()),
            Some(Ok(None)) => Err("can't name threads".to_owned()),
            Some(Err(error)) => Err(error.to_string()),
            Some(Ok(Some(probe))) => namer::ask(probe, prompt, LIMIT).await,
        };
        match answer {
            Ok(name) => {
                info!(%instance, %model, "named a thread");
                return Ok(name);
            }
            Err(error) => errors.push(format!("{instance} ({model}) {error}")),
        }
    }
    Err(errors.join("; "))
}

/// `dir`, created if missing.
fn ensure(dir: std::path::PathBuf) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(&dir)
        .map(|()| dir)
        .map_err(|error| format!("could not make plxd's temp folder: {error}"))
}

/// Sets thread `run_id`'s title from `name` unless it has one, and renames its branch.
async fn apply(daemon: &Arc<Daemon>, run_id: RunId, name: Name) -> Result<(), String> {
    if let Some(title) = title(&name.title) {
        daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                let id = run_id.into();
                let untitled = db
                    .get_thread(id)
                    .map_err(|e| agents::store_error(&e))?
                    .is_some_and(|row| row.fields.title.is_none());
                if untitled {
                    let update = ThreadUpdate {
                        title: Some(Some(title)),
                        ..ThreadUpdate::default()
                    };
                    let (row, _) = db
                        .update_thread(id, &update)
                        .map_err(|e| agents::store_error(&e))?;
                    let thread = thread_entry(&row)?;
                    db.stage(
                        Timestamp::now(),
                        None,
                        ParallaxEvent::ThreadUpdated { thread },
                    );
                }
                Ok(())
            })
            .await
            .map_err(|error| error.message)?;
    }
    if let Some(slug) = slug(&name.branch) {
        agents::rename_branch(daemon, run_id, slug)
            .await
            .map_err(|error| error.message)?;
    }
    Ok(())
}

/// A model's title as a thread's: its first line, without surrounding quotes, runs of spaces, or
/// trailing punctuation, cut to [`MAX_THREAD_TITLE_BYTES`]. `None` when nothing is left.
fn title(raw: &str) -> Option<String> {
    let line = raw.trim().lines().next().unwrap_or_default();
    let line = line.trim_matches(|c: char| matches!(c, '"' | '\'' | '`') || c.is_whitespace());
    let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let words = words.trim_end_matches(['.', ',', ';', ':', '!']);
    let cut = &words[..words.floor_char_boundary(MAX_THREAD_TITLE_BYTES)];
    (!cut.trim().is_empty()).then(|| cut.trim_end().to_owned())
}

/// A model's branch name as a branch slug ([`valid_branch_slug`]): its lowercase letters and
/// digits, words joined by hyphens, at most 40 bytes. `None` when it has none.
fn slug(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|word| !word.is_empty())
        .collect();
    let joined = words.join("-");
    let slug = joined[..joined.len().min(40)].trim_end_matches('-');
    valid_branch_slug(slug).then(|| slug.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{MAX_MESSAGE_BYTES, limit, slug, title};

    #[test]
    fn a_models_branch_becomes_a_slug() {
        assert_eq!(
            slug("fix/login-empty-password-crash").as_deref(),
            Some("fix-login-empty-password-crash")
        );
        assert_eq!(slug("  Add v2 API!  ").as_deref(), Some("add-v2-api"));
        assert_eq!(
            slug("a-very-long-branch-name-that-goes-on-past-forty-bytes").as_deref(),
            Some("a-very-long-branch-name-that-goes-on-pas")
        );
        assert_eq!(slug("!!!"), None);
    }

    #[test]
    fn a_models_title_is_one_clean_line() {
        assert_eq!(
            title("\"Fix  empty password crash.\"\nmore").as_deref(),
            Some("Fix empty password crash")
        );
        assert_eq!(title("  \n"), None);
    }

    #[test]
    fn a_long_message_keeps_its_start_and_end() {
        let message = format!("start {} end", "é".repeat(MAX_MESSAGE_BYTES));
        let limited = limit(&message);
        assert!(limited.len() <= MAX_MESSAGE_BYTES, "{}", limited.len());
        assert!(limited.starts_with("start "));
        assert!(limited.ends_with(" end"));
        assert!(limited.contains("[Content truncated]"));
        assert_eq!(limit("short"), "short");
    }
}
