import { expect, test } from "vite-plus/test";

import type { AgentRun, Repo, Thread } from "../protocol/generated/protocol";
import { emptyThreads } from "./threads";
import { folderOf } from "./ThreadTerminal";

test("a thread's terminal opens in its repository's checkout, or a No Repo thread's own folder", () => {
  const repo = { id: "r1", name: "app", path: "/src/app" } as Repo;
  const state = {
    ...emptyThreads,
    repos: [repo, { id: "s", name: "", path: "/scratch", scratch: true } as Repo],
    threads: [
      { id: "t1", repo: "r1" } as Thread,
      { id: "t2", repo: "r1" } as Thread,
      { id: "t3", repo: "s" } as Thread,
      { id: "t4", repo: "s" } as Thread,
    ],
    runs: {
      t1: { id: "t1", worktreePath: "/wt/t1" } as AgentRun,
      t2: { id: "t2", checkout: true } as AgentRun,
      t3: { id: "t3", worktreePath: "/scratch/t3" } as AgentRun,
    },
  };
  // A repository's threads and New thread share its checkout's terminal.
  const checkout = { key: "mini/new/r1", hostId: "mini", path: "/src/app" };
  expect(folderOf("mini", state, { threadId: "t1" })).toEqual(checkout);
  expect(folderOf("mini", state, { threadId: "t2" })).toEqual(checkout);
  expect(folderOf("mini", state, { repoId: "r1" })).toEqual(checkout);
  expect(folderOf("mini", state, { threadId: "t3" })).toEqual({
    key: "mini/t3",
    hostId: "mini",
    path: "/scratch/t3",
    threadId: "t3",
  });
  // Its scratch repository doesn't exist yet.
  expect(folderOf("mini", state, { threadId: "t4" })).toBeUndefined();
  expect(folderOf("mini", state, { repoId: "s" })).toBeUndefined();
});
