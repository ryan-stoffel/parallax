//! A run waiting for its usage limit to reset (PLX-371, decision 0049): what the actor does when
//! its CLI ends `rateLimited`, when the stored timer fires, and when a client resumes, cancels,
//! or turns auto-resume off for a waiting run. The policy is [`crate::agents::resume`]'s.

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AgentFailureKind, AgentOutcome, AgentRun, ErrorKind};
use tokio::time::Instant;
use tracing::{info, warn};

use super::Actor;
use crate::agents::RunOptions;
use crate::agents::convert::{self, WAITING};
use crate::agents::resume::{self, MESSAGE};

impl Actor {
    /// When the stored timer fires: the run's `resumeAt`, while it waits and no CLI runs.
    pub(super) fn resume_due(&self) -> Option<Instant> {
        if self.row.state.status != WAITING || self.live.is_some() {
            return None;
        }
        let at = self.row.state.resume_at?;
        let left = at.duration_since(Timestamp::now());
        Some(Instant::now() + left.try_into().unwrap_or_default())
    }

    /// After a CLI ended with `outcome`, before the run is saved: a run a usage limit stopped,
    /// with auto-resume on, waits for the reset its CLI reported, or backs off without one.
    /// Any other end clears the timer and the backoff.
    pub(super) async fn after_limit(&mut self, outcome: &AgentOutcome) {
        let reset = self.resumes.take_reset();
        let limited = matches!(
            outcome,
            AgentOutcome::Failed {
                failure: AgentFailureKind::RateLimited,
                ..
            }
        );
        let state = &mut self.row.state;
        state.resume_at = None;
        if !limited {
            state.resume_tries = 0;
            return;
        }
        if !resume::enabled(&self.daemon, self.row.state.auto_resume).await {
            return;
        }
        let timing = self.daemon.agents.resume_timing();
        let (at, tries) =
            resume::schedule(reset, self.row.state.resume_tries, Timestamp::now(), timing);
        info!(run = %self.id, resume_at = %at, "a usage limit stopped a run; it resumes then");
        WAITING.clone_into(&mut self.row.state.status);
        self.row.state.resume_at = Some(at);
        self.row.state.resume_tries = tries;
    }

    /// The stored timer fired: resumes the session with [`MESSAGE`], unless auto-resume was
    /// turned off meanwhile.
    pub(super) async fn resume_when_due(&mut self) {
        if !resume::enabled(&self.daemon, self.row.state.auto_resume).await {
            info!(run = %self.id, "auto-resume is off, so a waiting run stays stopped");
            self.stop_waiting(convert::FAILED).await;
            return;
        }
        self.resume_waiting().await;
    }

    /// `agent/resumeNow`: resumes a waiting run now.
    pub(super) async fn resume_now(&mut self) -> Result<AgentRun, ErrorObject> {
        if self.row.state.status != WAITING {
            return Err(ErrorObject::parallax(
                ErrorKind::RunNotResumable,
                format!("run {} isn't waiting for a usage limit to reset", self.id),
            ));
        }
        self.resume_waiting().await;
        self.snapshot()
    }

    /// `agent/autoResume`: sets the run's override. Turning auto-resume off for a waiting run
    /// clears its timer, leaving it `failed` with its usage limit's error.
    pub(super) async fn set_auto_resume(
        &mut self,
        auto_resume: Option<bool>,
    ) -> Result<AgentRun, ErrorObject> {
        if self.row.state.auto_resume != auto_resume {
            self.row.state.auto_resume = auto_resume;
            if self.row.state.status == WAITING && !resume::enabled(&self.daemon, auto_resume).await
            {
                self.stop_waiting(convert::FAILED).await;
            } else {
                self.save().await;
            }
        }
        self.snapshot()
    }

    /// `agent/cancel` on a waiting run: it stops waiting and is `cancelled`.
    pub(super) async fn cancel_waiting(&mut self) {
        if self.row.state.status == WAITING {
            info!(run = %self.id, "cancelling a run that waited for its usage limit");
            self.stop_waiting(convert::CANCELLED).await;
        }
    }

    /// Clears the timer and the backoff, and leaves the run in `status`.
    async fn stop_waiting(&mut self, status: &str) {
        status.clone_into(&mut self.row.state.status);
        self.row.state.resume_at = None;
        self.row.state.resume_tries = 0;
        self.save().await;
    }

    /// Resumes the waiting run's session with [`MESSAGE`], as plxd's own turn. A launch clears the
    /// timer; a run that can't be resumed stops waiting, `failed`.
    async fn resume_waiting(&mut self) {
        info!(run = %self.id, "resuming a run whose usage limit reset");
        let turn = self.resumes.next();
        let resumed = self
            .resume(
                turn,
                MESSAGE.to_owned(),
                Vec::new(),
                Vec::new(),
                RunOptions::default(),
                None,
            )
            .await;
        if let Err(error) = resumed {
            warn!(run = %self.id, error = %error.message, "could not resume a run after its usage limit");
            self.row.state.error = Some(error.message);
            self.stop_waiting(convert::FAILED).await;
        }
    }
}
