import { expect, test } from "vitest";

import type { AgentRun, Orchestrator, Thread } from "../../desktop/src/protocol/generated/protocol";
import { emptyThreads, threadOrchestrators, type ThreadsState } from "../../desktop/src/renderer/threads";
import { agentsLine, orchestratorChildren, parentLink } from "./orchestratorLogic";

const orchestrator = { id: "o", name: "Formula fly", run: "chat" } as Orchestrator;
const run = (id: string, status: string, createdAt: string, policy = "workspaceWrite") =>
  ({ id, project: "o", status, createdAt, policy, prompt: id }) as unknown as AgentRun;
const thread = (id: string, parent?: string) => ({ id, parent }) as unknown as Thread;

const state: ThreadsState = {
  ...emptyThreads,
  orchestrators: [orchestrator],
  threads: [thread("chat"), thread("old"), thread("working", "chat"), thread("asking", "chat"), thread("grandchild", "working"), thread("plain"), thread("fork", "plain")],
  titles: { asking: "Fix login", plain: "A plain thread" },
  runs: Object.fromEntries(
    [
      run("chat", "running", "1", "noWrite"),
      run("old", "completed", "0", "noWrite"),
      run("done", "completed", "2"),
      run("newer", "failed", "5"),
      run("working", "running", "3"),
      run("working2", "running", "6"),
      run("asking", "running", "4"),
    ].map((r) => [r.id, r]),
  ),
  approvals: { asking: { items: [{}] } } as unknown as ThreadsState["approvals"],
};

test("an orchestrator's children leave out its own runs, most urgent first and newest within each", () => {
  const children = orchestratorChildren(state, orchestrator, threadOrchestrators(state));
  expect(children.map((c) => [c.run.id, c.attention])).toEqual([
    ["asking", "needsYou"],
    ["working2", "working"],
    ["working", "working"],
    ["done", "done"],
    ["newer", "failed"],
  ]);
  expect(children[0]?.title).toBe("Fix login");
  expect(agentsLine(children)).toBe("5 agents · 2 working");
  expect(agentsLine(children.slice(3, 4))).toBe("1 agent");
  expect(agentsLine([])).toBe("");
});

test("a thread links to its orchestrator's chat, however deep, and any other to its parent", () => {
  const chat = { name: "Formula fly", runId: "chat" };
  expect(parentLink(state, thread("working", "chat"))).toEqual(chat);
  expect(parentLink(state, thread("grandchild", "working"))).toEqual(chat);
  expect(parentLink(state, thread("chat"))).toBeUndefined();
  expect(parentLink(state, thread("fork", "plain"))).toEqual({ name: "A plain thread", runId: "plain" });
});
