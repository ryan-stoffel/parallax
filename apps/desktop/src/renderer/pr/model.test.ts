import { expect, test } from "vite-plus/test";

import type { PrCheck, PrGuide, PullRequest } from "../../protocol/generated/protocol";
import {
  fileKind,
  kindsOf,
  checkRollup,
  commitPreview,
  groupChecks,
  guideView,
  baseIssue,
  mergeGate,
  mergeTone,
  methodHint,
  statusRows,
  threadsOf,
} from "./model";

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
    reasons: [],
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

test("mergeGate's reasons leave out what the status rows already say", () => {
  const gate = (reasons: string[]) =>
    mergeGate(pr({ mergeState: "blocked" }), statusOf({ mergeState: "BLOCKED", reasons })).reasons;
  expect(gate(["pending: e2e (macos-26), rust (windows-2025)"])).toEqual([]);
  expect(gate(["failing: test", "changes requested"])).toEqual([]);
  expect(gate(["pending: e2e", "1 unresolved review thread"])).toEqual([
    "1 unresolved review thread",
  ]);
  // The base chip says it's behind, which isn't why it's blocked.
  const blockedWhy = ["Branch protection needs a review or a check first."];
  expect(gate(["2 commits behind main"])).toEqual(blockedWhy);
  expect(gate([])).toEqual(blockedWhy);
});

test("baseIssue says when an open branch conflicts with its base or is behind it", () => {
  expect(baseIssue(pr({ mergeState: "dirty" }))).toEqual({
    kind: "conflicts",
    label: "Conflicts with main",
  });
  expect(baseIssue(pr({ mergeState: "behind" }))).toEqual({
    kind: "behind",
    label: "Behind main",
  });
  // Behind but not blocked by it, in a repository that doesn't require an up-to-date branch.
  expect(baseIssue(pr({ mergeState: "clean" }), statusOf({ behindBy: 1 }))).toEqual({
    kind: "behind",
    label: "1 commit behind main",
  });
  expect(baseIssue(pr({ draft: true, mergeState: "dirty" }))?.kind).toBe("conflicts");
  expect(baseIssue(pr({ mergeState: "clean" }))).toBeUndefined();
  // Another pull request's status, still held while this one's is read.
  expect(
    baseIssue(
      pr({ mergeState: "clean" }),
      statusOf({ url: "https://github.com/me/app/pull/2", behindBy: 3 }),
    ),
  ).toBeUndefined();
  expect(baseIssue(pr({ state: "merged" }), statusOf({ behindBy: 3 }))).toBeUndefined();
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

const rows = (p: PullRequest) => statusRows(p, p.checks, mergeGate(p));

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
      detail: "2 commits",
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
    ["waiting", "Review required", "ana requested"],
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

test("statusRows names requested reviewers who haven't reviewed beside the approvals", () => {
  const review = { state: "approved", submittedAt: "2026-10-02T12:00:00Z" } as const;
  const [row] = rows(
    pr({
      state: "merged",
      reviews: [{ author: "julius", ...review }],
      reviewRequests: ["julius", "ana", "bo", "cy"],
    }),
  );
  expect(row).toEqual({
    key: "reviews",
    tone: "passed",
    label: "Approved by julius",
    detail: "1 approval · ana and 2 others requested",
  });
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

test("mergeTone colors the merge button by the merge gate", () => {
  const tone = (more: Partial<PullRequest>) => {
    const p = pr(more);
    return mergeTone(mergeGate(p), p.checks);
  };
  expect(tone({ mergeState: "clean" })).toBe("ready");
  // A check still running is yellow even when GitHub would take the merge.
  const running: Partial<PullRequest> = { mergeState: "unstable", checks: [check("t", "pending")] };
  expect(tone(running)).toBe("running");
  expect(mergeGate(pr(running)).canMerge).toBe(true);
  expect(tone({ mergeState: "blocked", checks: [check("t", "pending")] })).toBe("running");
  expect(tone({ mergeState: undefined })).toBe("running");
  expect(tone({ mergeState: "blocked", checks: [check("t", "failed")] })).toBe("blocked");
  expect(tone({ mergeState: "blocked", reviewDecision: "changesRequested" })).toBe("blocked");
  expect(tone({ mergeState: "dirty" })).toBe("blocked");
  expect(tone({ mergeState: "behind" })).toBe("blocked");
  expect(tone({ state: "merged" })).toBe("merged");
  expect(tone({ draft: true, mergeState: "draft" })).toBe("neutral");
  expect(tone({ state: "closed" })).toBe("neutral");
});

test("commitPreview writes GitHub's default message for each method", () => {
  const commit = (oid: string, headline: string) => ({
    oid,
    headline,
    author: "me",
    committedAt: "2026-10-02T12:00:00Z",
  });
  const two = pr({
    number: 7,
    title: "Add a tray",
    headBranch: "tray",
    commits: [commit("aaaaaaa1", "feat: tray"), commit("bbbbbbb2", "test: tray")],
  });
  expect(commitPreview(two, "squash")).toEqual({
    title: "Add a tray (#7)",
    body: "* feat: tray\n\n* test: tray",
  });
  // One commit takes its own title, as GitHub's default does; none falls back to the PR's.
  expect(commitPreview({ ...two, commits: [commit("a", "feat: tray")] }, "squash")).toEqual({
    title: "feat: tray (#7)",
  });
  expect(commitPreview({ ...two, commits: [] }, "squash")).toEqual({ title: "Add a tray (#7)" });
  expect(commitPreview(two, "merge")).toEqual({
    title: "Merge pull request #7 from me/tray",
    body: "Add a tray",
  });
  expect(commitPreview(two, "rebase")).toEqual({
    replayed: [
      { oid: "aaaaaaa", headline: "feat: tray" },
      { oid: "bbbbbbb", headline: "test: tray" },
    ],
  });
});

test("guideView: the head's guide is ready, an older head's is stale until the new one lands", () => {
  const guide = (headSha: string): PrGuide => ({
    headSha,
    overview: "o",
    steps: [],
    createdAt: "2026-10-30T00:00:00Z",
  });
  expect(guideView({ guide: guide("b"), generating: false }, "b").kind).toBe("ready");
  expect(guideView({ guide: guide("b"), generating: true }, "b")).toEqual({
    kind: "ready",
    guide: guide("b"),
    generating: true,
  });
  expect(guideView({ guide: guide("a"), generating: true }, "b")).toEqual({
    kind: "stale",
    guide: guide("a"),
    generating: true,
    error: undefined,
  });
  expect(guideView({ guide: guide("a"), generating: false, error: "no" }, "b")).toMatchObject({
    kind: "stale",
    error: "no",
  });
  expect(guideView({ generating: true }, "b").kind).toBe("loading");
  expect(guideView(undefined, "b").kind).toBe("loading");
  expect(guideView({ generating: false, error: "no" }, "b")).toEqual({
    kind: "error",
    error: "no",
  });
  expect(guideView(undefined, "b", "offline")).toEqual({ kind: "error", error: "offline" });
});

test("file kinds tell tests, snapshots, and test classes from code", () => {
  const kinds = (path: string) => fileKind(path);
  expect(kinds("src/a.ts")).toBe("Code");
  expect(kinds("src/a.test.ts")).toBe("Tests");
  expect(kinds("pkg/a_test.go")).toBe("Tests");
  expect(kinds("test_a.py")).toBe("Tests");
  expect(kinds("src/FooTest.java")).toBe("Tests");
  expect(kinds("src/Latest.java")).toBe("Code");
  expect(kinds("src/__snapshots__/a.snap")).toBe("Mocks");
  expect(kinds("docs/a.md")).toBe("Docs");
  expect(kinds("pnpm-lock.yaml")).toBe("Generated");
});

test("a diff's lines add up by kind, and an empty kind stays out", () => {
  const rows = kindsOf([
    { path: "a.ts", added: 4, removed: 1 },
    { path: "b.ts", added: 1, removed: 1 },
    { path: "a.test.ts", added: 6, removed: 0 },
  ]);
  expect(rows).toEqual([
    { kind: "Code", added: 5, removed: 2 },
    { kind: "Tests", added: 6, removed: 0 },
  ]);
});
