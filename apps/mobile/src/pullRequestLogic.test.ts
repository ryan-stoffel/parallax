import { expect, test } from "vitest";

import type { PullRequest } from "../../desktop/src/protocol/generated/protocol";
import { activityOf, checksSummary, diffRows, reviewsSummary, shownRows, type PrFilters } from "./pullRequestLogic";

test("a diff splits into files, hunks, and numbered lines", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ function a() {",
    " keep",
    "--- a removed line that starts with dashes",
    "+added",
    "\\ No newline at end of file",
    "diff --git a/b.md b/b.md",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");
  expect(diffRows(diff)).toEqual([
    { kind: "file", path: "src/a.ts", additions: 1, deletions: 1 },
    { kind: "hunk", text: "@@ -10,3 +10,3 @@ function a() {" },
    { kind: "context", text: "keep", line: 10 },
    { kind: "del", text: "-- a removed line that starts with dashes", line: 11 },
    { kind: "add", text: "added", line: 11 },
    { kind: "file", path: "b.md", additions: 1, deletions: 0 },
    { kind: "hunk", text: "@@ -0,0 +1 @@" },
    { kind: "add", text: "hello", line: 1 },
  ]);
});

test("checks summarize failing first, then running, then passed", () => {
  const check = (state: "passed" | "failed" | "pending") => ({ name: state, state });
  expect(checksSummary([check("passed"), check("failed"), check("pending")]).title).toBe("1 check failing");
  expect(checksSummary([check("passed"), check("pending")]).title).toBe("Checks running");
  expect(checksSummary([check("passed"), check("passed")])).toEqual({
    title: "All checks passed",
    value: "2 of 2",
    tone: "success",
  });
});

test("a reviewer's latest verdict counts, and a later comment doesn't undo it", () => {
  const review = (author: string, state: "approved" | "changesRequested" | "commented", at: string) => ({
    author,
    state,
    submittedAt: at,
  });
  expect(
    reviewsSummary({
      reviewRequests: [],
      reviews: [review("ana", "changesRequested", "1"), review("ana", "approved", "2"), review("ana", "commented", "3")],
    }).title,
  ).toBe("Approved by ana");
  expect(reviewsSummary({ reviewRequests: ["bo"], reviews: [] }).title).toBe("Awaiting review");
});

test("a review's text shows once, with its verdict, among commits in time order", () => {
  const pr = {
    state: "open",
    comments: [{ author: "ana", body: "Looks good", createdAt: "2026-01-01T10:00:02Z" }],
    reviews: [{ author: "ana", state: "approved", submittedAt: "2026-01-01T10:00:00Z" }],
    commits: [{ oid: "abc", headline: "fix", author: "bo", committedAt: "2026-01-01T09:00:00Z" }],
  } as PullRequest;
  expect(activityOf(pr).map((e) => [e.kind, "verdict" in e ? e.verdict : undefined])).toEqual([
    ["commit", undefined],
    ["comment", "approved"],
  ]);
});

test("the list's filters: open includes drafts, an unread one shows, and computer and repo narrow", () => {
  const row = (n: number, host: string, pr?: Partial<PullRequest>) => ({
    entry: { hostId: host, runId: `r${n}`, threadTitle: "A thread", url: `https://github.com/me/app${n % 2}/pull/${n}` },
    read: pr && { pr: { state: "open", draft: false, labels: [], updatedAt: `2026-01-0${n}T00:00:00Z`, ...pr } as PullRequest },
  });
  const rows = [row(1, "a", { draft: true }), row(2, "a", { state: "merged" }), row(3, "b", { checksState: "failed" }), row(4, "b")];
  const shown = (f: PrFilters, q = "") => shownRows(rows, q, f).map((r) => r.entry.runId);
  expect(shown({ state: "open" })).toEqual(["r3", "r1", "r4"]);
  expect(shown({ state: "draft" })).toEqual(["r1", "r4"]);
  expect(shown({ state: "all", checks: "failed" })).toEqual(["r3", "r4"]);
  expect(shown({ state: "all", hostId: "a" })).toEqual(["r2", "r1"]);
  expect(shown({ state: "all", repo: "me/app0" })).toEqual(["r2", "r4"]);
  expect(shown({ state: "all" }, "#3")).toEqual(["r3"]);
});
