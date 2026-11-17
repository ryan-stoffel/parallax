//! GitHub, through the computer's `gh` (0050), as plxd runs it elsewhere: outside any repository,
//! with prompts off, and with plxd's own `gh` on `PATH` after the user's. Reads go through
//! `gh api graphql`, whose quota is apart from REST's, and they spend the quota agents share
//! (0086). Issue ids are `owner/repo#12`.

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    Issue, IssueComment, IssueContainer, IssueDetail, IssueProvider, IssueState, IssueStateCategory,
};
use serde::Deserialize;
use serde_json::Value;

use super::{GITHUB, TIMEOUT, failed, parse};
use crate::backend::process::{Launcher, StdinMode};
use crate::detect::{probe_spec, run_spec};

/// `gh`'s exit code when it isn't signed in.
const AUTH_REQUIRED: i32 = 4;

const ISSUE_FIELDS: &str = "fragment IssueFields on Issue {
    number title url state stateReason updatedAt
    repository { nameWithOwner }
    assignees(first: 1) { nodes { login } }
}";

/// The open issues assigned to the viewer, most recently updated first.
pub(super) async fn list(launcher: &Launcher) -> Result<Vec<Issue>, ErrorObject> {
    let answer = gh(launcher, &list_args(), None).await?;
    crate::gh_shim::record_graphql(launcher.data_dir(), &answer);
    list_of(&answer)
}

/// Issue `id` with its body and comments.
pub(super) async fn get(launcher: &Launcher, id: &str) -> Result<IssueDetail, ErrorObject> {
    let answer = gh(launcher, &get_args(id)?, None).await?;
    detail_of(&answer)
}

/// The viewer's repositories with issues on, most recently pushed first.
pub(super) async fn containers(launcher: &Launcher) -> Result<Vec<IssueContainer>, ErrorObject> {
    let query = "query { viewer { repositories(first: 100, \
                 orderBy: { field: PUSHED_AT, direction: DESC }, \
                 ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) \
                 { nodes { nameWithOwner hasIssuesEnabled isArchived } } } }";
    let answer = gh(launcher, &graphql_args(query, &[]), None).await?;
    containers_of(&answer)
}

/// Files an issue in `repo`, assigned to the viewer.
pub(super) async fn create(
    launcher: &Launcher,
    repo: &str,
    title: &str,
    body: &str,
) -> Result<Issue, ErrorObject> {
    let created = gh(launcher, &create_args(repo, title)?, Some(body)).await?;
    // gh prints the new issue's URL last.
    let number = created
        .trim()
        .rsplit_once("/issues/")
        .and_then(|(_, number)| number.parse::<u64>().ok())
        .ok_or_else(|| failed("gh filed the issue but didn't say where."))?;
    Ok(get(launcher, &format!("{repo}#{number}")).await?.issue)
}

/// Opens issue `id` again, or closes it as completed or not planned.
pub(super) async fn set_state(
    launcher: &Launcher,
    id: &str,
    state: &str,
) -> Result<Issue, ErrorObject> {
    gh(launcher, &state_args(id, state)?, None).await?;
    Ok(get(launcher, id).await?.issue)
}

/// Comments on issue `id`.
pub(super) async fn comment(
    launcher: &Launcher,
    id: &str,
    body: &str,
) -> Result<IssueComment, ErrorObject> {
    #[derive(Deserialize)]
    struct Posted {
        node_id: String,
        user: Option<Login>,
        body: String,
        created_at: Timestamp,
    }
    let answer = gh(launcher, &comment_args(id)?, Some(body)).await?;
    let created: Posted = parse("GitHub", &answer)?;
    Ok(IssueComment {
        id: created.node_id,
        author: created.user.map(|user| user.login).unwrap_or_default(),
        body: created.body,
        created_at: created.created_at,
    })
}

/// `gh api graphql` with `query` and `fields`, each a flag (`-f` for text, `-F` for a number)
/// and its `key=value`.
fn graphql_args(query: &str, fields: &[(&str, String)]) -> Vec<String> {
    let mut args = vec![
        "api".to_owned(),
        "graphql".to_owned(),
        "-f".to_owned(),
        format!("query={query}"),
    ];
    for (flag, field) in fields {
        args.extend([(*flag).to_owned(), field.clone()]);
    }
    args
}

/// The search for the viewer's open issues.
fn list_args() -> Vec<String> {
    let query = format!(
        "query($q: String!) {{ rateLimit {{ remaining resetAt }} \
         search(query: $q, type: ISSUE, first: 100) {{ nodes {{ ...IssueFields }} }} }} \
         {ISSUE_FIELDS}"
    );
    let search = "is:issue is:open assignee:@me archived:false sort:updated-desc";
    graphql_args(&query, &[("-f", format!("q={search}"))])
}

fn get_args(id: &str) -> Result<Vec<String>, ErrorObject> {
    let (owner, name, number) = parts(id)?;
    let query = format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ \
         repository(owner: $owner, name: $name) {{ issue(number: $number) {{ ...IssueFields body \
         comments(first: 100) {{ nodes {{ id body createdAt author {{ login }} }} }} }} }} }} \
         {ISSUE_FIELDS}"
    );
    Ok(graphql_args(
        &query,
        &[
            ("-f", format!("owner={owner}")),
            ("-f", format!("name={name}")),
            ("-F", format!("number={number}")),
        ],
    ))
}

/// `gh issue create` in `repo`, assigned to the viewer, with the body on stdin. Values go as
/// `--flag=value`, so none is read as a flag.
fn create_args(repo: &str, title: &str) -> Result<Vec<String>, ErrorObject> {
    if !repo
        .split_once('/')
        .is_some_and(|(owner, name)| is_name(owner) && is_name(name))
    {
        return Err(ErrorObject::invalid_params(format!(
            "{repo:?} is not a GitHub repository"
        )));
    }
    Ok(vec![
        "issue".to_owned(),
        "create".to_owned(),
        format!("--repo={repo}"),
        format!("--title={title}"),
        "--body-file=-".to_owned(),
        "--assignee=@me".to_owned(),
    ])
}

/// `gh issue reopen` or `gh issue close` with its reason, for `state`.
fn state_args(id: &str, state: &str) -> Result<Vec<String>, ErrorObject> {
    let (owner, name, number) = parts(id)?;
    let (verb, reason) = match state {
        "open" => ("reopen", None),
        "completed" => ("close", Some("--reason=completed")),
        "notPlanned" => ("close", Some("--reason=not planned")),
        _ => {
            return Err(ErrorObject::invalid_params(format!(
                "{state:?} is not open, completed, or notPlanned"
            )));
        }
    };
    let mut args = vec![
        "issue".to_owned(),
        verb.to_owned(),
        number.to_string(),
        format!("--repo={owner}/{name}"),
    ];
    args.extend(reason.map(str::to_owned));
    Ok(args)
}

/// `gh api` posting a comment whose body is on stdin.
fn comment_args(id: &str) -> Result<Vec<String>, ErrorObject> {
    let (owner, name, number) = parts(id)?;
    Ok(vec![
        "api".to_owned(),
        "--method=POST".to_owned(),
        format!("repos/{owner}/{name}/issues/{number}/comments"),
        "-F".to_owned(),
        "body=@-".to_owned(),
    ])
}

/// `owner/repo#12`'s parts.
fn parts(id: &str) -> Result<(&str, &str, u64), ErrorObject> {
    let found = || {
        let (repo, number) = id.split_once('#')?;
        let (owner, name) = repo.split_once('/')?;
        (is_name(owner) && is_name(name)).then_some((owner, name, number.parse().ok()?))
    };
    found().ok_or_else(|| ErrorObject::invalid_params(format!("{id:?} is not owner/repo#number")))
}

/// Whether `part` can be a GitHub owner's or repository's name.
fn is_name(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.starts_with('-')
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Runs `gh args`, with `input` on stdin: its stdout.
async fn gh(
    launcher: &Launcher,
    args: &[String],
    input: Option<&str>,
) -> Result<String, ErrorObject> {
    let mut spec = probe_spec("gh");
    spec.args = args.iter().map(Into::into).collect();
    spec.inject.set("GH_PROMPT_DISABLED", "1");
    if input.is_some() {
        spec.stdin = StdinMode::Piped;
    }
    let ran = run_spec(launcher, &spec, input.unwrap_or("").as_bytes(), TIMEOUT)
        .await
        .map_err(|error| failed(format!("Couldn't run gh: {error}.")))?;
    match ran.exit_code {
        Some(0) => Ok(ran.stdout),
        Some(AUTH_REQUIRED) => Err(failed(
            "gh is signed out on this computer. Sign in to GitHub in Settings.",
        )),
        _ => Err(failed(format!(
            "GitHub refused: {}",
            crate::github::last_line(&ran.stderr_tail)
        ))),
    }
}

/// The `data` of a GraphQL answer, or its first error.
fn data_of<T: serde::de::DeserializeOwned>(answer: &str) -> Result<T, ErrorObject> {
    #[derive(Deserialize)]
    struct Answer<T> {
        data: Option<T>,
        #[serde(default)]
        errors: Vec<Message>,
    }
    #[derive(Deserialize)]
    struct Message {
        message: String,
    }
    let answer: Answer<T> = parse("GitHub", answer)?;
    match (answer.data, answer.errors.into_iter().next()) {
        (Some(data), _) => Ok(data),
        (None, Some(error)) => Err(failed(format!("GitHub answered: {}", error.message))),
        (None, None) => Err(failed("GitHub answered with no data.")),
    }
}

/// A search's issues. A node that isn't an issue is skipped.
fn list_of(answer: &str) -> Result<Vec<Issue>, ErrorObject> {
    #[derive(Deserialize)]
    struct Data {
        search: Nodes<Value>,
    }
    let data: Data = data_of(answer)?;
    Ok(data
        .search
        .nodes
        .into_iter()
        .filter_map(|node| serde_json::from_value::<GhIssue>(node).ok())
        .map(GhIssue::into_issue)
        .collect())
}

fn detail_of(answer: &str) -> Result<IssueDetail, ErrorObject> {
    #[derive(Deserialize)]
    struct Data {
        repository: Option<Repository>,
    }
    #[derive(Deserialize)]
    struct Repository {
        issue: Option<Detail>,
    }
    #[derive(Deserialize)]
    struct Detail {
        #[serde(flatten)]
        issue: GhIssue,
        body: String,
        comments: Nodes<Comment>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Comment {
        id: String,
        body: String,
        created_at: Timestamp,
        author: Option<Login>,
    }
    let data: Data = data_of(answer)?;
    let detail = data
        .repository
        .and_then(|repository| repository.issue)
        .ok_or_else(|| failed("GitHub has no such issue."))?;
    let states = [
        ("open", "Open", IssueStateCategory::Todo),
        ("completed", "Closed", IssueStateCategory::Done),
        ("notPlanned", "Not planned", IssueStateCategory::Canceled),
    ]
    .map(|(id, name, category)| IssueState {
        id: id.to_owned(),
        name: name.to_owned(),
        category,
        color: None,
    });
    Ok(IssueDetail {
        issue: detail.issue.into_issue(),
        body: detail.body,
        comments: detail
            .comments
            .nodes
            .into_iter()
            .map(|comment| IssueComment {
                id: comment.id,
                // A deleted account is `ghost` on GitHub.
                author: comment
                    .author
                    .map_or_else(|| "ghost".to_owned(), |author| author.login),
                body: comment.body,
                created_at: comment.created_at,
            })
            .collect(),
        states: states.into(),
    })
}

fn containers_of(answer: &str) -> Result<Vec<IssueContainer>, ErrorObject> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }
    #[derive(Deserialize)]
    struct Viewer {
        repositories: Nodes<Repository>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Repository {
        name_with_owner: String,
        has_issues_enabled: bool,
        is_archived: bool,
    }
    let data: Data = data_of(answer)?;
    Ok(data
        .viewer
        .repositories
        .nodes
        .into_iter()
        .filter(|repo| repo.has_issues_enabled && !repo.is_archived)
        .map(|repo| IssueContainer {
            id: repo.name_with_owner.clone(),
            name: repo.name_with_owner,
        })
        .collect())
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameWithOwner {
    name_with_owner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssue {
    number: u64,
    title: String,
    url: String,
    state: String,
    state_reason: Option<String>,
    updated_at: Timestamp,
    repository: NameWithOwner,
    assignees: Nodes<Login>,
}

impl GhIssue {
    fn into_issue(self) -> Issue {
        let state = match (self.state.as_str(), self.state_reason.as_deref()) {
            ("OPEN", _) => ("open", "Open", IssueStateCategory::Todo),
            (_, Some("NOT_PLANNED" | "DUPLICATE")) => {
                ("notPlanned", "Not planned", IssueStateCategory::Canceled)
            }
            _ => ("completed", "Closed", IssueStateCategory::Done),
        };
        let repo = self.repository.name_with_owner;
        Issue {
            connection_id: GITHUB.to_owned(),
            provider: IssueProvider::Github,
            id: format!("{repo}#{}", self.number),
            key: format!("#{}", self.number),
            title: self.title,
            url: self.url,
            state: IssueState {
                id: state.0.to_owned(),
                name: state.1.to_owned(),
                category: state.2,
                color: None,
            },
            container: IssueContainer {
                id: repo.clone(),
                name: repo,
            },
            assignee: self.assignees.nodes.into_iter().next().map(|a| a.login),
            updated_at: self.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::IssueStateCategory;
    use serde_json::json;

    use super::{
        comment_args, containers_of, create_args, detail_of, get_args, list_args, list_of, parts,
        state_args,
    };

    /// The arguments for each `gh` call: values as GraphQL variables or `--flag=value`, and bodies
    /// on stdin, never in the arguments.
    #[test]
    fn gh_arguments() {
        let list = list_args();
        assert_eq!(list[..3], ["api", "graphql", "-f"]);
        assert!(list[3].starts_with("query=query($q: String!)"));
        assert_eq!(
            list[4..],
            [
                "-f",
                "q=is:issue is:open assignee:@me archived:false sort:updated-desc"
            ]
        );

        let get = get_args("octo/hello#12").unwrap();
        assert_eq!(
            get[4..],
            ["-f", "owner=octo", "-f", "name=hello", "-F", "number=12"]
        );

        assert_eq!(
            create_args("octo/hello", "--help me").unwrap(),
            [
                "issue",
                "create",
                "--repo=octo/hello",
                "--title=--help me",
                "--body-file=-",
                "--assignee=@me"
            ]
        );
        assert!(create_args("octo", "T").is_err());

        assert_eq!(
            state_args("octo/hello#12", "open").unwrap(),
            ["issue", "reopen", "12", "--repo=octo/hello"]
        );
        assert_eq!(
            state_args("octo/hello#12", "completed").unwrap(),
            [
                "issue",
                "close",
                "12",
                "--repo=octo/hello",
                "--reason=completed"
            ]
        );
        assert_eq!(
            state_args("octo/hello#12", "notPlanned").unwrap(),
            [
                "issue",
                "close",
                "12",
                "--repo=octo/hello",
                "--reason=not planned"
            ]
        );
        assert!(state_args("octo/hello#12", "closed").is_err());

        assert_eq!(
            comment_args("octo/hello#12").unwrap(),
            [
                "api",
                "--method=POST",
                "repos/octo/hello/issues/12/comments",
                "-F",
                "body=@-"
            ]
        );
    }

    fn issue_json(number: u64, state: &str, reason: Option<&str>) -> serde_json::Value {
        json!({
            "number": number,
            "title": "Crash on start",
            "url": format!("https://github.com/octo/hello/issues/{number}"),
            "state": state,
            "stateReason": reason,
            "updatedAt": "2026-11-17T12:00:00Z",
            "repository": { "nameWithOwner": "octo/hello" },
            "assignees": { "nodes": [{ "login": "octocat" }] }
        })
    }

    /// A search's issues read as `owner/repo#N`; a node that isn't an issue is skipped.
    #[test]
    fn github_search_results_parse() {
        let answer = json!({ "data": {
            "rateLimit": { "remaining": 4999, "resetAt": "2026-11-17T13:00:00Z" },
            "search": { "nodes": [issue_json(12, "OPEN", None), {}] }
        } });
        let issues = list_of(&answer.to_string()).unwrap();
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(
            (
                issue.id.as_str(),
                issue.key.as_str(),
                issue.container.id.as_str()
            ),
            ("octo/hello#12", "#12", "octo/hello")
        );
        assert_eq!(
            (issue.state.id.as_str(), issue.state.category),
            ("open", IssueStateCategory::Todo)
        );
        assert_eq!(issue.assignee.as_deref(), Some("octocat"));
    }

    /// An issue reads with its body and comments, and the three states GitHub has.
    #[test]
    fn a_github_issue_reads_with_comments_and_states() {
        let mut issue = issue_json(12, "CLOSED", Some("NOT_PLANNED"));
        issue["body"] = json!("It crashes.");
        issue["comments"] = json!({ "nodes": [
            { "id": "IC_1", "body": "Same here.", "createdAt": "2026-11-17T12:05:00Z",
              "author": { "login": "hubot" } },
            { "id": "IC_2", "body": "Gone.", "createdAt": "2026-11-17T12:06:00Z", "author": null }
        ] });
        let answer = json!({ "data": { "repository": { "issue": issue } } });
        let detail = detail_of(&answer.to_string()).unwrap();
        assert_eq!(detail.body, "It crashes.");
        assert_eq!(
            (detail.issue.state.id.as_str(), detail.issue.state.category),
            ("notPlanned", IssueStateCategory::Canceled)
        );
        let comments: Vec<_> = detail
            .comments
            .iter()
            .map(|c| (c.id.as_str(), c.author.as_str()))
            .collect();
        assert_eq!(comments, [("IC_1", "hubot"), ("IC_2", "ghost")]);
        let states: Vec<_> = detail.states.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(states, ["open", "completed", "notPlanned"]);
    }

    #[test]
    fn a_github_error_answer_is_its_message() {
        let answer = json!({ "data": { "repository": null }, "errors": [
            { "type": "NOT_FOUND", "message": "Could not resolve to a Repository with the name 'octo/gone'." }
        ] });
        let error = detail_of(&answer.to_string()).unwrap_err();
        assert_eq!(error.message, "GitHub has no such issue.");
        let answer = json!({ "errors": [{ "message": "Bad credentials" }] });
        assert_eq!(
            detail_of(&answer.to_string()).unwrap_err().message,
            "GitHub answered: Bad credentials"
        );
    }

    /// Only repositories with issues on and not archived can take an issue.
    #[test]
    fn github_containers_are_repositories_with_issues() {
        let answer = json!({ "data": { "viewer": { "repositories": { "nodes": [
            { "nameWithOwner": "octo/hello", "hasIssuesEnabled": true, "isArchived": false },
            { "nameWithOwner": "octo/off", "hasIssuesEnabled": false, "isArchived": false },
            { "nameWithOwner": "octo/old", "hasIssuesEnabled": true, "isArchived": true }
        ] } } } });
        let containers = containers_of(&answer.to_string()).unwrap();
        let names: Vec<_> = containers.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(names, ["octo/hello"]);
    }

    #[test]
    fn a_github_issue_id_is_owner_repo_and_number() {
        assert_eq!(parts("octo/hello#12").unwrap(), ("octo", "hello", 12));
        assert_eq!(parts("octo/.github#1").unwrap(), ("octo", ".github", 1));
        for bad in [
            "octo/hello",
            "octo#12",
            "-x/hello#1",
            "octo/..#1",
            "octo/hello#x",
            "a/b/c#1",
        ] {
            assert!(parts(bad).is_err(), "{bad:?}");
        }
    }
}
