//! A thread's schedule and pull request tools (0063), with T3 Code's names and inputs:
//! `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, and
//! `run_scheduled_task_now` through `schedule/*`, and `link_pull_request`,
//! `unlink_pull_request`, `watch_pull_request`, `unwatch_pull_request`, and
//! `list_thread_pull_requests` through `pr/*`, and Parallax's own `pull_request_status`
//! (PLX-837), `ci_failure_log` (PLX-1019), `upload_pr_media` (PLX-1020), `pull_request_diff`
//! (PLX-1021), `github_budget` (PLX-1023), and the paced writes `pull_request_comment`,
//! `pull_request_review`, `pull_request_edit`, `reply_to_review_thread`, and `merge_when_ready`
//! (PLX-1022). Every caller gets them, and [`INSTRUCTIONS`], which tell the agent to use them
//! instead of `gh`.

use parallax_protocol::methods::{
    PrFailureLog, PrLink, PrMergeWhenReady, PrSharedDiff, PrStatus, PrUnlink, PrUnwatch, PrWatch,
    PrWatches, PrWrite as WritePr, ScheduleDelete, ScheduleList, ScheduleRun, ScheduleSave,
    ThreadList,
};
use parallax_protocol::{
    AccountChoice, AgentRun, PrFailureLogParams, PrMergeWhenReadyParams, PrViewParams,
    PrWatchesParams, PrWriteParams, RunId, Schedule, ScheduleIdParams, ScheduleListParams,
    ScheduleSaveParams, ScheduledTask, ThreadListParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::{Binding, find_run};
use super::{MAX_RESULT_BYTES, MAX_TEXT_BYTES, check_text, object, parse, pretty, tool};
use crate::worktree::{agent_diff, github_pr_urls};

/// The tools this module serves, in [`definitions`]' order.
pub const TOOLS: &[&str] = &[
    "schedule_task",
    "list_scheduled_tasks",
    "update_scheduled_task",
    "delete_scheduled_task",
    "run_scheduled_task_now",
    "link_pull_request",
    "unlink_pull_request",
    "watch_pull_request",
    "unwatch_pull_request",
    "list_thread_pull_requests",
    "pull_request_status",
    "ci_failure_log",
    "upload_pr_media",
    "pull_request_diff",
    "github_budget",
    "pull_request_comment",
    "pull_request_review",
    "pull_request_edit",
    "reply_to_review_thread",
    "merge_when_ready",
];

/// What every thread's agent is told at startup, through MCP's `instructions`, as T3 Code's
/// runtime instructions tell it (PLX-837): without it, each agent reads and waits on its pull
/// requests its own way, with `gh` loops, sleeps, and watchers that spend the shared GitHub quota.
pub const INSTRUCTIONS: &str = "Parallax is your GitHub integration for pull requests. Register every pull request you open or work on with link_pull_request, each layer of a stack included. Read a pull request's title, body, branches, head commit, changed files, checks with their links and Actions run ids, reviews, unresolved review threads with their ids, conflicts, and whether it is ready to merge with pull_request_status, never gh pr view or gh pr checks. Read its diff, or only some files' diff, with pull_request_diff, never gh pr diff: one read per head serves every thread. To wait on CI or reviews, or when asked to monitor, watch, or babysit a pull request, call watch_pull_request and end your turn: Parallax wakes you when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict. Never poll, sleep, or run your own watcher, such as gh pr checks --watch, gh run watch, or a loop. Read why a check failed with ci_failure_log, not gh run list, gh run view --log-failed, or gh api: it returns each failed job's error lines and reads each log from GitHub once. Check how much of the shared GitHub quota is left with github_budget. Comment on, review, or edit the title or body of a pull request, and reply to or resolve a review thread, with pull_request_comment, pull_request_review, pull_request_edit, and reply_to_review_thread, never gh pr comment, gh pr review, gh pr edit, or gh api graphql: Parallax paces every pull request write on this host so parallel agents don't hit GitHub's secondary rate limit. To merge, call merge_when_ready and end your turn, never gh pr merge, gh pr merge --auto, or gh pr checks followed by gh pr merge: Parallax merges once the pull request is ready and wakes you with the result. Use gh only for what these tools don't do, such as opening a pull request.";

/// What `link_pull_request` and `list_thread_pull_requests` remind the agent of, as T3's do.
const REGISTER: &str = "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

/// The tools' definitions, in [`TOOLS`]' order.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one schema per tool, read side by side"
)]
pub fn definitions() -> Vec<Value> {
    let schedule = json!({
        "type": "object",
        "description": "The trigger, as an object, never JSON text: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings in the host's time zone; {type:'webhook'} runs once per request to a generated URL.",
        "properties": {
            "type": {"type": "string", "enum": ["interval", "fixed_time", "webhook"]},
            "everyMs": {"type": "integer", "minimum": 60000, "description": "For interval: milliseconds between runs, at least 60000."},
            "timeOfDay": {"type": "string", "description": "For fixed_time: HH:MM, 24-hour."},
            "weekdays": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 6}, "description": "For fixed_time: 0 is Sunday. Omit for every day."},
            "signature": {
                "type": "object",
                "description": "For webhook: an HMAC-SHA256 signature every request must carry over its raw body. GitHub's is {header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}.",
                "properties": {
                    "header": {"type": "string"},
                    "encoding": {"type": "string", "enum": ["hex", "base64"]},
                    "prefix": {"type": "string"},
                    "secretRef": {"type": "string", "description": "The secretRef request_secret returned, which this save uses up. Omit on an update to keep the stored secret."},
                },
                "required": ["header", "encoding", "prefix"],
                "additionalProperties": false,
            },
        },
        "required": ["type"],
        "additionalProperties": false,
    });
    let id = json!({"type": "string", "description": "The task's scheduledTaskId, from list_scheduled_tasks."});
    let bind = json!({"type": "boolean", "description": "True (the default) posts each run into this thread; false launches a fresh thread per run."});
    let target = || {
        object(
            json!({
                "threadId": {"type": "string", "description": "The thread's run id. Omit for this thread."},
                "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/123. Preferred when you have it."},
                "repository": {"type": "string", "description": "owner/repo. With number, when url is omitted."},
                "number": {"type": "integer", "minimum": 1, "description": "The pull request's number. With repository, when url is omitted."},
                "host": {"type": "string", "description": "github.com, the only host Parallax reads."},
            }),
            &[],
        )
    };
    vec![
        tool(
            "schedule_task",
            "Create work that runs on a schedule, even when no turn is active. Report the returned nextRunAt. A webhook run sees its request only through prompt placeholders: {{body.path}} (such as {{body.action}} or {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef. Give the user the result's webhookUrl; when it is absent, remote access is off on this host, so tell the user to turn it on in Settings > Connections, or share webhookPath for a sender on this network. By default each run posts into this thread; use bindToCurrentThread=false only when the user wants a fresh thread per run. A fresh thread uses this thread's repository, model, effort, and access, and in an orchestrator, each run goes to the orchestrator.",
            object(
                json!({
                    "prompt": {"type": "string", "description": "What each run sends, at most 64 KiB."},
                    "schedule": schedule,
                    "title": {"type": "string", "description": "A short name. Defaults to the prompt's first line."},
                    "enabled": {"type": "boolean", "description": "Whether it starts enabled. Defaults to true."},
                    "bindToCurrentThread": bind,
                }),
                &["prompt", "schedule"],
            ),
            false,
        ),
        tool(
            "list_scheduled_tasks",
            "List the scheduled tasks on this host, with each one's id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the scheduledTaskId with update_scheduled_task, delete_scheduled_task, or run_scheduled_task_now.",
            object(json!({}), &[]),
            true,
        ),
        tool(
            "update_scheduled_task",
            "Update a scheduled task. Only the fields you pass change. Use enabled=false to pause it without deleting it.",
            object(
                json!({
                    "scheduledTaskId": id,
                    "prompt": {"type": "string"},
                    "title": {"type": "string"},
                    "schedule": schedule,
                    "enabled": {"type": "boolean"},
                    "bindToCurrentThread": bind,
                }),
                &["scheduledTaskId"],
            ),
            false,
        ),
        tool(
            "delete_scheduled_task",
            "Delete a scheduled task for good; it stops at once. To keep it but stop its runs, use update_scheduled_task with enabled=false.",
            object(json!({"scheduledTaskId": id}), &["scheduledTaskId"]),
            false,
        ),
        tool(
            "run_scheduled_task_now",
            "Run a scheduled task once now, whether or not it is enabled. Its next scheduled run moves to one interval from now.",
            object(json!({"scheduledTaskId": id}), &["scheduledTaskId"]),
            false,
        ),
        tool(
            "link_pull_request",
            &format!(
                "{REGISTER} Links a pull request to a thread so Parallax shows it beside the thread. Linking one already linked succeeds with alreadyLinked=true."
            ),
            target(),
            false,
        ),
        tool(
            "unlink_pull_request",
            "Remove a pull request link from a thread, such as after closing one you opened by mistake. It also stops watching it. Unlinking one that isn't linked succeeds with wasLinked=false.",
            target(),
            false,
        ),
        tool(
            "watch_pull_request",
            "Have Parallax watch an open pull request for this thread, linking it first if needed. Parallax checks it every two minutes and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor a pull request instead of polling, sleeping, or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: call pull_request_status for that. When you hand the work back to the user, call unwatch_pull_request first. Watching ends when the pull request merges or closes, when its thread settles or is archived (an orchestrator's keeps watching, and wakes with the news), when Parallax fails to read it 8 times in a row (a rate limit only delays it), after 10 comment-only wakes in a row, or when you call unwatch_pull_request. Unsettle the thread before starting a new watch.",
            target(),
            false,
        ),
        tool(
            "unwatch_pull_request",
            "Stop Parallax watching a pull request for a thread. It stays linked.",
            target(),
            false,
        ),
        tool(
            "list_thread_pull_requests",
            &format!(
                "List the pull requests linked to a thread, and whether Parallax watches each. {REGISTER}"
            ),
            object(
                json!({"threadId": {"type": "string", "description": "The thread's run id. Omit for this thread."}}),
                &[],
            ),
            true,
        ),
        tool(
            "pull_request_status",
            "Read a pull request from GitHub and say whether it is ready to merge. Returns its title, body, state, draft, head commit, head and base branches, changed files with lines added and deleted, commits behind the base, mergeability, merge state, review decision, failing, pending, and passed checks, every check with its link and Actions run id, unresolved review threads with their ids and links, whether Parallax watches it for this thread, and ready with the reasons it isn't. Ready means open, not a draft, no conflict, not behind its base, every check on the head passed, no unresolved review thread, and no change requested. Use this instead of gh pr view, gh pr checks, or gh api to check a pull request, and after each watch_pull_request wake. It needn't be linked. A read under 30 seconds old, by any thread, can answer, but ready always comes from a fresh read. Right after a push the answer can predate the push or show the head with no checks yet, and neither is ready: watch it and end your turn.",
            target(),
            true,
        ),
        tool(
            "ci_failure_log",
            "Read why a pull request's checks failed: for each failed check on its head commit, its name, how it failed, its workflow run and job ids, its link, and its log cut to the lines around errors, failures, and panics. Use this instead of gh run list, gh run view --log-failed, or gh api for a job's log: Parallax reads each job's log from GitHub once per head commit and keeps it, so call it again freely. Pass check to read only the failed checks whose name contains it. A spent GitHub rate limit is an error saying when it resets; don't retry with gh before then.",
            object(
                json!({
                    "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/123. Preferred when you have it."},
                    "repository": {"type": "string", "description": "owner/repo. With number, when url is omitted."},
                    "number": {"type": "integer", "minimum": 1, "description": "The pull request's number. With repository, when url is omitted."},
                    "host": {"type": "string", "description": "github.com, the only host Parallax reads."},
                    "check": {"type": "string", "description": "Only failed checks whose name contains this, ignoring case. Omit for all."},
                }),
                &[],
            ),
            true,
        ),
        tool(
            "upload_pr_media",
            "Upload screenshots, GIFs, or videos for a pull request's body and get links that render on GitHub. Use this instead of the upload-media-pr skill's upload.sh, gh api, or committing media yourself: Parallax uploads one file at a time per host and reuses the link without uploading for bytes already uploaded to the repository. A call takes under a minute: when the upload queue is busy or GitHub rate limits it, it fails saying when to call again, and the files that finished are kept. Pass the pull request's URL and absolute paths to png, jpg, jpeg, gif, webp, mp4, mov, or webm files of at most 25 MB each, with an optional caption each (the file name by default). Each file comes back with a raw.githubusercontent.com URL pinned to a commit and a markdown line to paste into the body as is: an image embed, or a link for a video, since GitHub only plays videos it hosts. Upload all of a pull request's files in one call. Links from raw.githubusercontent.com render only for public repositories.",
            object(
                json!({
                    "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/123. The files go to its repository."},
                    "files": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "The file's absolute path."},
                                "caption": {"type": "string", "description": "The embed's text. The file name when omitted."},
                            },
                            "required": ["path"],
                            "additionalProperties": false,
                        },
                    },
                }),
                &["url", "files"],
            ),
            false,
        ),
        tool(
            "pull_request_diff",
            "Read a pull request's unified diff, as gh pr diff prints it, or only the files at or under paths. Parallax reads it from GitHub once per head commit and shares it with every thread, so the author and each reviewer cost one read. Use this instead of gh pr diff. It needn't be linked. A diff too long for one answer is cut at a line's end with a note: pass paths to read the rest.",
            {
                let mut schema = target();
                if let Some(properties) = schema["properties"].as_object_mut() {
                    properties.remove("threadId");
                }
                schema["properties"]["paths"] = json!({"type": "array", "items": {"type": "string"}, "description": "Files or folders, relative to the repository's root, such as src/main.rs or docs. Omit for the whole diff."});
                schema
            },
            true,
        ),
        tool(
            "github_budget",
            "How much of the GitHub quota every agent on this computer shares is left: the REST and GraphQL requests remaining, when each resets, and when Parallax saw each (seenAt), which shows its age: Parallax reads it again when it is over 60 seconds old, unless that read fails or gh isn't installed, when the answer can be older or empty. Use this instead of gh api rate_limit. When one is low, wait for its reset instead of retrying: under 200, gh refuses reads that spend it.",
            object(json!({}), &[]),
            true,
        ),
        tool(
            "pull_request_comment",
            &format!("Comment on a pull request's conversation. {PACED}"),
            written(
                json!({"body": {"type": "string", "description": "The comment, in Markdown."}}),
                &["body"],
            ),
            false,
        ),
        tool(
            "pull_request_review",
            &format!(
                "Review a pull request: comment, approve, or request changes, with a body. {PACED}"
            ),
            written(
                json!({
                    "event": {"type": "string", "enum": ["comment", "approve", "requestChanges"], "description": "The verdict."},
                    "body": {"type": "string", "description": "The review, in Markdown. Required to comment or request changes."},
                }),
                &["event", "body"],
            ),
            false,
        ),
        tool(
            "pull_request_edit",
            &format!("Change a pull request's title, body, or both. {PACED}"),
            written(
                json!({
                    "title": {"type": "string", "description": "The new title."},
                    "body": {"type": "string", "description": "The new body, in Markdown, replacing the old one."},
                }),
                &[],
            ),
            false,
        ),
        tool(
            "reply_to_review_thread",
            &format!(
                "Reply to a review thread on a pull request, resolve it, or both, by the thread id pull_request_status lists under unresolvedThreads. {PACED}"
            ),
            written(
                json!({
                    "reviewThreadId": {"type": "string", "description": "The review thread's id, such as PRRT_kwDO..., from pull_request_status."},
                    "body": {"type": "string", "description": "The reply, in Markdown. Omit to resolve without replying."},
                    "resolve": {"type": "boolean", "description": "Resolve the thread, after the reply. Defaults to false."},
                }),
                &["reviewThreadId"],
            ),
            false,
        ),
        tool(
            "merge_when_ready",
            "Have Parallax merge a pull request once it is ready, then wake you with the result; use this instead of gh pr merge, gh pr merge --auto, or polling checks. It watches the pull request for this thread as watch_pull_request does, and returns at once, so end your turn. Within about two minutes of it being ready, Parallax reads it again and merges it with method, only if its head is still the one it judged. Ready is pull_request_status's ready, except that being behind the base only holds it when the base requires branches to be up to date. It never merges a draft, a conflict, a pending or failing check, a GitHub Actions workflow still running, an unresolved review thread, or requested changes. On a base with a merge queue it queues the pull request instead, and says so. If GitHub refuses the merge, the wake says why. A registered merge survives plxd restarts. It is dropped when the watch ends: when this thread settles or is archived, the pull request closes, the watch reaches 10 comment-only wakes in a row, Parallax fails to read the pull request 8 times in a row, or you call unwatch_pull_request.",
            object(
                json!({
                    "threadId": {"type": "string", "description": "The thread to wake. Omit for this thread."},
                    "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/123. Preferred when you have it."},
                    "repository": {"type": "string", "description": "owner/repo. With number, when url is omitted."},
                    "number": {"type": "integer", "minimum": 1, "description": "The pull request's number. With repository, when url is omitted."},
                    "host": {"type": "string", "description": "github.com, the only host Parallax reads."},
                    "method": {"type": "string", "enum": ["merge", "squash", "rebase"], "description": "How to merge it."},
                }),
                &["method"],
            ),
            false,
        ),
    ]
}

/// What each pull request write tool says about the queue.
const PACED: &str = "Use this instead of gh or gh api: Parallax sends every pull request write on this host through one queue, a second apart, and backs off GitHub's secondary rate limit, so a call can take up to a minute. A busy queue or a rate limit is an error saying when to call again; don't retry with gh. It needn't be linked.";

/// A pull request write tool's schema: the pull request, and `own`, its own fields.
fn written(own: Value, required: &[&str]) -> Value {
    let mut properties = json!({
        "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/123. Preferred when you have it."},
        "repository": {"type": "string", "description": "owner/repo. With number, when url is omitted."},
        "number": {"type": "integer", "minimum": 1, "description": "The pull request's number. With repository, when url is omitted."},
        "host": {"type": "string", "description": "github.com, the only host Parallax reads."},
    });
    if let (Some(properties), Value::Object(own)) = (properties.as_object_mut(), own) {
        properties.extend(own);
    }
    object(properties, required)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScheduleArgs {
    prompt: String,
    schedule: Schedule,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    bind_to_current_thread: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateArgs {
    scheduled_task_id: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    schedule: Option<Schedule>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    bind_to_current_thread: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskArgs {
    scheduled_task_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TargetArgs {
    #[serde(default)]
    thread_id: Option<RunId>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    host: Option<String>,
}

/// `pull_request_diff`'s arguments: a [`TargetArgs`] without a thread, and the paths to read.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiffArgs {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadArgs {
    #[serde(default)]
    thread_id: Option<RunId>,
}

/// Runs tool `name`, one of [`TOOLS`], for the caller bound in `binding`.
pub(super) async fn call(
    binding: &Binding,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    let plxd = &binding.plxd;
    match name {
        "schedule_task" => schedule(binding, parse(arguments)?).await,
        "list_scheduled_tasks" => {
            let tasks = plxd
                .call::<ScheduleList>(ScheduleListParams {})
                .await?
                .tasks;
            Ok(pretty(
                &json!({"tasks": tasks.iter().map(shown).collect::<Vec<_>>()}),
            ))
        }
        "update_scheduled_task" => update(binding, parse(arguments)?).await,
        "delete_scheduled_task" => {
            let TaskArgs { scheduled_task_id } = parse(arguments)?;
            let deleted = plxd
                .call::<ScheduleDelete>(ScheduleIdParams {
                    id: scheduled_task_id.clone(),
                })
                .await?
                .deleted;
            Ok(pretty(
                &json!({"scheduledTaskId": scheduled_task_id, "deleted": deleted}),
            ))
        }
        "run_scheduled_task_now" => {
            let TaskArgs { scheduled_task_id } = parse(arguments)?;
            let task = plxd
                .call::<ScheduleRun>(ScheduleIdParams {
                    id: scheduled_task_id,
                })
                .await?;
            Ok(pretty(&shown(&task)))
        }
        "list_thread_pull_requests" => {
            let ThreadArgs { thread_id } = parse(arguments)?;
            pull_requests(binding, thread_id.unwrap_or(binding.run)).await
        }
        "github_budget" => {
            let data_dir = binding.data_dir.clone();
            let budget = tokio::task::spawn_blocking(move || crate::gh_shim::budget(&data_dir))
                .await
                .map_err(|error| error.to_string())?;
            Ok(pretty(&budget))
        }
        "ci_failure_log" => {
            // `check`, then the rest as any pull request tool's target.
            let mut arguments = arguments;
            let check = arguments
                .as_object_mut()
                .and_then(|args| args.remove("check"));
            let check = check.map(parse::<String>).transpose()?;
            let url = target_url(parse(arguments)?)?;
            let params = PrFailureLogParams { url, check };
            Ok(pretty(&plxd.call::<PrFailureLog>(params).await?))
        }
        "upload_pr_media" => Ok(pretty(
            &plxd
                .call::<parallax_protocol::methods::PrUploadMedia>(parse(arguments)?)
                .await?,
        )),
        "pull_request_diff" => {
            let DiffArgs {
                url,
                repository,
                number,
                host,
                paths,
            } = parse(arguments)?;
            let url = target_url(TargetArgs {
                thread_id: None,
                url,
                repository,
                number,
                host,
            })?;
            let params = PrViewParams {
                run_id: binding.run,
                url,
            };
            let read = plxd.call::<PrSharedDiff>(params).await?;
            Ok(agent_diff(read, &paths, MAX_RESULT_BYTES))
        }
        "pull_request_comment"
        | "pull_request_review"
        | "pull_request_edit"
        | "reply_to_review_thread"
        | "merge_when_ready" => write(binding, name, arguments).await,
        _ => pull_request(binding, name, parse(arguments)?).await,
    }
}

/// The paced write tools (PLX-1022): `pull_request_comment`, `pull_request_review`,
/// `pull_request_edit`, `reply_to_review_thread`, and `merge_when_ready`.
async fn write(binding: &Binding, name: &str, arguments: Value) -> Result<String, String> {
    let plxd = &binding.plxd;
    match name {
        "pull_request_comment"
        | "pull_request_review"
        | "pull_request_edit"
        | "reply_to_review_thread" => {
            let (kind, keys): (&str, &[&str]) = match name {
                "pull_request_comment" => ("comment", &["body"]),
                "pull_request_review" => ("review", &["event", "body"]),
                "pull_request_edit" => ("edit", &["title", "body"]),
                _ => ("replyToThread", &["reviewThreadId", "body", "resolve"]),
            };
            let (mut own, target) = split(arguments, keys);
            own.insert("kind".to_owned(), json!(kind));
            let write = parse(Value::Object(own))?;
            let url = target_url(parse(target)?)?;
            plxd.call::<WritePr>(PrWriteParams {
                url: url.clone(),
                write,
            })
            .await?;
            let mut answer = identity(&url);
            answer["sent"] = json!(kind);
            Ok(pretty(&answer))
        }
        "merge_when_ready" => {
            let (mut own, target) = split(arguments, &["method"]);
            let method = parse(own.remove("method").unwrap_or_default())?;
            let target: TargetArgs = parse(target)?;
            let run_id = target.thread_id.unwrap_or(binding.run);
            let url = target_url(target)?;
            let params = PrMergeWhenReadyParams {
                run_id,
                url: url.clone(),
                method,
            };
            let result = plxd.call::<PrMergeWhenReady>(params).await?;
            let mut answer = identity(&url);
            answer["merge"] = json!(method);
            answer["watching"] = json!(result.watching);
            answer["wasWatching"] = json!(result.was_watching);
            Ok(pretty(&answer))
        }
        other => Err(format!("no tool is named {other:?}")),
    }
}

/// `schedule_task`: a new task, bound to the caller's thread unless asked otherwise.
async fn schedule(binding: &Binding, args: ScheduleArgs) -> Result<String, String> {
    let ScheduleArgs {
        prompt,
        schedule,
        title,
        enabled,
        bind_to_current_thread,
    } = args;
    check_text("prompt", &prompt, MAX_TEXT_BYTES)?;
    let title = title.unwrap_or_else(|| first_line(&prompt));
    let mut params = ScheduleSaveParams {
        id: None,
        title,
        prompt,
        enabled: enabled.unwrap_or(true),
        schedule,
        thread: None,
        orchestrator: None,
        repo: None,
        account: None,
        model: None,
        effort: None,
        permission: None,
        from: Some(binding.run),
    };
    bind(binding, &mut params, bind_to_current_thread.unwrap_or(true)).await?;
    let task = binding.plxd.call::<ScheduleSave>(params).await?;
    Ok(pretty(&shown(&task)))
}

/// `update_scheduled_task`: the task with the fields `args` passes changed.
async fn update(binding: &Binding, args: UpdateArgs) -> Result<String, String> {
    let UpdateArgs {
        scheduled_task_id,
        prompt,
        title,
        schedule,
        enabled,
        bind_to_current_thread,
    } = args;
    let plxd = &binding.plxd;
    let tasks = plxd
        .call::<ScheduleList>(ScheduleListParams {})
        .await?
        .tasks;
    let task = tasks
        .into_iter()
        .find(|task| task.id == scheduled_task_id)
        .ok_or_else(|| format!("no scheduled task has id {scheduled_task_id}"))?;
    if let Some(prompt) = &prompt {
        check_text("prompt", prompt, MAX_TEXT_BYTES)?;
    }
    let mut params = ScheduleSaveParams {
        id: Some(task.id),
        title: title.unwrap_or(task.title),
        prompt: prompt.unwrap_or(task.prompt),
        enabled: enabled.unwrap_or(task.enabled),
        schedule: schedule.unwrap_or(task.schedule),
        thread: task.thread,
        orchestrator: task.orchestrator,
        repo: task.repo,
        account: task.account,
        model: task.model,
        effort: task.effort,
        permission: task.permission,
        from: Some(binding.run),
    };
    if let Some(bound) = bind_to_current_thread {
        bind(binding, &mut params, bound).await?;
    }
    let task = plxd.call::<ScheduleSave>(params).await?;
    Ok(pretty(&shown(&task)))
}

/// `list_thread_pull_requests`: thread `run_id`'s pull requests, and whether each is watched.
async fn pull_requests(binding: &Binding, run_id: RunId) -> Result<String, String> {
    let plxd = &binding.plxd;
    let run = find_run(plxd, run_id).await?;
    let watched = plxd
        .call::<PrWatches>(PrWatchesParams { run_id })
        .await?
        .urls;
    let listed: Vec<Value> = run
        .pull_requests
        .iter()
        .map(|url| {
            let mut entry = identity(url);
            entry["watching"] = json!(watched.contains(url));
            entry
        })
        .collect();
    Ok(pretty(&json!({"pullRequests": listed})))
}

/// The tools on one pull request: linking, unlinking, watching, unwatching, and its status.
async fn pull_request(binding: &Binding, name: &str, target: TargetArgs) -> Result<String, String> {
    let plxd = &binding.plxd;
    let run_id = target.thread_id.unwrap_or(binding.run);
    let url = target_url(target)?;
    let params = PrViewParams {
        run_id,
        url: url.clone(),
    };
    let mut answer = identity(&url);
    match name {
        "link_pull_request" | "unlink_pull_request" => {
            let before = find_run(plxd, run_id).await?.pull_requests.contains(&url);
            if name == "link_pull_request" {
                plxd.call::<PrLink>(params).await?;
                answer["alreadyLinked"] = json!(before);
            } else {
                plxd.call::<PrUnlink>(params).await?;
                answer["wasLinked"] = json!(before);
            }
        }
        "pull_request_status" => return Ok(pretty(&plxd.call::<PrStatus>(params).await?)),
        "watch_pull_request" | "unwatch_pull_request" => {
            let result = if name == "watch_pull_request" {
                plxd.call::<PrWatch>(params).await?
            } else {
                plxd.call::<PrUnwatch>(params).await?
            };
            answer["watching"] = json!(result.watching);
            answer["wasWatching"] = json!(result.was_watching);
        }
        other => return Err(format!("no tool is named {other:?}")),
    }
    Ok(pretty(&answer))
}

/// Points a task at the caller's thread, or with `bound` false, at a fresh thread like it: in its
/// repository with its model, effort, and access, or in an orchestrator, at the orchestrator.
async fn bind(
    binding: &Binding,
    params: &mut ScheduleSaveParams,
    bound: bool,
) -> Result<(), String> {
    params.thread = None;
    params.orchestrator = None;
    params.repo = None;
    if bound {
        params.thread = Some(binding.run);
        return Ok(());
    }
    let plxd = &binding.plxd;
    let caller = find_run(plxd, binding.run).await?;
    let listed = plxd.call::<ThreadList>(ThreadListParams {}).await?;
    match listed
        .threads
        .iter()
        .find(|thread| thread.id == binding.run)
    {
        Some(thread) => {
            params.repo = listed
                .repos
                .iter()
                .find(|repo| repo.id == thread.repo && !repo.scratch)
                .map(|repo| repo.id);
        }
        None => params.orchestrator = Some(caller.project),
    }
    inherit(params, &caller);
    Ok(())
}

/// A fresh thread's account, model, effort, and access, from `caller`'s.
fn inherit(params: &mut ScheduleSaveParams, caller: &AgentRun) {
    params.account = Some(if caller.account_id == caller.backend {
        AccountChoice::Subscription {
            backend: caller.backend.clone(),
        }
    } else {
        match caller.account_id.parse() {
            Ok(id) => AccountChoice::Key { id },
            Err(_) => AccountChoice::Subscription {
                backend: caller.backend.clone(),
            },
        }
    });
    params.model.clone_from(&caller.model);
    params.effort = caller.effort;
    params.permission = caller.permission;
}

/// A task as T3's tools show one.
fn shown(task: &ScheduledTask) -> Value {
    let mut shown = json!({
        "scheduledTaskId": task.id,
        "title": task.title,
        "prompt": task.prompt,
        "enabled": task.enabled,
        "schedule": task.schedule,
        "boundThreadId": task.thread,
        "nextRunAt": task.next_run_at,
        "lastRunStatus": task.last_run_status,
    });
    if let Some(error) = &task.last_run_error {
        shown["lastRunError"] = json!(error);
    }
    if let Some(webhook) = &task.webhook {
        shown["webhookPath"] = json!(webhook.path);
        if let Some(url) = &webhook.url {
            shown["webhookUrl"] = json!(url);
        }
        shown["webhookSignature"] = json!(if webhook.has_secret { "set" } else { "none" });
    }
    shown
}

/// The prompt's first line, cut to a title's length.
fn first_line(prompt: &str) -> String {
    let line = prompt.trim().lines().next().unwrap_or_default();
    let end = line.floor_char_boundary(80);
    line[..end].to_owned()
}

/// The pull request a target names: its URL, or its repository and number on github.com.
fn target_url(target: TargetArgs) -> Result<String, String> {
    if target
        .host
        .as_deref()
        .is_some_and(|host| !host.eq_ignore_ascii_case("github.com"))
    {
        return Err("Parallax reads pull requests on github.com only".to_owned());
    }
    let url = match (target.url, target.repository, target.number) {
        (Some(url), _, _) => url.trim().to_owned(),
        (None, Some(repository), Some(number)) => {
            format!("https://github.com/{}/pull/{number}", repository.trim())
        }
        _ => return Err("pass either url, or both repository and number".to_owned()),
    };
    if github_pr_urls(&url) != [url.as_str()] {
        return Err(format!(
            "{url:?} is not a GitHub pull request URL; pass repository and number instead"
        ));
    }
    Ok(url)
}

/// `arguments` with `keys` taken out into their own object, then the rest, which names the pull
/// request.
fn split(mut arguments: Value, keys: &[&str]) -> (serde_json::Map<String, Value>, Value) {
    let own = arguments
        .as_object_mut()
        .map(|args| {
            keys.iter()
                .filter_map(|key| Some(((*key).to_owned(), args.remove(*key)?)))
                .collect()
        })
        .unwrap_or_default();
    (own, arguments)
}

/// A pull request URL's host, repository, number, and URL.
fn identity(url: &str) -> Value {
    let parts: Vec<&str> = url
        .trim_start_matches("https://github.com/")
        .split('/')
        .collect();
    json!({
        "host": "github.com",
        "repository": parts.get(..2).map(|parts| parts.join("/")),
        "number": parts.get(3).and_then(|number| number.parse::<u64>().ok()),
        "url": url,
    })
}

#[cfg(test)]
mod tests {
    use super::{TargetArgs, target_url};

    #[test]
    fn a_target_is_a_url_or_a_repository_and_number() {
        let target = |url: Option<&str>, repository: Option<&str>, number, host: Option<&str>| {
            target_url(TargetArgs {
                thread_id: None,
                url: url.map(str::to_owned),
                repository: repository.map(str::to_owned),
                number,
                host: host.map(str::to_owned),
            })
        };
        let url = "https://github.com/ryan/parallax/pull/7";
        assert_eq!(target(Some(url), None, None, None).unwrap(), url);
        assert_eq!(
            target(None, Some("ryan/parallax"), Some(7), None).unwrap(),
            url
        );
        assert!(target(None, Some("ryan/parallax"), None, None).is_err());
        assert!(target(Some("https://example.com/x"), None, None, None).is_err());
        assert!(target(Some(url), None, None, Some("gitlab.com")).is_err());
    }
}
