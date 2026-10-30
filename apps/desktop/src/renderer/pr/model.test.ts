import { expect, test } from "vite-plus/test";

import type { PrCheck, PullRequest } from "../../protocol/generated/protocol";
import { checkRollup, groupChecks, mergeGate, threadsOf } from "./model";

const check = (name: string, state: PrCheck["state"], workflow?: string): PrCheck => ({
  name,
  state,
  workflow,
});

test("checkRollup counts passed of those that count, skipped left out, failed over running", () => {
  expect(
    checkRollup([
      check("a", "passed"),
      check("b", "failed"),
      check("c", "pending"),
      check("d", "skipped"),
    ]),
  ).toMatchObject({
    state: "failed",
    passed: 1,
    total: 3,
    words: "1 of 3 checks passed, 1 failed, 1 running",
  });
  expect(checkRollup([check("a", "skipped")])).toMatchObject({
    state: "skipped",
    words: "Checks skipped",
  });
  expect(checkRollup([])).toMatchObject({ state: "none", words: "No checks" });
});

test("groupChecks puts a workflow with a failure first, its failed job first", () => {
  const groups = groupChecks([
    check("lint", "passed", "CI"),
    check("docs", "passed", "Docs"),
    check("e2e", "failed", "E2E"),
    check("deploy", "pending"),
  ]);
  expect(groups.map((g) => [g.name, g.checks.map((c) => c.name)])).toEqual([
    ["E2E", ["e2e"]],
    ["Other checks", ["deploy"]],
    ["CI", ["lint"]],
    ["Docs", ["docs"]],
  ]);
});

const pr = (more: Partial<PullRequest>): PullRequest => ({
  number: 1,
  title: "T",
  url: "https://github.com/me/app/pull/1",
  repo: "me/app",
  state: "open",
  draft: false,
  author: "me",
  updatedAt: "2026-10-02T12:00:00Z",
  baseBranch: "main",
  headBranch: "b",
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  body: "",
  comments: [],
  reviewRequests: [],
  labels: [],
  checks: [],
  ...more,
});

test("mergeGate offers Merge only when GitHub would take it, and says why not", () => {
  expect(mergeGate(pr({ mergeState: "clean" }))).toMatchObject({ tone: "ready", canMerge: true });
  expect(mergeGate(pr({ mergeState: "unstable" }))).toMatchObject({
    tone: "warning",
    canMerge: true,
  });
  expect(mergeGate(pr({ draft: true, mergeState: "draft" }))).toMatchObject({
    draft: true,
    canMerge: false,
  });
  expect(mergeGate(pr({ mergeState: "dirty" }))).toMatchObject({
    title: "This branch has conflicts",
    canMerge: false,
    canAutoMerge: false,
  });
  expect(mergeGate(pr({ mergeState: "behind" }))).toMatchObject({
    behind: true,
    canMerge: false,
    canAutoMerge: true,
  });
  expect(mergeGate(pr({ mergeState: "blocked", checks: [check("t", "failed")] }))).toMatchObject({
    title: "Checks failed",
    reasons: ["1 check failed."],
    canAutoMerge: true,
  });
  expect(mergeGate(pr({ mergeState: undefined }))).toMatchObject({
    tone: "pending",
    canMerge: false,
  });
  expect(mergeGate(pr({ state: "merged" }))).toMatchObject({ tone: "merged", canMerge: false });
});

test("threadsOf takes PLX-1151's full threads when sent, else pr/status's unresolved ones", () => {
  const status = {
    unresolvedThreads: [{ id: "T1", path: "a.ts", author: "rev", body: "Rename" }],
  } as Parameters<typeof threadsOf>[1];
  expect(threadsOf(pr({}), status)).toEqual([
    {
      id: "T1",
      path: "a.ts",
      resolved: false,
      url: undefined,
      comments: [{ author: "rev", body: "Rename" }],
    },
  ]);
  const full = pr({
    reviewThreads: [
      { id: "T2", path: "b.ts", line: 4, isResolved: true, comments: [{ author: "a", body: "x" }] },
    ],
  } as Partial<PullRequest>);
  expect(threadsOf(full, status)).toMatchObject([{ id: "T2", line: 4, resolved: true }]);
});
