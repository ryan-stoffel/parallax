import { expect, test } from "vite-plus/test";

import type { AgentRun, Repo, Thread } from "../protocol/generated/protocol";
import { emptyThreads } from "./threads";
import { folderOf } from "./ThreadTerminal";

test("a terminal opens in a thread's worktree, else its repository's checkout, else home", () => {
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
  // A Current checkout thread and New thread share its repository's checkout terminal.
  const checkout = { key: "mini/new/r1", hostId: "mini", path: "/src/app" };
  expect(folderOf("mini", state, { threadId: "t1" })).toEqual({
    key: "mini/t1",
    hostId: "mini",
    path: "/wt/t1",
    threadId: "t1",
  });
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
  // No Repo's New thread opens in the host's home folder.
  expect(folderOf("mini", state, { repoId: "no-repo" })).toEqual({
    key: "mini/home",
    hostId: "mini",
    path: "~",
  });
});
