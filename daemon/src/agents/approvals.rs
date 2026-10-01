//! Permission requests a run's CLI waits on (RYA-222, decision 0031): when each one expires, and
//! how each one ended, so a resolution is logged once and `agent/approve` stays idempotent.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use tokio::time::Instant;
use wisp_protocol::{AgentApprovalBy, AgentApprovalDecision, AgentApproveResult, ApprovalId};

/// How long a permission request waits for an answer before wispd denies it.
pub(crate) const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What the agent is told when the user denies a request without a message.
pub(super) const DENIED: &str = "The user denied permission for this tool call.";

/// What the agent is told when nobody answered in time.
pub(super) const EXPIRED: &str = "Nobody answered this permission request in time, so wisp \
                                  denied it. Carry on without it if you can, and say what you \
                                  needed it for.";

/// What the agent is told when its run is cancelled or wispd stops while a request waits.
pub(super) const STOPPED: &str = "The run was stopped while this permission request waited.";

/// One run's permission requests, as long as its actor lives.
#[derive(Default)]
pub(super) struct Approvals {
    /// The requests the CLI waits on, oldest first, since ids are version 7 UUIDs.
    pending: BTreeMap<ApprovalId, Pending>,
    resolved: HashMap<ApprovalId, AgentApproveResult>,
}

struct Pending {
    deadline: Instant,
    /// The request offers rules to always allow, so an answer may give `always`.
    offers_always: bool,
}

/// Where a request stands.
pub(super) enum Lookup {
    /// It waits for an answer.
    Pending {
        /// An answer may give `always`.
        offers_always: bool,
    },
    /// It ended.
    Resolved(AgentApproveResult),
    /// This actor never saw it.
    Unknown,
}

impl Approvals {
    /// Adds a request that expires at `deadline`.
    pub fn add(&mut self, id: ApprovalId, deadline: Instant, offers_always: bool) {
        self.pending.insert(
            id,
            Pending {
                deadline,
                offers_always,
            },
        );
    }

    pub fn lookup(&self, id: ApprovalId) -> Lookup {
        if let Some(pending) = self.pending.get(&id) {
            return Lookup::Pending {
                offers_always: pending.offers_always,
            };
        }
        self.resolved
            .get(&id)
            .map_or(Lookup::Unknown, |resolution| {
                Lookup::Resolved(resolution.clone())
            })
    }

    /// When the next request expires.
    pub fn due(&self) -> Option<Instant> {
        self.pending.values().map(|pending| pending.deadline).min()
    }

    /// The requests that have expired by `now`, oldest first.
    pub fn expired(&self, now: Instant) -> Vec<ApprovalId> {
        self.pending
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(&id, _)| id)
            .collect()
    }

    /// Every request that waits, oldest first.
    pub fn pending(&self) -> Vec<ApprovalId> {
        self.pending.keys().copied().collect()
    }

    /// Records how request `id` ended. Returns false, and changes nothing, when it isn't
    /// waiting.
    pub fn resolve(&mut self, id: ApprovalId, resolution: AgentApproveResult) -> bool {
        if self.pending.remove(&id).is_none() {
            return false;
        }
        self.resolved.insert(id, resolution);
        true
    }
}

/// A resolution that isn't the user's.
pub(super) fn ended(decision: AgentApprovalDecision, by: AgentApprovalBy) -> AgentApproveResult {
    AgentApproveResult {
        decision,
        by,
        always: false,
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::Instant;
    use wisp_protocol::{AgentApprovalBy, AgentApprovalDecision, ApprovalId};

    use super::{Approvals, Lookup, ended};

    #[test]
    fn a_request_resolves_once_and_then_answers_with_how_it_ended() {
        let mut approvals = Approvals::default();
        let now = Instant::now();
        let (first, second) = (ApprovalId::generate(), ApprovalId::generate());
        approvals.add(second, now + Duration::from_secs(60), true);
        approvals.add(first, now + Duration::from_secs(30), false);
        assert_eq!(approvals.due(), Some(now + Duration::from_secs(30)));
        assert_eq!(approvals.pending(), [first, second], "oldest first");
        assert!(approvals.expired(now).is_empty());
        assert_eq!(approvals.expired(now + Duration::from_secs(30)), [first]);
        assert!(matches!(
            approvals.lookup(second),
            Lookup::Pending {
                offers_always: true
            }
        ));

        let expired = ended(AgentApprovalDecision::Expired, AgentApprovalBy::Timeout);
        assert!(approvals.resolve(first, expired.clone()));
        let cancelled = ended(AgentApprovalDecision::Denied, AgentApprovalBy::Cancel);
        assert!(!approvals.resolve(first, cancelled), "resolved once");
        assert!(matches!(approvals.lookup(first), Lookup::Resolved(r) if r == expired));
        assert_eq!(approvals.due(), Some(now + Duration::from_secs(60)));
        assert!(matches!(
            approvals.lookup(ApprovalId::generate()),
            Lookup::Unknown
        ));
    }
}
