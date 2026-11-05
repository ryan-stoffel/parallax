//! `pr/write`'s `applySuggestions` (PLX-1189): commits review comments' suggestions to a pull
//! request's head branch, as GitHub's own Commit suggestion does, and resolves their threads.
//!
//! GitHub's API has no call for it. So plxd reads each file at the head commit, replaces the lines,
//! and commits them with `createCommitOnBranch`: no worktree, signed by GitHub, and `expectedHeadOid`
//! refuses a branch that moved since the reviewer read it.

use std::collections::BTreeMap;
use std::path::Path;

use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::json;
use tokio::time::Instant;

use super::{RESOLVE, send};
use crate::pr_watch::parts;
use crate::server::Daemon;
use crate::worktree::PrError;

/// The pull request's head and review threads, enough to place each suggestion.
const READ: &str = "query($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
    headRefOid headRefName headRepository { nameWithOwner } viewerCanApplySuggestion \
    reviewThreads(last: 100) { nodes { id path line startLine diffSide isOutdated \
    comments(first: 50) { nodes { id body } } } } } } }";

/// A file's text at `$expression`, `<oid>:<path>`.
const FILE: &str = "query($owner: String!, $name: String!, $expression: String!) { \
    repository(owner: $owner, name: $name) { object(expression: $expression) { \
    ... on Blob { text isBinary isTruncated } } } }";

/// One commit on a branch, whose `input` goes in the request's body.
const COMMIT: &str = "mutation($input: CreateCommitOnBranchInput!) { \
    createCommitOnBranch(input: $input) { commit { oid } } }";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Read {
    head_ref_oid: String,
    head_ref_name: String,
    head_repository: Option<HeadRepository>,
    viewer_can_apply_suggestion: bool,
    review_threads: Nodes<Thread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRepository {
    name_with_owner: String,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    path: Option<String>,
    line: Option<usize>,
    start_line: Option<usize>,
    diff_side: Option<String>,
    #[serde(default)]
    is_outdated: bool,
    comments: Nodes<ThreadComment>,
}

#[derive(Deserialize)]
struct ThreadComment {
    id: String,
    body: String,
}

/// Lines `start` to `end`, from 1 and inclusive, replaced with `lines`, or deleted with none.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Replacement {
    start: usize,
    end: usize,
    lines: Vec<String>,
}

/// What a batch of suggestions changes: each file's replacements, and the threads to resolve.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    files: BTreeMap<String, Vec<Replacement>>,
    threads: Vec<String>,
}

/// The lines of `body`'s first ```` ```suggestion ```` fence, empty to delete.
fn suggestion_of(body: &str) -> Option<Vec<String>> {
    let mut lines = body.lines();
    let fence = lines.by_ref().find_map(|line| {
        let name = line.trim_end().strip_suffix("suggestion")?;
        let tick = name.chars().next()?;
        ((tick == '`' || tick == '~') && name.len() >= 3 && name.chars().all(|c| c == tick))
            .then(|| name.to_owned())
    })?;
    let mut out = Vec::new();
    for line in lines {
        if line.trim_end() == fence {
            return Some(out);
        }
        out.push(line.to_owned());
    }
    None
}

/// Where each of `comment_ids`'s suggestions goes in `threads`, or why one can't apply.
fn plan(threads: &[Thread], comment_ids: &[String]) -> Result<Plan, String> {
    let mut files: BTreeMap<String, Vec<Replacement>> = BTreeMap::new();
    let mut resolve = Vec::new();
    for id in comment_ids {
        let (thread, comment) = threads
            .iter()
            .find_map(|thread| {
                let comment = thread.comments.nodes.iter().find(|c| &c.id == id)?;
                Some((thread, comment))
            })
            .ok_or_else(|| format!("couldn't find suggestion {id} on the pull request"))?;
        let path = thread.path.as_ref().ok_or("a suggestion has no file")?;
        if thread.is_outdated {
            return Err(format!(
                "a suggestion on {path} is outdated: the code changed since"
            ));
        }
        if thread.diff_side.as_deref() == Some("LEFT") {
            return Err(format!("a suggestion on {path} is on a removed line"));
        }
        let end = thread
            .line
            .ok_or_else(|| format!("a suggestion on {path} has no line"))?;
        let lines = suggestion_of(&comment.body)
            .ok_or_else(|| format!("a comment on {path} has no suggestion"))?;
        let start = thread.start_line.unwrap_or(end);
        files
            .entry(path.clone())
            .or_default()
            .push(Replacement { start, end, lines });
        if !resolve.contains(&thread.id) {
            resolve.push(thread.id.clone());
        }
    }
    Ok(Plan {
        files,
        threads: resolve,
    })
}

/// `text` with each of `replacements` made, keeping its line endings and whether it ends with one.
/// Refuses ones that overlap or run past its end.
fn replace_lines(text: &str, mut replacements: Vec<Replacement>) -> Result<String, String> {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    replacements.sort_by_key(|r| r.start);
    if replacements
        .windows(2)
        .any(|pair| pair[1].start <= pair[0].end)
    {
        return Err("these suggestions overlap: commit them one at a time".to_owned());
    }
    // From the bottom, so an earlier one's lines don't move a later one's.
    for r in replacements.into_iter().rev() {
        if r.start == 0 || r.start > r.end || r.end > lines.len() {
            return Err(format!(
                "a suggestion covers lines {} to {}, but the file has {}",
                r.start,
                r.end,
                lines.len()
            ));
        }
        let at_end = r.end == lines.len();
        let ended = lines[r.end - 1].ends_with('\n');
        let mut new: Vec<String> = r.lines.iter().map(|l| format!("{l}{eol}")).collect();
        // The file's last line has no line ending, so its replacement's last has none.
        if at_end
            && !ended
            && let Some(last) = new.last_mut()
        {
            last.truncate(last.len() - eol.len());
        }
        lines.splice(r.start - 1..r.end, new);
    }
    Ok(lines.concat())
}

/// The request body that commits `contents` to `branch` of `repo` on top of `head`.
fn commit_request(
    repo: &str,
    branch: &str,
    head: &str,
    message: &str,
    contents: &BTreeMap<String, String>,
) -> serde_json::Value {
    let (headline, body) = message.split_once('\n').unwrap_or((message, ""));
    let additions: Vec<_> = contents
        .iter()
        .map(|(path, text)| {
            let encoded = BASE64.encode(text.as_bytes());
            json!({ "path": path, "contents": encoded })
        })
        .collect();
    json!({
        "query": COMMIT,
        "variables": { "input": {
            "branch": { "repositoryNameWithOwner": repo, "branchName": branch },
            "message": { "headline": headline.trim(), "body": body.trim() },
            "expectedHeadOid": head,
            "fileChanges": { "additions": additions },
        } },
    })
}

/// Reads `<head>:<path>` of `repo`.
async fn read_file(
    gh: &crate::worktree::WorktreeManager,
    repo: &str,
    head: &str,
    path: &str,
) -> Result<String, PrError> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| PrError::Gh(format!("{repo:?} is not a repository")))?;
    let query = format!("query={FILE}");
    let (owner, name) = (format!("owner={owner}"), format!("name={name}"));
    let expression = format!("expression={head}:{path}");
    let args = [
        "api",
        "graphql",
        "-f",
        &query,
        "-f",
        &owner,
        "-f",
        &name,
        "-f",
        &expression,
    ];
    let answer = gh.gh(&std::env::temp_dir(), &args).await?;
    let answer: serde_json::Value = serde_json::from_str(&answer)
        .map_err(|error| PrError::Gh(format!("could not read {path}: {error}")))?;
    let blob = answer.pointer("/data/repository/object");
    let text = blob
        .and_then(|blob| blob.get("text"))
        .and_then(serde_json::Value::as_str);
    let whole = blob
        .and_then(|blob| blob.get("isTruncated"))
        .and_then(serde_json::Value::as_bool);
    match (text, whole) {
        (Some(text), Some(false)) => Ok(text.to_owned()),
        _ => Err(PrError::Gh(format!(
            "{path} is binary, too large, or gone at the head commit, so a suggestion can't change it"
        ))),
    }
}

/// Commits `comment_ids`'s suggestions to `url`'s head branch with `message`, while it is still
/// `head_sha`, and resolves their threads, by `deadline`. `body_file` carries the request.
pub(super) async fn apply(
    daemon: &Daemon,
    url: &str,
    comment_ids: &[String],
    message: &str,
    head_sha: &str,
    body_file: &Path,
    deadline: Instant,
) -> Result<(), PrError> {
    if comment_ids.is_empty() {
        return Err(PrError::Gh("name at least one suggestion".to_owned()));
    }
    if message.trim().is_empty() {
        return Err(PrError::Gh("the commit needs a message".to_owned()));
    }
    let gh = daemon.agents.worktrees();
    let (owner, name, number) = parts(url)?;
    let query = format!("query={READ}");
    let (owner, name, number) = (
        format!("owner={owner}"),
        format!("name={name}"),
        format!("number={number}"),
    );
    let args = [
        "api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number,
    ];
    let answer = gh.gh(&std::env::temp_dir(), &args).await?;
    let read: serde_json::Value = serde_json::from_str(&answer)
        .map_err(|error| PrError::Gh(format!("could not read the pull request: {error}")))?;
    let read: Read = read
        .pointer("/data/repository/pullRequest")
        .cloned()
        .and_then(|pr| serde_json::from_value(pr).ok())
        .ok_or_else(|| PrError::Gh("GitHub's answer left out the pull request".to_owned()))?;
    if !read.viewer_can_apply_suggestion {
        return Err(PrError::Gh(
            "you can't commit to this pull request's branch".to_owned(),
        ));
    }
    if read.head_ref_oid != head_sha {
        return Err(PrError::Gh(moved()));
    }
    let repo = read
        .head_repository
        .ok_or_else(|| PrError::Gh("the head branch's repository is gone".to_owned()))?
        .name_with_owner;
    let plan = plan(&read.review_threads.nodes, comment_ids).map_err(PrError::Gh)?;
    let mut contents = BTreeMap::new();
    for (path, replacements) in plan.files {
        let text = read_file(gh, &repo, head_sha, &path).await?;
        contents.insert(
            path,
            replace_lines(&text, replacements).map_err(PrError::Gh)?,
        );
    }
    let request = commit_request(&repo, &read.head_ref_name, head_sha, message, &contents);
    std::fs::write(body_file, request.to_string())
        .map_err(|error| PrError::Gh(format!("could not write the commit's request: {error}")))?;
    let input = body_file.display().to_string();
    send(gh, &["api", "graphql", "--input", &input], deadline)
        .await
        .map_err(|error| match error {
            PrError::Gh(error) if error.contains("Expected branch to point to") => {
                PrError::Gh(moved())
            }
            error => error,
        })?;
    let query = format!("query={RESOLVE}");
    for thread in &plan.threads {
        let thread = format!("thread={thread}");
        send(
            gh,
            &["api", "graphql", "-f", &query, "-f", &thread],
            deadline,
        )
        .await
        .map_err(|error| {
            PrError::Gh(format!(
                "the suggestions are committed, but resolving their threads failed: {error}"
            ))
        })?;
    }
    Ok(())
}

/// Why a moved head is refused.
fn moved() -> String {
    "the branch has moved since this was read, so nothing was committed. Refresh and try again"
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, line: usize, start: Option<usize>, comment: (&str, &str)) -> Thread {
        Thread {
            id: id.to_owned(),
            path: Some("a.rs".to_owned()),
            line: Some(line),
            start_line: start,
            diff_side: Some("RIGHT".to_owned()),
            is_outdated: false,
            comments: Nodes {
                nodes: vec![ThreadComment {
                    id: comment.0.to_owned(),
                    body: comment.1.to_owned(),
                }],
            },
        }
    }

    fn one(start: usize, end: usize, lines: &[&str]) -> Vec<Replacement> {
        vec![Replacement {
            start,
            end,
            lines: lines.iter().map(|l| (*l).to_owned()).collect(),
        }]
    }

    #[test]
    fn a_single_line_suggestion_replaces_its_line() {
        assert_eq!(
            replace_lines("a\nb\nc\n", one(2, 2, &["B"])).unwrap(),
            "a\nB\nc\n"
        );
    }

    #[test]
    fn a_multi_line_suggestion_replaces_its_range_with_any_number_of_lines() {
        assert_eq!(
            replace_lines("a\nb\nc\nd\n", one(2, 3, &["X"])).unwrap(),
            "a\nX\nd\n"
        );
        assert_eq!(
            replace_lines("a\nb\n", one(1, 1, &["X", "Y", "Z"])).unwrap(),
            "X\nY\nZ\nb\n"
        );
    }

    #[test]
    fn an_empty_suggestion_deletes_its_lines() {
        assert_eq!(replace_lines("a\nb\nc\n", one(2, 3, &[])).unwrap(), "a\n");
    }

    #[test]
    fn a_file_keeps_its_line_endings_and_a_missing_last_one() {
        assert_eq!(
            replace_lines("a\r\nb\r\n", one(1, 1, &["X"])).unwrap(),
            "X\r\nb\r\n"
        );
        assert_eq!(
            replace_lines("a\nb", one(2, 2, &["X", "Y"])).unwrap(),
            "a\nX\nY"
        );
    }

    #[test]
    fn suggestions_in_one_file_apply_from_the_bottom_so_none_moves_another() {
        let mut replacements = one(1, 1, &["X", "X2"]);
        replacements.extend(one(3, 3, &["Z"]));
        assert_eq!(
            replace_lines("a\nb\nc\n", replacements).unwrap(),
            "X\nX2\nb\nZ\n"
        );
    }

    #[test]
    fn overlapping_suggestions_and_lines_past_the_end_are_refused() {
        let mut overlap = one(1, 2, &["X"]);
        overlap.extend(one(2, 3, &["Y"]));
        assert!(
            replace_lines("a\nb\nc\n", overlap)
                .unwrap_err()
                .contains("overlap")
        );
        assert!(replace_lines("a\n", one(5, 5, &["X"])).is_err());
    }

    #[test]
    fn a_suggestion_is_read_from_its_fence() {
        let body = "Try:\n\n```suggestion\none\n\ntwo\n```\nThanks";
        assert_eq!(
            suggestion_of(body),
            Some(vec!["one".into(), String::new(), "two".into()])
        );
        assert_eq!(suggestion_of("```suggestion\n```"), Some(vec![]));
        assert_eq!(
            suggestion_of("````suggestion\n```\n````"),
            Some(vec!["```".to_owned()])
        );
        assert_eq!(suggestion_of("```ts\ncode\n```"), None);
        assert_eq!(suggestion_of("```suggestion\nnever closed"), None);
    }

    #[test]
    fn a_plan_places_each_suggestion_and_names_each_thread_once() {
        let threads = [
            thread("T1", 9, Some(7), ("C1", "```suggestion\nx\n```")),
            thread("T2", 3, None, ("C2", "```suggestion\ny\n```")),
        ];
        let plan = plan(&threads, &["C1".to_owned(), "C2".to_owned()]).unwrap();
        assert_eq!(plan.threads, ["T1", "T2"]);
        let file = &plan.files["a.rs"];
        assert_eq!((file[0].start, file[0].end), (7, 9));
        assert_eq!((file[1].start, file[1].end), (3, 3));
    }

    #[test]
    fn an_outdated_or_old_side_or_missing_suggestion_is_refused() {
        let ids = ["C1".to_owned()];
        let good = ("C1", "```suggestion\nx\n```");
        let mut outdated = thread("T", 1, None, good);
        outdated.is_outdated = true;
        assert!(plan(&[outdated], &ids).unwrap_err().contains("outdated"));
        let mut left = thread("T", 1, None, good);
        left.diff_side = Some("LEFT".to_owned());
        assert!(plan(&[left], &ids).unwrap_err().contains("removed line"));
        assert!(plan(&[thread("T", 1, None, ("C1", "no block"))], &ids).is_err());
        assert!(plan(&[], &ids).is_err());
    }

    #[test]
    fn the_commit_is_pinned_to_the_head_it_was_read_from() {
        let contents = BTreeMap::from([("a.rs".to_owned(), "x\n".to_owned())]);
        let request = commit_request("me/app", "main", "abc", "Apply\n\nWhy", &contents);
        let input = &request["variables"]["input"];
        assert_eq!(input["expectedHeadOid"], "abc");
        assert_eq!(input["branch"]["repositoryNameWithOwner"], "me/app");
        assert_eq!(input["message"]["headline"], "Apply");
        assert_eq!(input["message"]["body"], "Why");
        assert_eq!(input["fileChanges"]["additions"][0]["contents"], "eAo=");
    }
}
