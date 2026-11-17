//! Issue trackers (0107, PLX-1594), behind the `issues` capability: plxd connects to GitHub,
//! Linear, and Jira Cloud on a computer and reads and writes the issues assigned to you there.
//!
//! GitHub uses the computer's `gh` sign-in (0050) and is the connection with id `github`. A
//! Linear or Jira connection is saved by `issue/connect`, its token in the host's keystore. No
//! method returns a token.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A tracker plxd reads issues from.
///
/// A newer plxd may send a provider this version does not know; skip its connections and issues.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum IssueProvider {
    /// GitHub, through the computer's `gh`.
    Github,
    /// Linear, with a personal API key.
    Linear,
    /// Jira Cloud, with an email and an API token.
    Jira,
}

/// A tracker account plxd reads issues from on this computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueConnection {
    /// `github` for `gh`'s sign-in, else a UUID.
    pub id: String,
    /// The tracker.
    pub provider: IssueProvider,
    /// Who it is signed in as: a GitHub login, a Linear user's name, or a Jira account's email.
    pub account: String,
    /// Where: a Linear workspace's name, or a Jira site's host, such as `acme.atlassian.net`.
    /// Absent for GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub site: Option<String>,
}

/// Params of `issue/connections`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueConnectionsParams {}

/// Result of `issue/connections`: GitHub while `gh` is signed in, then every saved connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueConnectionsResult {
    /// The connections.
    pub connections: Vec<IssueConnection>,
}

/// Params of `issue/connect`: an account to save, which plxd checks with the tracker first.
/// Connecting an account already saved replaces its token.
///
/// A newer client may send a provider this version does not know; plxd refuses it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "provider",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IssueConnectParams {
    /// A Linear personal API key.
    Linear {
        /// The key, from Linear's Settings › Security & access.
        api_key: String,
    },
    /// A Jira Cloud account.
    Jira {
        /// The site, such as `acme.atlassian.net`, with or without `https://`.
        site: String,
        /// The account's email.
        email: String,
        /// An API token from id.atlassian.com.
        api_token: String,
    },
}

// Never print a token, whoever formats it.
impl std::fmt::Debug for IssueConnectParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Linear { .. } => f.debug_struct("Linear").finish_non_exhaustive(),
            Self::Jira { site, email, .. } => f
                .debug_struct("Jira")
                .field("site", site)
                .field("email", email)
                .finish_non_exhaustive(),
        }
    }
}

/// Result of `issue/connect`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueConnectResult {
    /// The saved connection.
    pub connection: IssueConnection,
}

/// Params of `issue/disconnect`: removes a saved connection and its token. `github` and an
/// unknown id change nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueDisconnectParams {
    /// The connection's id.
    pub id: String,
}

/// Result of `issue/disconnect`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueDisconnectResult {}

/// Which way an issue's state leans, across trackers.
///
/// A newer plxd may send a category this version does not know; treat it as `todo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum IssueStateCategory {
    /// Not planned yet: Linear's backlog and triage.
    Backlog,
    /// Planned, not started: GitHub's open, Linear's unstarted, Jira's To Do.
    Todo,
    /// Started.
    InProgress,
    /// Finished: GitHub's closed as completed, Linear's completed, Jira's Done.
    Done,
    /// Dropped: GitHub's closed as not planned, Linear's canceled.
    Canceled,
}

/// An issue's state, or one it can move to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueState {
    /// Its id, the same in an issue and in [`IssueDetail::states`], and what `issue/setState`
    /// takes: `open`, `completed`, or `notPlanned` on GitHub, a workflow state's id on Linear,
    /// and a status's id on Jira, which plxd moves to through the transition that leads there.
    pub id: String,
    /// Its name, such as `In Progress`.
    pub name: String,
    /// Which way it leans.
    pub category: IssueStateCategory,
    /// The tracker's color for it, as `#rrggbb`. Absent where the tracker has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
}

/// Where issues are filed: a GitHub repository, a Linear team, or a Jira project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueContainer {
    /// What `issue/create` takes: `owner/repo`, a Linear team's id, or a Jira project's key.
    pub id: String,
    /// Its name: `owner/repo`, or a Linear team's or Jira project's name.
    pub name: String,
}

/// An issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// The connection it was read through.
    pub connection_id: String,
    /// Its tracker.
    pub provider: IssueProvider,
    /// What `issue/get` and the writes take: `owner/repo#12` on GitHub, the issue's id on
    /// Linear, and its key on Jira.
    pub id: String,
    /// What people call it: `#12`, `PLX-12`, or `ABC-12`.
    pub key: String,
    /// Its title.
    pub title: String,
    /// Its page on the tracker.
    pub url: String,
    /// Its state.
    pub state: IssueState,
    /// Where it is filed.
    pub container: IssueContainer,
    /// Who it is assigned to, by name. Absent while it is unassigned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub assignee: Option<String>,
    /// When it last changed.
    pub updated_at: Timestamp,
}

/// Params of `issue/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueListParams {
    /// Only this connection's issues. Absent reads every connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connection_id: Option<String>,
}

/// A connection `issue/list` couldn't read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueConnectionError {
    /// The connection.
    pub connection_id: String,
    /// Why, for the user.
    pub message: String,
}

/// Result of `issue/list`: the open issues assigned to you, most recently updated first, up to
/// 100 per connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueListResult {
    /// The issues.
    pub issues: Vec<Issue>,
    /// The connections that failed, whose issues are missing.
    pub errors: Vec<IssueConnectionError>,
}

/// Params of `issue/get`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueGetParams {
    /// The connection.
    pub connection_id: String,
    /// The issue's [`Issue::id`].
    pub id: String,
}

/// A comment on an issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    /// The tracker's id for it.
    pub id: String,
    /// Who wrote it, by name.
    pub author: String,
    /// Its text, as Markdown.
    pub body: String,
    /// When it was written.
    pub created_at: Timestamp,
}

/// Result of `issue/get`: an issue with its body, comments, and the states it can move to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    /// The issue.
    pub issue: Issue,
    /// Its description, as Markdown. Jira's rich text is converted.
    pub body: String,
    /// Its comments, oldest first.
    pub comments: Vec<IssueComment>,
    /// The states `issue/setState` can move it to, its own included.
    pub states: Vec<IssueState>,
}

/// Params of `issue/containers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueContainersParams {
    /// The connection.
    pub connection_id: String,
}

/// Result of `issue/containers`: where you can file an issue, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueContainersResult {
    /// The repositories, teams, or projects.
    pub containers: Vec<IssueContainer>,
}

/// Params of `issue/create`: files an issue, assigned to you.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueCreateParams {
    /// The connection.
    pub connection_id: String,
    /// The [`IssueContainer::id`] to file it in.
    pub container_id: String,
    /// Its title.
    pub title: String,
    /// Its description, as Markdown. Empty leaves it blank.
    pub body: String,
}

/// Params of `issue/setState`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueSetStateParams {
    /// The connection.
    pub connection_id: String,
    /// The issue's [`Issue::id`].
    pub id: String,
    /// One of [`IssueDetail::states`]' ids.
    pub state_id: String,
}

/// Params of `issue/comment`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueCommentParams {
    /// The connection.
    pub connection_id: String,
    /// The issue's [`Issue::id`].
    pub id: String,
    /// The comment, as Markdown.
    pub body: String,
}
