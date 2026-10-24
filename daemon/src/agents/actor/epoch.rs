//! A coordinator's epochs (PLX-937, decision 0079): each provider session of its run is one,
//! recorded in `coordinator_sessions`, and a new one starts from a rehydration packet
//! ([`crate::agents::packet`]) when the last can't be resumed, moves to another backend, or the
//! user asks for a fresh one. Each end adds an `epoch` item, the transcript's divider.

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AgentOutputItem, AgentRun, CoordinatorSessionEnd, ErrorKind};
use tracing::warn;

use super::Actor;
use crate::agents::{packet, store, store_error};

/// How `coordinator_sessions` stores `reason`.
fn stored(reason: CoordinatorSessionEnd) -> &'static str {
    match reason {
        CoordinatorSessionEnd::CompactedOut => "compacted-out",
        CoordinatorSessionEnd::NotResumable => parallax_store::NOT_RESUMABLE,
        CoordinatorSessionEnd::UserFresh => "user-fresh",
        CoordinatorSessionEnd::BackendChange => "backend-change",
        CoordinatorSessionEnd::Unknown => "unknown",
    }
}

impl Actor {
    /// `coordinator/fresh`: ends the coordinator's idle session and its epoch, so its next
    /// message starts the next epoch from the packet. Refused while a turn runs.
    pub(super) async fn fresh(&mut self) -> Result<AgentRun, ErrorObject> {
        if !self.is_coordinator() {
            return Err(ErrorObject::invalid_params(format!(
                "run {} isn't a Project's coordinator",
                self.id
            )));
        }
        self.effect_busy(ErrorKind::IdConflict)?;
        if self.busy() {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!(
                    "the coordinator, run {}, is running; stop it before starting a fresh session",
                    self.id
                ),
            ));
        }
        if self.live.is_some() {
            self.end_session().await;
        }
        self.end_epoch(CoordinatorSessionEnd::UserFresh).await;
        self.row.state.session_id = None;
        self.save().await;
        self.flush().await;
        self.snapshot()
    }

    /// Ends the coordinator's open epoch for `reason`, with its divider. Nothing when none is
    /// open.
    pub(super) async fn end_epoch(&mut self, reason: CoordinatorSessionEnd) {
        let run = self.row.id;
        let ended = store(&self.daemon, move |db| {
            db.end_coordinator_session(run, stored(reason))
                .map_err(|e| store_error(&e))
        })
        .await;
        match ended {
            Ok(Some(epoch)) => self.push(AgentOutputItem::Epoch { epoch, reason }).await,
            Ok(None) => {}
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not end a coordinator's epoch");
            }
        }
    }

    /// Records the session a coordinator's CLI reported: a new one ends the open epoch as not
    /// resumable, as when its resume fell back to the packet, and starts the next.
    pub(super) async fn began_session(&mut self, session_id: String) {
        if !self.is_coordinator() {
            return;
        }
        let run = self.row.id;
        let began = store(&self.daemon, move |db| {
            db.begin_coordinator_session(run, &session_id)
                .map_err(|e| store_error(&e))
        })
        .await;
        match began {
            Ok(Some((epoch, true))) => {
                let reason = CoordinatorSessionEnd::NotResumable;
                self.push(AgentOutputItem::Epoch { epoch, reason }).await;
            }
            Ok(_) => {}
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not record a coordinator's session");
            }
        }
    }

    /// `text` as the coordinator's next turn: after the Project's state again when its provider
    /// compacted the session since the last one began.
    pub(super) async fn after_compaction(&mut self, text: String) -> String {
        if !std::mem::take(&mut self.compacted) {
            return text;
        }
        let note = packet::after_compaction(&self.daemon, self.project, self.id).await;
        format!("{note}\n\n{text}")
    }

    /// The first message of the coordinator's new session: the packet, then `text`.
    pub(super) async fn packet(&self, text: &str) -> String {
        packet::packet(&self.daemon, self.project, self.id, text).await
    }
}
