//! Permission requests, behind the `approvals` capability (PLX-222, decision 0031).
//!
//! A run whose CLI would ask before a tool call (Claude Code in Manual, Auto, or Plan) asks the
//! app instead of denying it, when the client started it with `approvals`. The request is an
//! `approvalRequested` item in the run's transcript, `agent/approve` answers it, and an
//! `approvalResolved` item says how it ended: the user's answer, a timeout, a cancel, a stop, or
//! the CLI no longer asking.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::RunId;
use crate::id::uuid_v7_id;

uuid_v7_id! {
    /// A permission request's id: a version 7 UUID that plxd generates when a run's CLI asks.
    /// `approvalRequested` carries it, and `agent/approve` and `approvalResolved` name it.
    ApprovalId
}

/// The user's answer to a permission request.
///
/// A newer peer may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentApprovalAnswer {
    /// Run the tool call.
    Allow,
    /// Don't run it.
    Deny,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// What a permission request came to.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentApprovalDecision {
    /// The tool call may run.
    Allowed,
    /// It may not: the user said no, or the run was cancelled or stopped while it waited.
    Denied,
    /// Nobody answered before `expiresAt`, so plxd denied it.
    Expired,
    /// The CLI stopped waiting for an answer, because its turn was interrupted or it exited.
    Withdrawn,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Who or what decided a permission request.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentApprovalBy {
    /// The user, through `agent/approve`.
    User,
    /// plxd, once the request expired.
    Timeout,
    /// `agent/cancel`, or `thread/delete`, stopping the run.
    Cancel,
    /// plxd stopping.
    Stop,
    /// The run's CLI.
    Agent,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `agent/approve`: the user's answer to a run's permission request, from its
/// `approvalRequested`.
///
/// Idempotent: answering a request that is already resolved changes nothing, and returns how it
/// was resolved, which may be another answer, a timeout, or a cancel. A run started without
/// `approvals` has no requests, so any answer for it fails with `approvalNotFound`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproveParams {
    /// The run.
    pub run_id: RunId,
    /// The request.
    pub approval_id: ApprovalId,
    /// Allow or deny.
    pub decision: AgentApprovalAnswer,
    /// With `allow`: the tool's input to run with instead of the one it asked with, a JSON
    /// object of the same shape, at most 1 MiB. Absent runs it as asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<Value>,
    /// With `allow`: also allow what the request's `alwaysAllow` lists, for the rest of the CLI
    /// process. Only for a request whose `alwaysAllow` isn't empty.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always: bool,
    /// With `deny`: what to tell the agent, at most 64 KiB. Absent says that the user denied it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
}

/// Result of `agent/approve`: how the request was resolved, as its `approvalResolved` says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproveResult {
    /// What it came to.
    pub decision: AgentApprovalDecision,
    /// Who or what decided it: `user` when this answer, or an earlier one, did.
    pub by: AgentApprovalBy,
    /// True when it was allowed for the rest of the CLI process as well.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always: bool,
    /// The user's message to the agent with a denial.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision, AgentApproveParams};
    use crate::{AgentRun, ThreadStartParams};

    #[test]
    fn unknown_values_decode_as_unknown() {
        assert_eq!(
            serde_json::from_value::<AgentApprovalAnswer>(json!("ask")).unwrap(),
            AgentApprovalAnswer::Unknown
        );
        assert_eq!(
            serde_json::from_value::<AgentApprovalDecision>(json!("deferred")).unwrap(),
            AgentApprovalDecision::Unknown
        );
        assert_eq!(
            serde_json::from_value::<AgentApprovalBy>(json!("policy")).unwrap(),
            AgentApprovalBy::Unknown
        );
    }

    #[test]
    fn a_plain_answer_leaves_out_what_it_does_not_use() {
        let params: AgentApproveParams = serde_json::from_value(json!({
            "runId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01",
            "approvalId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e09",
            "decision": "allow",
        }))
        .unwrap();
        assert_eq!(params.decision, AgentApprovalAnswer::Allow);
        assert!(!params.always);
        let value = serde_json::to_value(&params).unwrap();
        assert!(value.get("always").is_none());
        assert!(value.get("input").is_none());
        assert!(value.get("message").is_none());
    }

    /// An older client never sends `approvals`, so its runs keep denying what would prompt.
    #[test]
    fn a_start_asks_for_approvals_only_when_it_says_so() {
        let older: ThreadStartParams = serde_json::from_value(json!({
            "runId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01",
            "prompt": "Fix the flaky test.",
        }))
        .unwrap();
        assert!(!older.approvals);
        assert!(
            serde_json::to_value(&older)
                .unwrap()
                .get("approvals")
                .is_none()
        );
        let newer = ThreadStartParams {
            approvals: true,
            ..older
        };
        assert_eq!(serde_json::to_value(&newer).unwrap()["approvals"], true);
    }

    /// A client reads whether a run asks from the run itself, and an older plxd's run, which
    /// never says, doesn't.
    #[test]
    fn a_run_says_whether_it_asks_only_when_it_does() {
        let older = json!({
            "id": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01",
            "project": "01a0d349-6e00-7c9e-80e2-0426486a8cae",
            "prompt": "Fix the flaky test.",
            "policy": "workspaceWrite",
            "status": "running",
            "backend": "claude",
            "accountId": "claude",
            "createdAt": "2026-10-01T12:00:00Z",
            "updatedAt": "2026-10-01T12:00:01Z",
        });
        let run: AgentRun = serde_json::from_value(older.clone()).unwrap();
        assert!(!run.approvals);
        assert_eq!(serde_json::to_value(&run).unwrap(), older);
        let asking = AgentRun {
            approvals: true,
            ..run
        };
        assert_eq!(serde_json::to_value(&asking).unwrap()["approvals"], true);
    }
}
