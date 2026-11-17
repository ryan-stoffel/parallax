//! Jira Cloud, through REST v3 at `https://<site>` with basic auth from the account's email and
//! an API token. Issue ids are keys such as `ABC-12`, containers are projects, and a state an
//! issue can move to is a transition. Descriptions and comments are Atlassian Document Format,
//! converted to and from a small part of Markdown.

use data_encoding::BASE64;
use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    Issue, IssueComment, IssueContainer, IssueDetail, IssueProvider, IssueState, IssueStateCategory,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{Answer, failed, parse, request};
use crate::backend::process::Launcher;

/// What `issue/list` and the writes read of an issue.
const FIELDS: &str = "summary,status,assignee,updated,project";

/// A Jira connection and its API token.
pub(super) struct Jira {
    pub(super) id: String,
    /// The site's host, such as `acme.atlassian.net`.
    pub(super) site: String,
    pub(super) email: String,
    pub(super) token: Zeroizing<String>,
}

/// `site` as a bare host, lowercased, without `https://` or a trailing `/`.
pub(super) fn normalize_site(site: &str) -> Result<String, String> {
    let host = site.trim();
    let host = host.strip_prefix("https://").unwrap_or(host);
    let host = host.strip_suffix('/').unwrap_or(host).to_ascii_lowercase();
    let label = |label: &str| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if host.len() <= 253 && host.contains('.') && host.split('.').all(label) {
        Ok(host)
    } else {
        Err(format!(
            "{site:?} is not a Jira site; give its host, such as acme.atlassian.net"
        ))
    }
}

/// Checks the account with Jira: its email, else `email`.
pub(super) async fn check(
    launcher: &Launcher,
    site: &str,
    email: &str,
    token: &str,
) -> Result<String, ErrorObject> {
    let auth = basic(email, token);
    let url = format!("https://{site}/rest/api/3/myself");
    let answer = request(launcher, "Jira", "GET", &url, &auth, None).await?;
    if matches!(answer.status, 401 | 403) {
        return Err(failed(format!(
            "Jira refused the email and API token for {site}{}.",
            reason(&answer.body)
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )));
    }
    let myself: Myself = answered(&answer)?;
    Ok(myself
        .email_address
        .filter(|address| !address.is_empty())
        .unwrap_or_else(|| email.to_owned()))
}

impl Jira {
    /// The unfinished issues assigned to the account, most recently updated first.
    pub(super) async fn list(&self, launcher: &Launcher) -> Result<Vec<Issue>, ErrorObject> {
        let body = json!({
            "jql": "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
            "maxResults": 100,
            "fields": FIELDS.split(',').collect::<Vec<_>>(),
        });
        let found: Search = self
            .call(launcher, "POST", "/rest/api/3/search/jql", Some(&body))
            .await?;
        Ok(found
            .issues
            .into_iter()
            .map(|issue| issue.into_issue(&self.id, &self.site))
            .collect())
    }

    /// Issue `key` with its description, comments, and transitions.
    pub(super) async fn get(
        &self,
        launcher: &Launcher,
        key: &str,
    ) -> Result<IssueDetail, ErrorObject> {
        let key = issue_key(key)?;
        let path = format!("/rest/api/3/issue/{key}?fields={FIELDS},description,comment");
        let issue: Value = self.call(launcher, "GET", &path, None).await?;
        let transitions: Value = self
            .call(
                launcher,
                "GET",
                &format!("/rest/api/3/issue/{key}/transitions"),
                None,
            )
            .await?;
        detail_of(&self.id, &self.site, issue, &transitions)
    }

    /// The projects the account can see.
    pub(super) async fn containers(
        &self,
        launcher: &Launcher,
    ) -> Result<Vec<IssueContainer>, ErrorObject> {
        #[derive(Deserialize)]
        struct Page {
            values: Vec<Project>,
        }
        let page: Page = self
            .call(
                launcher,
                "GET",
                "/rest/api/3/project/search?maxResults=100",
                None,
            )
            .await?;
        Ok(page
            .values
            .into_iter()
            .map(|project| IssueContainer {
                id: project.key,
                name: project.name,
            })
            .collect())
    }

    /// Files an issue in project `project` as a Task, else its first type that isn't a sub-task,
    /// and assigns it to the account.
    pub(super) async fn create(
        &self,
        launcher: &Launcher,
        project: &str,
        title: &str,
        body: &str,
    ) -> Result<Issue, ErrorObject> {
        if !is_project_key(project) {
            return Err(ErrorObject::invalid_params(format!(
                "{project:?} is not a Jira project key"
            )));
        }
        let types: IssueTypes = self
            .call(
                launcher,
                "GET",
                &format!("/rest/api/3/issue/createmeta/{project}/issuetypes"),
                None,
            )
            .await?;
        let kind = pick_issue_type(&types.issue_types).ok_or_else(|| {
            failed(format!(
                "Jira's project {project} has no issue type plxd can file."
            ))
        })?;
        let myself: Myself = self
            .call(launcher, "GET", "/rest/api/3/myself", None)
            .await?;
        let mut fields = json!({
            "project": { "key": project },
            "issuetype": { "id": kind },
            "summary": title,
        });
        if !body.is_empty() {
            fields["description"] = markdown_to_adf(body);
        }
        let created: Created = self
            .call(
                launcher,
                "POST",
                "/rest/api/3/issue",
                Some(&json!({ "fields": fields })),
            )
            .await?;
        // Not every project's create screen has the assignee, so it's set after.
        let assignee = json!({ "accountId": myself.account_id });
        self.send(
            launcher,
            "PUT",
            &format!("/rest/api/3/issue/{}/assignee", created.key),
            Some(&assignee),
        )
        .await?;
        self.issue(launcher, &created.key).await
    }

    /// Moves issue `key` through transition `transition`.
    pub(super) async fn set_state(
        &self,
        launcher: &Launcher,
        key: &str,
        transition: &str,
    ) -> Result<Issue, ErrorObject> {
        let key = issue_key(key)?;
        let body = json!({ "transition": { "id": transition } });
        self.send(
            launcher,
            "POST",
            &format!("/rest/api/3/issue/{key}/transitions"),
            Some(&body),
        )
        .await?;
        self.issue(launcher, key).await
    }

    /// Comments on issue `key`.
    pub(super) async fn comment(
        &self,
        launcher: &Launcher,
        key: &str,
        body: &str,
    ) -> Result<IssueComment, ErrorObject> {
        let key = issue_key(key)?;
        let comment: Comment = self
            .call(
                launcher,
                "POST",
                &format!("/rest/api/3/issue/{key}/comment"),
                Some(&json!({ "body": markdown_to_adf(body) })),
            )
            .await?;
        comment.into_comment()
    }

    async fn issue(&self, launcher: &Launcher, key: &str) -> Result<Issue, ErrorObject> {
        let issue: JiraIssue = self
            .call(
                launcher,
                "GET",
                &format!("/rest/api/3/issue/{key}?fields={FIELDS}"),
                None,
            )
            .await?;
        Ok(issue.into_issue(&self.id, &self.site))
    }

    /// Sends a request to `path` and reads its answer as `T`.
    async fn call<T: DeserializeOwned>(
        &self,
        launcher: &Launcher,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, ErrorObject> {
        let answer = self.send(launcher, method, path, body).await?;
        answered(&answer)
    }

    /// Sends a request to `path`, refusing an answer that isn't a success.
    async fn send(
        &self,
        launcher: &Launcher,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Answer, ErrorObject> {
        let auth = basic(&self.email, &self.token);
        let url = format!("https://{}{path}", self.site);
        let answer = request(launcher, "Jira", method, &url, &auth, body).await?;
        let why = || {
            reason(&answer.body)
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        };
        match answer.status {
            401 => Err(failed(
                "Jira refused the email and API token. Connect it again in Settings › Issue \
                 trackers.",
            )),
            403 => Err(failed(format!(
                "Jira says this account can't do that{}.",
                why()
            ))),
            404 => Err(failed(format!("Jira can't find that{}.", why()))),
            _ if answer.ok() => Ok(answer),
            status => Err(failed(format!("Jira answered HTTP {status}{}.", why()))),
        }
    }
}

/// `Basic` auth for `email` and `token`.
fn basic(email: &str, token: &str) -> Zeroizing<String> {
    let pair = Zeroizing::new(format!("{email}:{token}"));
    Zeroizing::new(format!("Basic {}", BASE64.encode(pair.as_bytes())))
}

/// A success's body as `T`.
fn answered<T: DeserializeOwned>(answer: &Answer) -> Result<T, ErrorObject> {
    if !answer.ok() {
        return Err(failed(format!(
            "Jira answered HTTP {}{}.",
            answer.status,
            reason(&answer.body)
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )));
    }
    parse("Jira", &answer.body)
}

/// Jira's own words in an error's body: its `errorMessages` and field `errors`.
fn reason(body: &str) -> Option<String> {
    let body: Value = serde_json::from_str(body).ok()?;
    let messages = body["errorMessages"].as_array().into_iter().flatten();
    let fields = body["errors"]
        .as_object()
        .into_iter()
        .flat_map(|errors| errors.values());
    let reasons: Vec<&str> = messages.chain(fields).filter_map(Value::as_str).collect();
    (!reasons.is_empty()).then(|| reasons.join(" "))
}

/// `key` if it is an issue key, such as `ABC-12`.
fn issue_key(key: &str) -> Result<&str, ErrorObject> {
    let valid = key.rsplit_once('-').is_some_and(|(project, number)| {
        is_project_key(project) && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
    });
    if valid {
        Ok(key)
    } else {
        Err(ErrorObject::invalid_params(format!(
            "{key:?} is not a Jira issue key"
        )))
    }
}

/// Whether `key` can be a project key: letters, digits, and `_`, starting with a letter.
fn is_project_key(key: &str) -> bool {
    key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The issue type to file as: Task, else the first that isn't a sub-task.
fn pick_issue_type(types: &[IssueType]) -> Option<&str> {
    let usable = || types.iter().filter(|kind| !kind.subtask);
    usable()
        .find(|kind| kind.name.eq_ignore_ascii_case("task"))
        .or_else(|| usable().next())
        .map(|kind| kind.id.as_str())
}

/// Jira's times, such as `2026-11-17T12:00:00.000+0000`, whose offset has no colon.
fn jira_time(text: &str) -> Option<Timestamp> {
    text.parse().ok().or_else(|| {
        jiff::fmt::strtime::parse("%Y-%m-%dT%H:%M:%S%.f%z", text)
            .ok()?
            .to_timestamp()
            .ok()
    })
}

fn deserialize_time<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Timestamp, D::Error> {
    let text = String::deserialize(de)?;
    jira_time(&text).ok_or_else(|| serde::de::Error::custom(format!("{text:?} is not a time")))
}

/// An issue from `/issue/{key}` and its transitions from `/transitions`: the transitions, each as
/// the status it leads to, and the issue's own status when none leads there.
fn detail_of(
    connection: &str,
    site: &str,
    issue: Value,
    transitions: &Value,
) -> Result<IssueDetail, ErrorObject> {
    #[derive(Deserialize)]
    struct Transitions {
        transitions: Vec<Transition>,
    }
    #[derive(Deserialize)]
    struct Transition {
        id: String,
        to: Status,
    }
    let description = issue["fields"]["description"].clone();
    let comments: Vec<Comment> =
        serde_json::from_value(issue["fields"]["comment"]["comments"].clone()).unwrap_or_default();
    let issue: JiraIssue = serde_json::from_value(issue).map_err(|_| unreadable())?;
    let transitions: Transitions =
        serde_json::from_value(transitions.clone()).map_err(|_| unreadable())?;
    let own = issue.fields.status.clone();
    let leads_to_own = transitions
        .transitions
        .iter()
        .any(|transition| transition.to.id == own.id);
    let mut states: Vec<IssueState> = transitions
        .transitions
        .into_iter()
        .map(|transition| IssueState {
            id: transition.id,
            ..transition.to.into_state()
        })
        .collect();
    if !leads_to_own {
        states.insert(0, own.into_state());
    }
    let mut comments = comments
        .into_iter()
        .map(Comment::into_comment)
        .collect::<Result<Vec<_>, _>>()?;
    comments.sort_by_key(|comment| comment.created_at);
    Ok(IssueDetail {
        issue: issue.into_issue(connection, site),
        body: adf_to_markdown(&description),
        comments,
        states,
    })
}

fn unreadable() -> ErrorObject {
    failed("Jira answered in a way plxd can't read.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Myself {
    account_id: String,
    email_address: Option<String>,
}

#[derive(Deserialize)]
struct Search {
    issues: Vec<JiraIssue>,
}

#[derive(Deserialize)]
struct Created {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueTypes {
    // The first versions of this endpoint called it `values`.
    #[serde(alias = "values")]
    issue_types: Vec<IssueType>,
}

#[derive(Deserialize)]
struct IssueType {
    id: String,
    name: String,
    #[serde(default)]
    subtask: bool,
}

#[derive(Deserialize)]
struct Project {
    key: String,
    name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    id: String,
    name: String,
    #[serde(rename = "statusCategory")]
    category: Category,
}

#[derive(Clone, Deserialize)]
struct Category {
    key: String,
}

impl Status {
    fn into_state(self) -> IssueState {
        let category = match self.category.key.as_str() {
            "indeterminate" => IssueStateCategory::InProgress,
            "done" => IssueStateCategory::Done,
            _ => IssueStateCategory::Todo,
        };
        IssueState {
            id: self.id,
            name: self.name,
            category,
            color: None,
        }
    }
}

#[derive(Deserialize)]
struct JiraIssue {
    key: String,
    fields: Fields,
}

#[derive(Deserialize)]
struct Fields {
    summary: String,
    status: Status,
    assignee: Option<User>,
    #[serde(deserialize_with = "deserialize_time")]
    updated: Timestamp,
    project: Project,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    display_name: String,
}

impl JiraIssue {
    fn into_issue(self, connection: &str, site: &str) -> Issue {
        Issue {
            connection_id: connection.to_owned(),
            provider: IssueProvider::Jira,
            id: self.key.clone(),
            url: format!("https://{site}/browse/{}", self.key),
            key: self.key,
            title: self.fields.summary,
            state: self.fields.status.into_state(),
            container: IssueContainer {
                id: self.fields.project.key,
                name: self.fields.project.name,
            },
            assignee: self.fields.assignee.map(|user| user.display_name),
            updated_at: self.fields.updated,
        }
    }
}

#[derive(Deserialize)]
struct Comment {
    id: String,
    author: Option<User>,
    #[serde(default)]
    body: Value,
    created: String,
}

impl Comment {
    fn into_comment(self) -> Result<IssueComment, ErrorObject> {
        Ok(IssueComment {
            id: self.id,
            author: self
                .author
                .map_or_else(|| "Jira".to_owned(), |user| user.display_name),
            body: adf_to_markdown(&self.body),
            created_at: jira_time(&self.created).ok_or_else(unreadable)?,
        })
    }
}

/// Atlassian Document Format as Markdown: paragraphs, headings, bullet and ordered lists, code
/// blocks, hard breaks, and text that is strong, emphasized, code, or a link. A mention is its
/// text. Anything else is its content's.
fn adf_to_markdown(doc: &Value) -> String {
    blocks(doc).join("\n\n")
}

fn children(node: &Value) -> &[Value] {
    node["content"].as_array().map_or(&[], Vec::as_slice)
}

fn blocks(node: &Value) -> Vec<String> {
    children(node)
        .iter()
        .map(block)
        .filter(|text| !text.is_empty())
        .collect()
}

fn block(node: &Value) -> String {
    match node["type"].as_str().unwrap_or("") {
        "paragraph" => inline(node),
        "heading" => {
            let level = node["attrs"]["level"].as_u64().unwrap_or(1).clamp(1, 6);
            format!("{} {}", "#".repeat(level as usize), inline(node))
        }
        "bulletList" => list(node, None),
        "orderedList" => list(node, Some(node["attrs"]["order"].as_u64().unwrap_or(1))),
        "codeBlock" => {
            let code: String = children(node)
                .iter()
                .filter_map(|text| text["text"].as_str())
                .collect();
            let language = node["attrs"]["language"].as_str().unwrap_or("");
            format!("```{language}\n{code}\n```")
        }
        "text" | "hardBreak" | "mention" => inline_node(node),
        _ if children(node).iter().all(is_inline) => inline(node),
        _ => blocks(node).join("\n\n"),
    }
}

fn is_inline(node: &Value) -> bool {
    matches!(
        node["type"].as_str(),
        Some("text" | "hardBreak" | "mention")
    )
}

/// A list's items, each marked and with its later lines indented under its first.
fn list(node: &Value, start: Option<u64>) -> String {
    children(node)
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let marker = match start {
                Some(start) => format!("{}. ", start + index as u64),
                None => "- ".to_owned(),
            };
            let indent = " ".repeat(marker.len());
            let text = blocks(item).join("\n");
            let mut lines = text.lines();
            let first = format!("{marker}{}", lines.next().unwrap_or(""));
            std::iter::once(first)
                .chain(lines.map(|line| {
                    if line.is_empty() {
                        String::new()
                    } else {
                        format!("{indent}{line}")
                    }
                }))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn inline(node: &Value) -> String {
    children(node).iter().map(inline_node).collect()
}

fn inline_node(node: &Value) -> String {
    match node["type"].as_str().unwrap_or("") {
        "text" => {
            let mut text = node["text"].as_str().unwrap_or("").to_owned();
            let marks = node["marks"].as_array().map_or(&[][..], Vec::as_slice);
            let has = |kind: &str| marks.iter().any(|mark| mark["type"] == kind);
            if has("code") {
                text = format!("`{text}`");
            }
            if has("em") {
                text = format!("*{text}*");
            }
            if has("strong") {
                text = format!("**{text}**");
            }
            if let Some(href) = marks
                .iter()
                .find(|mark| mark["type"] == "link")
                .and_then(|mark| mark["attrs"]["href"].as_str())
            {
                text = format!("[{text}]({href})");
            }
            text
        }
        "hardBreak" => "\n".to_owned(),
        "mention" => node["attrs"]["text"].as_str().unwrap_or("").to_owned(),
        _ => inline(node),
    }
}

/// Markdown as Atlassian Document Format: blank lines separate paragraphs, a single newline is a
/// hard break, and a fenced block is a code block. The rest stays as typed.
fn markdown_to_adf(text: &str) -> Value {
    let mut content = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut code: Option<(&str, Vec<&str>)> = None;
    let flush = |paragraph: &mut Vec<&str>, content: &mut Vec<Value>| {
        if paragraph.is_empty() {
            return;
        }
        let mut inline = Vec::new();
        for (index, line) in paragraph.drain(..).enumerate() {
            if index > 0 {
                inline.push(json!({ "type": "hardBreak" }));
            }
            inline.push(json!({ "type": "text", "text": line }));
        }
        content.push(json!({ "type": "paragraph", "content": inline }));
    };
    let code_block = |language: &str, lines: &[&str]| {
        let mut block = json!({ "type": "codeBlock", "content": [] });
        if !language.is_empty() {
            block["attrs"] = json!({ "language": language });
        }
        if !lines.is_empty() {
            block["content"] = json!([{ "type": "text", "text": lines.join("\n") }]);
        }
        block
    };
    for line in text.lines() {
        let fence = line.trim_start().strip_prefix("```");
        match (&mut code, fence) {
            (Some((language, lines)), Some(_)) => {
                content.push(code_block(language, lines));
                code = None;
            }
            (Some((_, lines)), None) => lines.push(line),
            (None, Some(language)) => {
                flush(&mut paragraph, &mut content);
                code = Some((language.trim(), Vec::new()));
            }
            (None, None) if line.trim().is_empty() => flush(&mut paragraph, &mut content),
            (None, None) => paragraph.push(line),
        }
    }
    if let Some((language, lines)) = code {
        content.push(code_block(language, &lines));
    }
    flush(&mut paragraph, &mut content);
    json!({ "type": "doc", "version": 1, "content": content })
}

#[cfg(test)]
mod tests {
    use parallax_protocol::IssueStateCategory;
    use serde_json::json;

    use super::{
        IssueType, Search, adf_to_markdown, detail_of, markdown_to_adf, normalize_site,
        pick_issue_type,
    };

    fn issue_json(key: &str, status: (&str, &str, &str)) -> serde_json::Value {
        json!({
            "id": "10001",
            "key": key,
            "fields": {
                "summary": "Fix the login page",
                "status": {
                    "id": status.0, "name": status.1,
                    "statusCategory": { "id": 4, "key": status.2, "colorName": "yellow" }
                },
                "assignee": { "accountId": "5b10", "displayName": "Ada Lovelace" },
                "updated": "2026-11-17T12:00:00.000+0000",
                "project": { "id": "10000", "key": "ABC", "name": "Alphabet" }
            }
        })
    }

    #[test]
    fn a_jira_site_is_a_bare_host() {
        assert_eq!(
            normalize_site(" https://Acme.atlassian.net/ ").unwrap(),
            "acme.atlassian.net"
        );
        assert_eq!(
            normalize_site("acme.atlassian.net").unwrap(),
            "acme.atlassian.net"
        );
        for bad in [
            "",
            "acme",
            "http://acme.atlassian.net",
            "acme.atlassian.net/jira",
            "acme.atlassian.net:443",
            "ada@acme.atlassian.net",
            "-acme.atlassian.net",
            "acme..atlassian.net",
        ] {
            assert!(normalize_site(bad).is_err(), "{bad:?}");
        }
    }

    /// `/search/jql`'s issues read with their status category, project, and browse URL.
    #[test]
    fn jira_search_results_parse() {
        let answer = json!({
            "issues": [
                issue_json("ABC-12", ("3", "In Progress", "indeterminate")),
                issue_json("ABC-9", ("10000", "To Do", "new")),
            ],
            "isLast": true
        });
        let search: Search = serde_json::from_value(answer).unwrap();
        let issues: Vec<_> = search
            .issues
            .into_iter()
            .map(|issue| issue.into_issue("conn", "acme.atlassian.net"))
            .collect();
        let first = &issues[0];
        assert_eq!(
            (first.id.as_str(), first.key.as_str(), first.url.as_str()),
            (
                "ABC-12",
                "ABC-12",
                "https://acme.atlassian.net/browse/ABC-12"
            )
        );
        assert_eq!(first.state.category, IssueStateCategory::InProgress);
        assert_eq!(first.container.id, "ABC");
        assert_eq!(first.assignee.as_deref(), Some("Ada Lovelace"));
        assert_eq!(first.updated_at.to_string(), "2026-11-17T12:00:00Z");
        assert_eq!(issues[1].state.category, IssueStateCategory::Todo);
    }

    /// An issue reads with its description and comments as Markdown, and its transitions as the
    /// states they lead to, its own status first when no transition leads there.
    #[test]
    fn a_jira_issue_reads_with_comments_and_transitions() {
        let mut issue = issue_json("ABC-12", ("3", "In Progress", "indeterminate"));
        issue["fields"]["description"] = json!({ "type": "doc", "version": 1, "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "Broken." }] }
        ] });
        issue["fields"]["comment"] = json!({ "comments": [
            { "id": "2", "author": { "displayName": "Bo" }, "created": "2026-11-17T13:00:00.000+0000",
              "body": { "type": "doc", "version": 1, "content": [
                  { "type": "paragraph", "content": [{ "type": "text", "text": "Earlier" }] }] } },
            { "id": "1", "author": { "displayName": "Ada" }, "created": "2026-11-17T12:30:00.000-0700",
              "body": { "type": "doc", "version": 1, "content": [
                  { "type": "paragraph", "content": [{ "type": "text", "text": "Later" }] }] } }
        ], "total": 2 });
        let transitions = json!({ "transitions": [
            { "id": "11", "name": "Back to do", "to": {
                "id": "10000", "name": "To Do", "statusCategory": { "key": "new" } } },
            { "id": "31", "name": "Done", "to": {
                "id": "10001", "name": "Done", "statusCategory": { "key": "done" } } }
        ] });
        let detail = detail_of("conn", "acme.atlassian.net", issue, &transitions).unwrap();
        assert_eq!(detail.body, "Broken.");
        let comments: Vec<_> = detail
            .comments
            .iter()
            .map(|c| (c.id.as_str(), c.author.as_str(), c.body.as_str()))
            .collect();
        // 12:30 at -07:00 is after 13:00 UTC.
        assert_eq!(comments, [("2", "Bo", "Earlier"), ("1", "Ada", "Later")]);
        let states: Vec<_> = detail
            .states
            .iter()
            .map(|s| (s.id.as_str(), s.name.as_str(), s.category))
            .collect();
        assert_eq!(
            states,
            [
                ("3", "In Progress", IssueStateCategory::InProgress),
                ("11", "To Do", IssueStateCategory::Todo),
                ("31", "Done", IssueStateCategory::Done)
            ]
        );
    }

    #[test]
    fn a_task_is_filed_before_other_issue_types() {
        let types = |names: &[(&str, &str, bool)]| -> Vec<IssueType> {
            names
                .iter()
                .map(|(id, name, subtask)| IssueType {
                    id: (*id).to_owned(),
                    name: (*name).to_owned(),
                    subtask: *subtask,
                })
                .collect()
        };
        assert_eq!(
            pick_issue_type(&types(&[("1", "Bug", false), ("2", "Task", false)])),
            Some("2")
        );
        assert_eq!(
            pick_issue_type(&types(&[("5", "Sub-task", true), ("1", "Story", false)])),
            Some("1")
        );
        assert_eq!(pick_issue_type(&types(&[("5", "Sub-task", true)])), None);
    }

    #[test]
    fn adf_reads_as_markdown() {
        let doc = json!({ "type": "doc", "version": 1, "content": [
            { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Steps" }] },
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Ask " },
                { "type": "mention", "attrs": { "id": "5b10", "text": "@Ada" } },
                { "type": "text", "text": " to run " },
                { "type": "text", "text": "make", "marks": [{ "type": "code" }] },
                { "type": "hardBreak" },
                { "type": "text", "text": "then", "marks": [{ "type": "strong" }, { "type": "em" }] },
                { "type": "text", "text": " read " },
                { "type": "text", "text": "the docs", "marks": [
                    { "type": "link", "attrs": { "href": "https://example.com" } }] }
            ] },
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "one" }] },
                    { "type": "orderedList", "attrs": { "order": 3 }, "content": [
                        { "type": "listItem", "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "nested" }] }] }
                    ] }
                ] },
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] }
            ] },
            { "type": "codeBlock", "attrs": { "language": "sh" }, "content": [
                { "type": "text", "text": "make\nmake test" }] },
            { "type": "panel", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Kept." }] }] }
        ] });
        assert_eq!(
            adf_to_markdown(&doc),
            "## Steps\n\n\
             Ask @Ada to run `make`\n***then*** read [the docs](https://example.com)\n\n\
             - one\n  3. nested\n- two\n\n\
             ```sh\nmake\nmake test\n```\n\n\
             Kept."
        );
        assert_eq!(adf_to_markdown(&serde_json::Value::Null), "");
    }

    #[test]
    fn markdown_writes_as_adf() {
        let doc = markdown_to_adf(
            "First line\nsecond line\n\n```rust\nfn main() {}\n\nlet x;\n```\nAfter",
        );
        assert_eq!(
            doc,
            json!({ "type": "doc", "version": 1, "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "First line" },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "second line" }
                ] },
                { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [
                    { "type": "text", "text": "fn main() {}\n\nlet x;" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "After" }] }
            ] })
        );
        assert_eq!(
            markdown_to_adf("```\n"),
            json!({ "type": "doc", "version": 1, "content": [
                { "type": "codeBlock", "content": [] }] })
        );
    }
}
