//! A Project's history (0044, PLX-407): `history/<run id>.md` in its folder, one per child, which
//! plxd writes each time the child's CLI ends, from the run's row and last result, as 0025's
//! wake-up summaries are. A child resumed later rewrites its own. The coordinator reads one with
//! `memory_read`. It costs no tokens.

use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::{AgentOutcome, AgentRun, ContextWriteId, ProjectId};
use tracing::warn;

use super::memory::one_line;
use crate::methods::context::write_context_file;
use crate::server::Daemon;

/// The most of a child's task, and of its last result or error, a history file keeps.
const TASK_BYTES: usize = 1024;
const RESULT_BYTES: usize = 8 * 1024;

/// Writes `run`'s history file in `project`'s folder for how its CLI ended, and reports the
/// change itself: `history/` is created by this write, and the watcher can miss a file written
/// into a folder before its watch is added. A failure is logged: the child's end doesn't wait
/// on it.
pub(crate) async fn write(
    daemon: &Arc<Daemon>,
    project: ProjectId,
    run: &AgentRun,
    outcome: &AgentOutcome,
) {
    let daemon = Arc::clone(daemon);
    let path = format!("history/{}.md", run.id);
    let text = render(run, outcome);
    let id = run.id;
    let written = tokio::task::spawn_blocking(move || {
        write_context_file(
            &daemon,
            project,
            &path,
            &text,
            None,
            ContextWriteId::generate(),
        )
    })
    .await;
    match written {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => warn!(run = %id, ?error, "could not write a child's history"),
        Err(error) => warn!(run = %id, %error, "could not write a child's history"),
    }
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
