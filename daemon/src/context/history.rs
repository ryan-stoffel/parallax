//! An orchestrator's history (0044, PLX-407): `history/<run id>.md` in its folder, one per child,
//! which plxd writes each time the child's CLI ends, from the run's row and last result, as 0025's
//! wake-up summaries are. A child resumed later rewrites its own. The orchestrator reads one with
//! `memory_read`. It costs no tokens. History counts toward the bulk cap, not the 20 MiB one
//! (PLX-941).

use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::{AgentOutcome, AgentRun, ContextWriteId, InboxKind, ScopeId};
use tracing::warn;

use super::memory::one_line;
use crate::methods::context::{pruned_item, write_context_file};
use crate::server::Daemon;

/// The most of a child's task, and of its last result or error, a history file keeps.
const TASK_BYTES: usize = 1024;
const RESULT_BYTES: usize = 8 * 1024;

/// Writes `run`'s history file in `project`'s folder for how its CLI ended, and reports the
/// change itself: `history/` is created by this write, and the watcher can miss a file written
/// into a folder before its watch is added. It deletes the oldest artifacts first when history
/// and artifacts would pass their cap, with a `needsYou` inbox item, and a failure adds a
/// `failed` one: the child's end doesn't wait on it.
pub(crate) async fn write(
    daemon: &Arc<Daemon>,
    project: ScopeId,
    run: &AgentRun,
    outcome: &AgentOutcome,
) {
    let blocking = Arc::clone(daemon);
    let path = format!("history/{}.md", run.id);
    let text = render(run, outcome);
    let id = run.id;
    let written = tokio::task::spawn_blocking(move || {
        let dir = super::ensure_dir(&blocking.data_dir, project).map_err(|e| e.to_string())?;
        let pruned = super::make_room(&dir, &path, text.len() as u64)
            .map_err(|e| e.to_string())?
            .ok_or("history and artifacts are over 2 GiB")?;
        let written = write_context_file(
            &blocking,
            project,
            &path,
            &text,
            None,
            ContextWriteId::generate(),
        );
        Ok::<_, String>((pruned, written.map_err(|e| e.message)))
    })
    .await;
    let error = match written {
        Ok(Ok((pruned, written))) => {
            pruned_item(daemon, project, id, &pruned).await;
            match written {
                Ok(_) => return,
                Err(error) => error,
            }
        }
        Ok(Err(error)) => error,
        Err(error) => error.to_string(),
    };
    warn!(run = %id, %error, "could not write a child's history");
    let text = format!("Couldn't save this thread's history: {error}");
    crate::methods::inbox::add(daemon, project, id, InboxKind::Failed, text).await;
}

/// A history file: the run, its task, how it ended, its diff stats, and its last result. Each is
/// one line, since a child's words could otherwise pass for another field.
pub(crate) fn render(run: &AgentRun, outcome: &AgentOutcome) -> String {
    let (ended, result) = match outcome {
        AgentOutcome::Completed { result } => ("completed".to_owned(), result.as_deref()),
        AgentOutcome::Failed { message, .. } => {
            (format!("failed: {}", one_line(message, RESULT_BYTES)), None)
        }
        AgentOutcome::Cancelled => ("cancelled".to_owned(), None),
        AgentOutcome::Interrupted => ("interrupted".to_owned(), None),
        AgentOutcome::Unknown => ("stopped".to_owned(), None),
    };
    let changes = match (&run.diff, &run.branch) {
        (Some(diff), Some(branch)) => format!(
            "{} files (+{} -{}) on branch {}",
            diff.files,
            diff.insertions,
            diff.deletions,
            one_line(branch, TASK_BYTES)
        ),
        _ => "none committed".to_owned(),
    };
    let mut text = format!(
        "Run: {}\nTask: {}\nEnded: {ended}\nChanges: {changes}\n",
        run.id,
        one_line(&run.prompt, TASK_BYTES)
    );
    if let Some(result) = result {
        let _ = writeln!(text, "Last result: {}", one_line(result, RESULT_BYTES));
    }
    text
}
