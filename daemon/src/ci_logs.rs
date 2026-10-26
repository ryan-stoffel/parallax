//! `pr/failureLog` (PLX-1019): the error lines of each failed check's log on a pull request's
//! head, so agents never run `gh run list`, `gh run view --log-failed`, or `gh api` for them.
//!
//! One `gh api graphql` call reads the head commit's checks. A failed GitHub Actions check run's
//! database id is its job id, so each failed job's log is one `gh api .../actions/jobs/<id>/logs`
//! call, which [`trim`] cuts to the lines around errors, failures, and panics. The excerpt is
//! cached in [`DataDir::ci_logs_dir`](crate::paths::DataDir::ci_logs_dir) as
//! `<head sha>/<job id>.log`, so each job's log is read from GitHub once; head folders older than
//! [`KEEP`] are deleted as new ones are written. A spent rate limit fails the call with the time
//! it resets, read from `gh api rate_limit`, which doesn't count against it.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use futures_util::future::try_join_all;
use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{PrFailureLog, PrFailureLogParams, PrFailureLogResult};
use serde_json::Value;
use tracing::warn;

use crate::server::Daemon;
use crate::worktree::PrError;

/// The head commit and its checks' names, states, links, and Actions ids.
const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun {
          name status conclusion detailsUrl databaseId
          checkSuite { workflowRun { databaseId } }
        }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}";

/// Lines kept before and after each line [`trim`] matches.
const BEFORE: usize = 3;
const AFTER: usize = 8;
/// Lines kept from the end of a log in which nothing matches.
const TAIL: usize = 40;
/// An excerpt's most bytes, half from its start and half from its end.
const CAP: usize = 8 * 1024;
/// How long a head's cached excerpts are kept.
const KEEP: Duration = Duration::from_hours(7 * 24);

/// A failed check as the checks read found it, before its log is read.
#[derive(Debug, PartialEq, Eq)]
struct Failed {
    name: String,
    how: String,
    workflow_run_id: Option<u64>,
    job_id: Option<u64>,
    url: Option<String>,
}

/// `pr/failureLog`: reads `url`'s head checks, then each failed job's log, from the cache when it
/// has it.
pub(crate) async fn failure_log(
    daemon: &Daemon,
    params: PrFailureLogParams,
) -> Result<PrFailureLogResult, ErrorObject> {
    let PrFailureLogParams { url, check } = params;
    let (owner, name, number) =
        parts(&url).map_err(|error| ErrorObject::invalid_params(error.to_string()))?;
    let query = format!("query={QUERY}");
    let (owner_field, name_field) = (format!("owner={owner}"), format!("name={name}"));
    let number_field = format!("number={number}");
    let args = [
        "api",
        "graphql",
        "-f",
        &query,
        "-f",
        &owner_field,
        "-f",
        &name_field,
        "-F",
        &number_field,
    ];
    let read = gh(daemon, &args).await;
    let answer = match read {
        Ok(answer) => answer,
        Err(error) => return Err(refused(daemon, error, "the pull request's checks").await),
    };
    let (head_sha, failed) = parse(&answer).map_err(|error| {
        ErrorObject::invalid_params(format!("could not read the checks: {error}"))
    })?;
    let wanted = check.map(|check| check.to_lowercase());
    let failed = failed.into_iter().filter(|failed| {
        wanted
            .as_ref()
            .is_none_or(|wanted| failed.name.to_lowercase().contains(wanted))
    });
    let dir = daemon.data_dir.ci_logs_dir();
    let failures = try_join_all(failed.map(|failed| {
        let (dir, head_sha, owner, name) = (&dir, head_sha.as_deref(), owner, name);
        async move {
            let log = match (failed.job_id, head_sha) {
                (Some(job), Some(sha)) => {
                    let read = excerpt(dir, sha, job, || {
                        let path = format!("repos/{owner}/{name}/actions/jobs/{job}/logs");
                        async move {
                            // gh refuses to print a log's colors without the flag, which a gh
                            // older than that refusal doesn't know.
                            match gh(daemon, &["api", "--allow-escape-sequences", &path]).await {
                                Err(PrError::Gh(error)) if error.contains("unknown flag") => {
                                    gh(daemon, &["api", &path]).await
                                }
                                read => read,
                            }
                        }
                    })
                    .await;
                    match read {
                        Ok(log) => log,
                        Err(error) => return Err(refused(daemon, error, "the job's log").await),
                    }
                }
                _ => "No log: this check isn't a GitHub Actions job. Open its url.".to_owned(),
            };
            Ok::<_, ErrorObject>(PrFailureLog {
                name: failed.name,
                how: failed.how,
                workflow_run_id: failed.workflow_run_id,
                job_id: failed.job_id,
                url: failed.url,
                log,
            })
        }
    }))
    .await?;
    Ok(PrFailureLogResult {
        url,
        head_sha,
        failures,
    })
}

/// Runs `gh args` in plxd's temp folder.
async fn gh(daemon: &Daemon, args: &[&str]) -> Result<String, PrError> {
    daemon
        .agents
        .worktrees()
        .gh(&std::env::temp_dir(), args)
        .await
}

/// The error for a read of `what` that `gh` failed: for a rate limit, says so with the time it
/// resets when GitHub tells.
async fn refused(daemon: &Daemon, error: PrError, what: &str) -> ErrorObject {
    let text = error.to_string();
    if !text.to_lowercase().contains("rate limit") {
        return ErrorObject::invalid_params(format!("could not read {what}: {text}"));
    }
    let reset = match gh(daemon, &["api", "rate_limit"]).await {
        Ok(answer) => spent_until(&answer),
        Err(_) => None,
    };
    let when = reset.map_or_else(
        || "GitHub didn't say when it resets".to_owned(),
        |reset| format!("it resets at {reset}"),
    );
    ErrorObject::invalid_params(format!(
        "GitHub's API rate limit is spent, so plxd could not read {what}; {when}. Don't retry \
         with gh before then. ({text})"
    ))
}

/// When the spent `core` or `graphql` limit in `gh api rate_limit`'s answer resets, if one is.
pub(crate) fn spent_until(answer: &str) -> Option<Timestamp> {
    let answer: Value = serde_json::from_str(answer).ok()?;
    ["core", "graphql"]
        .iter()
        .map(|bucket| &answer["resources"][bucket])
        .filter(|bucket| bucket["remaining"].as_u64() == Some(0))
        .filter_map(|bucket| Timestamp::from_second(bucket["reset"].as_i64()?).ok())
        .max()
}

/// The cached excerpt of job `job` on head `sha` in `dir`, or else `fetch`'s log, trimmed and
/// cached.
async fn excerpt<F, Fut>(dir: &Path, sha: &str, job: u64, fetch: F) -> Result<String, PrError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String, PrError>>,
{
    // GitHub's own answer, but it names a folder, so only hex passes.
    let cacheable = !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit());
    let file = dir.join(sha).join(format!("{job}.log"));
    if cacheable && let Ok(cached) = tokio::fs::read_to_string(&file).await {
        return Ok(cached);
    }
    let excerpt = trim(&fetch().await?);
    if cacheable && let Err(error) = store(dir, &file, &excerpt).await {
        warn!(%error, file = %file.display(), "could not cache a CI log");
    }
    Ok(excerpt)
}

/// Writes `excerpt` to `file` through a temp file, so a reader never sees half of it, after
/// deleting head folders in `dir` older than [`KEEP`].
// ponytail: two calls for the same new head both read the log; lock per job if that shows up.
async fn store(dir: &Path, file: &Path, excerpt: &str) -> std::io::Result<()> {
    if let Ok(mut heads) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(head)) = heads.next_entry().await {
            let old = head
                .metadata()
                .await
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|at| at.elapsed().is_ok_and(|age| age > KEEP));
            if old && let Err(error) = tokio::fs::remove_dir_all(head.path()).await {
                warn!(%error, "could not delete an old CI log folder");
            }
        }
    }
    let folder = file.parent().unwrap_or(dir);
    tokio::fs::create_dir_all(folder).await?;
    let partial = file.with_extension(format!("{}.partial", uuid::Uuid::new_v4()));
    tokio::fs::write(&partial, excerpt).await?;
    tokio::fs::rename(&partial, file).await
}

/// `https://github.com/<owner>/<name>/pull/<number>`'s parts.
fn parts(url: &str) -> Result<(&str, &str, u64), PrError> {
    let found = || {
        let mut parts = url.strip_prefix("https://github.com/")?.split('/');
        let (owner, name) = (parts.next()?, parts.next()?);
        (parts.next()? == "pull").then_some(())?;
        Some((owner, name, parts.next()?.parse().ok()?))
    };
    found().ok_or_else(|| PrError::Gh(format!("{url:?} is not a GitHub pull request URL")))
}

/// [`QUERY`]'s answer: the head commit, and its failed checks by name.
fn parse(answer: &str) -> Result<(Option<String>, Vec<Failed>), PrError> {
    let answer: Value = serde_json::from_str(answer)
        .map_err(|error| PrError::Gh(format!("could not read GitHub's answer: {error}")))?;
    if let Some(message) = answer["errors"][0]["message"].as_str() {
        return Err(PrError::Gh(message.to_owned()));
    }
    let pr = &answer["data"]["repository"]["pullRequest"];
    if pr.is_null() {
        return Err(PrError::Gh("GitHub has no such pull request".to_owned()));
    }
    let commit = &pr["commits"]["nodes"][0]["commit"];
    let text = |value: &Value| value.as_str().map(str::to_owned);
    let mut failed: Vec<Failed> = commit["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| {
            let how = match (text(&node["status"]), text(&node["state"])) {
                (Some(status), _) if status == "COMPLETED" => how(&text(&node["conclusion"])?)?,
                (None, Some(state)) => how(&state)?,
                _ => return None,
            };
            Some(Failed {
                name: text(&node["name"]).or_else(|| text(&node["context"]))?,
                how: how.to_owned(),
                workflow_run_id: node["checkSuite"]["workflowRun"]["databaseId"].as_u64(),
                // Only an Actions job has a log to read.
                job_id: node["checkSuite"]["workflowRun"]
                    .is_object()
                    .then(|| node["databaseId"].as_u64())
                    .flatten(),
                url: text(&node["detailsUrl"]).or_else(|| text(&node["targetUrl"])),
            })
        })
        .collect();
    failed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((text(&commit["oid"]), failed))
}

/// How a finished check or a status with `outcome` failed, or `None` when it passed.
fn how(outcome: &str) -> Option<&'static str> {
    Some(match outcome {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" | "STALE" | "PENDING" | "EXPECTED" => return None,
        "CANCELLED" => "cancelled",
        "TIMED_OUT" => "timed out",
        "ACTION_REQUIRED" => "action required",
        "STARTUP_FAILURE" => "startup failure",
        "ERROR" => "error",
        _ => "failure",
    })
}

/// A job's log cut to what explains its failure: each line mentioning an error, a failure, or a
/// panic, with [`BEFORE`] lines before it and [`AFTER`] after, gaps marked `...`, or the last
/// [`TAIL`] lines when none does. Timestamps and colors are removed, and the result is at most
/// [`CAP`] bytes.
pub(crate) fn trim(log: &str) -> String {
    let lines: Vec<String> = log.lines().map(clean).collect();
    // A step's header, its command and inputs such as `fail-on-cache-miss`, runs from
    // `##[group]Run` to `##[endgroup]`; only what comes after is the step's output.
    let mut header = false;
    let hits = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            if line.starts_with("##[group]Run ") {
                header = true;
            } else if line.starts_with("##[endgroup]") {
                header = false;
            }
            !header && matters(line)
        })
        .map(|(at, _)| at);
    let mut kept: Vec<&str> = Vec::new();
    let mut end = 0;
    for hit in hits {
        let start = hit.saturating_sub(BEFORE).max(end);
        let stop = (hit + AFTER + 1).min(lines.len());
        if start > end && !kept.is_empty() {
            kept.push("...");
        }
        kept.extend(lines[start..stop.max(start)].iter().map(String::as_str));
        end = end.max(stop);
    }
    if kept.is_empty() {
        let from = lines.len().saturating_sub(TAIL);
        kept.extend(lines[from..].iter().map(String::as_str));
    }
    cap(&kept.join("\n"))
}

/// Whether a log line tells why the job failed. A passing test or a crate being built can be
/// named after errors, so those don't count.
fn matters(line: &str) -> bool {
    let line = line.trim_start();
    let noise = (line.starts_with("test ")
        && (line.ends_with(" ok") || line.ends_with(" ignored")))
        || ["Compiling ", "Checking ", "Downloaded ", "Downloading "]
            .iter()
            .any(|prefix| line.starts_with(prefix));
    let lower = line.to_lowercase();
    !noise
        && ["error", "fail", "panic"]
            .iter()
            .any(|word| lower.contains(word))
}

/// A log line without its leading byte-order mark, its Actions timestamp, or terminal colors.
fn clean(line: &str) -> String {
    let line = line.trim_start_matches('\u{feff}');
    let line = match line.split_once(' ') {
        Some((stamp, rest))
            if stamp.len() >= 20 && stamp.ends_with('Z') && stamp.parse::<Timestamp>().is_ok() =>
        {
            rest
        }
        _ => line,
    };
    let mut clean = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // `ESC [`, parameters, then a final byte from `@` to `~`.
            if chars.next() == Some('[') {
                chars.find(|c| ('@'..='~').contains(c));
            }
        } else {
            clean.push(c);
        }
    }
    clean
}

/// `text`, or its first and last [`CAP`]/2 bytes in whole lines with a note of what is cut.
fn cap(text: &str) -> String {
    if text.len() <= CAP {
        return text.to_owned();
    }
    let half = CAP / 2;
    let head = &text[..text.floor_char_boundary(half)];
    let head = head.rfind('\n').map_or(head, |end| &head[..end]);
    let tail = &text[text.ceil_char_boundary(text.len() - half)..];
    let tail = tail.find('\n').map_or(tail, |start| &tail[start + 1..]);
    let cut = text.len() - head.len() - tail.len();
    format!("{head}\n... ({cut} bytes cut) ...\n{tail}")
}

#[cfg(test)]
mod tests;
