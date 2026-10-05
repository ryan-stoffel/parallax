//! Starting a Project's child that waited to be placed (PLX-413, decision 0046): its first CLI,
//! on the account [`crate::agents::placement`] found, with the first message it was queued with.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AccountChoice, AgentRun, ErrorKind, Role};

use super::Actor;
use crate::agents::convert::WAITING;
use crate::agents::placement::Pending;
use crate::agents::{RunOptions, first_prompt, prepare};

impl Actor {
    /// Starts the waiting child on `account` with `pending`, its first message. A child that no
    /// longer waits, since a message, Resume now, or Cancel ended its wait, is left as it is. One
    /// that can't start is `failed`, saying why. One whose push or Open PR runs is refused, and
    /// stays queued for the dispatcher's next look (PLX-458).
    pub(super) async fn place(
        &mut self,
        account: AccountChoice,
        pending: Pending,
    ) -> Result<AgentRun, ErrorObject> {
        self.effect_busy(ErrorKind::RunNotResumable)?;
        let waits = self.row.state.status == WAITING
            && self.live.is_none()
            && self.row.state.session_id.is_none();
        if waits && let Err(error) = self.start_placed(account, pending).await {
            self.failed_to_start(error.message).await;
        }
        self.snapshot()
    }

    async fn start_placed(
        &mut self,
        account: AccountChoice,
        pending: Pending,
    ) -> Result<(), ErrorObject> {
        let (prepared, repo_path) = prepare(
            &self.daemon,
            self.project,
            self.id,
            Some(account),
            Role::Worker,
        )
        .await?;
        // Another instance of the same kind serves the same model, so the model goes with it.
        let backend = prepared.resolved.backend();
        let model = self.row.fields.model.clone();
        let changes = RunOptions {
            model: model.filter(|_| backend.name() != self.row.fields.backend),
            ..RunOptions::default()
        };
        self.store_options(backend, changes).await?;
        let paths = self.checkout_paths(&repo_path).await?;
        // Re-read attachments when delivery becomes possible. Older queue rows may already
        // contain an expanded prompt, so use the run's original message.
        let attached = super::super::attached::prompt(
            &self.daemon,
            self.id,
            &pending.threads,
            &self.row.fields.prompt,
        )
        .await?;
        let task = first_prompt(&attached.text, &prepared.place)?;
        self.attach(None, pending.threads);
        if self
            .launch(prepared, task, pending.images, None, None, paths)
            .await
        {
            self.record_initial_seen(attached.seen).await;
        }
        Ok(())
    }
}
