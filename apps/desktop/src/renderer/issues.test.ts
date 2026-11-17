import { expect, test } from "vite-plus/test";

import type { Issue, IssueProvider } from "../protocol/generated/protocol";
import { draftGroup, issueDraft, matchesIssue, mergeIssues, sortIssues } from "./issues";

const issue = (over: Partial<Issue> = {}): Issue => ({
  connectionId: "github",
  provider: "github",
  id: "octo/hello#12",
  key: "#12",
  title: "Crash on start",
  url: "https://github.com/octo/hello/issues/12",
  state: { id: "open", name: "Open", category: "todo" },
  container: { id: "octo/hello", name: "octo/hello" },
  updatedAt: "2026-11-17T12:00:00Z",
  ...over,
});

const linear = issue({
  connectionId: "lin",
  provider: "linear",
  id: "9c67",
  key: "ENG-12",
  title: "Show issues in Parallax",
  url: "https://linear.app/acme/issue/ENG-12",
  state: { id: "s1", name: "In Progress", category: "inProgress" },
  container: { id: "t1", name: "Engineering" },
  assignee: "Ada Lovelace",
  updatedAt: "2026-11-16T12:00:00Z",
});

test("an issue two computers read shows once, as the first computer's copy", () => {
  const merged = mergeIssues([
    { hostId: "mac", issues: [issue(), linear] },
    { hostId: "mini", issues: [issue({ title: "Stale copy" }), issue({ url: "https://x/2" })] },
  ]);
  expect(merged.map((e) => [e.hostId, e.issue.url])).toEqual([
    ["mac", "https://github.com/octo/hello/issues/12"],
    ["mac", "https://linear.app/acme/issue/ENG-12"],
    ["mini", "https://x/2"],
  ]);
  expect(merged[0]!.issue.title).toBe("Crash on start");
});

test("a tracker this version doesn't know is left out", () => {
  const other = issue({ provider: "gitlab" as IssueProvider, url: "https://gitlab.com/a/b/1" });
  expect(mergeIssues([{ hostId: "mac", issues: [other, linear] }])).toHaveLength(1);
});

test("search needs every word, across key, title, state, container, and assignee", () => {
  const none = new Set<IssueProvider>();
  expect(matchesIssue(linear, "eng-12 progress", none)).toBe(true);
  expect(matchesIssue(linear, "engineering ada", none)).toBe(true);
  expect(matchesIssue(linear, "issues crash", none)).toBe(false);
  expect(matchesIssue(linear, "", new Set<IssueProvider>(["github"]))).toBe(false);
  expect(matchesIssue(linear, "show", new Set<IssueProvider>(["github", "linear"]))).toBe(true);
});

test("sorts by update, by state with what's under way first, and by title", () => {
  const entries = [issue(), linear].map((i) => ({ hostId: "mac", issue: i }));
  const keys = (sort: Parameters<typeof sortIssues>[1]) =>
    sortIssues(entries, sort).map((e) => e.issue.key);
  expect(keys("updated")).toEqual(["#12", "ENG-12"]);
  expect(keys("state")).toEqual(["ENG-12", "#12"]);
  expect(keys("title")).toEqual(["#12", "ENG-12"]);
});

test("a thread's draft holds the issue's key, title, URL, and body, a line to a paragraph", () => {
  const draft = issueDraft("mac", "repo-1", issue(), "It crashes.\n\n- on launch\n");
  expect(draft).toMatchObject({ hostId: "mac", groupId: "repo-1" });
  expect(draft.text).toBe(
    "Work on #12: Crash on start\nhttps://github.com/octo/hello/issues/12\n\nIt crashes.\n\n- on launch",
  );
  expect(draft.doc.content).toHaveLength(6);
  expect(draft.doc.content![2]).toEqual({ type: "paragraph" });
  expect(draft.doc.content![5]).toEqual({
    type: "paragraph",
    content: [{ type: "text", text: "- on launch" }],
  });
});

test("an issue with no body drafts its title and URL alone", () => {
  expect(issueDraft("mac", "g", issue(), "").text).toBe(
    "Work on #12: Crash on start\nhttps://github.com/octo/hello/issues/12",
  );
});

test("a GitHub issue's thread starts in the repository of its name, never a Project or another repo", () => {
  const groups = [
    { id: "p1", name: "hello", project: true },
    { id: "g1", name: "parallax" },
    { id: "g2", name: "hello" },
  ];
  expect(draftGroup(issue(), groups, "g1", "no-repo")).toBe("g2");
  expect(draftGroup(issue(), groups.slice(0, 2), "g1", "no-repo")).toBe("no-repo");
  expect(draftGroup(linear, groups, "g1", "no-repo")).toBe("g1");
});
