//! An orchestrator's children's questions (PLX-402, decision 0043), behind the `questions`
//! capability. A child asks with `question/ask` and goes on with its assumption at once. The
//! question wakes the orchestrator, which answers it with `question/answer` or passes it to the
//! user with `question/escalate`. The user answers any question, or changes a decided one, with
//! `question/answer` and no `from`. `question/list` lists an orchestrator's questions.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::id::uuid_v7_id;
use crate::{RunId, ScopeId};

uuid_v7_id! {
    /// Identifies one question. plxd generates it.
    QuestionId
}

/// Where a question stands.
///
/// A newer plxd may send a status this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum QuestionStatus {
    /// Waiting for the orchestrator. The child went on with its assumption.
    Open,
    /// The orchestrator passed it to the user, in Needs you.
    Escalated,
    /// The orchestrator answered it for the user, who may change the answer.
    Decided,
    /// The user answered it.
    Answered,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A question a child asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The question's id.
    pub id: QuestionId,
    /// The child that asked it.
    pub run: RunId,
    /// The question.
    pub question: String,
    /// What the child went on assuming.
    pub assumption: String,
    /// Where it stands.
    pub status: QuestionStatus,
    /// The orchestrator's or the user's answer. Absent while `open` or `escalated`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer: Option<String>,
    /// When the child asked it, in RFC 3339 UTC.
    pub created_at: Timestamp,
}

/// Params of `question/ask`. Fails with `invalidParams` unless `run` is in an orchestrator and
/// isn't its orchestrator, and with `runNotFound` for an unknown run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAskParams {
    /// The child asking.
    pub run: RunId,
    /// The question, at most 4 KiB.
    pub question: String,
    /// What the child goes on assuming until it hears otherwise, at most 4 KiB.
    pub assumption: String,
}

/// Params of `question/answer`. With `from`, the orchestrator's current orchestrator answers an
/// `open` question, which becomes `decided`; otherwise it fails with `invalidParams`. Without
/// `from`, the user answers any question, which becomes `answered`. The child gets the answer as a
/// queued message when it differs from what it was last told: its assumption, or the decided answer
/// the user changes. Fails with `invalidParams` for an unknown question, or one whose child is
/// gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswerParams {
    /// The question.
    pub question: QuestionId,
    /// The answer, at most 4 KiB.
    pub text: String,
    /// The orchestrator's run, when it answers. Absent for the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<RunId>,
}

/// Params of `question/escalate`: the orchestrator's current orchestrator passes an `open` question
/// to the user, adding a `needsYou` inbox item. Fails with `invalidParams` from any other run or
/// for a question that isn't open or is unknown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionEscalateParams {
    /// The question.
    pub question: QuestionId,
    /// The orchestrator's run.
    pub from: RunId,
}

/// Result of `question/ask`, `question/answer`, and `question/escalate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResult {
    /// The question as it stands.
    pub question: Question,
}

/// Params of `question/list`. Fails with `orchestratorNotFound` for an unknown orchestrator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionListParams {
    /// The Orchestrator.
    #[serde(alias = "project")]
    pub orchestrator: ScopeId,
}

/// Result of `question/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionListResult {
    /// Every question, oldest first.
    pub questions: Vec<Question>,
}
