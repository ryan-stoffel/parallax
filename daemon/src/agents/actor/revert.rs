//! Durable checkpoint rollback: provider mutation runs once, then local completion is retried.
//! A backend that resumes at a cursor (Claude) changes nothing at revert time: the thread's next
//! run resumes where [`rewound`] says.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AgentRun, ErrorKind, ParallaxEvent, ThreadRun, ThreadRunStatus};
use parallax_store::OrchestrationReceipt;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::info;
use uuid::Uuid;

use super::{Actor, DiffSummary, convert};
use crate::backend::Rewind;
use crate::checkpoints;
use crate::store::store_error;
use crate::worktree::RunFolder;

/// Written before contacting the provider. An uncertain provider outcome holds the thread
/// rather than risking another relative rewind. Completed provider steps retry only local work.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Pending {
    command_id: String,
    plan: checkpoints::Revert,
    pub(super) provider_done: bool,
}

/// Where a backend with [`Capabilities::resume_at`](crate::backend::Capabilities::resume_at)
/// resumes a thread a revert went back on (0062).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Rewound {
    /// The session, at the newest kept turn's cursor.
    At(String),
    /// A new session, since the revert kept no turn.
    Restart,
}

/// Where the thread with `runs`, in session `session`, resumes after a revert: at the newest kept
/// turn's cursor in that session, when a rolled-back turn is newer, or in a new session when every
/// turn was rolled back. `None` is a plain resume, which drops nothing. It holds until a turn
/// after the revert reports its own cursor, so a CLI that failed to start resumes at the same
/// place, even after a restart. A cursor from another session, before the thread moved between
/// providers, never counts: that session's turns are already past.
pub(super) fn rewound(runs: &[ThreadRun], session: &str) -> Option<Rewound> {
    let started = || runs.iter().filter(|run| run.ordinal.is_some());
    let undone = started()
        .filter(|run| run.status == ThreadRunStatus::RolledBack)
        .filter_map(|run| run.ordinal)
        .max()?;
    if started().all(|run| run.status == ThreadRunStatus::RolledBack) {
        return Some(Rewound::Restart);
    }
    started()
        .filter(|run| run.status != ThreadRunStatus::RolledBack)
        .filter(|run| run.session_id.as_deref() == Some(session))
        .filter(|run| run.cursor.is_some())
        .max_by_key(|run| run.ordinal)
        .filter(|run| run.ordinal < Some(undone))
        .and_then(|run| run.cursor.clone())
        .map(Rewound::At)
}

impl Actor {
    /// [`rewound`] for this thread in `session`, with its logged output folded first.
    pub(super) async fn rewound(&mut self, session: &str) -> Result<Option<Rewound>, ErrorObject> {
        self.flush().await;
        let id = self.row.id;
        let runs = self
            .daemon
            .reader
            .run(&CancellationToken::new(), move |db| {
                crate::graph::runs(db, id)
            })
            .await?;
        Ok(rewound(&runs, session))
    }

    pub(super) async fn load_revert(&mut self) -> Result<(), ErrorObject> {
        let id = self.row.id;
        let pending = self
            .daemon
            .reader
            .run(&CancellationToken::new(), move |db| {
                db.checkpoint_revert(id)
                    .map_err(|error| store_error(&error))
            })
            .await?;
        self.pending_revert = pending
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(ErrorObject::internal_error)?;
        Ok(())
    }

    async fn save_revert(&mut self) -> Result<(), ErrorObject> {
        let (id, state) = (self.row.id, self.row.state.clone());
        let json = serde_json::to_string(&self.pending_revert.as_ref().expect("pending revert"))
            .map_err(ErrorObject::internal_error)?;
        self.row = self
            .write(move |db, _| {
                db.set_checkpoint_revert(id, Some(&json))
                    .map_err(|error| store_error(&error))?;
                db.update_run(id, &state)
                    .map_err(|error| store_error(&error))
            })
            .await?;
        Ok(())
    }

    /// Completes the pending local steps and stores state, graph, and receipt together.
    pub(super) async fn finish_pending_revert(&mut self) -> Result<AgentRun, ErrorObject> {
        let pending = self.pending_revert.clone().expect("pending revert");
        if !pending.provider_done {
            return Err(ErrorObject::parallax(
                ErrorKind::RevertRefused,
                "The provider's revert outcome is unknown. Check its conversation before continuing. This thread is held to avoid removing another turn.",
            ));
        }
        // Also retries persistence if the provider succeeded but its completion write failed.
        self.save_revert().await?;
        checkpoints::restore_revert(&self.daemon, &pending.plan).await?;
        if pending.plan.restore_files {
            self.commit(&format!("Revert to turn {}", pending.plan.ordinal))
                .await
                .map_err(ErrorObject::internal_error)?;
            // A crash after the commit can leave no new changes on retry. Always refresh HEAD.
            let worktree = self
                .worktree
                .as_ref()
                .ok_or_else(|| ErrorObject::internal_error("the thread's worktree is gone"))?;
            let path = std::path::Path::new(&worktree.path);
            let git_dir = std::path::Path::new(&worktree.git_dir);
            let manager = self.daemon.agents.worktrees();
            let commit = manager
                .head(RunFolder::Worktree { path, git_dir })
                .await
                .map_err(ErrorObject::internal_error)?;
            let stat = manager
                .diff_stat(path, git_dir, &worktree.base)
                .await
                .map_err(ErrorObject::internal_error)?;
            self.record_diff(DiffSummary {
                commit,
                files: stat.files,
                insertions: stat.insertions,
                deletions: stat.deletions,
            });
        }
        let (project, event) = checkpoints::finish_revert(&self.daemon, pending.plan).await?;
        let (id, run_id, state) = (self.row.id, self.id, self.row.state.clone());
        self.row = self
            .write(move |db, now| {
                let row = db
                    .update_run(id, &state)
                    .map_err(|error| store_error(&error))?;
                db.stage(now, Some(project), event);
                let seq = db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentUpdated {
                        run_id,
                        state: convert::run_state(&row),
                    },
                );
                db.set_checkpoint_revert(id, None)
                    .map_err(|error| store_error(&error))?;
                db.insert_orchestration_receipt(&OrchestrationReceipt {
                    command_id: pending.command_id,
                    thread_id: id,
                    kind: "checkpoint.rollback".to_owned(),
                    result_seq: Some(seq),
                    error: None,
                })
                .map_err(|error| store_error(&error))?;
                Ok(row)
            })
            .await?;
        self.pending_revert = None;
        self.snapshot()
    }

    /// Rewinds once, persisting completion before any file or ref mutation.
    pub(super) async fn revert(
        &mut self,
        command_id: Uuid,
        ordinal: u32,
        restore_files: bool,
    ) -> Result<AgentRun, ErrorObject> {
        let key = command_id.hyphenated().to_string();
        let completed = self
            .daemon
            .reader
            .run(&CancellationToken::new(), move |db| {
                db.orchestration_receipt(&key)
                    .map_err(|error| store_error(&error))
            })
            .await?;
        if completed.is_some() {
            return self.snapshot();
        }
        if let Some(pending) = &self.pending_revert {
            if pending.plan.ordinal != ordinal || pending.plan.restore_files != restore_files {
                return Err(ErrorObject::parallax(
                    ErrorKind::RevertRefused,
                    "Finish the pending checkpoint revert before choosing a different checkpoint.",
                ));
            }
            return self.finish_pending_revert().await;
        }
        let refused = |why: &str| ErrorObject::parallax(ErrorKind::RevertRefused, why);
        if self.accepted() {
            return Err(crate::agents::run_accepted(self.id));
        }
        if self.busy() {
            return Err(refused(
                "Interrupt the current turn before reverting checkpoints.",
            ));
        }
        self.effect_busy(ErrorKind::RevertRefused)?;
        self.flush().await;
        let name = self.row.fields.backend.clone();
        let backend = self
            .daemon
            .agents
            .backends()
            .by_backend_name(&name)
            .map(|(_, backend)| backend);
        let capabilities = backend.as_ref().map(|backend| backend.capabilities());
        let plan = checkpoints::plan_revert(
            &self.daemon,
            self.id,
            ordinal,
            restore_files,
            capabilities.unwrap_or_default(),
            self.row.state.session_id.clone(),
        )
        .await?;
        let rewind = if plan.turns > 0 {
            let session_id = self
                .row
                .state
                .session_id
                .clone()
                .ok_or_else(|| refused("This thread has no provider session to revert."))?;
            if self.live.is_some() {
                self.end_session().await;
            }
            Some(Rewind {
                session_id,
                cwd: plan.cwd().to_owned(),
                turns: plan.turns,
            })
        } else {
            None
        };
        self.pending_revert = Some(Pending {
            command_id: command_id.hyphenated().to_string(),
            plan,
            provider_done: rewind.is_none(),
        });
        if let Err(error) = self.save_revert().await {
            self.pending_revert = None;
            return Err(error);
        }
        if let Some(rewind) = rewind {
            let turns = rewind.turns;
            let session = backend
                .expect("checked rewind capability")
                .rewind(rewind)
                .await
                .map_err(|why| {
                    ErrorObject::internal_error(format!(
                        "{name} could not rewind the thread: {why}"
                    ))
                })?;
            info!(run = %self.id, turns, "rewound a thread's conversation");
            self.row.state.session_id = Some(session);
            self.pending_revert
                .as_mut()
                .expect("pending revert")
                .provider_done = true;
            self.save_revert().await?;
        }
        self.finish_pending_revert().await
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{ThreadRun, ThreadRunStatus, TurnId};

    use super::{Rewound, rewound};

    /// A started run, with the session and cursor its turn ended at, if it reported one.
    fn run(ordinal: u32, status: ThreadRunStatus, at: Option<(&str, &str)>) -> ThreadRun {
        ThreadRun {
            id: TurnId::generate(),
            status,
            ordinal: Some(ordinal),
            position: None,
            attempt: Some(1),
            text: None,
            images: 0,
            threads: Vec::new(),
            from: None,
            wake: false,
            queue_held: false,
            started_at: None,
            completed_at: None,
            checkpoint: None,
            cursor: at.map(|(_, cursor)| cursor.to_owned()),
            session_id: at.map(|(session, _)| session.to_owned()),
        }
    }

    #[test]
    fn the_next_run_resumes_where_a_revert_went_back_to_until_a_new_turn_ends() {
        use ThreadRunStatus::{Completed, Failed, RolledBack};
        let mut runs = vec![
            run(1, Completed, Some(("a", "one"))),
            run(2, Completed, Some(("a", "two"))),
        ];
        assert_eq!(rewound(&runs, "a"), None, "no revert");
        runs[1].status = RolledBack;
        assert_eq!(rewound(&runs, "a"), Some(Rewound::At("one".to_owned())));
        // A turn after it that failed before reporting a cursor changes nothing.
        runs.push(run(3, Failed, None));
        assert_eq!(rewound(&runs, "a"), Some(Rewound::At("one".to_owned())));
        // One that reported its cursor is the session's newest entry: a plain resume follows it.
        runs.push(run(4, Completed, Some(("a", "four"))));
        assert_eq!(rewound(&runs, "a"), None);
        // Back to the start, nothing is kept.
        for run in &mut runs {
            run.status = RolledBack;
        }
        assert_eq!(rewound(&runs, "a"), Some(Rewound::Restart));
    }

    /// After a revert, a thread that moved to another provider and to Claude session `b`, whose
    /// first turn reported no cursor, resumes `b` as it is: a turn without a cursor in `b` or one
    /// in another session drops nothing, and no new session loses the conversation kept so far.
    #[test]
    fn a_later_session_resumes_plainly_whatever_a_cursor_of_an_earlier_one_says() {
        use ThreadRunStatus::{Completed, Interrupted, RolledBack};
        // A Codex thread (a fork's copied run 1, then turn 2), turn 3 reverted, then Claude.
        let codex = vec![
            run(1, Completed, None),
            run(2, Completed, None),
            run(3, RolledBack, None),
            run(4, Interrupted, None),
        ];
        assert_eq!(rewound(&codex, "b"), None);
        // Claude session `a`, a revert to turn 1, then Codex, then Claude session `b`.
        let moved = vec![
            run(1, Completed, Some(("a", "one"))),
            run(2, RolledBack, Some(("a", "two"))),
            run(3, Completed, None),
            run(4, Interrupted, None),
        ];
        assert_eq!(rewound(&moved, "b"), None);
    }
}
