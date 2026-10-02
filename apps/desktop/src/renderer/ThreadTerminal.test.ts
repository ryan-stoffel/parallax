import { expect, test } from "vite-plus/test";

import type { AgentRun, Repo, Thread } from "../protocol/generated/protocol";
import { emptyThreads } from "./threads";
import { folderOf } from "./ThreadTerminal";

test("a thread's terminal opens in its worktree, or its repository for a checkout thread", () => {
  const repo = { id: "r1", name: "app", path: "/src/app" } as Repo;
  const thread = (id: string) => ({ id, repo: "r1" }) as Thread;
  const state = {
    ...emptyThreads,
    repos: [repo, { id: "s", name: "", path: "/scratch", scratch: true } as Repo],
    threads: [thread("t1"), thread("t2"), thread("t3")],
    runs: {
      t1: { id: "t1", worktreePath: "/wt/t1" } as AgentRun,
      t2: { id: "t2", checkout: true } as AgentRun,
      t3: { id: "t3" } as AgentRun,
    },
  };
  expect(folderOf("local", state, { threadId: "t1" })).toEqual({
    key: "local/t1",
    hostId: "local",
    path: "/wt/t1",
    threadId: "t1",
  });
  expect(folderOf("local", state, { threadId: "t2" })?.path).toBe("/src/app");
  // Its worktree doesn't exist yet.
  expect(folderOf("local", state, { threadId: "t3" })).toBeUndefined();
  expect(folderOf("mini", state, { repoId: "r1" })).toEqual({
    key: "mini/new/r1",
    hostId: "mini",
    path: "/src/app",
  });
  expect(folderOf("local", state, { repoId: "s" })).toBeUndefined();
});
