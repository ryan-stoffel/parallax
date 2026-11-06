# 0046: plxd places a Project's children across accounts, and later hosts

- Status: accepted; builds on [0040](0040-provider-instances.md) (an account is a provider instance), and supersedes in part [0012](0012-account-routing.md) (one account per backend, and the automatic API key fallback, for a Project's children)
- Date: 2026-10-03
- Issue: PLX-383

## Context

A Project and its runs live on one host (0009). A subscription's sign-in lives in that host's CLI, one per backend (0012), and on a rate limit routing falls back once to an API key. 0040 lets a host keep any number of provider instances, so a second Codex with its own `CODEX_HOME` is a second account. Current limits come from `usage/get`, usage history from 0039, and PLX-371 resumes a limited thread when its limit resets.

A Project should keep going on whichever account has room, and later on whichever machine. Children start before the coordinator reads their prompt ([0042](0042-project-children-are-threads.md)), so placement can't wait on the coordinator.

## Decision

### Accounts

- An account is a provider instance. A host may have more than one of a kind, each signed in on its own.
- Each instance can have a reserve: a percentage of each limit window `usage/get` reports (such as a 5-hour or weekly window) that Projects leave for the user. An instance at or past its limit minus its reserve takes no new children. Off by default. An instance that reports no limits, such as Cursor, is always eligible.

### Placement at dispatch

plxd places each child with fixed rules, no model involved:

1. The instance and model the composer picked, or the Project's defaults, if that instance is enabled, signed in, has the Project's mode, and is under its reserve.
2. Otherwise another instance of the same kind that serves the model, with the most headroom.
3. Otherwise the child waits in the Project's queue with a reason the inbox shows: "Waiting for Claude quota, resets at 3:40 PM." It starts when an instance frees up.

- A host runs at most `maxChildren` of a Project's children at once (default 10). Over it, children wait in the same queue.
- An API key account is used only when the Project allows it (off by default), never as 0012's automatic fallback.

### Recovery mid-run

- On a rate limit, plxd moves the child to another instance of the same kind with headroom, with 0014's account move: the run keeps its id, transcript, worktree, and branch, and starts a new session with the conversation so far, since a CLI session can't move between accounts.
- With none free, the child waits for its limit to reset and resumes (PLX-371).
- **The coordinator may move a child** to another instance or vendor with `thread_move {runId, instance, model?}`, only when it judges the move worth a new session, such as a long wait on a task another vendor can do now. `capacity_read` shows it each instance's headroom and running children.

### Hosts (after one host works)

- **The home host** owns a Project's coordinator, integration branch, memory, and inbox. It keeps working with the laptop closed.
- **Worker hosts** run plxd. The home plxd reaches them as the app does, with `plxd attach` over ssh, and starts children there. A worker host keeps a clone of the repository, and the home host fetches a child's branch from it over the same ssh. GitHub isn't required. Memory is mirrored to it, as 0005 planned.
- Placement adds a filter before rule 1: the host is online, has the repository and any tool the task requires, and the instance is signed in there. Then it prefers the host with the fewest running children.
- **The laptop is a worker host**, which is how M6's local agent fits. The home host usually can't reach the laptop over ssh, so how it reaches the laptop is PLX-55's to decide.

### The app

- Each child shows a chip with its host and account.
- A Capacity view lists hosts and instances with headroom, reserve, and what each is running. A task can be pinned to a host or instance, and each instance's reserve set there.

## Consequences

- Placement is predictable and costs no tokens. A poor first placement costs a move, which is a new session that rereads the conversation so far.
- Several accounts of one vendor on one host now work for Projects. Threads keep 0012's routing.
- A Project in Auto narrows placement to kinds with Auto ([0042](0042-project-children-are-threads.md)).
- Until worker hosts exist, everything runs on the home host.
