# 0063: Schedules, webhooks, PR watches, and delegation work as T3 Code's

- Status: accepted; answers PLAN's open question on how triggers wake the coordinator (PLX-59), and supersedes in part [0025](0025-coordinator-wake-ups.md) (wake-ups as their own batched turn, never steered) and [0041](0041-thread-lineage-and-host-mcp.md) (the thread tool set)
- Date: 2026-10-09
- Issue: PLX-636, for PLX-648 and PLX-649

## Context

Parallax has no schedules, webhooks, or PR watches. The only trace is an unknown `trigger.fired` event in a decode test (`crates/parallax-protocol/src/events.rs`). 0046's "scheduler" places children across accounts and has nothing to do with time. A child that ends a CLI process wakes its parent with a summary batched for 2 s and sent as its own turn once the parent is idle, capped at 100 in a row (`daemon/src/agents/wake.rs`, 0025, 0043). `thread_launch` starts a child in a new worktree by default, with a mode that can't need less approval than the caller's (`daemon/src/mcp/thread.rs`). Nothing stops a parent's children when the parent stops. There is no way for an agent to ask the user for a secret.

T3 Code (`apps/server/src/`):

- **Scheduled tasks** (`scheduledTasks/ScheduledTaskService.ts`, `Schedule.ts`): `interval` (`everyMs`, at least 60 s, an overdue interval catches up with one run), `fixed_time` (`timeOfDay` and optional `weekdays`; a run missed by more than 10 minutes is skipped), and `webhook`. A task with no thread launches a new thread per fire. A task bound to a thread queues into it, never interrupting a tool. Each fire has a key (`<id>:<startedAt>:<trigger>`, or `<id>:webhook:<deliveryId>`), and its `commandId` is `scheduled-task:<fire key>`, so a fire can't dispatch twice. A task never overlaps itself. One shared scheduler ticks every 5 s (`scheduling/Scheduler.ts`).
- **Webhooks** are reached at `/api/hooks/<hookId>/<token>`, and publicly through T3 Connect's relay. They keep 50 deliveries, queue at most 20, and accept 60 a minute. An optional HMAC-SHA256 signature is checked in constant time (`webhookVerification.ts`). The prompt template takes `{{body.a.b}}`, `{{headers.x}}`, `{{query.x}}`, `{{body}}`, and `{{request}}`, with credential-named values redacted (`webhookTemplate.ts`).
- **PR watches** (`orchestration-v2/PullRequestWatchReactor.ts`, `pullRequestWatch.ts`): a sweep every 2 minutes wakes the thread when a check newly fails, when the required checks (else all) pass, on a new or edited comment by someone other than the viewer and the PR's author, or when the PR starts to conflict. At most 10 comment-only wakes in a row, and 8 failed reads end the watch. A watch ends when the PR merges or closes, or the thread settles or is archived. The wake is a `message.dispatch` with `queue_after_active`. `PullRequestSyncReactor.ts` refreshes linked PRs' state.
- **Delegation** (`mcp/OrchestratorMcpService.ts`, `packages/provider-core/src/server/subagentProjection.ts`): `delegate_task` needs an active parent run. The child is a new thread with lineage `subagent`, inheriting the parent's project, worktree, and branch, on any provider, with a runtime mode no broader than the parent's (approval < auto < full access). `mode: wait` blocks up to 10 minutes (at most 60) with `completionWake: settled_only`; async uses `always`, and a timed-out wait becomes `always`. Completions are delivered to the parent as one `delegatedCompletion` message per cohort, with no batching delay. The message is steered into the parent's running turn only when every task in it has `completionWake: always`, a turn is running, the provider supports active steering, and its steering doesn't interrupt tools (`activeSteeringInterruptsTools`). Otherwise it is queued (`orchestration-v2/Orchestrator.ts`). `task_status` reads a result and acknowledges it, `task_cancel` sends the internal `thread.stop` command, and `create_threads` and `orchestrator_capabilities` round it out (`mcp/toolkits/orchestrator/tools.ts`).
- **Cascading stop.** Stop is `run.interrupt` with `holdQueue`. It holds the queue, ends PR watches, drops pending wakes, and enqueues `delegated-tasks.stop`, which sends `thread.stop` to every delegated child, depth first (`ThreadManagementService.ts`).
- **request_secret** (`secrets/SecretRequests.ts`, `auth/ServerSecretStore.ts`): the user enters a value in the app, and the agent gets a single-use `secret-ref:<id>` bound to the project, valid 24 hours. Only server tools such as `schedule_task` consume it.
- **Merge back** (`orchestration-v2/Orchestrator.ts`, `ContextHandoffDelivery.ts`) moves a fork's new context back to its source as a `fork_delta_summary` handoff. It is context, not git.

## Decision

plxd does the same, as commands and effects on [0059](0059-orchestration-rewrite.md)'s orchestrator. Each tool is added to `plxd mcp` (0041) with T3's name and inputs where Parallax has no equivalent: `delegate_task`, `task_status`, `task_cancel`, `create_threads`, `orchestrator_capabilities`, `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`, `request_secret`, `thread_merge_back`, `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`, `watch_pull_request`, and `unwatch_pull_request`. `thread_*`, `pr_link`, and `pr_unlink` keep their names. The app gets T3's Schedules view and secret prompt.

### Schedules

- Table `scheduled_tasks`, with T3's three kinds, rules, and fire keys. A fire is `message.dispatch` with `scheduled-task:<fire key>` as its `commandId`: a new thread in the task's repository or Project, or a queued message on its bound thread.
- One timer for the earliest due task, re-armed when a task changes or fires. With no tasks there is no timer. T3's 5 s tick is left out.
- A task owned by a Project fires into the coordinator, so schedules are the coordinator's triggers from PLAN.

### Webhooks

- `/api/hooks/<hookId>/<token>` on plxd's HTTP listener ([0065](0065-remote-reach.md)). Publicly it is reached through the relay's `/v1/hooks/...`, which can hold deliveries while plxd is offline. T3's limits, signature check, and template syntax apply.

### PR watches

- `watch_pull_request` on a linked PR (0041's `pr_link`). The sweep runs every 2 minutes while at least one watch exists, through `gh` (0050), with T3's wake conditions, caps, and end conditions. A wake is `message.dispatch` with `queue_after_active` and `createdBy: agent`.
- Linked PRs on threads that aren't settled refresh by T3's sync rules, on the same sweep. With no watches and no such links there is no timer.

### Delegation

- `delegate_task` follows T3: the child inherits the parent's worktree and branch, lineage `subagent`, cross-provider, its access level no broader than the parent's (0054's ladder), `wait` or async with T3's timeouts and wake policies. `thread_launch` stays for a child in its own worktree.
- **Wake-ups become delegated completions.** A child launched with `notify` (`thread_launch`, a Project's child) wakes its parent the same way: completions go out as one `delegatedCompletion` message, steered or queued by T3's rule above. A Project child's notify counts as `completionWake: always`, so its wake-up can be steered into the coordinator's running turn, which 0025 never did. Parallax keeps its own 2 s batch, which T3 doesn't have, so several children that finish together arrive as one message. The cap of 100 and the pause (0025, 0043) stay, as fields of the parent thread.
- **Stop cascades and holds the queue,** as in T3. Stop on a thread holds its queue until the user resumes it, ends its PR watches, drops wakes it owes, and enqueues `delegated-tasks.stop`, which stops every child it delegated or launched with `notify`, depth first. `task_cancel` stops one child the same way. A Project's Stop stops its coordinator's children through the same path.
- **request_secret** stores the value in the host keystore (`daemon/src/keystore.rs`: the Keychain on macOS, the Secret Service on Linux), as API keys are. Windows has no keystore yet (PLX-23), so there `request_secret` is refused until it does. The ref is single use, bound to the repository or Project, and expires after 24 hours. A timer is set only while a ref is outstanding.
- **thread_merge_back** is a `merge_back` context transfer with a `fork_delta_summary` handoff, as T3.

## Consequences

- Threads and coordinators can run on a schedule, react to webhooks, and follow their PRs, which completes PLAN's M6 triggers.
- An idle host has no schedule or PR timer unless something is scheduled or watched.
- Webhooks need plxd's HTTP listener, and public webhooks need the relay (0065). Without the relay, only a webhook sender on the same network or tailnet reaches plxd.
- Stop changes. Stopping a thread now stops every child it delegated or launched with `notify`, depth first, including a Project coordinator's children, and holds the thread's queued messages until Resume.
- Wake-ups can now land inside a parent's running turn, by T3's steering rule, which changes 0025's "always its own turn".
- Polling GitHub every 2 minutes per watched PR uses the user's `gh` rate limit. T3's grouping per PR and its quiet rereads keep that low.
