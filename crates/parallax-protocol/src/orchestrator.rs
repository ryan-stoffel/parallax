use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::id::uuid_v7_id;
use crate::{AccountChoice, AgentEffort, AgentPermission, PromptImage, RunId};

uuid_v7_id! {
    /// A run's scope: an orchestrator's id, or a repo entry's for a thread's run. An orchestrator's
    /// is a version 7 UUID that the client generates once and sends again on every retry of
    /// `orchestrator/create`. Its wire name is still `project` where a field holds a scope (0093).
    ScopeId
}

/// An orchestrator thread (0093, once a Project): a long-running chat on one repository that plans
/// work and hands it to child threads, run by this plxd.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Orchestrator {
    /// The id the client chose when it created the orchestrator.
    pub id: ScopeId,
    /// The name shown in the app.
    pub name: String,
    /// The icon the user chose, behind the `orchestratorEdit` capability (PLX-227, 0032). Absent
    /// means the app's default icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<ChosenIcon>,
    /// The absolute path of the repository on this host, or empty for an orchestrator with no
    /// repo (0093), which only a client of a plxd that advertises `orchestratorThreads` makes.
    pub repo_path: String,
    /// The branch checked out in the repository, or the first 7 digits of the commit when `HEAD`
    /// is detached, read when plxd sends the orchestrator. Absent when plxd can't read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
    /// The run of its chat, the newest one `orchestrator/start` started (0024). Its transcript,
    /// messages, and Stop go through `agent/*` like any run's. Was `coordinator` (0093).
    #[serde(
        default,
        alias = "coordinator",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub run: Option<RunId>,
    /// The permission mode its run and every child start in (0042), behind the
    /// `orchestratorPermission` capability. Absent only from an older plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<OrchestratorPermission>,
    /// Who answers its children's questions (0043), behind the `orchestratorAutonomy` capability.
    /// Absent only from an older plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub autonomy: Option<OrchestratorAutonomy>,
    /// The branch its integration branch is cut from and its PR targets (0045), behind the
    /// `integrationBranch` capability. Absent until set, or until plxd cuts the integration branch
    /// from the repository's default branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_branch: Option<String>,
    /// Its integration branch, `parallax/<orchestrator slug>` (0045), behind `integrationBranch`.
    /// Absent until plxd cuts it, when the orchestrator is created or a run in it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub integration_branch: Option<String>,
    /// Its children land without waiting for the user's approval (0045), behind the `landing`
    /// capability. Absent means false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_land: bool,
    /// How many of its children run at once (0046), behind `orchestratorPlacement`. Over it, a new
    /// child waits in the orchestrator's queue. Absent only from an older plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_children: Option<u32>,
    /// Whether its children may run on an API key account (0046), behind `orchestratorPlacement`.
    /// Off, a child never starts on one, nor falls back to one on a usage limit. Absent only from
    /// an older plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allow_api_keys: Option<bool>,
    /// The command plxd runs in the integration worktree after each landing (0045), behind the
    /// `checks` capability: through `sh -c` (`cmd /C` on Windows), with a 30-minute limit. Absent
    /// means none, so a clean merge is enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checks: Option<String>,
    /// The checks command the orchestrator proposed, behind `checks`. It never runs: the user
    /// confirms it, or another, by setting `checks`. Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proposed_checks: Option<String>,
    /// The Tailscale node ID of the Connect device its children run on (0057), one of the
    /// tailnet devices `connect/devices` lists. Absent means this plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub computer: Option<String>,
    /// When the orchestrator was created, in RFC 3339 UTC.
    pub created_at: Timestamp,
    /// When the orchestrator last changed, in RFC 3339 UTC. `orchestrator/update` leaves it as it
    /// is, since a rename or a new icon is not activity (0032).
    pub updated_at: Timestamp,
}

/// An orchestrator's permission mode (0042): the mode its run and every child start
/// in. Each maps to the [`AgentPermission`] of the same name. A run on a backend that doesn't map
/// it is refused with `unsupportedOption`, never moved to another mode.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum OrchestratorPermission {
    /// Auto: a classifier approves or blocks each action.
    Auto,
    /// Bypass Permissions: no permission checks.
    Bypass,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

impl OrchestratorPermission {
    /// The run mode it maps to, or `None` for [`OrchestratorPermission::Unknown`].
    #[must_use]
    pub fn agent(self) -> Option<AgentPermission> {
        match self {
            Self::Auto => Some(AgentPermission::Auto),
            Self::Bypass => Some(AgentPermission::Bypass),
            Self::Unknown => None,
        }
    }
}

/// An orchestrator's autonomy level (0043): who answers its children's questions. Separate from its
/// permission mode, which decides what they may run.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum OrchestratorAutonomy {
    /// Ask me: the orchestrator answers nothing. plxd refuses its `answer`, and every question
    /// goes to Needs you without waking it.
    Ask,
    /// Routine, the default: the orchestrator answers what memory or the code clearly answers.
    Routine,
    /// Full: the orchestrator answers everything it can justify.
    Full,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// An orchestrator's icon (PLX-227, 0032): a Lucide icon and a color from the app's palette, both
/// by name, and optionally an uploaded image (PLX-339, 0038). plxd stores them as the client sent
/// them and never reads them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChosenIcon {
    /// The Lucide icon's name in kebab-case, such as `rocket`: 1 to 64 characters of `a-z`, `0-9`,
    /// and `-`.
    pub name: String,
    /// The palette key of its color, such as `green`: 1 to 32 characters of `a-z`, `0-9`, and
    /// `-`. Absent means the app's accent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// An uploaded image the app draws instead of the glyph, behind the `iconImages` capability
    /// (0038). Its `data` is at most the capability's `maxBytes` of base64, or the request fails
    /// with `imageTooLarge`. Absent means no image, so an icon sent without one clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub image: Option<PromptImage>,
}

/// Params of `orchestrator/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorListParams {}

/// Result of `orchestrator/list`: a snapshot of every orchestrator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorListResult {
    /// Every orchestrator, oldest first.
    #[serde(alias = "projects")]
    pub orchestrators: Vec<Orchestrator>,
    /// The event log's `seq` from before the list was read. Subscribe with `after` set to it. The
    /// list may already reflect some events after it, and replaying them is harmless.
    pub seq: u64,
}

/// Params of `orchestrator/create`.
///
/// It is idempotent on `id`: if an orchestrator with that id exists, plxd returns it instead of
/// creating another, and fails with `idConflict` if `name`, `repoPath`, `icon`, `permission`,
/// `autonomy`, or a given `baseBranch` differ. A new orchestrator's `repoPath` must be the top
/// folder of a git working tree on this host, or it fails with `notARepository`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCreateParams {
    /// The new orchestrator's id, a version 7 UUID generated by the client.
    pub id: ScopeId,
    /// The name shown in the app.
    pub name: String,
    /// The absolute path of the repository on this host. Absent or empty makes an orchestrator
    /// with no repo (0093), sent only to a plxd that advertises `orchestratorThreads`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo_path: Option<String>,
    /// The orchestrator's icon, sent only to a plxd that advertises `orchestratorEdit`. Absent
    /// means the app's default icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<ChosenIcon>,
    /// The orchestrator's permission mode, sent only to a plxd that advertises
    /// `orchestratorPermission`. Absent means `auto`, the mode orchestrators from before it have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<OrchestratorPermission>,
    /// The orchestrator's autonomy level, sent only to a plxd that advertises
    /// `orchestratorAutonomy`. Absent means `routine`, the level orchestrators from before it have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub autonomy: Option<OrchestratorAutonomy>,
    /// The orchestrator's base branch (0045), sent only to a plxd that advertises
    /// `integrationBranch`: a local or remote-tracking branch, such as `main` or `origin/main`.
    /// Absent means the repository's default branch. A retry that leaves it out matches any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_branch: Option<String>,
}

/// Result of `orchestrator/create`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCreateResult {
    /// The orchestrator, new or existing.
    #[serde(alias = "project")]
    pub orchestrator: Orchestrator,
}

/// Params of `orchestrator/update`: renames an orchestrator or sets its icon, behind the
/// `orchestratorEdit` capability (PLX-227, 0032), its permission mode, behind
/// `orchestratorPermission` (0042), its autonomy level, behind `orchestratorAutonomy` (0043), its
/// base branch, behind `integrationBranch` (0045), automatic landing, behind `landing` (0045), how
/// its children are placed, behind `orchestratorPlacement` (0046), its checks, behind `checks`
/// (0045), or the computer its children run on, behind `orchestratorComputer` (0057).
///
/// A field that is absent stays as it is, and `icon` replaces the whole icon. `name` follows
/// `orchestrator/create`'s rules, and the repository can't change. A rename, a new icon, a new
/// mode, or a new level is not activity, so `updatedAt` stays as it is. Fails with
/// `orchestratorNotFound` for an unknown orchestrator. A change appends `orchestrator.updated`; an
/// update that changes nothing appends no event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorUpdateParams {
    /// The orchestrator.
    #[serde(alias = "project")]
    pub orchestrator: ScopeId,
    /// The new name. Absent keeps the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// The new icon. Absent keeps the icon, and so does `null`: an icon can't be removed (0032).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<ChosenIcon>,
    /// The new permission mode. Absent keeps the mode. Each run in the orchestrator starts its next
    /// CLI process in it, and a running CLI keeps its mode until it exits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<OrchestratorPermission>,
    /// The new autonomy level. Absent keeps it. It applies to the next question: one already
    /// waiting for the orchestrator stays with it, though in `ask` plxd refuses its answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub autonomy: Option<OrchestratorAutonomy>,
    /// The new base branch, behind `integrationBranch`. Absent keeps it. An integration branch
    /// already cut stays where it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_branch: Option<String>,
    /// Turns automatic landing on or off, behind `landing` (0045). Absent keeps it. Children
    /// already waiting for approval keep waiting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_land: Option<bool>,
    /// How many children may run at once, from 1 to 100, behind `orchestratorPlacement`. Absent
    /// keeps it. Children already running keep running, and a higher number starts waiting ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_children: Option<u32>,
    /// Whether children may run on an API key account, behind `orchestratorPlacement`. Absent keeps
    /// it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allow_api_keys: Option<bool>,
    /// The checks command the user confirms or edits, behind `checks` (0045): at most 4,096
    /// bytes. Empty clears it, and setting it clears `proposedChecks`. Absent keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checks: Option<String>,
    /// The orchestrator's proposal for `checks`, behind `checks`, which adds a `needsYou` item
    /// naming it and never runs. Empty clears it. Ignored when `checks` is set too. Absent keeps
    /// it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proposed_checks: Option<String>,
    /// The Tailscale node ID of the device its children run on, behind `orchestratorComputer`
    /// (0057). Empty clears it, so they run on this plxd. Absent keeps it. The node has to be one
    /// of `connect/devices`' tailnet devices, online or not, and the repository needs an `origin`
    /// for the device to find its copy. A plxd without `orchestratorComputer` refuses it with
    /// `unsupportedOption`. Children already started keep their computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub computer: Option<String>,
}

/// Result of `orchestrator/update`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorUpdateResult {
    /// The orchestrator as it stands after the update.
    #[serde(alias = "project")]
    pub orchestrator: Orchestrator,
}

/// Params of `orchestrator/start`: starts the orchestrator chat (0024), behind the
/// `orchestrator` capability.
///
/// The orchestrator is a run with policy `noWrite` in the orchestrator's repository, whose
/// `orchestratorThread` is its own id. Later messages, Stop, and its transcript go through
/// `agent/send`, `agent/cancel`, and `agent/events`, and its events are the orchestrator's
/// `agent.*` events. Idempotent on `runId` like `agent/start`: the same params return the run, and
/// different ones fail with `idConflict`. An orchestrator is its newest one, which
/// `Orchestrator.orchestrator` names. A new `runId` starts over: it replaces the orchestrator
/// unless that one is starting or running, when it fails with `idConflict`. So an orchestrator
/// whose session can't be resumed never locks its orchestrator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStartParams {
    /// The orchestrator.
    #[serde(alias = "project")]
    pub orchestrator: ScopeId,
    /// The orchestrator run's id, a version 7 UUID generated by the client.
    pub run_id: RunId,
    /// The user's first message.
    pub prompt: String,
    /// The account to run on. Absent means the orchestrator role's default
    /// (`accounts/defaults/*`). Only a backend that can coordinate takes it: Claude Code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
    /// The model, as `agent/start`'s. Absent means the CLI's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// How hard the model thinks, as `agent/start`'s. Absent means the CLI's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<AgentEffort>,
    /// Ignored: the orchestrator runs in the orchestrator's permission mode (0042).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<AgentPermission>,
    /// Images for the first message, as `agent/start`'s.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<PromptImage>,
    /// Ignored: plxd starts the orchestrator as if it were set, as it does every orchestrator
    /// child, since the inbox answers its permission requests (0042).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approvals: bool,
}

/// Params of `orchestrator/fresh`: ends an orchestrator session, so its next message
/// starts a new one from the orchestrator's state (PLX-937, decision 0079), behind the
/// `orchestratorEpochs` capability.
///
/// The orchestrator stays the same run and thread. plxd ends its idle CLI, ends its epoch as
/// `userFresh`, and adds an `epoch` item to its transcript. Its next message starts the next epoch
/// from a rehydration packet. Fails with `orchestratorNotFound` for an unknown orchestrator,
/// `runNotFound` for one with no orchestrator, and `idConflict` while the orchestrator is starting
/// or running.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorFreshParams {
    /// The orchestrator.
    #[serde(alias = "project")]
    pub orchestrator: ScopeId,
}

/// Params of `orchestrator/fromThreads`: makes an orchestrator from threads (0042), behind the
/// `orchestratorFromThreads` capability.
///
/// Each thread must be on the same repo entry and have its own worktree, so a thread on the scratch
/// entry, one in the user's checkout, one whose worktree `agent/accept` removed, or one already in
/// an orchestrator fails with `invalidParams`, as do threads on two repo entries. A thread whose
/// kind has no `permission` in an orchestrator fails with `unsupportedOption`. An unknown thread
/// fails with `threadNotFound`.
///
/// plxd creates the orchestrator on the threads' repository as `orchestrator/create` does, starts
/// its orchestrator as `orchestrator/start` does, with a first message asking it to read the
/// threads and propose the brief with `memory_propose` for the user to save, and makes each thread
/// the orchestrator's child. When the orchestrator can't start, plxd removes the orchestrator it
/// just created and leaves the threads as they were.
///
/// A thread keeps its history, worktree, branch, and `Thread.repo`. Its run moves to the
/// orchestrator, so its later `agent.*` events are on the orchestrator's scope, and it forwards its
/// permission requests (`approvals`) to the inbox. It takes the orchestrator as its `parent`
/// (reported as `thread.updated`), replacing any parent it had: a thread another thread started
/// stops waking that thread. It runs in the orchestrator's mode from its next CLI process.
/// Idempotent on `id` and `runId`: a retry returns the same orchestrator and run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorFromThreadsParams {
    /// The new orchestrator's id, a version 7 UUID generated by the client.
    pub id: ScopeId,
    /// The orchestrator run's id, a version 7 UUID generated by the client.
    pub run_id: RunId,
    /// The name shown in the app.
    pub name: String,
    /// The orchestrator's permission mode, which the user picked in the disclaimer.
    pub permission: OrchestratorPermission,
    /// The threads, by run id: at least one.
    pub threads: Vec<RunId>,
    /// The orchestrator's account, as `orchestrator/start`'s. Absent means the orchestrator role's
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
}

/// Result of `orchestrator/fromThreads`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorFromThreadsResult {
    /// The orchestrator, with its run.
    #[serde(alias = "project")]
    pub orchestrator: Orchestrator,
    /// The orchestrator's run.
    pub run: crate::AgentRun,
}

/// Params of `orchestrator/delete`: deletes an orchestrator with every run in it, their
/// stored events, sent turns, images, worktrees, and branches, and its shared context folder,
/// behind the `orchestratorDelete` capability (PLX-338).
///
/// Running CLIs are cancelled first, and the delete answers once they have exited, the runs' pushes
/// and Open PRs in flight have finished (PLX-458), and the orchestrator is gone, after appending
/// `orchestrator.deleted`. Deleting an orchestrator that doesn't exist, or a repo entry's id, fails
/// with `orchestratorNotFound`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDeleteParams {
    /// The orchestrator.
    #[serde(alias = "project")]
    pub orchestrator: ScopeId,
}

/// Result of `orchestrator/delete`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDeleteResult {}
