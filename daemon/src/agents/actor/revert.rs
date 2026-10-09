//! `checkpoint.rollback` (0062) in a thread's actor, which runs it between its other commands so
//! no turn starts meanwhile. Every check comes first, in [`crate::checkpoints::plan_revert`],
//! then T3 Code's order: the provider drops the later turns, then the files and refs go back.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AgentRun, ErrorKind};
use tracing::info;

use super::Actor;
use crate::backend::Rewind;
use crate::checkpoints;

impl Actor {
    /// Reverts the thread to the checkpoint after run `ordinal`, with its files when
    /// `restore_files`.
    pub(super) async fn revert(
        &mut self,
        ordinal: u32,
        restore_files: bool,
    ) -> Result<AgentRun, ErrorObject> {
        let refused = |why: String| ErrorObject::parallax(ErrorKind::RevertRefused, why);
        if self.accepted() {
            return Err(crate::agents::run_accepted(self.id));
        }
        if self.busy() {
            return Err(refused(format!(
                "thread {} is still running; revert once its turn ends",
                self.id
            )));
        }
        self.effect_busy(ErrorKind::RevertRefused)?;
        // The turn that just ended commits, and enqueues its capture, before the checks.
        self.flush().await;
        let name = self.row.fields.backend.clone();
        let backend = self
            .daemon
            .agents
            .backends()
            .by_backend_name(&name)
            .map(|(_, backend)| backend);
        let can_rewind = backend
            .as_ref()
            .is_some_and(|backend| backend.capabilities().rewind);
        let plan = checkpoints::plan_revert(
            &self.daemon,
            self.id,
            ordinal,
            restore_files,
            &name,
            can_rewind,
        )
        .await?;
        if plan.turns > 0 {
            let (Some(backend), Some(session_id)) = (backend, self.row.state.session_id.clone())
            else {
                return Err(refused(format!(
                    "thread {} has no session to rewind",
                    self.id
                )));
            };
            // The provider rewinds a conversation no process holds.
            if self.live.is_some() {
                self.end_session().await;
            }
            let rewind = Rewind {
                session_id,
                cwd: plan.cwd().to_owned(),
                turns: plan.turns,
            };
            let session = backend.rewind(rewind).await.map_err(|why| {
                ErrorObject::internal_error(format!("{name} could not rewind the thread: {why}"))
            })?;
            info!(run = %self.id, turns = plan.turns, "rewound a thread's conversation");
            if self.row.state.session_id.as_ref() != Some(&session) {
                self.row.state.session_id = Some(session);
                self.save().await;
            }
        }
        checkpoints::finish_revert(&self.daemon, plan).await?;
        self.snapshot()
    }
}
