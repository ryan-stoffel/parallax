//! Permission requests a run's CLI waits on (RYA-222, decision 0031): when each one expires, and
//! how each one ended, so a resolution is logged once and `agent/approve` stays idempotent.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::time::Instant;
use wisp_protocol::{AgentApprovalBy, AgentApprovalDecision, AgentApproveResult, ApprovalId};

/// How long a permission request waits for an answer before wispd denies it.
pub(crate) const APPROVAL_TIMEOUT: Duration = Duration::from_mins(30);

/// What the agent is told when the user denies a request without a message.
pub(super) const DENIED: &str = "The user denied permission for this tool call.";

/// What the agent is told when nobody answered in time.
pub(super) const EXPIRED: &str = "Nobody answered this permission request in time, so wisp \
                                  denied it. Carry on without it if you can, and say what you \
                                  needed it for.";

/// What the agent is told when its run is cancelled or wispd stops while a request waits.
pub(super) const STOPPED: &str = "The run was stopped while this permission request waited.";

/// The input fields that name what a file tool works on: `file_path` (`Read`, `Write`, `Edit`),
/// `notebook_path` (`NotebookEdit`), and `path` (`Glob`, `Grep`). A worker's edited input must
/// keep them as the request had them (0031).
pub(super) const PATH_FIELDS: &[&str] = &["file_path", "notebook_path", "path"];

/// `ExitPlanMode`'s input field naming the plan file Claude Code writes an approved plan to
/// (RYA-243). A worker's edited input may leave it out, as a client that sends back only the
/// edited `plan` does, but may not change or add it. Claude Code 2.1.283 ignores it and writes
/// the file it chose, but that write is the CLI's own, which `--restricted` doesn't confine, so
/// wispd doesn't rely on that (0031).
pub(super) const PLAN_PATH_FIELD: &str = "planFilePath";

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
    /// The request input's [`PATH_FIELDS`] and [`PLAN_PATH_FIELD`].
    paths: Map<String, Value>,
}

/// Where a request stands.
pub(super) enum Lookup {
    /// It waits for an answer.
    Pending {
        /// An answer may give `always`.
        offers_always: bool,
        /// The request input's [`PATH_FIELDS`] and [`PLAN_PATH_FIELD`].
        paths: Map<String, Value>,
    },
    /// It ended.
    Resolved(AgentApproveResult),
    /// This actor never saw it.
    Unknown,
}

impl Approvals {
    /// Adds a request for `input` that expires at `deadline`.
    pub fn add(&mut self, id: ApprovalId, deadline: Instant, offers_always: bool, input: &Value) {
        let paths = PATH_FIELDS
            .iter()
            .chain([&PLAN_PATH_FIELD])
            .filter_map(|&field| Some((field.to_owned(), input.get(field)?.clone())))
            .collect();
        self.pending.insert(
            id,
            Pending {
                deadline,
                offers_always,
                paths,
            },
        );
    }

    pub fn lookup(&self, id: ApprovalId) -> Lookup {
        if let Some(pending) = self.pending.get(&id) {
            return Lookup::Pending {
                offers_always: pending.offers_always,
                paths: pending.paths.clone(),
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

/// Whether `edited` names another file than the request's `paths` did: by any of
/// [`PATH_FIELDS`], adding or dropping one included, or by a [`PLAN_PATH_FIELD`] that isn't the
/// request's. Leaving that one out doesn't move anything.
pub(super) fn moves_paths(paths: &Map<String, Value>, edited: &Value) -> bool {
    PATH_FIELDS
        .iter()
        .any(|&field| paths.get(field) != edited.get(field))
        || edited
            .get(PLAN_PATH_FIELD)
            .is_some_and(|plan_file| paths.get(PLAN_PATH_FIELD) != Some(plan_file))
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

    use serde_json::json;
    use tokio::time::Instant;
    use wisp_protocol::{AgentApprovalBy, AgentApprovalDecision, ApprovalId};

    use super::{Approvals, Lookup, ended, moves_paths};

    #[test]
    fn a_request_resolves_once_and_then_answers_with_how_it_ended() {
        let mut approvals = Approvals::default();
        let now = Instant::now();
        let (first, second) = (ApprovalId::generate(), ApprovalId::generate());
        approvals.add(second, now + Duration::from_mins(1), true, &json!({}));
        approvals.add(first, now + Duration::from_secs(30), false, &json!({}));
        assert_eq!(approvals.due(), Some(now + Duration::from_secs(30)));
        assert_eq!(approvals.pending(), [first, second], "oldest first");
        assert!(approvals.expired(now).is_empty());
        assert_eq!(approvals.expired(now + Duration::from_secs(30)), [first]);
        assert!(matches!(
            approvals.lookup(second),
            Lookup::Pending {
                offers_always: true,
                ..
            }
        ));

        let expired = ended(AgentApprovalDecision::Expired, AgentApprovalBy::Timeout);
        assert!(approvals.resolve(first, expired.clone()));
        let cancelled = ended(AgentApprovalDecision::Denied, AgentApprovalBy::Cancel);
        assert!(!approvals.resolve(first, cancelled), "resolved once");
        assert!(matches!(approvals.lookup(first), Lookup::Resolved(r) if r == expired));
        assert_eq!(approvals.due(), Some(now + Duration::from_mins(1)));
        assert!(matches!(
            approvals.lookup(ApprovalId::generate()),
            Lookup::Unknown
        ));
    }

    /// 0031: a worker's edit may change what a tool does, never which file it does it to.
    #[test]
    fn an_edit_that_names_another_file_moves_the_request() {
        let mut approvals = Approvals::default();
        let id = ApprovalId::generate();
        let asked = json!({"file_path": "/w/README.md", "old_string": "a", "new_string": "b"});
        approvals.add(id, Instant::now() + Duration::from_mins(1), false, &asked);
        let Lookup::Pending { paths, .. } = approvals.lookup(id) else {
            panic!("the request waits");
        };
        let kept = json!({"file_path": "/w/README.md", "old_string": "a", "new_string": "c"});
        assert!(!moves_paths(&paths, &kept));
        for moved in [
            json!({"file_path": "/etc/hosts", "old_string": "a", "new_string": "b"}),
            json!({"old_string": "a", "new_string": "b"}),
            json!({"file_path": "/w/README.md", "path": "/", "old_string": "a"}),
            json!({"file_path": "/w/README.md", "notebook_path": "/w/n.ipynb"}),
        ] {
            assert!(moves_paths(&paths, &moved), "{moved}");
        }
    }

    /// RYA-243: an edited plan may leave out `ExitPlanMode`'s `planFilePath`, as a client that
    /// sends back only the plan does, but may not name another file, whatever Claude Code does
    /// with it. Nor may an edit add one to a request that had none.
    #[test]
    fn an_edited_plan_may_drop_its_plan_file_but_not_move_it() {
        let mut approvals = Approvals::default();
        let id = ApprovalId::generate();
        let plan_file = "/Users/u/.claude/plans/plan-it-cozy-pinwheel.md";
        let asked = json!({"plan": "1. Add a README.", "planFilePath": plan_file});
        approvals.add(id, Instant::now() + Duration::from_mins(1), false, &asked);
        let Lookup::Pending { paths, .. } = approvals.lookup(id) else {
            panic!("the request waits");
        };
        for kept in [
            json!({"plan": "1. Add a README and a license."}),
            json!({"plan": "1. Add a README and a license.", "planFilePath": plan_file}),
        ] {
            assert!(!moves_paths(&paths, &kept), "{kept}");
        }
        for moved in [
            json!({"plan": "1. Add a README.", "planFilePath": "/Users/u/.zshenv"}),
            json!({"plan": "1. Add a README.", "planFilePath": null}),
        ] {
            assert!(moves_paths(&paths, &moved), "{moved}");
        }

        let bash = ApprovalId::generate();
        approvals.add(
            bash,
            Instant::now() + Duration::from_mins(1),
            false,
            &json!({"command": "ls"}),
        );
        let Lookup::Pending { paths, .. } = approvals.lookup(bash) else {
            panic!("the request waits");
        };
        let added = json!({"command": "ls", "planFilePath": "/Users/u/.zshenv"});
        assert!(moves_paths(&paths, &added));
        assert!(!moves_paths(&paths, &json!({"command": "ls -a"})));
    }
}
