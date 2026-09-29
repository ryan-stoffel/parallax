import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentRun, Repo, Thread, WispEvent } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { uuidv7 } from "./uuidv7";

/** A host's repo entries and normal threads (0017), and each thread's title and run. */
export interface ThreadsState {
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

export const emptyThreads: ThreadsState = { repos: [], threads: [], titles: {}, runs: {} };

export type ThreadsAction =
  | { type: "snapshot"; repos: Repo[]; threads: Thread[]; runs: AgentRun[] }
  | { type: "runs"; runs: AgentRun[] }
  | { type: "event"; event: WispEvent };

/** Applies a snapshot, runs' titles, or a host-level event. Events are upserts, so a repeat is harmless. */
export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case "snapshot":
      return {
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
    case "event": {
      const e = action.event;
      switch (e.kind) {
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
  return Object.fromEntries(runs.map((r) => [r.id, r.prompt.trim().split("\n")[0]!]));
}

/** The sidebar's id for "No Repo", which holds wispd's scratch entry's threads, made on first use. */
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
 * entry isn't known yet goes under No Repo: `thread/start` with no repo answers before wispd's
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
  /** Starts a thread in a group. Reuse `runId` to retry. Resolves to wispd's error, or undefined. */
  start: (runId: string, groupId: string, prompt: string) => Promise<RpcError | undefined>;
  archive: (runId: string, archived: boolean) => Promise<string | undefined>;
  remove: (thread: Thread) => Promise<string | undefined>;
  /** Lists a repo entry's runs again, so their status is current. Failures are ignored. */
  refresh: (repo: string) => void;
}

/**
 * A host's threads, kept live: `thread/list` and `agent/list` (for titles and runs), then host-level
 * events after the list's `seq`, starting over on `resync`. Loads only while `connected`.
 */
export function useThreads(hostId: string, connected: boolean): ThreadsView {
  const [state, dispatch] = useReducer(threadsReducer, emptyThreads);
  const [error, setError] = useState<string>();
  // Another host starts empty, rather than showing this one's threads until its list loads.
  const [shownHost, setShownHost] = useState(hostId);
  if (shownHost !== hostId) {
    setShownHost(hostId);
    dispatch({ type: "snapshot", repos: [], threads: [], runs: [] });
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
      const list = await window.wisp.request(hostId, "thread/list", {});
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      // After the list, so every thread listed has its run here.
      const runs = await window.wisp.request(hostId, "agent/list", {});
      if (stopped) return;
      if ("error" in runs) return setError(runs.error.message);
      dispatch({ type: "snapshot", ...list.result, runs: runs.result.runs });
      setError(undefined);
      const since = { after: list.result.seq, logId: list.logId };
      unsubscribe = window.wisp.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type === "error") return setError(message.error.message);
        const { event } = message.event;
        dispatch({ type: "event", event });
        // Its title is its run's prompt, which the event doesn't carry.
        if (event.kind === "thread.started")
          void window.wisp
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
      // A fresh id is safe to retry with: wispd returns the entry a path already has.
      const answer = await window.wisp.request(hostId, "repo/add", { id: uuidv7(), path });
      if ("error" in answer) return describeError(answer.error);
      dispatch({ type: "event", event: { kind: "repo.added", repo: answer.result.repo } });
      return answer.result.repo;
    },
    [hostId],
  );

  const start = useCallback(
    async (runId: string, groupId: string, prompt: string) => {
      const answer = await window.wisp.request(hostId, "thread/start", {
        runId,
        prompt,
        ...(groupId !== noRepo && { repo: groupId }),
      });
      if ("error" in answer) return answer.error;
      dispatch({ type: "runs", runs: [answer.result.run] });
      dispatch({ type: "event", event: { kind: "thread.started", thread: answer.result.thread } });
      return undefined;
    },
    [hostId],
  );

  const archive = useCallback(
    async (runId: string, archived: boolean) => {
      const answer = await window.wisp.request(hostId, "thread/archive", { runId, archived });
      if ("error" in answer) return answer.error.message;
      dispatch({ type: "event", event: { kind: "thread.updated", thread: answer.result.thread } });
      return undefined;
    },
    [hostId],
  );

  const remove = useCallback(
    async (thread: Thread) => {
      const answer = await window.wisp.request(hostId, "thread/delete", { runId: thread.id });
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
      void window.wisp.request(hostId, "agent/list", { project: repo }).then((answer) => {
        if (shown.current === hostId && "result" in answer)
          dispatch({ type: "runs", runs: answer.result.runs });
      });
    },
    [hostId],
  );

  return { state, error, addRepo, start, archive, remove, refresh };
}
