import { expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/threads.json";
import type {
  AgentBackgroundTask,
  AgentRun,
  EventsEventParams,
  ThreadStartResult,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import {
  asksOf,
  emptyThreads,
  holdQuiet,
  projectRuns,
  threadProjects,
  threadsReducer,
  type ThreadsState,
} from "./threads";

const messages = samples as { id?: number; method?: string; params?: unknown; result?: unknown }[];
const events = messages
  .filter((m) => m.method === "events/event")
  .map((m) => (m.params as EventsEventParams).event);
const [parallaxAdded, threadStarted, , threadArchived, threadDeleted] = events as [
  ParallaxEvent,
  ParallaxEvent,
  ParallaxEvent,
  ParallaxEvent,
  ParallaxEvent,
];
const started = messages.find((m) => m.id === 4 && m.result)!.result as ThreadStartResult;

const apply = (state: ThreadsState, ...list: ParallaxEvent[]) =>
  list.reduce((s, event) => threadsReducer(s, { type: "event", event }), state);

test("repo.added, thread.started, and project.created add entries, and repeating one changes nothing", () => {
  const project = {
    id: "p-1",
    name: "parallax",
    repoPath: "/src/parallax",
    createdAt: "2026-09-26T12:00:00Z",
    updatedAt: "2026-09-26T12:00:00Z",
  };
  const created: ParallaxEvent = { kind: "project.created", project };
  const state = apply(emptyThreads, parallaxAdded, threadStarted, created);
  expect(apply(state, parallaxAdded, threadStarted, created)).toEqual(state);
  expect(state.repos.map((r) => r.name)).toEqual(["parallax"]);
  expect(state.threads.map((t) => t.id)).toEqual([started.thread.id]);
  expect(state.projects).toEqual([project]);
});

test("project.deleted drops the project and its runs, and keeps the rest", () => {
  const project = (id: string) => ({
    id,
    name: id,
    repoPath: "/src/parallax",
    createdAt: "2026-09-26T12:00:00Z",
    updatedAt: "2026-09-26T12:00:00Z",
  });
  const run = (id: string, inProject: string) => ({ id, project: inProject }) as AgentRun;
  const state: ThreadsState = {
    ...emptyThreads,
    projects: [project("p-1"), project("p-2")],
    runs: { a: run("a", "p-1"), b: run("b", "p-1"), c: run("c", "p-2"), t: run("t", "r-1") },
  };
  const after = apply(state, { kind: "project.deleted", project: "p-1" });
  expect(after.projects.map((p) => p.id)).toEqual(["p-2"]);
  expect(Object.keys(after.runs)).toEqual(["c", "t"]);
});

test("thread.updated replaces the thread, and thread.deleted removes it", () => {
  const archived = apply(emptyThreads, parallaxAdded, threadStarted, threadArchived);
  expect(archived.threads).toEqual([{ ...started.thread, archived: true }]);
  expect(apply(archived, threadDeleted).threads).toEqual([]);
});

test("runs are kept by id: a later list replaces the runs it has, and keeps the rest", () => {
  const other = { ...started.run, id: "other" };
  let state = threadsReducer(emptyThreads, {
    type: "snapshot",
    projects: [],
    repos: [],
    threads: [started.thread],
    runs: [started.run, other],
  });
  state = threadsReducer(state, { type: "runs", runs: [{ ...started.run, status: "failed" }] });
  expect(state.runs[started.run.id]?.status).toBe("failed");
  expect(state.runs["other"]).toEqual(other);
});

test("a scope's events keep a run current, stamp when it changed, and track what it asks", () => {
  const run = { id: "r-1", prompt: "Go", status: "running", updatedAt: "2026-10-01T10:00:00Z" };
  let state = threadsReducer(emptyThreads, {
    type: "snapshot",
    projects: [],
    repos: [],
    threads: [],
    runs: [run as never],
  });
  const asked = {
    seq: 5,
    time: "2026-10-01T10:01:00Z",
    event: {
      kind: "agent.output",
      runId: "r-1",
      items: [{ kind: "approvalRequested", requestId: "q-1", toolName: "Bash", input: {} }],
    },
  };
  const finished = {
    seq: 6,
    time: "2026-10-01T10:02:00Z",
    event: { kind: "agent.updated", runId: "r-1", state: { status: "completed", accountId: "a" } },
  };
  state = threadsReducer(state, { type: "scope", events: [asked as never] });
  expect(asksOf(state, "r-1")).toBe(1);
  state = threadsReducer(state, { type: "scope", events: [finished as never] });
  expect(state.runs["r-1"]).toMatchObject({
    status: "completed",
    updatedAt: "2026-10-01T10:02:00Z",
  });
});

test("an older log read for its requests never undoes a run's newer status", () => {
  const done = { id: "r-1", prompt: "Go", status: "completed", updatedAt: "2026-10-01T10:05:00Z" };
  let state = threadsReducer(emptyThreads, {
    type: "snapshot",
    projects: [],
    repos: [],
    threads: [],
    runs: [done as never],
  });
  const old = {
    seq: 2,
    time: "2026-10-01T10:00:00Z",
    event: { kind: "agent.updated", runId: "r-1", state: { status: "running", accountId: "a" } },
  };
  state = threadsReducer(state, { type: "approvals", events: [old as never] });
  expect(state.runs["r-1"]).toEqual(done);
});

test("a thread is in a Project when its run or an ancestor's is one of the Project's", () => {
  const run = (id: string, project: string) => ({ id, project }) as AgentRun;
  const thread = (id: string, parent?: string) => ({ id, repo: "r", createdAt: "", parent });
  const state: ThreadsState = {
    ...emptyThreads,
    projects: [{ id: "p", name: "p", repoPath: "/p", createdAt: "", updatedAt: "" }],
    runs: {
      coord: run("coord", "p"),
      child: run("child", "r"),
      grandchild: run("grandchild", "r"),
      plain: run("plain", "r"),
      own: run("own", "p"),
    },
    threads: [
      thread("child", "coord"),
      thread("grandchild", "child"),
      // Its own run is the Project's, as a child plxd starts in it may be.
      thread("own"),
      thread("plain"),
      thread("orphan", "gone"),
      thread("loop", "loop"),
    ],
  };
  const inProject = threadProjects(state);
  expect([...inProject]).toEqual([
    ["child", "p"],
    ["grandchild", "p"],
    ["own", "p"],
  ]);
  expect(projectRuns(state, "p", inProject).map((r) => r.id)).toEqual([
    "coord",
    "child",
    "grandchild",
    "own",
  ]);
});

test("holdQuiet holds the end of a run's background work until the agent has had time to wake (PLX-1015)", () => {
  vi.useFakeTimers();
  const applied: ParallaxEvent[] = [];
  const quiet = holdQuiet((e) => applied.push(e), 1000);
  const task = { taskId: "b1", kind: "command", description: "build" } as AgentBackgroundTask;
  const ended: ParallaxEvent = { kind: "agent.background", runId: "r", tasks: [] };
  const other: ParallaxEvent = { kind: "areas.changed", areas: [] };

  quiet.pass(other);
  quiet.pass(ended);
  expect(applied).toEqual([other]);
  // New work before the hold ends replaces it.
  const more: ParallaxEvent = { kind: "agent.background", runId: "r", tasks: [task] };
  quiet.pass(more);
  vi.advanceTimersByTime(1000);
  expect(applied).toEqual([other, more]);
  // With nothing new, it applies once the hold ends.
  quiet.pass(ended);
  vi.advanceTimersByTime(999);
  expect(applied).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(applied).toEqual([other, more, ended]);
  // The agent waking for it applies it at once.
  quiet.pass(ended);
  const woke = { kind: "agent.updated", runId: "r", state: { status: "running" } } as ParallaxEvent;
  quiet.pass(woke);
  expect(applied).toEqual([other, more, ended, woke, ended]);
  vi.advanceTimersByTime(1000);
  expect(applied).toHaveLength(5);
  // So does its stopping, since it can't wake now.
  quiet.pass(ended);
  const stopped = {
    kind: "agent.updated",
    runId: "r",
    state: { status: "cancelled" },
  } as ParallaxEvent;
  quiet.pass(stopped);
  expect(applied.slice(5)).toEqual([stopped, ended]);
  vi.useRealTimers();
});
