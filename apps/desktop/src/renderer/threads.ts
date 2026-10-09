import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  AccountChoice,
  Capabilities,
  AgentRun,
  LoggedEvent,
  Project,
  ProjectIcon as ProjectIconValue,
  ProjectAutonomy,
  ProjectPermission,
  InboxItem,
  ProjectStartParams,
  ProjectUpdateParams,
  PromptImage,
  Repo,
  Thread,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import { describeError } from "./errors";
import type { RunOptions } from "./models";
import { slugify } from "./naming";
import { newThreadPrefs } from "./prefs";
import { trackApprovals, updateRun, type ApprovalsByRun } from "./transcript";
import { useWatchKey } from "./useWatchKey";
import { uuidv7 } from "./uuidv7";

/** A host's projects, repo entries, and normal threads (0017), and each thread's title and run. */
export interface ThreadsState {
  projects: Project[];
  repos: Repo[];
  threads: Thread[];
  /**
   * By run id: a thread's own title from plxd (0041), or else its run's (`titleOf`). Runs with no
   * thread, such as a Project's, have their run's.
   */
  titles: Readonly<Record<string, string>>;
  /** By run id: each run, kept current by its repo's or Project's own events. */
  runs: Readonly<Record<string, AgentRun>>;
  /** By run id: the permission requests each run waits on (0033's "needs you"). */
  approvals: ApprovalsByRun;
  /**
   * By run id: how many times its checkpoints changed since this app connected, a capture or a
   * revert (0062), so its Changes view knows to reload.
   */
  checkpoints: Readonly<Record<string, number>>;
}

export const emptyThreads: ThreadsState = {
  projects: [],
  repos: [],
  threads: [],
  titles: {},
  runs: {},
  approvals: {},
  checkpoints: {},
};

/** How many permission requests run `runId` waits on. */
export const asksOf = (state: ThreadsState, runId: string) =>
  state.approvals[runId]?.items.length ?? 0;

export type ThreadsAction =
  | { type: "snapshot"; projects: Project[]; repos: Repo[]; threads: Thread[]; runs: AgentRun[] }
  | { type: "runs"; runs: AgentRun[] }
  /** A Project's new coordinator, which no host-level event announces (0024). */
  | { type: "coordinator"; run: AgentRun }
  | { type: "event"; event: ParallaxEvent }
  /** A repo's or a Project's own events: its runs and their permission requests. */
  | { type: "scope"; events: LoggedEvent[] }
  /** The permission requests runs wait on, from the shell's snapshot. */
  | { type: "approvals"; events: LoggedEvent[] };

/** Applies a snapshot, runs' titles, or a host-level event. Events are upserts, so a repeat is harmless. */
export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case "snapshot":
      return {
        projects: action.projects,
        repos: action.repos,
        threads: action.threads,
        titles: withThreadTitles(titlesOf(action.runs), action.threads),
        runs: byId(action.runs),
        approvals: {},
        checkpoints: state.checkpoints,
      };
    case "runs":
      return {
        ...state,
        titles: withThreadTitles({ ...state.titles, ...titlesOf(action.runs) }, state.threads),
        runs: { ...state.runs, ...byId(action.runs) },
      };
    case "coordinator":
      return {
        ...threadsReducer(state, { type: "runs", runs: [action.run] }),
        projects: state.projects.map((p) =>
          p.id === action.run.project ? { ...p, coordinator: action.run.id } : p,
        ),
      };
    case "scope": {
      let runs = state.runs;
      for (const { event, time } of action.events) {
        if (!("runId" in event)) continue;
        const before = runs[event.runId];
        const run = updateRun(before, event);
        // `updatedAt` marks when it last changed, so a run that stops after the user looked
        // counts as unseen (0033).
        if (run && run !== before) runs = { ...runs, [run.id]: { ...run, updatedAt: time } };
      }
      const started = action.events.flatMap((e) =>
        e.event.kind === "agent.started" && e.event.run ? [e.event.run] : [],
      );
      const approvals = trackApprovals(state.approvals, action.events);
      // Output that changes neither, the bulk of a running agent's events, keeps the state.
      if (runs === state.runs && approvals === state.approvals && !started.length) return state;
      return {
        ...state,
        runs,
        titles: started.length
          ? withThreadTitles({ ...state.titles, ...titlesOf(started) }, state.threads)
          : state.titles,
        approvals,
      };
    }
    case "approvals":
      return { ...state, approvals: trackApprovals(state.approvals, action.events) };
    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "project.created":
        case "project.updated":
          return { ...state, projects: upsert(state.projects, e.project) };
        case "project.deleted":
          return {
            ...state,
            projects: state.projects.filter((p) => p.id !== e.project),
            runs: Object.fromEntries(
              Object.entries(state.runs).filter(([, r]) => r.project !== e.project),
            ),
          };
        case "repo.added":
        case "repo.updated":
          return { ...state, repos: upsert(state.repos, e.repo) };
        case "thread.started":
        case "thread.updated": {
          const run = state.runs[e.thread.id];
          // A cleared title falls back to its run's.
          const title = e.thread.title ?? (run && titleOf(run));
          return {
            ...state,
            threads: upsert(state.threads, e.thread),
            titles: title ? { ...state.titles, [e.thread.id]: title } : state.titles,
          };
        }
        case "thread.deleted":
          return { ...state, threads: state.threads.filter((t) => t.id !== e.runId) };
        case "thread.checkpoint":
        case "thread.reverted":
          return {
            ...state,
            checkpoints: { ...state.checkpoints, [e.runId]: (state.checkpoints[e.runId] ?? 0) + 1 },
          };
        default:
          return state;
      }
    }
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

function byId(runs: AgentRun[]): Record<string, AgentRun> {
  return Object.fromEntries(runs.map((r) => [r.id, r]));
}

function titlesOf(runs: AgentRun[]): Record<string, string> {
  return Object.fromEntries(runs.map((r) => [r.id, titleOf(r)]));
}

/** `titles` with each of `threads`' own title (0041) over its run's. */
function withThreadTitles(titles: Record<string, string>, threads: Thread[]) {
  for (const t of threads) if (t.title) titles[t.id] = t.title;
  return titles;
}

/**
 * A run's title: the generated title this app kept for it, or else its prompt's first line, or
 * "Image" for a prompt of images alone. A thread's own title from plxd comes first (`titles`).
 */
export function titleOf(run: AgentRun): string {
  return readTitle(run.id) ?? (run.prompt.trim().split("\n")[0] || "Image");
}

// A thread's generated title, which earlier versions kept in this app for a plxd without
// `threadLineage`, which keeps no title. `useThreads` moves any kept here to a lineage host. Run
// ids are unique across hosts.
const titleKey = (runId: string) => `parallax:title:${runId}`;

function readTitle(runId: string): string | undefined {
  try {
    return localStorage.getItem(titleKey(runId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function forgetTitle(runId: string) {
  try {
    localStorage.removeItem(titleKey(runId));
  } catch {
    // Storage is off, so nothing was kept.
  }
}

/** The sidebar's id for "No Repo", which holds plxd's scratch entry's threads, made on first use. */
export const noRepo = "no-repo";

export interface ThreadGroup {
  /** A repo entry's id, or `noRepo`. */
  id: string;
  name: string;
  /** Unarchived, newest first. */
  threads: Thread[];
}

/**
 * The sidebar's groups: each repository, oldest first, then No Repo, always there. A thread whose
 * entry isn't known yet goes under No Repo: `thread/start` with no repo answers before plxd's
 * `repo.added` for the scratch entry arrives.
 */
export function groupThreads({ repos, threads }: ThreadsState): {
  groups: ThreadGroup[];
  archived: Thread[];
} {
  const groups: ThreadGroup[] = [
    ...repos.filter((r) => !r.scratch).map((r) => ({ id: r.id, name: r.name, threads: [] })),
    { id: noRepo, name: "No Repo", threads: [] },
  ];
  const newestFirst = [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const t of newestFirst.filter((t) => !t.archived))
    (groups.find((g) => g.id === t.repo) ?? groups.at(-1)!).threads.push(t);
  return { groups, archived: newestFirst.filter((t) => t.archived) };
}

/** A thread's group id: its repository's, or `noRepo`. */
export const groupOf = (state: ThreadsState, thread: Thread) =>
  state.repos.some((r) => r.id === thread.repo && !r.scratch) ? thread.repo : noRepo;

/** A thread's parent thread (0041), if it's listed. A Project coordinator's run is no thread. */
export const parentOf = (state: ThreadsState, thread: Thread) =>
  thread.parent === undefined ? undefined : state.threads.find((t) => t.id === thread.parent);

/**
 * By thread id: the Project each thread is in (0042), where its own run or an ancestor's is one of
 * a Project's, as a coordinator's child's parent is. Threads in no Project are left out. Such a
 * thread shows only inside its Project, never in the main sidebar. A loop of parents stops where
 * it repeats.
 */
export function threadProjects(state: ThreadsState): Map<string, string> {
  const projects = new Set(state.projects.map((p) => p.id));
  const parents = new Map(state.threads.map((t) => [t.id, t.parent]));
  const found = new Map<string, string>();
  for (const thread of state.threads) {
    const seen = new Set<string>();
    for (let id = thread.id as string | undefined; id && !seen.has(id); id = parents.get(id)) {
      seen.add(id);
      const project = state.runs[id]?.project;
      if (project && projects.has(project)) {
        found.set(thread.id, project);
        break;
      }
    }
  }
  return found;
}

/**
 * Project `project`'s runs: its own, coordinators included, and those of the threads in it
 * (`threadProjects`). Its side panel and its sidebar row count the same runs.
 */
export const projectRuns = (
  state: ThreadsState,
  project: string,
  inProject: ReadonlyMap<string, string>,
) =>
  Object.values(state.runs).filter((r) => r.project === project || inProject.get(r.id) === project);

/** The threads `id` launched, oldest first, so their order holds as they start. */
export const childrenOf = (state: ThreadsState, id: string) =>
  state.threads
    .filter((t) => t.parent === id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * What the top bar shows of a thread's lineage: with children, the thread and them; else, as a
 * child, its parent and its unarchived siblings, itself included. Undefined for neither.
 * `parent` is the crumb before the chips.
 */
export function lineageOf(
  state: ThreadsState,
  thread: Thread,
): { parent?: Thread; chips: Thread[]; active?: string } | undefined {
  const parent = parentOf(state, thread);
  const children = childrenOf(state, thread.id).filter((t) => !t.archived);
  if (children.length > 0) return { parent, chips: children };
  if (!parent) return undefined;
  const chips = childrenOf(state, parent.id).filter((t) => !t.archived || t.id === thread.id);
  return { parent, chips, active: thread.id };
}

/** A thread's topmost listed ancestor, for the whole tree. A loop of parents stops where it repeats. */
export function rootOf(state: ThreadsState, thread: Thread): Thread {
  const seen = new Set([thread.id]);
  let root = thread;
  for (let up = parentOf(state, root); up && !seen.has(up.id); up = parentOf(state, up)) {
    seen.add(up.id);
    root = up;
  }
  return root;
}

/**
 * A thread to start in group `groupId` with `prompt` and its `images`, with `options` sent as they
 * are, on a branch named from the prompt's words. A plxd with `threadNaming` then names the thread
 * and its branch with the naming model in Settings (0058). With `checkout`, it works in the
 * repository's own checkout instead of a new worktree, so it gets no branch. Reuse `runId`, with
 * the same options, `checkout`, and `gitRef`, to retry.
 */
export interface ThreadStart {
  runId: string;
  groupId: string;
  prompt: string;
  images: PromptImage[];
  /** The run ids of the threads attached to the prompt as context (0047). */
  threads: string[];
  options: RunOptions;
  checkout: boolean;
  /** The ref the worktree starts from, or with `checkout`, the branch the checkout switches to. */
  gitRef?: string;
}

export interface ThreadsView {
  state: ThreadsState;
  /** Why the list couldn't load or stopped updating, for people. */
  error?: string;
  /**
   * While a load or resync is under way: its list can be in without the permission requests
   * that follow it, so who needs the user isn't settled yet (PLX-507's alarms wait it out).
   */
  loading?: boolean;
  /** Registers a repository (idempotent on its path). Resolves to its entry or an error message. */
  addRepo: (path: string) => Promise<Repo | string>;
  /** Starts a thread as `ThreadStart` says. Resolves to plxd's error, or undefined. */
  start: (start: ThreadStart) => Promise<RpcError | undefined>;
  /**
   * Forks thread `runId` at `turnId`, or at its latest turn (`thread/fork`, 0050), keeping its model
   * or running on `choice`'s. Resolves to the fork's id, or plxd's error.
   */
  fork: (
    runId: string,
    turnId: string | undefined,
    choice: ForkChoice,
  ) => Promise<string | RpcError>;
  archive: (runId: string, archived: boolean) => Promise<string | undefined>;
  remove: (thread: Thread) => Promise<string | undefined>;
  /**
   * Creates a project on a repository's path, with `icon` if one was chosen and `permission` and
   * `autonomy` where the host keeps them. Reuse `id`, with the same name, path, icon, mode, and
   * autonomy, to retry. Resolves to the project or an error message.
   */
  createProject: (
    id: string,
    name: string,
    repoPath: string,
    icon?: ProjectIconValue,
    permission?: ProjectPermission,
    autonomy?: ProjectAutonomy,
  ) => Promise<Project | string>;
  /**
   * Renames a project or sets its icon, which replaces the whole icon (0032). Resolves to an error
   * message, or undefined.
   */
  updateProject: (project: string, change: ProjectChange) => Promise<string | undefined>;
  /**
   * Deletes a Project with every run in it, once plxd has stopped them. Resolves to an error
   * message, or undefined.
   */
  removeProject: (project: string) => Promise<string | undefined>;
  /**
   * Starts a Project's coordinator with `prompt` and its `images`, or starts it over with a new
   * `runId` (0024), then keeps it as the Project's. Reusing `runId` to retry is safe with any
   * prompt or options: a failed `project/start` creates nothing, and one whose answer was lost
   * shows up in `project/list` after a reconnect. Resolves to plxd's error, or undefined.
   */
  startCoordinator: (
    project: string,
    runId: string,
    prompt: string,
    images: PromptImage[],
    options: CoordinatorOptions,
  ) => Promise<RpcError | undefined>;
  /** The host's plxd's capabilities, or none while it isn't connected. */
  capabilities: Capabilities;
  /** The cap on an icon image's base64, where the host's plxd keeps icon images (`iconImages`, 0038). */
  iconImageBytes?: number;
  /**
   * Marks a thread seen, or snoozes it until a time (a past one ends the snooze). Resolves to an
   * error message, or undefined.
   */
  update: (runId: string, change: ThreadChange) => Promise<string | undefined>;
  /** Sets a repo entry's icon. Resolves to an error message, or undefined. */
  updateRepo: (repo: string, icon: ProjectIconValue) => Promise<string | undefined>;
}

/** What a fork runs on: absent keeps the thread's model and account. */
export type ForkChoice = { model?: string; account?: AccountChoice };

/** What `thread/update` changes. */
export type ThreadChange = { seen?: boolean; snoozedUntil?: string };

/** What `project/update` changes: a project's name, icon, permission mode, or autonomy. */
export type ProjectChange = Omit<ProjectUpdateParams, "project">;

/** What a new coordinator runs on: its model, effort, permission, and account (`project/start`'s). */
export type CoordinatorOptions = Pick<
  ProjectStartParams,
  "model" | "effort" | "permission" | "account"
>;

/**
 * A host's threads and projects, kept live through `orchestration/subscribeShell` (0059): a
 * snapshot of its projects, repo entries, threads, runs, and the permission requests runs wait
 * on, then what a sidebar shows of every scope's events (0033). It opens once the host connects,
 * which is when plxd's `capabilities` are known, and stays open across disconnects: a reconnect
 * resumes after the last event, and a fresh snapshot replaces the state only when the gap is
 * too long to replay (`useWatchKey`). An older plxd has no shell to load.
 * With `approvals`, the threads and coordinators started here forward their permission
 * requests (PLX-196, 0031); with `threadLineage`, titles kept in this app move to plxd once
 * (0041); with `threadNaming`, plxd names new threads and their branches (0058). The view carries
 * them all for the sidebar and top bar. A Project's new Needs you inbox item (0043) goes to
 * `onNeedsYou`.
 */
export function useThreads(
  hostId: string,
  capabilities: Capabilities | undefined,
  iconImageBytes: number | undefined,
  /** Called for each new Needs you item in one of the host's Projects' inboxes (0043). */
  onNeedsYou: (project: string, item: InboxItem) => void,
): ThreadsView {
  const has = (key: string) => !!capabilities && key in capabilities;
  const connected = !!capabilities;
  const approvals = has("approvals");
  const lineage = has("threadLineage");
  const naming = has("threadNaming");
  const [state, dispatch] = useReducer(threadsReducer, emptyThreads);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const needsYou = useRef(onNeedsYou);
  // Read when a snapshot arrives, so a change doesn't reopen the shell.
  const lineageNow = useRef(lineage);
  useEffect(() => {
    needsYou.current = onNeedsYou;
    lineageNow.current = lineage;
  });
  const [watchKey, failed] = useWatchKey(hostId, connected);

  useEffect(() => {
    if (!watchKey) return;
    let stopped = false;
    let moved = false;

    // Titles this app kept before plxd kept them go to plxd, once each, for threads it has none for.
    async function moveTitles(threads: Thread[]) {
      for (const t of threads) {
        const title = t.title ? undefined : readTitle(t.id);
        if (!title) continue;
        const answer = await window.parallax.request(hostId, "thread/update", {
          runId: t.id,
          title,
        });
        if (stopped) return;
        if ("error" in answer) continue;
        forgetTitle(t.id);
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
      }
    }

    setLoading(true);
    const stop = window.parallax.watch(hostId, { shell: true }, (message) => {
      if (stopped) return;
      if (message.type === "error") {
        failed();
        return setError(
          message.error.code === ErrorCodes.MethodNotFound ? tooOld : message.error.message,
        );
      }
      if (message.type === "snapshot") {
        const { projects, repos, threads, runs, requests } = message.snapshot;
        dispatch({ type: "snapshot", projects, repos, threads, runs });
        dispatch({ type: "approvals", events: requests });
        setError(undefined);
        setLoading(false);
        if (lineageNow.current && !moved) {
          moved = true;
          void moveTitles(threads);
        }
        return;
      }
      // A host-level event changes the lists, and a scope's its runs and their requests; each
      // action leaves the other's kinds alone.
      const logged = message.event;
      dispatch({ type: "event", event: logged.event });
      dispatch({ type: "scope", events: [logged] });
      const { event } = logged;
      if (event.kind === "inbox.added" && event.item.kind === "needsYou" && logged.project)
        needsYou.current?.(logged.project, event.item);
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [hostId, watchKey, failed]);

  // Each applies its own answer at once; the matching event repeats it harmlessly.
  const actions = useMemo(
    () => ({
      async addRepo(path: string) {
        // A fresh id is safe to retry with: plxd returns the entry a path already has.
        const answer = await window.parallax.request(hostId, "repo/add", { id: uuidv7(), path });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.added", repo: answer.result.repo } });
        return answer.result.repo;
      },

      async start({
        runId,
        groupId,
        prompt,
        images,
        threads,
        options,
        checkout,
        gitRef,
      }: ThreadStart) {
        const branchSlug = slugify(prompt);
        const { naming: model, namingEffort } = newThreadPrefs.get();
        const answer = await window.parallax.request(hostId, "thread/start", {
          runId,
          prompt,
          ...(images.length > 0 && { images }),
          ...(threads.length > 0 && { threads }),
          ...(groupId !== noRepo && { repo: groupId }),
          ...options,
          // The checkout keeps its own branch, so a name gives it none.
          ...(checkout ? { checkout } : branchSlug && { branchSlug }),
          ...(gitRef && (checkout ? { checkoutRef: gitRef } : { base: gitRef })),
          ...(approvals && { approvals }),
          ...(naming &&
            prompt.trim() && {
              naming: { backend: model.provider, model: model.id, effort: namingEffort },
            }),
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "runs", runs: [answer.result.run] });
        dispatch({
          type: "event",
          event: { kind: "thread.started", thread: answer.result.thread },
        });
        return undefined;
      },

      async fork(runId: string, turnId: string | undefined, choice: ForkChoice) {
        const newRunId = uuidv7();
        const answer = await window.parallax.request(hostId, "thread/fork", {
          runId,
          newRunId,
          ...(turnId && { turnId }),
          ...choice,
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "runs", runs: [answer.result.run] });
        dispatch({
          type: "event",
          event: { kind: "thread.started", thread: answer.result.thread },
        });
        return newRunId;
      },

      async archive(runId: string, archived: boolean) {
        const answer = await window.parallax.request(hostId, "thread/archive", { runId, archived });
        if ("error" in answer) return answer.error.message;
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
        return undefined;
      },

      async remove(thread: Thread) {
        const answer = await window.parallax.request(hostId, "thread/delete", { runId: thread.id });
        if ("error" in answer) return answer.error.message;
        dispatch({
          type: "event",
          event: { kind: "thread.deleted", runId: thread.id, repo: thread.repo },
        });
        return undefined;
      },

      async createProject(
        id: string,
        name: string,
        repoPath: string,
        icon?: ProjectIconValue,
        permission?: ProjectPermission,
        autonomy?: ProjectAutonomy,
      ) {
        const answer = await window.parallax.request(hostId, "project/create", {
          id,
          name,
          repoPath,
          ...(icon && { icon }),
          ...(permission && { permission }),
          ...(autonomy && { autonomy }),
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "project.created", project: answer.result.project },
        });
        return answer.result.project;
      },

      async updateProject(project: string, change: ProjectChange) {
        const answer = await window.parallax.request(hostId, "project/update", {
          project,
          ...change,
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "project.updated", project: answer.result.project },
        });
        return undefined;
      },

      async removeProject(project: string) {
        const answer = await window.parallax.request(hostId, "project/delete", { project });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "project.deleted", project } });
        return undefined;
      },

      async startCoordinator(
        project: string,
        runId: string,
        prompt: string,
        images: PromptImage[],
        options: CoordinatorOptions,
      ) {
        const answer = await window.parallax.request(hostId, "project/start", {
          project,
          runId,
          prompt,
          ...(images.length > 0 && { images }),
          ...options,
          ...(approvals && { approvals }),
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "coordinator", run: answer.result.run });
        return undefined;
      },

      async update(runId: string, change: ThreadChange) {
        const answer = await window.parallax.request(hostId, "thread/update", { runId, ...change });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
        return undefined;
      },

      async updateRepo(repo: string, icon: ProjectIconValue) {
        const answer = await window.parallax.request(hostId, "repo/update", { repo, icon });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.updated", repo: answer.result.repo } });
        return undefined;
      },
    }),
    [hostId, approvals, naming],
  );

  // One object per change, so a parent can keep it and compare.
  return useMemo(
    () => ({
      state,
      error,
      loading,
      capabilities: capabilities ?? noCapabilities,
      iconImageBytes,
      ...actions,
    }),
    [state, error, loading, capabilities, iconImageBytes, actions],
  );
}

/** Why a host's lists can't load: its plxd predates the subscriptions this app uses (0059). */
const tooOld = "This host's plxd is too old for this version of Parallax. Update Parallax there.";

const notConnected = "Not connected to this host.";
/** A disconnected host's capabilities: one shared object, so a view without them stays equal. */
const noCapabilities: Capabilities = {};

/** A host's view before its list loads: empty, and every action answers that it isn't connected. */
export const idleThreads: ThreadsView = {
  state: emptyThreads,
  capabilities: noCapabilities,
  addRepo: async () => notConnected,
  start: async () => ({ code: -32000, message: notConnected }),
  fork: async () => ({ code: -32000, message: notConnected }),
  archive: async () => notConnected,
  remove: async () => notConnected,
  createProject: async () => notConnected,
  updateProject: async () => notConnected,
  removeProject: async () => notConnected,
  startCoordinator: async () => ({ code: -32000, message: notConnected }),
  update: async () => notConnected,
  updateRepo: async () => notConnected,
};
