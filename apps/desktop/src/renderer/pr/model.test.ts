import { expect, test } from "vite-plus/test";

import type { PrCheck, PullRequest } from "../../protocol/generated/protocol";
import { checkRollup, groupChecks, mergeGate, methodHint, statusRows, threadsOf } from "./model";

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

type Status = NonNullable<Parameters<typeof mergeGate>[1]>;

const statusOf = (more: Partial<Status> = {}): Status => ({
  url: pr({}).url,
  state: "OPEN",
  draft: false,
  baseBranch: "main",
  behindBy: 0,
  mergeable: "MERGEABLE",
  mergeState: "BLOCKED",
  failing: [],
  pending: [],
  passed: [],
  unresolvedThreads: [],
  watching: false,
  ready: false,
  reasons: ["Required review missing"],
  ...more,
});

test.each([
  ["BLOCKED", "Merging is blocked"],
  ["DIRTY", "This branch has conflicts"],
  ["BEHIND", "This branch is behind main"],
  ["UNKNOWN", "Checking whether it can merge"],
])("mergeGate uses matching status %s over a cached clean view", (mergeState, title) => {
  expect(mergeGate(pr({ mergeState: "clean" }), statusOf({ mergeState }))).toMatchObject({
    title,
    canMerge: false,
  });
});

test("mergeGate normalizes status states and falls back when status is absent or mismatched", () => {
  expect(mergeGate(pr({ mergeState: "clean" }), statusOf())).toMatchObject({
    reasons: ["Required review missing"],
    canMerge: false,
  });
  for (const mergeState of ["CLEAN", "HAS_HOOKS", "UNSTABLE"])
    expect(
      mergeGate(pr({ mergeState: "blocked" }), statusOf({ mergeState, reasons: [] })).canMerge,
    ).toBe(true);
  const current = Object.assign(pr({ mergeState: "clean" }), { headSha: "new-head" });
  for (const status of [
    undefined,
    statusOf({ url: "https://github.com/me/app/pull/2" }),
    statusOf({ headSha: "old-head" }),
  ])
    expect(mergeGate(current, status).canMerge).toBe(true);
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

const rows = (p: PullRequest) => statusRows(p, p.checks, mergeGate(p), "squash");

test("statusRows reads checks, reviews, and mergeability as the reference's rows", () => {
  const commit = { oid: "a", headline: "h", author: "me", committedAt: "2026-10-02T12:00:00Z" };
  expect(
    rows(
      pr({
        mergeState: "clean",
        checks: [check("a", "passed"), check("b", "passed"), check("c", "skipped")],
        reviews: [{ author: "julius", state: "approved", submittedAt: "2026-10-02T12:00:00Z" }],
        commits: [commit, { ...commit, oid: "b" }],
      }),
    ),
  ).toEqual([
    { key: "checks", tone: "passed", label: "All checks passed", detail: "2 of 2" },
    { key: "reviews", tone: "passed", label: "Approved by julius", detail: "1 approval" },
    {
      key: "merge",
      tone: "passed",
      label: "No conflicts with main",
      detail: "squash · 2 commits",
    },
  ]);
});

test("statusRows leaves out what doesn't apply and names what blocks", () => {
  // No checks and no reviews: only the merge row.
  expect(rows(pr({ mergeState: "dirty" }))).toEqual([
    { key: "merge", tone: "failed", label: "Conflicts with main", detail: undefined },
  ]);
  const blocked = rows(
    pr({
      mergeState: "behind",
      behindBy: 3,
      checks: [check("a", "failed"), check("b", "passed")],
      reviewDecision: "reviewRequired",
      reviewRequests: ["ana"],
    }),
  );
  expect(blocked.map((r) => [r.tone, r.label, r.detail])).toEqual([
    ["failed", "1 check failed", "1 of 2 passed"],
    ["waiting", "Review required", "1 requested"],
    ["waiting", "Behind main", "3 commits"],
  ]);
  // A later comment doesn't undo changes requested; a merged one has no merge row.
  const merged = rows(
    pr({
      state: "merged",
      reviews: [
        { author: "bo", state: "changesRequested", submittedAt: "2026-10-02T12:00:00Z" },
        { author: "bo", state: "commented", submittedAt: "2026-10-02T13:00:00Z" },
      ],
    }),
  );
  expect(merged).toEqual([
    { key: "reviews", tone: "failed", label: "Changes requested by bo", detail: undefined },
  ]);
});

test("methodHint says GitHub's line for each method, with the commits when known", () => {
  expect(methodHint("merge")).toBe(
    "All commits from this branch will be added to the base branch via a merge commit.",
  );
  expect(methodHint("squash", 8)).toBe(
    "The 8 commits from this branch will be combined into one commit in the base branch.",
  );
  expect(methodHint("rebase", 1)).toBe(
    "The 1 commit from this branch will be rebased and added to the base branch.",
  );
});
