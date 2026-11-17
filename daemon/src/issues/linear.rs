//! Linear, through its GraphQL API with a personal API key, which goes in `Authorization` with no
//! `Bearer`. Issue ids are Linear's UUIDs, and containers are the viewer's teams.

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    Issue, IssueComment, IssueContainer, IssueDetail, IssueProvider, IssueState, IssueStateCategory,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{failed, request};
use crate::backend::process::Launcher;

const URL: &str = "https://api.linear.app/graphql";

/// The issue fields every query reads.
const ISSUE_FIELDS: &str = "fragment IssueFields on Issue {
    id identifier title url updatedAt
    state { id name type color }
    team { id name }
    assignee { name }
}";

/// A Linear connection and its API key.
pub(super) struct Linear {
    pub(super) id: String,
    pub(super) key: Zeroizing<String>,
}

/// Checks `key` with Linear: who it signs in as, and the workspace's name.
pub(super) async fn check(launcher: &Launcher, key: &str) -> Result<(String, String), ErrorObject> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }
    #[derive(Deserialize)]
    struct Viewer {
        name: String,
        organization: Named,
    }
    let data: Data = graphql(
        launcher,
        key,
        "query { viewer { id name organization { name } } }",
        json!({}),
        false,
    )
    .await?;
    Ok((data.viewer.name, data.viewer.organization.name))
}

impl Linear {
    /// The open issues assigned to the viewer, most recently updated first.
    pub(super) async fn list(&self, launcher: &Launcher) -> Result<Vec<Issue>, ErrorObject> {
        let query = format!(
            "query {{ viewer {{ assignedIssues(first: 100, orderBy: updatedAt, \
             filter: {{ state: {{ type: {{ nin: [\"completed\", \"canceled\"] }} }} }}) \
             {{ nodes {{ ...IssueFields }} }} }} }} {ISSUE_FIELDS}"
        );
        let data: Value = self.query(launcher, &query, json!({})).await?;
        list_of(&self.id, data)
    }

    /// Issue `id` with its description, comments, and its team's states.
    pub(super) async fn get(
        &self,
        launcher: &Launcher,
        id: &str,
    ) -> Result<IssueDetail, ErrorObject> {
        let query = format!(
            "query($id: String!) {{ issue(id: $id) {{ ...IssueFields description \
             comments(first: 100) {{ nodes {{ id body createdAt user {{ name }} botActor {{ name }} }} }} \
             team {{ states {{ nodes {{ id name type color position }} }} }} }} }} {ISSUE_FIELDS}"
        );
        let data: Value = self.query(launcher, &query, json!({ "id": id })).await?;
        detail_of(&self.id, data)
    }

    /// The viewer's teams.
    pub(super) async fn containers(
        &self,
        launcher: &Launcher,
    ) -> Result<Vec<IssueContainer>, ErrorObject> {
        #[derive(Deserialize)]
        struct Data {
            viewer: TeamsOf,
        }
        #[derive(Deserialize)]
        struct TeamsOf {
            teams: Nodes<Team>,
        }
        let data: Data = self
            .query(
                launcher,
                "query { viewer { teams(first: 100) { nodes { id name } } } }",
                json!({}),
            )
            .await?;
        Ok(data
            .viewer
            .teams
            .nodes
            .into_iter()
            .map(|team| IssueContainer {
                id: team.id,
                name: team.name,
            })
            .collect())
    }

    /// Files an issue in team `team`, assigned to the viewer.
    pub(super) async fn create(
        &self,
        launcher: &Launcher,
        team: &str,
        title: &str,
        body: &str,
    ) -> Result<Issue, ErrorObject> {
        #[derive(Deserialize)]
        struct Data {
            viewer: Id,
        }
        let viewer: Data = self
            .query(launcher, "query { viewer { id } }", json!({}))
            .await?;
        let mut input = json!({ "teamId": team, "title": title, "assigneeId": viewer.viewer.id });
        if !body.is_empty() {
            input["description"] = json!(body);
        }
        let query = format!(
            "mutation($input: IssueCreateInput!) {{ issueCreate(input: $input) \
             {{ issue {{ ...IssueFields }} }} }} {ISSUE_FIELDS}"
        );
        let data: Value = self
            .query(launcher, &query, json!({ "input": input }))
            .await?;
        self.issue_in(&data["issueCreate"]["issue"])
    }

    /// Moves issue `id` to workflow state `state`.
    pub(super) async fn set_state(
        &self,
        launcher: &Launcher,
        id: &str,
        state: &str,
    ) -> Result<Issue, ErrorObject> {
        let query = format!(
            "mutation($id: String!, $state: String!) {{ issueUpdate(id: $id, \
             input: {{ stateId: $state }}) {{ issue {{ ...IssueFields }} }} }} {ISSUE_FIELDS}"
        );
        let data: Value = self
            .query(launcher, &query, json!({ "id": id, "state": state }))
            .await?;
        self.issue_in(&data["issueUpdate"]["issue"])
    }

    /// Comments on issue `id`.
    pub(super) async fn comment(
        &self,
        launcher: &Launcher,
        id: &str,
        body: &str,
    ) -> Result<IssueComment, ErrorObject> {
        let data: Value = self
            .query(
                launcher,
                "mutation($input: CommentCreateInput!) { commentCreate(input: $input) \
                 { comment { id body createdAt user { name } botActor { name } } } }",
                json!({ "input": { "issueId": id, "body": body } }),
            )
            .await?;
        let comment: Comment = serde_json::from_value(data["commentCreate"]["comment"].clone())
            .map_err(|_| unreadable())?;
        Ok(comment.into())
    }

    fn issue_in(&self, issue: &Value) -> Result<Issue, ErrorObject> {
        let issue: LinearIssue = serde_json::from_value(issue.clone()).map_err(|_| unreadable())?;
        Ok(issue.into_issue(&self.id))
    }

    async fn query<T: DeserializeOwned>(
        &self,
        launcher: &Launcher,
        query: &str,
        variables: Value,
    ) -> Result<T, ErrorObject> {
        graphql(launcher, &self.key, query, variables, true).await
    }
}

/// Runs `query` with `variables` as `key`: its `data`. `saved` says the key was saved, so a
/// refusal tells the user to connect again.
async fn graphql<T: DeserializeOwned>(
    launcher: &Launcher,
    key: &str,
    query: &str,
    variables: Value,
    saved: bool,
) -> Result<T, ErrorObject> {
    let body = json!({ "query": query, "variables": variables });
    let answer = request(launcher, "Linear", "POST", URL, key, Some(&body)).await?;
    let parsed: Option<Response<T>> = serde_json::from_str(&answer.body).ok();
    let error = parsed
        .as_ref()
        .and_then(|response| response.errors.first())
        .map(|error| {
            let message = error
                .extensions
                .as_ref()
                .and_then(|e| e.user_presentable_message.clone())
                .unwrap_or_else(|| error.message.clone());
            let auth = error
                .extensions
                .as_ref()
                .and_then(|e| e.code.as_deref())
                .is_some_and(|code| code == "AUTHENTICATION_ERROR");
            (message, auth)
        });
    let refused = matches!(answer.status, 401 | 403) || error.as_ref().is_some_and(|e| e.1);
    if refused {
        let reason = error.map(|e| format!(": {}", e.0)).unwrap_or_default();
        return Err(failed(if saved {
            format!(
                "Linear refused the API key{reason}. Connect it again in Settings › Issue trackers."
            )
        } else {
            format!("Linear refused the API key{reason}.")
        }));
    }
    if let Some((message, _)) = error {
        return Err(failed(format!("Linear answered: {message}")));
    }
    if !answer.ok() {
        return Err(failed(format!("Linear answered HTTP {}.", answer.status)));
    }
    parsed
        .and_then(|response| response.data)
        .ok_or_else(unreadable)
}

fn unreadable() -> ErrorObject {
    failed("Linear answered in a way plxd can't read.")
}

/// `viewer.assignedIssues`' issues.
fn list_of(connection: &str, data: Value) -> Result<Vec<Issue>, ErrorObject> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        viewer: Assigned,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Assigned {
        assigned_issues: Nodes<LinearIssue>,
    }
    let data: Data = serde_json::from_value(data).map_err(|_| unreadable())?;
    Ok(data
        .viewer
        .assigned_issues
        .nodes
        .into_iter()
        .map(|issue| issue.into_issue(connection))
        .collect())
}

/// `issue`'s detail: comments oldest first, and its team's states in their workflow's order.
fn detail_of(connection: &str, data: Value) -> Result<IssueDetail, ErrorObject> {
    #[derive(Deserialize)]
    struct Data {
        issue: Option<Detail>,
    }
    #[derive(Deserialize)]
    struct Detail {
        #[serde(flatten)]
        issue: LinearIssue,
        description: Option<String>,
        comments: Nodes<Comment>,
    }
    let data: Data = serde_json::from_value(data).map_err(|_| unreadable())?;
    let detail = data
        .issue
        .ok_or_else(|| failed("Linear has no such issue."))?;
    let mut comments: Vec<IssueComment> =
        detail.comments.nodes.into_iter().map(Into::into).collect();
    comments.sort_by_key(|comment| comment.created_at);
    let mut issue = detail.issue;
    let mut states = issue
        .team
        .states
        .take()
        .map(|states| states.nodes)
        .unwrap_or_default();
    states.sort_by(|a, b| a.position.total_cmp(&b.position));
    Ok(IssueDetail {
        issue: issue.into_issue(connection),
        body: detail.description.unwrap_or_default(),
        comments,
        states: states.into_iter().map(State::into_state).collect(),
    })
}

#[derive(Deserialize)]
struct Response<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
    extensions: Option<Extensions>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extensions {
    code: Option<String>,
    user_presentable_message: Option<String>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct Team {
    id: String,
    name: String,
    /// Read by `issue/get` only.
    states: Option<Nodes<State>>,
}

#[derive(Deserialize)]
struct State {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    color: Option<String>,
    #[serde(default)]
    position: f64,
}

impl State {
    fn into_state(self) -> IssueState {
        let category = match self.kind.as_str() {
            "backlog" | "triage" => IssueStateCategory::Backlog,
            "started" => IssueStateCategory::InProgress,
            "completed" => IssueStateCategory::Done,
            "canceled" => IssueStateCategory::Canceled,
            _ => IssueStateCategory::Todo,
        };
        IssueState {
            id: self.id,
            name: self.name,
            category,
            color: self.color,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearIssue {
    id: String,
    identifier: String,
    title: String,
    url: String,
    updated_at: Timestamp,
    state: State,
    team: Team,
    assignee: Option<Named>,
}

impl LinearIssue {
    fn into_issue(self, connection: &str) -> Issue {
        Issue {
            connection_id: connection.to_owned(),
            provider: IssueProvider::Linear,
            id: self.id,
            key: self.identifier,
            title: self.title,
            url: self.url,
            state: self.state.into_state(),
            container: IssueContainer {
                id: self.team.id,
                name: self.team.name,
            },
            assignee: self.assignee.map(|assignee| assignee.name),
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    id: String,
    body: String,
    created_at: Timestamp,
    user: Option<Named>,
    bot_actor: Option<Named>,
}

impl From<Comment> for IssueComment {
    fn from(comment: Comment) -> Self {
        Self {
            id: comment.id,
            author: comment
                .user
                .or(comment.bot_actor)
                .map_or_else(|| "Linear".to_owned(), |named| named.name),
            body: comment.body,
            created_at: comment.created_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::IssueStateCategory;
    use serde_json::json;

    use super::{detail_of, list_of};

    /// An assigned issue reads with its state's category and color, its team, and its assignee.
    #[test]
    fn linear_assigned_issues_parse() {
        let data = json!({ "viewer": { "assignedIssues": { "nodes": [{
            "id": "9c675a02-3529-4cfb-8496-cc7e462c12c1",
            "identifier": "ENG-12",
            "title": "Show issues in Parallax",
            "url": "https://linear.app/acme/issue/ENG-12/show-issues-in-parallax",
            "updatedAt": "2026-11-17T12:00:00.000Z",
            "state": { "id": "s1", "name": "In Progress", "type": "started", "color": "#f2c94c" },
            "team": { "id": "t1", "name": "Engineering" },
            "assignee": { "name": "Ada Lovelace" }
        }, {
            "id": "b2", "identifier": "ENG-13", "title": "Triage me",
            "url": "https://linear.app/acme/issue/ENG-13", "updatedAt": "2026-11-16T12:00:00.000Z",
            "state": { "id": "s0", "name": "Triage", "type": "triage", "color": "#fc7840" },
            "team": { "id": "t1", "name": "Engineering" },
            "assignee": null
        }] } } });
        let issues = list_of("conn", data).unwrap();
        assert_eq!(issues.len(), 2);
        let issue = &issues[0];
        assert_eq!(
            (
                issue.key.as_str(),
                issue.connection_id.as_str(),
                issue.container.name.as_str()
            ),
            ("ENG-12", "conn", "Engineering")
        );
        assert_eq!(issue.state.category, IssueStateCategory::InProgress);
        assert_eq!(issue.state.color.as_deref(), Some("#f2c94c"));
        assert_eq!(issue.assignee.as_deref(), Some("Ada Lovelace"));
        assert_eq!(issues[1].state.category, IssueStateCategory::Backlog);
        assert_eq!(issues[1].assignee, None);
    }

    /// An issue's comments come oldest first and its team's states in workflow order.
    #[test]
    fn a_linear_issue_reads_with_comments_and_states() {
        let data = json!({ "issue": {
            "id": "i1", "identifier": "ENG-12", "title": "T",
            "url": "https://linear.app/acme/issue/ENG-12", "updatedAt": "2026-11-17T12:00:00.000Z",
            "state": { "id": "s1", "name": "Todo", "type": "unstarted", "color": "#e2e2e2" },
            "team": { "id": "t1", "name": "Engineering", "states": { "nodes": [
                { "id": "s3", "name": "Done", "type": "completed", "color": "#5e6ad2", "position": 3.0 },
                { "id": "s1", "name": "Todo", "type": "unstarted", "color": "#e2e2e2", "position": 1.0 },
                { "id": "s4", "name": "Canceled", "type": "canceled", "color": "#95a2b3", "position": 4.0 }
            ] } },
            "assignee": { "name": "Ada" },
            "description": "Do **it**.",
            "comments": { "nodes": [
                { "id": "c2", "body": "Second", "createdAt": "2026-11-17T12:10:00.000Z",
                  "user": null, "botActor": { "name": "GitHub" } },
                { "id": "c1", "body": "First", "createdAt": "2026-11-17T12:05:00.000Z",
                  "user": { "name": "Ada" }, "botActor": null }
            ] }
        } });
        let detail = detail_of("conn", data).unwrap();
        assert_eq!(detail.body, "Do **it**.");
        assert_eq!(detail.issue.state.category, IssueStateCategory::Todo);
        let comments: Vec<_> = detail
            .comments
            .iter()
            .map(|c| (c.author.as_str(), c.body.as_str()))
            .collect();
        assert_eq!(comments, [("Ada", "First"), ("GitHub", "Second")]);
        let states: Vec<_> = detail
            .states
            .iter()
            .map(|s| (s.id.as_str(), s.category))
            .collect();
        assert_eq!(
            states,
            [
                ("s1", IssueStateCategory::Todo),
                ("s3", IssueStateCategory::Done),
                ("s4", IssueStateCategory::Canceled)
            ]
        );
    }
}
