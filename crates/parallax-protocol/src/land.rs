//! A Project's landing queue (PLX-410, decision 0045), behind the `landing` capability: the
//! coordinator queues a finished child with its `land` tool (`land/queue`), the user approves it
//! with `land/approve` or sends it back with `land/sendBack`, and plxd squash-merges children onto
//! the Project's integration branch one at a time. What happens shows in the Project's inbox.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ProjectId, RunId};

/// Where a child is in its Project's landing queue.
///
/// A newer plxd may send a status this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LandingStatus {
    /// It waits for the user's `land/approve` or `land/sendBack`, and the inbox has a `needsYou`
    /// item for it.
    Waiting,
    /// Approved, or the Project lands automatically: it lands when its turn in the queue comes.
    Queued,
    /// Its branch conflicted with the integration branch, or the user sent it back: the child has
    /// a message saying what to do, and plxd queues it again when that turn ends.
    SentBack,
    /// Its branch is on the integration branch, and the inbox has a `done` item for it.
    Landed,
    /// It can't land without the user, such as after a second conflict, and the inbox has a
    /// `needsYou` item saying why.
    NeedsYou,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A child in its Project's landing queue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    /// The child's run.
    pub run_id: RunId,
    /// Its Project.
    pub project: ProjectId,
    /// Where it is.
    pub status: LandingStatus,
    /// When it was last queued, in RFC 3339 UTC. The queue lands the oldest first.
    pub queued_at: Timestamp,
}

/// Params of `land/queue`: queues a finished child of a Project to land on its integration
/// branch, as the coordinator's `land` tool does. It waits for the user's approval unless the
/// Project's `autoLand` is on. A child already waiting, queued, or sent back stays as it is.
///
/// Fails with `runNotFound`, or `landRefused` for a run that isn't a Project's completed child
/// with a branch, such as one started with `explore`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LandQueueParams {
    /// The child's run.
    pub run_id: RunId,
}

/// Params of `land/approve`: lands a child waiting for approval, in its turn. Fails with
/// `landRefused` unless it is `waiting`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LandApproveParams {
    /// The child's run.
    pub run_id: RunId,
}

/// Params of `land/sendBack`: sends a child waiting for approval a message from the user instead
/// of landing it. plxd queues it again, waiting for approval, when that turn ends. Fails with
/// `landRefused` unless it is `waiting`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LandSendBackParams {
    /// The child's run.
    pub run_id: RunId,
    /// What the child should change, sent as the user's message.
    pub text: String,
}

/// Result of `land/queue`, `land/approve`, and `land/sendBack`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    /// The child's landing as it stands.
    pub landing: Landing,
}
