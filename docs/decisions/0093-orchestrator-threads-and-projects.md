# 0093: Orchestrator threads replace Projects, and Spaces become Projects

- Status: accepted; amends [0042](0042-project-children-are-threads.md), [0043](0043-project-inbox-and-autonomy.md), [0069](0069-spaces.md), [0087](0087-sidebar-rows-no-areas-or-folders.md), [0090](0090-projects-page-and-spaces.md), and [0094](0094-sidebar-modes-drafts-pins.md)
- Date: 2026-10-30
- Issue: PLX-1173, PLX-1174

## Context

"Project" meant two things. In Claude and ChatGPT a Project is a folder of chats with shared files and instructions, which Parallax calls a Space (0069, 0090). In Parallax a Project was a long-running coordinator chat that plans work and hands it to child threads (0024, 0042). The Projects page listed both kinds together. And a Parallax Project was tied to a repo and kept apart from threads, though it behaves like a long-running thread. Ryan decided the names, model, and lifecycle on Oct 30, 2026.

## Decision

**Names, everywhere, internal names included.** A Parallax Project and its coordinator become an **orchestrator thread**, "orchestrator" for short. A Space becomes a **Project**.

**Model.** An orchestrator thread is a kind of thread, not a container tied to a Project. It keeps what coordinators have: memory, children, schedules, PR watches, autonomy, and its board. Any thread can sit in a Project (formerly a Space), an orchestrator included.

**Lifecycle.** An orchestrator lists, settles, and archives like a normal thread, so a quiet sidebar stays clean. Three things set it apart:

1. It wakes itself. It un-archives into the list when a child finishes, a schedule fires, a watched PR changes, or it needs the user, the way a snoozed thread wakes (0075).
2. New thread offers it. The picker (the Repositories palette) lists orchestrators beside repositories and No repo. The New thread screen shows the 3 or 4 most recent orchestrators as chips under the prompt ("Continue in formula fly"), and the headline picker ("What should we build in **parallax**?") switches to one too. Picking one opens its thread view and sends the prompt to it, which brings it back into the list.
3. It's found first. ⌘K lists orchestrators first, and they sort to the top of Archived.

Its children fold under its row with a count ("3 agents · 1 working") and add no rows. There is no permanent shelf and no separate section, since an idle orchestrator would still take space at the top.

**Order.** Four steps, each its own pull request:

1. Rename Project and coordinator to orchestrator (PLX-1174).
2. Rename Space to Project (PLX-1175), after step 1, so the two names never collide.
3. plxd's model: an orchestrator becomes a thread with orchestration on, no longer tied to a repo or Project, and existing ones migrate.
4. The app: rows with folded children, waking, New thread's picker, chips, and headline switch, ⌘K and Archived ordering, and the Projects page for Projects only.

**What step 1 renames.** Where the word meant the coordinator Project or its coordinator:

- Methods `project/list|create|update|delete|start|fromThreads` and `coordinator/fresh` are `orchestrator/*`. Events `project.created|updated|deleted` are `orchestrator.*`. Capabilities `coordinator`, `coordinatorEpochs`, and `project*` are `orchestrator`, `orchestratorEpochs`, and `orchestrator*`. Error kind `projectNotFound` is `orchestratorNotFound`.
- Protocol types and fields: `Project` is `Orchestrator`, whose run is `run`, not `coordinator`; `projects` is `orchestrators`; a field naming an orchestrator is `orchestrator`, not `project`; `coordinatorThread` is `orchestratorThread`; the accounts role and provider flag `coordinator` are `orchestrator`; memory's `project` scope is `orchestrator`. `ProjectIcon` is `ChosenIcon`, since threads and repos use it too.
- Migration 56 renames `projects` to `orchestrators`, `coordinator_sessions` to `orchestrator_sessions`, `runs.coordinator_thread` to `orchestrator_thread`, and `project_id` to `orchestrator_id` on the inbox, questions, landings, placements, and board items, and moves the `coordinator` accounts default to `orchestrator`. plxd backs the store up before it.
- plxd's modules, the `plxd mcp` tools' descriptions and memory scope, the desktop and phone apps' components, stores, and copy ("New orchestrator thread", "orchestrator" for short labels), and the docs. 0059's command dispatcher, which plxd called its orchestrator, is now its dispatcher.

**What step 1 keeps.** A run's scope, which holds a repo entry's id or an orchestrator's, keeps its wire name `project` on runs, events, `events/subscribe`, `agent/*`, and `context/*`; its type is `ScopeId`. Step 3 reworks scopes, and after step 2 the name fits. The Projects page, its pins, its nav row, and the icon palette keep their names, since they cover orchestrators and Spaces until step 4 makes the page Projects-only. Words for a code project stay. So do the on-disk `coordinators/` worktree folder and the stored `project.cleanup` and `project.delete` effect kinds, which rows already name.

**One release of the old names.** plxd answers the old method names, and every renamed field and value has a serde alias, so old params and stored JSON decode. `initialize` advertises both capability names. A client declares the `orchestrators` capability to get the new names; plxd rewrites what it sends any other client to the old ones (`parallax_protocol::legacy`). The app reads a plxd that advertises `coordinator` but not `orchestrator` through `legacyNames.ts`, in both directions, and renames an old event plxd replays. Memory proposals and writers keep reading `project` and `coordinator`. The protocol's old samples moved to `samples/v1/legacy/`, which only decode. All of it goes once the window ends.

## Rejected

| Option | Why not |
| --- | --- |
| A permanent orchestrator shelf, or its own sidebar section | An idle orchestrator would still take space at the top. |
| Keeping it a container tied to a repo and kept apart from threads | It behaves like a long-running thread, and any thread should be able to sit in a Project. T3 Code's Orchestrator V2 has no separate type either: any thread delegates, and children show under their parent. |
| Renaming Space to Project first | The two names would collide for a release. |
| Keeping the wire field names and renaming only methods | The app's own code would still say `project` and `coordinator` for an orchestrator. |
| Renaming the run scope's `project` now | It holds repo entries too, step 3 reworks it, and after step 2 the name is right. |

## Consequences

- An app or phone from before 0093 works against a newer plxd, and a newer app against an older plxd, for one release. Ending the window removes `legacy.rs`, `legacyNames.ts`, the aliases, and the legacy samples.
- A store migrated to 56 doesn't open in an older plxd; the `.pre-56` backup is the way back.
- `orchestration/*` (0059's thread graph) and `orchestrator/*` now read alike.
