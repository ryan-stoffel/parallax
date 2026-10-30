import { expect, test } from "vite-plus/test";

import {
  capabilitiesFromLegacy,
  errorFromLegacy,
  eventFromLegacy,
  isLegacy,
  requestToLegacy,
  resultFromLegacy,
} from "./legacyNames";

test("a plxd from before 0093 is legacy, and its capabilities gain their new names", () => {
  expect(isLegacy({ coordinator: {}, projectEdit: {} })).toBe(true);
  expect(isLegacy({ orchestrator: {}, coordinator: {} })).toBe(false);
  expect(isLegacy({ threads: {} })).toBe(false);
  expect(capabilitiesFromLegacy({ coordinator: {}, projectEdit: {}, threads: {} })).toEqual({
    coordinator: {},
    projectEdit: {},
    threads: {},
    orchestrator: {},
    orchestratorEdit: {},
  });
});

test("requests take the old method and field names", () => {
  expect(requestToLegacy("orchestrator/update", { orchestrator: "o1", name: "fly" })).toEqual([
    "project/update",
    { project: "o1", name: "fly" },
  ]);
  expect(requestToLegacy("thread/start", { runId: "r", orchestrator: "o1", prompt: "go" })).toEqual(
    ["thread/start", { runId: "r", project: "o1", prompt: "go" }],
  );
  expect(requestToLegacy("agent/start", { project: "o1", orchestratorThread: "r1" })).toEqual([
    "agent/start",
    { project: "o1", coordinatorThread: "r1" },
  ]);
  expect(requestToLegacy("accounts/defaults/set", { role: "orchestrator" })).toEqual([
    "accounts/defaults/set",
    { role: "coordinator" },
  ]);
  expect(requestToLegacy("memory/list", { scope: { kind: "orchestrator", id: "o1" } })).toEqual([
    "memory/list",
    { scope: { kind: "project", id: "o1" } },
  ]);
});

test("results come back in the new names, and a run's scope and an agent's JSON stay", () => {
  const old = { id: "o1", name: "fly", repoPath: "/r", coordinator: "r1" };
  expect(resultFromLegacy("orchestrator/list", { projects: [old], seq: 3 })).toEqual({
    orchestrators: [{ id: "o1", name: "fly", repoPath: "/r", run: "r1" }],
    seq: 3,
  });
  expect(resultFromLegacy("orchestrator/create", { project: old })).toEqual({
    orchestrator: { id: "o1", name: "fly", repoPath: "/r", run: "r1" },
  });
  const run = { id: "r2", project: "o1", coordinatorThread: "r1", items: [{ coordinator: true }] };
  expect(resultFromLegacy("agent/list", { runs: [run] })).toEqual({
    runs: [{ id: "r2", project: "o1", orchestratorThread: "r1", items: [{ coordinator: true }] }],
  });
  expect(resultFromLegacy("providers/list", { providers: [{ coordinator: true }] })).toEqual({
    providers: [{ orchestrator: true }],
  });
  const account = { kind: "subscription", backend: "claude" };
  expect(resultFromLegacy("accounts/defaults/get", { coordinator: account })).toEqual({
    orchestrator: account,
  });
  expect(resultFromLegacy("schedule/list", { tasks: [{ id: "t", project: "o1" }] })).toEqual({
    tasks: [{ id: "t", orchestrator: "o1" }],
  });
  expect(resultFromLegacy("land/queue", { landing: { runId: "r", project: "o1" } })).toEqual({
    landing: { runId: "r", orchestrator: "o1" },
  });
});

test("events take the new names, from an old plxd or one replaying what it stored before", () => {
  const created = {
    subscription: "s",
    seq: 1,
    event: { kind: "project.created", project: { id: "o1", repoPath: "/r", coordinator: "r1" } },
  };
  expect(eventFromLegacy(created)).toEqual({
    subscription: "s",
    seq: 1,
    event: { kind: "orchestrator.created", orchestrator: { id: "o1", repoPath: "/r", run: "r1" } },
  });
  expect(eventFromLegacy({ event: { kind: "project.deleted", project: "o1" } })).toEqual({
    event: { kind: "orchestrator.deleted", orchestrator: "o1" },
  });
  const started = { event: { kind: "agent.started", run: { id: "r2", coordinatorThread: "r1" } } };
  expect(eventFromLegacy(started)).toEqual({
    event: { kind: "agent.started", run: { id: "r2", orchestratorThread: "r1" } },
  });
  const output = { event: { kind: "agent.output", items: [] } };
  expect(eventFromLegacy(output)).toBe(output);
});

test("an old error kind takes its new name", () => {
  expect(
    errorFromLegacy({ code: -32000, message: "m", data: { kind: "projectNotFound" } }),
  ).toEqual({ code: -32000, message: "m", data: { kind: "orchestratorNotFound" } });
});
