import { expect, test } from "vite-plus/test";

import samples from "../../../../crates/wisp-protocol/samples/v1/threads.json";
import type {
  EventsEventParams,
  ThreadStartResult,
  WispEvent,
} from "../protocol/generated/protocol";
import { emptyThreads, groupThreads, noRepo, threadsReducer, type ThreadsState } from "./threads";

const messages = samples as { id?: number; method?: string; params?: unknown; result?: unknown }[];
const events = messages
  .filter((m) => m.method === "events/event")
  .map((m) => (m.params as EventsEventParams).event);
const [wispAdded, threadStarted, scratchAdded, threadArchived, threadDeleted] = events as [
  WispEvent,
  WispEvent,
  WispEvent,
  WispEvent,
  WispEvent,
];
const started = messages.find((m) => m.id === 4 && m.result)!.result as ThreadStartResult;
const quickChat = messages.find((m) => m.id === 5 && m.result)!.result as ThreadStartResult;

const apply = (state: ThreadsState, ...list: WispEvent[]) =>
  list.reduce((s, event) => threadsReducer(s, { type: "event", event }), state);

test("repo.added and thread.started add entries, and repeating one changes nothing", () => {
  const state = apply(emptyThreads, wispAdded, threadStarted, wispAdded, threadStarted);
  expect(state.repos.map((r) => r.name)).toEqual(["wisp"]);
  expect(state.threads.map((t) => t.id)).toEqual([started.thread.id]);
});

test("thread.updated replaces the thread, and thread.deleted removes it", () => {
  const archived = apply(emptyThreads, wispAdded, threadStarted, threadArchived);
  expect(archived.threads).toEqual([{ ...started.thread, archived: true }]);
  expect(apply(archived, threadDeleted).threads).toEqual([]);
});

test("a thread's title is the first line of its run's prompt", () => {
  const run = { ...started.run, prompt: "  Fix the flaky attach test.\nIt fails on CI.  " };
  const state = threadsReducer(emptyThreads, {
    type: "snapshot",
    repos: [],
    threads: [started.thread],
    runs: [run],
  });
  expect(state.titles).toEqual({ [run.id]: "Fix the flaky attach test." });
});

test("groups: repositories, then No Repo, newest first, archived apart", () => {
  // The quick chat's result arrives before the scratch entry's repo.added (seq 50).
  let state = apply(emptyThreads, wispAdded, threadStarted);
  state = apply(state, { kind: "thread.started", thread: quickChat.thread });
  const newer = { ...started.thread, id: "newer", createdAt: "2026-09-26T13:00:00Z" };
  state = apply(state, { kind: "thread.started", thread: newer });

  const byGroup = () =>
    groupThreads(state).groups.map((g) => [g.id, g.name, g.threads.map((t) => t.id)]);
  const wisp = started.thread.repo;
  expect(byGroup()).toEqual([
    [wisp, "wisp", ["newer", started.thread.id]],
    [noRepo, "No Repo", [quickChat.thread.id]],
  ]);
  // Once the scratch entry is known, it is still the one No Repo group, not a repository.
  state = apply(state, scratchAdded, threadArchived);
  expect(byGroup()).toEqual([
    [wisp, "wisp", ["newer"]],
    [noRepo, "No Repo", [quickChat.thread.id]],
  ]);
  expect(groupThreads(state).archived.map((t) => t.id)).toEqual([started.thread.id]);
});
