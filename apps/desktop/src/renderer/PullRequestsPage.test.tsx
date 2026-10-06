import { expect, test } from "vite-plus/test";

import type { PullRequest } from "../protocol/generated/protocol";
import { matches, sortRows, type PrRow } from "./PullRequestsPage";

const row = (n: number, pr?: Partial<PullRequest>, thread = "A thread"): PrRow => ({
  entry: {
    hostId: "h",
    runId: `r${n}`,
    threadTitle: thread,
    url: `https://github.com/me/app/pull/${n}`,
  },
  read: pr && {
    pr: {
      number: n,
      title: `Change ${n}`,
      url: `https://github.com/me/app/pull/${n}`,
      repo: "me/app",
      state: "open",
      draft: false,
      author: "ryan",
      updatedAt: `2026-10-0${n}T00:00:00Z`,
      baseBranch: "develop",
      headBranch: `feature/${n}`,
      changedFiles: 1,
      additions: 1,
      deletions: 1,
      body: "",
      comments: [],
      reviewRequests: [],
      labels: [],
      checks: [],
      ...pr,
    },
    at: "2026-10-06T00:00:00Z",
  },
});

const none = new Set<string>();

test("search matches the number, title, thread, and labels, and label: terms only labels", () => {
  const bug = row(3, { labels: ["bug"], title: "Fix crash" }, "Crash thread");
  expect(matches(bug, "#3", none)).toBe(true);
  expect(matches(bug, "crash", none)).toBe(true);
  expect(matches(bug, "label:bug", none)).toBe(true);
  expect(matches(bug, "label:docs", none)).toBe(false);
  expect(matches(bug, "fix label:bug", none)).toBe(true);
  expect(matches(bug, "state:open author:ryan", none)).toBe(true);
  expect(matches(bug, "state:merged", none)).toBe(false);
});

test("filters pick states and check results, and a draft is not Open", () => {
  const draft = row(1, { draft: true });
  const failing = row(2, { checksState: "failed" });
  expect(matches(draft, "", new Set(["draft"]))).toBe(true);
  expect(matches(draft, "", new Set(["open"]))).toBe(false);
  expect(matches(failing, "", new Set(["open", "failed"]))).toBe(true);
  expect(matches(failing, "", new Set(["passed"]))).toBe(false);
  // Not read yet: only words match, and no filter does.
  expect(matches(row(4), "thread", none)).toBe(true);
  expect(matches(row(4), "", new Set(["open"]))).toBe(false);
});

test("sorting orders by update, number, or title, with unread ones last", () => {
  const rows = [row(2, { title: "b" }), row(5), row(1, { title: "c" }), row(3, { title: "a" })];
  const order = (sort: Parameters<typeof sortRows>[1]) =>
    sortRows(rows, sort).map((r) => r.entry.url.split("/").pop());
  expect(order("updated")).toEqual(["3", "2", "1", "5"]);
  expect(order("oldest")).toEqual(["1", "2", "3", "5"]);
  expect(order("number")).toEqual(["3", "2", "1", "5"]);
  expect(order("title")).toEqual(["3", "2", "1", "5"]);
});
