//! Waking a project's coordinator when runs it started finish (RYA-42, decision 0025).
//!
//! When a worker with a `coordinatorThread` ends a CLI process, [`notify`] hands a summary of it
//! to the coordinator's actor, which keeps it in [`Wakes`]. The actor sends what is waiting as one
//! turn, through the same resume as `agent/send`, once [`BATCH`] has passed since the first
//! summary arrived and its own CLI isn't running: a turn in progress gets them next. After
//! [`CAP`] wake-ups in a row with no message from the user, after the user stops the coordinator,
//! or when a wake-up can't start it, it pauses them until the user writes and reports
//! `agent.wakeupsPaused`.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;
use tracing::warn;
use uuid::Uuid;
use wisp_protocol::{AgentOutcome, AgentRun, RunId, TurnId};

use super::actor::Command;
use super::convert::{option_name, truncate};
use crate::server::Daemon;

/// How long wake-ups wait after the first arrives, so runs that finish together make one turn.
const BATCH: Duration = Duration::from_secs(2);

/// Wake-up turns a coordinator takes in a row, with no message from the user, before wispd
/// pauses them.
pub(super) const CAP: u32 = 10;

/// How much of a run's task and last message a summary quotes.
const TASK_BYTES: usize = 200;
const EXCERPT_BYTES: usize = 500;

/// A coordinator's waiting wake-ups, and how many it has taken since the user last wrote.
// ponytail: in memory, so a restart loses what is waiting, the count, and a pause; store them if
// restarts in the middle of a project start to matter (RYA-178).
#[derive(Debug, Default)]
pub(super) struct Wakes {
    waiting: Vec<String>,
    since: Option<Instant>,
    in_a_row: u32,
    paused: bool,
    /// The wake-up turn last sent, until its `turnStarted` is logged. Only one can be in flight,
    /// since none is sent while the coordinator's CLI runs.
    sent: Option<TurnId>,
}

impl Wakes {
    /// Adds a finished run's summary.
    pub fn push(&mut self, summary: String, now: Instant) {
        self.waiting.push(summary);
        self.since.get_or_insert(now);
    }

    /// When what is waiting is due, unless nothing is or wake-ups are paused.
    pub fn due(&self) -> Option<Instant> {
        self.since
            .filter(|_| !self.paused)
            .map(|since| since + BATCH)
    }

    /// The next wake-up turn's id and message, or `None` once the cap is reached. What is
    /// waiting stays until [`Wakes::delivered`].
    pub fn next(&mut self) -> Option<(TurnId, String)> {
        if self.in_a_row >= CAP {
            return None;
        }
        let turn = TurnId::generate();
        self.sent = Some(turn);
        Some((turn, message(&self.waiting)))
    }

    /// The wake-up from [`Wakes::next`] reached the coordinator's CLI: it counts against the cap,
    /// and what waited is gone.
    pub fn delivered(&mut self) {
        self.in_a_row += 1;
        self.waiting.clear();
        self.since = None;
    }

    /// The user wrote to the coordinator: the count starts over, and a pause ends.
    pub fn attended(&mut self) {
        self.in_a_row = 0;
        self.paused = false;
    }

    /// Nothing wakes the coordinator until the user writes again. Whether it wasn't paused
    /// already.
    pub fn pause(&mut self) -> bool {
        !std::mem::replace(&mut self.paused, true)
    }

    /// Drops what is waiting, for a coordinator a newer one replaced (0024).
    pub fn clear(&mut self) {
        self.waiting.clear();
        self.since = None;
    }

    /// Whether `turn` was sent as a wake-up, forgetting it.
    pub fn was_sent(&mut self, turn: TurnId) -> bool {
        self.sent.take_if(|sent| *sent == turn).is_some()
    }
}

/// Hands `summary` to coordinator `thread`'s actor, spawning one after a restart, without waiting
/// for it.
pub(super) fn notify(daemon: &Arc<Daemon>, thread: Uuid, summary: String) {
    let Ok(id) = RunId::try_from(thread) else {
        return;
    };
    let owned = Arc::clone(daemon);
    daemon.agents.tracker.spawn(async move {
        match super::actor_for(&owned, id).await {
            Ok(actor) => {
                // A closed channel is a coordinator that stopped or was deleted: nothing to wake.
                let _ = actor.send(Command::Wake(summary)).await;
            }
            Err(error) => {
                warn!(coordinator = %id, error = %error.message, "could not wake a coordinator");
            }
        }
    });
}

/// One line on how `run`'s CLI process ended: its id, task, outcome, and branch.
pub(super) fn summary(run: &AgentRun, outcome: &AgentOutcome) -> String {
    let task = run
        .prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let ended = match outcome {
        AgentOutcome::Completed {
            result: Some(result),
        } => format!("completed, saying: {}", one_line(result, EXCERPT_BYTES)),
        AgentOutcome::Completed { result: None } => "completed".to_owned(),
        AgentOutcome::Failed { failure, message } => format!(
            "failed ({}): {}",
            option_name(failure).unwrap_or_default(),
            one_line(message, EXCERPT_BYTES)
        ),
        AgentOutcome::Cancelled => "cancelled".to_owned(),
        AgentOutcome::Interrupted | AgentOutcome::Unknown => "stopped".to_owned(),
    };
    let changes = match (&run.diff, &run.branch) {
        (Some(diff), Some(branch)) => format!(
            "Branch {branch} changes {} files (+{} -{}).",
            diff.files, diff.insertions, diff.deletions
        ),
        _ => "It has committed no changes.".to_owned(),
    };
    format!(
        "- Run {} ({}): {ended}. {changes}",
        run.id,
        one_line(task, TASK_BYTES)
    )
}

/// `text` cut to about `max` bytes, on one line, so each run's summary stays one line.
fn one_line(text: &str, max: usize) -> String {
    truncate(text, max)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A wake-up turn's message: the summaries, and what to do with them.
fn message(summaries: &[String]) -> String {
    format!(
        "wisp, not the user: runs you started finished.\n\n{}\n\nReview them with agent_status \
         and agent_diff, message or start runs if more is needed, and tell the user where things \
         stand.",
        summaries.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use tokio::time::Instant;

    use super::{BATCH, CAP, Wakes};

    #[test]
    fn runs_finishing_together_make_one_turn_after_the_first_waits_its_batch() {
        let mut wakes = Wakes::default();
        assert_eq!(wakes.due(), None, "nothing waiting");
        let first = Instant::now();
        wakes.push("- Run a".to_owned(), first);
        wakes.push("- Run b".to_owned(), first + BATCH / 2);
        assert_eq!(
            wakes.due(),
            Some(first + BATCH),
            "the first one sets the time"
        );

        let (turn, message) = wakes.next().unwrap();
        assert!(message.contains("- Run a\n- Run b"), "{message}");
        assert_eq!(wakes.due(), Some(first + BATCH), "kept until delivered");
        wakes.delivered();
        assert_eq!(wakes.due(), None, "both went out in one turn");
        assert!(wakes.was_sent(turn));
        assert!(!wakes.was_sent(turn), "each turn is marked once");
    }

    #[test]
    fn the_cap_pauses_wake_ups_until_the_user_writes() {
        let mut wakes = Wakes::default();
        let now = Instant::now();
        for _ in 0..CAP {
            wakes.push("- Run".to_owned(), now);
            assert!(wakes.next().is_some());
            wakes.delivered();
        }
        wakes.push("- Run late".to_owned(), now);
        assert!(wakes.next().is_none(), "one past the cap");
        assert!(wakes.pause(), "which the actor pauses on, once");
        assert!(!wakes.pause());
        wakes.push("- Run later".to_owned(), now);
        assert_eq!(wakes.due(), None, "paused: nothing is due");

        wakes.attended();
        assert_eq!(wakes.due(), Some(now + BATCH), "what waited is due again");
        let (_, message) = wakes.next().unwrap();
        assert!(message.contains("late\n- Run later"), "{message}");
    }
}
