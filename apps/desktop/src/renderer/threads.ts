import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { RpcError, ThreadName } from "../preload/bridge";
import type {
  AgentRun,
  Project,
  ProjectIcon as ProjectIconValue,
  ProjectStartParams,
  ProjectUpdateParams,
  PromptImage,
  Repo,
  Thread,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import { describeError } from "./errors";
import type { RunOptions } from "./models";
import { uuidv7 } from "./uuidv7";

/** A host's projects, repo entries, and normal threads (0017), and each thread's title and run. */
export interface ThreadsState {
  projects: Project[];
  repos: Repo[];
  threads: Thread[];
  /** By run id: the first line of the run's prompt, since a thread has no title of its own. */
  titles: Readonly<Record<string, string>>;
  /**
   * By run id: each thread's run as last listed. Host-level events don't carry run changes, so
   * its status can lag until `refresh` lists the thread's repository again.
   */
  runs: Readonly<Record<string, AgentRun>>;
}

export const emptyThreads: ThreadsState = {
  projects: [],
  repos: [],
  threads: [],
  titles: {},
  runs: {},
};

export type ThreadsAction =
  | { type: "snapshot"; projects: Project[]; repos: Repo[]; threads: Thread[]; runs: AgentRun[] }
  | { type: "runs"; runs: AgentRun[] }
  /** A Project's new coordinator, which no host-level event announces (0024). */
  | { type: "coordinator"; run: AgentRun }
  | { type: "event"; event: ParallaxEvent };

/** Applies a snapshot, runs' titles, or a host-level event. Events are upserts, so a repeat is harmless. */
export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case "snapshot":
      return {
        projects: action.projects,
        repos: action.repos,
        threads: action.threads,
        titles: titlesOf(action.runs),
        runs: byId(action.runs),
      };
    case "runs":
      return {
        ...state,
        titles: { ...state.titles, ...titlesOf(action.runs) },
        runs: { ...state.runs, ...byId(action.runs) },
      };
    case "coordinator":
      return {
        ...threadsReducer(state, { type: "runs", runs: [action.run] }),
        projects: state.projects.map((p) =>
          p.id === action.run.project ? { ...p, coordinator: action.run.id } : p,
        ),
      };
    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "project.created":
        case "project.updated":
          return { ...state, projects: upsert(state.projects, e.project) };
        case "repo.added":
          return { ...state, repos: upsert(state.repos, e.repo) };
        case "thread.started":
        case "thread.updated":
          return { ...state, threads: upsert(state.threads, e.thread) };
        case "thread.deleted":
          return { ...state, threads: state.threads.filter((t) => t.id !== e.runId) };
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

/**
 * A run's title: its thread's generated title, or else its prompt's first line, or "Image" for a
 * prompt of images alone.
 */
export function titleOf(run: AgentRun): string {
  return readTitle(run.id) ?? (run.prompt.trim().split("\n")[0] || "Image");
}

// A thread's generated title, kept in this app: plxd has no title of its own. Run ids are unique
// across hosts. ponytail: not shared with other computers running the app, or with a cleared
// browser profile; both fall back to the prompt's first line.
const titleKey = (runId: string) => `parallax:title:${runId}`;

function readTitle(runId: string): string | undefined {
  try {
    return localStorage.getItem(titleKey(runId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveTitle(runId: string, title: string) {
  try {
    localStorage.setItem(titleKey(runId), title);
  } catch {
    // Storage is off: the thread keeps its prompt as its title.
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

export interface ThreadsView {
  state: ThreadsState;
  /** Why the list couldn't load or stopped updating, for people. */
  error?: string;
  /** Registers a repository (idempotent on its path). Resolves to its entry or an error message. */
  addRepo: (path: string) => Promise<Repo | string>;
  /**
   * Starts a thread in a group with `prompt` and its `images`, with `options` sent as they are, and
   * its branch and title from `name`. With `checkout`, it works in the repository's own checkout
   * instead of a new worktree, so it gets no branch. Reuse `runId`, with the same options and
   * `checkout`, to retry. Resolves to plxd's error, or undefined.
   */
  start: (
    runId: string,
    groupId: string,
    prompt: string,
    images: PromptImage[],
    options: RunOptions,
    checkout: boolean,
    name?: ThreadName,
  ) => Promise<RpcError | undefined>;
  archive: (runId: string, archived: boolean) => Promise<string | undefined>;
  remove: (thread: Thread) => Promise<string | undefined>;
  /** Lists a repo entry's runs again, so their status is current. Failures are ignored. */
  refresh: (repo: string) => void;
  /**
   * Creates a project on a repository's path, with `icon` if one was chosen. Reuse `id`, with the
   * same name, path, and icon, to retry. Resolves to the project or an error message.
   */
  createProject: (
    id: string,
    name: string,
    repoPath: string,
    icon?: ProjectIconValue,
  ) => Promise<Project | string>;
  /**
   * Renames a project or sets its icon, which replaces the whole icon (0032). Resolves to an error
   * message, or undefined.
   */
  updateProject: (project: string, change: ProjectChange) => Promise<string | undefined>;
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
}

/** What `project/update` changes: a project's name, its icon, or both. */
export type ProjectChange = Omit<ProjectUpdateParams, "project">;

/** What a new coordinator runs on: its model, effort, permission, and account (`project/start`'s). */
export type CoordinatorOptions = Pick<
  ProjectStartParams,
  "model" | "effort" | "permission" | "account"
>;

/**
 * A host's threads and projects, kept live: `thread/list`, `agent/list` (for titles and runs), and
 * `project/list`, then host-level events after the thread list's `seq`, starting over on `resync`.
 * Loads only while `connected`. With `approvals`, the host's plxd advertises them, and the threads
 * and coordinators started here forward their permission requests (RYA-196, 0031).
 */
export function useThreads(hostId: string, connected: boolean, approvals = false): ThreadsView {
  const [state, dispatch] = useReducer(threadsReducer, emptyThreads);
  const [error, setError] = useState<string>();
  // Another host starts empty, rather than showing this one's threads until its list loads.
  const [shownHost, setShownHost] = useState(hostId);
  if (shownHost !== hostId) {
    setShownHost(hostId);
    dispatch({ type: "snapshot", projects: [], repos: [], threads: [], runs: [] });
    setError(undefined);
  }
  // The host shown now, so `refresh` drops a late answer from one the user has left.
  const shown = useRef(hostId);
  useEffect(() => {
    shown.current = hostId;
  }, [hostId]);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let unsubscribe = () => {};

    async function load() {
      const list = await window.parallax.request(hostId, "thread/list", {});
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      // After the list, so every thread listed has its run here.
      const runs = await window.parallax.request(hostId, "agent/list", {});
      if (stopped) return;
      if ("error" in runs) return setError(runs.error.message);
      // Also after the list, whose older `seq` the subscription starts from: a project it
      // replays is already here, and applying it again changes nothing.
      const projects = await window.parallax.request(hostId, "project/list", {});
      if (stopped) return;
      if ("error" in projects) return setError(projects.error.message);
      dispatch({
        type: "snapshot",
        ...list.result,
        projects: projects.result.projects,
        runs: runs.result.runs,
      });
      setError(undefined);
      const since = { after: list.result.seq, logId: list.logId };
      unsubscribe = window.parallax.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type === "error") return setError(message.error.message);
        const { event } = message.event;
        dispatch({ type: "event", event });
        // Its title is its run's prompt, which the event doesn't carry.
        if (event.kind === "thread.started")
          void window.parallax
            .request(hostId, "agent/list", { project: event.thread.repo })
            .then((answer) => {
              if (!stopped && "result" in answer)
                dispatch({ type: "runs", runs: answer.result.runs });
            });
      });
    }

    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, connected]);

  // Each applies its own answer at once; the matching event repeats it harmlessly.
  const addRepo = useCallback(
    async (path: string) => {
      // A fresh id is safe to retry with: plxd returns the entry a path already has.
      const answer = await window.parallax.request(hostId, "repo/add", { id: uuidv7(), path });
      if ("error" in answer) return describeError(answer.error);
      dispatch({ type: "event", event: { kind: "repo.added", repo: answer.result.repo } });
      return answer.result.repo;
    },
    [hostId],
  );

  const start = useCallback(
    async (
      runId: string,
      groupId: string,
      prompt: string,
      images: PromptImage[],
      options: RunOptions,
      checkout: boolean,
      name?: ThreadName,
    ) => {
      const answer = await window.parallax.request(hostId, "thread/start", {
        runId,
        prompt,
        ...(images.length > 0 && { images }),
        ...(groupId !== noRepo && { repo: groupId }),
        ...options,
        // The checkout keeps its own branch, so a name gives it none.
        ...(checkout ? { checkout } : name?.slug && { branchSlug: name.slug }),
        ...(approvals && { approvals }),
      });
      if ("error" in answer) return answer.error;
      if (name?.title) saveTitle(runId, name.title);
      dispatch({ type: "runs", runs: [answer.result.run] });
      dispatch({ type: "event", event: { kind: "thread.started", thread: answer.result.thread } });
      return undefined;
    },
    [hostId, approvals],
  );

  const archive = useCallback(
    async (runId: string, archived: boolean) => {
      const answer = await window.parallax.request(hostId, "thread/archive", { runId, archived });
      if ("error" in answer) return answer.error.message;
      dispatch({ type: "event", event: { kind: "thread.updated", thread: answer.result.thread } });
      return undefined;
    },
    [hostId],
  );

  const remove = useCallback(
    async (thread: Thread) => {
      const answer = await window.parallax.request(hostId, "thread/delete", { runId: thread.id });
      if ("error" in answer) return answer.error.message;
      dispatch({
        type: "event",
        event: { kind: "thread.deleted", runId: thread.id, repo: thread.repo },
      });
      return undefined;
    },
    [hostId],
  );

  const refresh = useCallback(
    (repo: string) => {
      void window.parallax.request(hostId, "agent/list", { project: repo }).then((answer) => {
        if (shown.current === hostId && "result" in answer)
          dispatch({ type: "runs", runs: answer.result.runs });
      });
    },
    [hostId],
  );

  const createProject = useCallback(
    async (id: string, name: string, repoPath: string, icon?: ProjectIconValue) => {
      const answer = await window.parallax.request(hostId, "project/create", {
        id,
        name,
        repoPath,
        ...(icon && { icon }),
      });
      if ("error" in answer) return describeError(answer.error);
      // Not into another host's list, if the user has left this one.
      if (shown.current === hostId)
        dispatch({
          type: "event",
          event: { kind: "project.created", project: answer.result.project },
        });
      return answer.result.project;
    },
    [hostId],
  );

  const updateProject = useCallback(
    async (project: string, change: ProjectChange) => {
      const answer = await window.parallax.request(hostId, "project/update", {
        project,
        ...change,
      });
      if ("error" in answer) return describeError(answer.error);
      if (shown.current === hostId)
        dispatch({
          type: "event",
          event: { kind: "project.updated", project: answer.result.project },
        });
      return undefined;
    },
    [hostId],
  );

  const startCoordinator = useCallback(
    async (
      project: string,
      runId: string,
      prompt: string,
      images: PromptImage[],
      options: CoordinatorOptions,
    ) => {
      const answer = await window.parallax.request(hostId, "project/start", {
        project,
        runId,
        prompt,
        ...(images.length > 0 && { images }),
        ...options,
        ...(approvals && { approvals }),
      });
      if ("error" in answer) return answer.error;
      if (shown.current === hostId) dispatch({ type: "coordinator", run: answer.result.run });
      return undefined;
    },
    [hostId, approvals],
  );

  return {
    state,
    error,
    addRepo,
    start,
    archive,
    remove,
    refresh,
    createProject,
    updateProject,
    startCoordinator,
  };
}
