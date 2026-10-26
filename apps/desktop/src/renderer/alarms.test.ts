import { expect, test } from "vite-plus/test";

import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { markOf, threadNotice } from "./alarms";

const thread = { id: "t", repo: "r", createdAt: "2026-10-01T10:00:00Z" } as Thread;
const run = (status: AgentRun["status"]) =>
  ({ id: "t", status, updatedAt: "2026-10-01T11:00:00Z" }) as AgentRun;

test("a thread finishes when its agent waits on nothing, not when a turn ends (PLX-1015)", () => {
  const completed = run("completed");
  // The turn ended, but background work or a watched pull request will wake the agent.
  const waiting = markOf(thread, completed, 0, "waiting");
  expect(waiting).toBe("waiting");
  expect(threadNotice("working", waiting, "Fix it", completed)).toBeUndefined();
  expect(
    threadNotice("working", markOf(thread, completed, 0, "monitoring"), "Fix it", completed),
  ).toBeUndefined();
  // Once it waits on nothing, it's done.
  const done = markOf(thread, completed, 0, undefined);
  expect(threadNotice(waiting, done, "Fix it", completed)?.title).toBe("Thread finished");
  // A usage limit is its own news.
  const limited = markOf(thread, run("waiting"), 0, undefined);
  expect(threadNotice("working", limited, "Fix it", run("waiting"))?.title).toBe(
    "Thread hit a usage limit",
  );
});
