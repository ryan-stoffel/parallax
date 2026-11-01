# 0093: Orchestrator threads replace Projects, and Spaces become Projects

- Status: accepted; amends [0042](0042-project-children-are-threads.md), [0043](0043-project-inbox-and-autonomy.md), [0069](0069-spaces.md), [0087](0087-sidebar-rows-no-areas-or-folders.md), [0090](0090-projects-page-and-spaces.md), and [0094](0094-sidebar-modes-drafts-pins.md)
- Date: 2026-10-30
- Issue: PLX-1173, PLX-1174, PLX-1175

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

**Its row is a thread's** (PLX-1177). In every sidebar mode, pinned or not, an orchestrator's row is a thread's card: its repo's icon and name with its status or age, its name, then its branch, computer, provider, and pull requests, with no "Orchestrator" label, thread count, or icon of its own. Inbox lists every one by activity, and under a Traditional folder it's the folder's thread row. Traditional's **Pinned** is one section that folds: pinned Projects first, each a card the size of a pinned thread's with its icon and "Project" over its name, then pinned orchestrator threads and threads.

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

**What step 2 renames.** Where the word meant a Space, landed with step 1 in one pull request:

- Methods `space/create|delete` are `project/create|delete`, and `thread/setSpace` is `thread/setProject`. Capabilities `spaces`, `spaceContext`, and `spaceThreads` are `projects`, `projectContext`, and `projectThreads`. A repo entry's `space` and a thread's `space` are `project`, and so is the id on `project/delete` and `thread/setProject`. `Space*Params` and `MAX_SPACE_*` are `Project*` and `MAX_PROJECT_*`.
- Migration 57 renames `repos.space` to `project` and `threads.space_id` to `project_id`, with a backup before it.
- plxd's `spaces` module and its threads' `<space_instructions>`, the app's Space components and copy, and the docs.
- The Projects page lists Projects only, with no kind filter, and its New button makes a Project; orchestrators show in the sidebar and ⌘K until step 4. Pins, the `projects` nav row, and the icon palette now mean Projects.
- With 0094's Traditional sidebar, the head's **New project** and the add palette's first option, **New Project**, make a Project; an orchestrator thread starts from New thread's picker, whose **Orchestrator threads** section ends with **New orchestrator thread**. Pinned Projects and orchestrators list in Traditional's Pinned section, as above.

**What steps 1 and 2 keep.** A run's scope, which holds a repo entry's id (a repository's or a Project's) or an orchestrator's, keeps its wire name `project` on runs, events, `events/subscribe`, `agent/*`, and `context/*`; its type is `ScopeId`. Step 3 reworks scopes. Words for a code project stay, as do whitespace, the Space key, and CSS spacing. So do the on-disk `coordinators/` and `spaces/` folders and the stored `project.cleanup` and `project.delete` effect kinds, which rows already name.

**What step 3 does** (PLX-1176). An orchestrator's current run is its thread: a thread row with orchestration on (`orchestrator` on `Thread`), in the orchestrator as its children's rows are, so an app from before 0093 keeps hiding it. The orchestrator's id still keys its settings, memory, board, inbox, schedules, children, and `coordinators/` folder. `orchestrator/start` makes the row, and a Start over moves orchestration, its Project, and its pin to the new run. Migration 60, with a backup before it, gives each orchestrator's newest run its row. Runs keep their scope: an orchestrator thread's and its children's is the orchestrator's id. A fork of it (PLX-1218) is an ordinary thread, in its repository's entry, which is registered if it has none, or with no repo for an orchestrator with no repo.

- **It lists like a thread.** `thread/archive`, `thread/update`'s settled flag, and `thread/setProject` work on it. In a Project its CLI gets the Project's instructions. Its children stay out of Projects.
- **It wakes itself.** An archived or settled orchestrator thread comes back, un-archived and un-settled, in the same transaction as what woke it, and records `wakeReason`: `childFinished` (a child's done or failed inbox item), `needsYou` (a needs-you inbox item), `schedule` (a task fired at it), or `pullRequest` (a watched pull request's news), with the run, task, or URL. `thread.updated` carries it. Archiving or un-archiving it by hand clears it. A snoozed thread's wake (0075) stays in the app, since plxd has none to share.
- **A repo is optional.** `orchestrator/create` may leave out `repoPath`. With no repo, the orchestrator plans in its `coordinators/<id>` folder, each child works in a scratch repository of its own as a thread with no repo does, and it has no integration branch, so `land/queue` refuses its children and `baseBranch` and another computer are refused. With a repo, the integration branch stays a per-orchestrator setting, cut as before, and children land on it. On the wire `repoPath` stays a string, empty for none, so an older app reads it.
- **Capability.** `orchestratorThreads` advertises `orchestrator` and `wakeReason` on `Thread` and an optional `repoPath`. `orchestrator/*` and an old app's `project/*` answer as before.

**One release of the old names.** plxd answers the old method names, and every renamed field and value has a serde alias, so old params and stored JSON decode. `initialize` advertises both capability names. The app reads a plxd that advertises `coordinator` but not `orchestrator` through `legacyNames.ts`, in both directions, and renames an old event plxd replays. Memory proposals and writers keep reading `project` and `coordinator`. The protocol's old samples moved to `samples/v1/legacy/`, which only decode. All of it goes once the window ends.

**Routing `project/*`.** After both steps `project/*` names an orchestrator to an app from before 0093 and a Project to a newer one, so the client's declared capability decides, never the method name alone:

| Client | Declares | `project/create`, `project/delete` | `project/list`, `/update`, `/start`, `/fromThreads` | `space/*`, `thread/setSpace` | What plxd sends |
| --- | --- | --- | --- | --- | --- |
| Before 0093 | neither | `orchestrator/*` | `orchestrator/*` | a Project's | old names (`parallax_protocol::legacy`): orchestrators as `project`, Projects as `space` |
| From 0093 | `projects` | a Project's | unknown method | a Project's | new names |

The `projects` client capability asks for both steps' names: step 1's `orchestrators` never shipped, so it folded in. Against a plxd from before 0093 the app sends `orchestrator/*` as `project/*` and a Project's `project/*` as `space/*`.

## Rejected

| Option | Why not |
| --- | --- |
| A permanent orchestrator shelf, or its own sidebar section | An idle orchestrator would still take space at the top. |
| Keeping it a container tied to a repo and kept apart from threads | It behaves like a long-running thread, and any thread should be able to sit in a Project. T3 Code's Orchestrator V2 has no separate type either: any thread delegates, and children show under their parent. |
| Renaming Space to Project first | The two names would collide for a release. |
| Keeping the wire field names and renaming only methods | The app's own code would still say `project` and `coordinator` for an orchestrator. |
| Renaming the run scope's `project` now | It holds repositories' entries and orchestrators' ids too, and step 3 reworks it. |
| Routing `project/*` by its params | The same params fit both meanings in places; a capability a client declares once is exact. |

## Consequences

- An app or phone from before 0093 works against a newer plxd, and a newer app against an older plxd, for one release. Ending the window removes `legacy.rs`, `legacyNames.ts`, the aliases, and the legacy samples.
- A store migrated to 56 or 57 doesn't open in an older plxd; the `.pre-56` backup is the way back.
- `orchestration/*` (0059's thread graph) and `orchestrator/*` now read alike.
