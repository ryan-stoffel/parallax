//! Git commits between two plxds (0057), behind the `peerGit` capability: a run's branch goes
//! from the device to the home plxd with `bundle/prepare`, `bundle/read`, and `bundle/drop`, and
//! an integration tip comes back with `bundle/begin`, `bundle/write`, and `bundle/apply`, as a git
//! bundle file in 1 MiB chunks of base64, at most 64 MiB, checked with its SHA-256. Then
//! `git/startMerge` starts a conflict merge in the run's worktree.
//!
//! Only a run id and hex object ids come from the caller. plxd reads the branch and repository
//! from the run and builds every ref name itself.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;
use crate::id::uuid_v7_id;

uuid_v7_id! {
    /// A bundle file's id on the plxd that holds it: a version 7 UUID that `bundle/prepare` or
    /// `bundle/begin` generates.
    BundleId
}

/// Params of `bundle/prepare`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundlePrepareParams {
    /// The run whose branch to bundle. It must have a worktree.
    pub run: RunId,
    /// Commits the receiver already has, as full hex object ids, left out of the bundle. At most
    /// 256. Each must be in the run's repository.
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// Result of `bundle/prepare`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundlePrepareResult {
    /// The branch's tip when the bundle was made. A branch that moves later doesn't change it.
    pub tip: String,
    /// The bundle, or absent when `exclude` already has `tip`, so there is nothing to send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bundle: Option<BundleFile>,
}

/// A bundle file `bundle/prepare` made. It is removed by `bundle/drop`, or 10 minutes after it
/// was last read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    /// Its id, for `bundle/read` and `bundle/drop`.
    pub id: BundleId,
    /// Its size in bytes.
    pub size: u64,
    /// The SHA-256 of its bytes, in lowercase hex.
    pub sha256: String,
}

/// Params of `bundle/read`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleReadParams {
    /// The bundle.
    pub id: BundleId,
    /// Where to start reading, in bytes.
    pub offset: u64,
    /// How many bytes to read, at most 1 MiB.
    pub length: u64,
}

/// Result of `bundle/read`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleReadResult {
    /// The bytes, in standard base64 with padding. Past the end is empty.
    pub data: String,
}

/// Params of `bundle/drop`: removes a bundle file of either direction. An unknown id changes
/// nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleDropParams {
    /// The bundle.
    pub id: BundleId,
}

/// Params of `bundle/begin`: opens an empty bundle file for `bundle/write` to fill.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleBeginParams {
    /// The run whose repository the bundle goes into. It must have a worktree.
    pub run: RunId,
    /// The bundle's size in bytes, at most 64 MiB.
    pub size: u64,
    /// The SHA-256 of its bytes, in lowercase hex, which `bundle/apply` checks.
    pub sha256: String,
}

/// Result of `bundle/begin`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleBeginResult {
    /// The new file's id, for `bundle/write` and `bundle/apply`. A file that isn't written to for
    /// 10 minutes is removed.
    pub id: BundleId,
}

/// Params of `bundle/write`: appends a chunk to a file `bundle/begin` opened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleWriteParams {
    /// The bundle.
    pub id: BundleId,
    /// Where the chunk starts, which must be the length written so far.
    pub offset: u64,
    /// The chunk, at most 1 MiB, in standard base64 with padding.
    pub data: String,
}

/// Params of `bundle/apply`: checks a written bundle and fetches its one ref into the run's
/// repository as `refs/parallax-sync/<run id>`, the only ref it writes. The file is removed
/// either way.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleApplyParams {
    /// The bundle, fully written.
    pub id: BundleId,
    /// The commit its ref must point at, as a full hex object id.
    pub tip: String,
}

/// Params of `git/startMerge`: starts merging `tip` into the run's worktree, leaving conflict
/// markers for the run to resolve, as a landing conflict does for a local child (0045). Refused
/// with `runBusy` while the run is starting or running.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStartMergeParams {
    /// The run.
    pub run: RunId,
    /// The commit to merge, as a full hex object id, already in the run's repository.
    pub tip: String,
}

/// The empty result of `bundle/drop`, `bundle/write`, `bundle/apply`, and `git/startMerge`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BundleOkResult {}
