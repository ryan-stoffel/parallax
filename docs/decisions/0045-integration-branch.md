# 0045: A Project's children land on one integration branch, one PR at the end

- Status: accepted
- Date: 2026-10-03
- Issue: PLX-383

## Context

A child branches from the latest commit in the user's checkout. Work that needs another child's changes waits until the user merges that child and updates their checkout. Seven children end as seven branches, and the user is the merge queue.

## Decision

### The branch

- Each Project has one integration branch, `parallax/<project slug>`, cut from its base branch (a Project setting, by default the repository's default branch). plxd keeps a worktree for it in its data folder, and only the landing queue writes there.
- A child's worktree is cut from the integration branch's tip when it starts, so a child started after another landed sees that work. The coordinator's worktree follows the tip too ([0042](0042-project-children-are-threads.md)).
- Exploration children, such as spikes and comparisons, are started with `explore: true` and never queue.
- As built (PLX-409): the slug comes from the Project's name when the branch is cut, with the project id's short hash appended if another branch already has that name. The worktree is `<data dir>/integration/<project id>`. The base must be a local or remote-tracking branch. plxd cuts both when a Project is created and again before any child or coordinator CLI process starts, in case either is missing. The coordinator's worktree, `<data dir>/coordinators/<project id>`, is moved to the branch's tip before each of its CLI processes (PLX-397). The branch name, and the default base it was cut from, are then stored on the Project. Deleting a Project removes the worktree and keeps the branch. `explore` is an `agent/start` param and a field on `AgentRun`.

### Landing

- When a child finishes and the coordinator's review passes, the coordinator queues it with `land {runId}`.
- Landing waits for the user's approval by default: the item shows in Needs you and in the Deliverable panel with Land and Send back. A Project setting turns on automatic landing.
- The queue lands one child at a time. plxd fetches the base branch first. If it moved, plxd merges it alone and runs the checks, so a failure there is the base branch's, not the child's, and goes to Needs you like a conflict with it. Then plxd squash-merges the child's branch as one commit per task (its title is the task's first line, its body names the run), then runs the Project's checks in the integration worktree.
- **A conflict** aborts the merge, leaving the branch untouched. plxd sends the child a message to merge the tip into its branch and resolve, since it still knows its intent, and plxd queues the child again when that turn ends, still waiting for approval unless landing is automatic. A second conflict for the same child goes to Needs you. A conflict with the base branch has no child to own it and goes to Needs you, with a button that starts a child for it.
- **Red checks** reset the integration branch to its previous tip, which serial landing makes exact, and send the child the failing output, cut to its last 64 KiB. plxd queues it again when that turn ends. If the fix fails the checks again, the item goes to Needs you.
- As built (PLX-410): `land` is the coordinator's tool for `land/queue`, and the user answers with `land/approve` and `land/sendBack`, behind the `landing` capability. `autoLand` is the Project setting, off by default. The queue is a `landings` table, so a restart picks it up. Merges are built with `git merge-tree` and `commit-tree`, so a conflict never touches the branch or its worktree. On a child's first conflict plxd starts `git merge --no-commit <tip>` in its worktree, so the child only resolves files and never runs git, and the commit its turn ends with concludes the merge; a child that is working when it conflicts goes to Needs you instead, and so does a resolution whose branch adds a conflict marker (`git diff --check`). A conflict with the base adds Needs you and the child still lands on the tip. Only a remote-tracking base is fetched. The checks are PLX-411's, and pass until then.
- **The checks command** is found once by the coordinator from `AGENTS.md`, CI config, and package scripts, shown to the user, and stored as a Project setting the user can edit. It runs with a 30-minute limit. A Project with no checks lands on a clean merge alone.
- As built (PLX-411): the coordinator's `checks_propose` tool sets `proposedChecks`, which adds a Needs you item and never runs. The user confirms or edits it by setting `checks` with `project/update`, behind the `checks` capability. plxd runs it through `sh -c` (`cmd /C` on Windows) in the integration worktree, with the agent environment (the login shell's `PATH`, no tokens), in its own process group, killed whole at the limit. Red checks after the base merge leave the base out, add Needs you, and the child still lands on the tip. Red checks after the child's squash send it the output in a fence marked as data, and it is queued again when that turn ends. The second failure adds Needs you, with the end of the output.

### Shipping

- One PR from the integration branch into the Project's base branch, which isn't always the repository's default. Only the user opens it, from the Deliverable panel. plxd merges the base branch in and runs the checks first, then pushes the integration branch and opens the PR with PLX-168's code, targeting the base branch.
- A stack of one PR per task isn't built.
- Merging the PR is the user's, as always.

### The Deliverable panel

The integration branch, its landed tasks (one commit each, linked to its child), the queue, the latest checks, and the combined diff. M5's review works per child and on the combined diff.

## Consequences

- The Project ends as one branch and one PR. The user reviews, not merges.
- Squashing loses a child's own commits on the integration branch. They stay on the child's branch.
- Checks run on the home host, with its tools and the user's environment, for every landing. A slow suite slows the queue, since landing is serial.
- A thread's `agent/accept` stays for threads. A Project's children land instead.
