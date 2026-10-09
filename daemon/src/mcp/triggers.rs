//! A thread's schedule and pull request tools (0063), with T3 Code's names and inputs:
//! `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, and
//! `run_scheduled_task_now` through `schedule/*`, and `link_pull_request`,
//! `unlink_pull_request`, `watch_pull_request`, `unwatch_pull_request`, and
//! `list_thread_pull_requests` through `pr/*`. Every caller gets them.

use parallax_protocol::methods::{
    PrLink, PrUnlink, PrUnwatch, PrWatch, PrWatches, ScheduleDelete, ScheduleList, ScheduleRun,
    ScheduleSave, ThreadList,
};
use parallax_protocol::{
    AccountChoice, AgentRun, PrViewParams, PrWatchesParams, RunId, Schedule, ScheduleIdParams,
    ScheduleListParams, ScheduleSaveParams, ScheduledTask, ThreadListParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::{Binding, find_run};
use super::{MAX_TEXT_BYTES, check_text, parse, pretty};
use crate::worktree::github_pr_urls;

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
];

/// What `link_pull_request` and `list_thread_pull_requests` remind the agent of, as T3's do.
const REGISTER: &str = "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

/// The tools' definitions, in [`TOOLS`]' order.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one schema per tool, read side by side"
)]
pub fn definitions() -> Vec<Value> {
    let object = |properties: Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        })
    };
    let tool = |name: &str, description: &str, schema: Value, read_only: bool| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "annotations": {"readOnlyHint": read_only, "destructiveHint": false},
        })
    };
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
                "description": "For webhook: an HMAC-SHA256 signature every request must carry over its raw body. GitHub's is {header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secret}.",
                "properties": {
                    "header": {"type": "string"},
                    "encoding": {"type": "string", "enum": ["hex", "base64"]},
                    "prefix": {"type": "string"},
                    "secret": {"type": "string", "description": "The shared secret the user gave you. Omit on an update to keep the stored one."},
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
            "Create work that runs on a schedule, even when no turn is active. Report the returned nextRunAt. A webhook run sees its request only through prompt placeholders: {{body.path}} (such as {{body.action}} or {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). For a sender that signs requests, ask the user for its secret and set signature. Give the user the result's webhookUrl; when it is absent, remote access is off on this host, so tell the user to turn it on in Settings > Connections, or share webhookPath for a sender on this network. By default each run posts into this thread; use bindToCurrentThread=false only when the user wants a fresh thread per run. A fresh thread uses this thread's repository, model, effort, and access, and in a Project, each run goes to the Project's coordinator.",
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
            "Have Parallax watch an open pull request for this thread, linking it first if needed. Parallax checks it every two minutes and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor a pull request instead of polling, sleeping, or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision. When you hand the work back to the user, call unwatch_pull_request first. Watching ends when the pull request merges or closes, when its thread settles or is archived, when Parallax fails to read it 8 times in a row (a rate limit only delays it), after 10 comment-only wakes in a row, or when you call unwatch_pull_request. Unsettle the thread before starting a new watch.",
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
    ]
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ThreadArgs {
    #[serde(default)]
    thread_id: Option<RunId>,
}

/// Runs tool `name`, one of [`TOOLS`], for the caller bound in `binding`.
#[expect(clippy::too_many_lines, reason = "one arm per tool")]
pub(super) async fn call(
    binding: &Binding,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    let plxd = &binding.plxd;
    match name {
        "schedule_task" => {
            let ScheduleArgs {
                prompt,
                schedule,
                title,
                enabled,
                bind_to_current_thread,
            } = parse(arguments)?;
            check_text("prompt", &prompt, MAX_TEXT_BYTES)?;
            let title = title.unwrap_or_else(|| first_line(&prompt));
            let mut params = ScheduleSaveParams {
                id: None,
                title,
                prompt,
                enabled: enabled.unwrap_or(true),
                schedule,
                thread: None,
                project: None,
                repo: None,
                account: None,
                model: None,
                effort: None,
                permission: None,
            };
            bind(binding, &mut params, bind_to_current_thread.unwrap_or(true)).await?;
            let task = plxd.call::<ScheduleSave>(params).await?;
            Ok(pretty(&shown(&task)))
        }
        "list_scheduled_tasks" => {
            let tasks = plxd
                .call::<ScheduleList>(ScheduleListParams {})
                .await?
                .tasks;
            Ok(pretty(
                &json!({"tasks": tasks.iter().map(shown).collect::<Vec<_>>()}),
            ))
        }
        "update_scheduled_task" => {
            let UpdateArgs {
                scheduled_task_id,
                prompt,
                title,
                schedule,
                enabled,
                bind_to_current_thread,
            } = parse(arguments)?;
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
                project: task.project,
                repo: task.repo,
                account: task.account,
                model: task.model,
                effort: task.effort,
                permission: task.permission,
            };
            if let Some(bound) = bind_to_current_thread {
                bind(binding, &mut params, bound).await?;
            }
            let task = plxd.call::<ScheduleSave>(params).await?;
            Ok(pretty(&shown(&task)))
        }
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
            let run_id = thread_id.unwrap_or(binding.run);
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
        _ => {
            let target: TargetArgs = parse(arguments)?;
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
    }
}

/// Points a task at the caller's thread, or with `bound` false, at a fresh thread like it: in its
/// repository with its model, effort, and access, or in a Project, at the coordinator.
async fn bind(
    binding: &Binding,
    params: &mut ScheduleSaveParams,
    bound: bool,
) -> Result<(), String> {
    params.thread = None;
    params.project = None;
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
        None => params.project = Some(caller.project),
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
    use super::{TOOLS, TargetArgs, definitions, first_line, target_url};

    #[test]
    fn the_definitions_list_every_tool_in_order() {
        let listed: Vec<String> = definitions()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(listed, TOOLS);
    }

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
        assert_eq!(first_line("  Check CI\nand more"), "Check CI");
    }
}
