import { expect, test } from "vite-plus/test";

import type { Issue, IssueProvider } from "../protocol/generated/protocol";
import type { IssueEntry } from "./issues";
import {
  boardGroups,
  containerChoices,
  pickedContainer,
  pickedProvider,
  draftGroup,
  dropState,
  issueDraft,
  activeFilters,
  matchesFilters,
  matchesIssue,
  projectChoices,
  mergeIssues,
  sortIssues,
} from "./issues";

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

test("the board groups issues by where their state leans, and leaves canceled ones out", () => {
  const canceled = issue({
    url: "https://x/3",
    state: { id: "notPlanned", name: "Closed as not planned", category: "canceled" },
  });
  const newer = issue({
    url: "https://x/4",
    state: { id: "s9", name: "Blocked", category: "blocked" as never },
  });
  const groups = boardGroups(
    [issue(), linear, canceled, newer].map((i) => ({ hostId: "mac", issue: i })),
  );
  expect(groups.backlog).toEqual([]);
  // A category this version doesn't know reads as to do.
  expect(groups.todo.map((e) => e.issue.url)).toEqual([issue().url, "https://x/4"]);
  expect(groups.inProgress.map((e) => e.issue.key)).toEqual(["ENG-12"]);
  expect(groups.done).toEqual([]);
});

test("a drop moves an issue to the column's first state in the tracker's order, or nowhere", () => {
  const states = [
    { id: "a", name: "Todo", category: "todo" as const },
    { id: "b", name: "In Progress", category: "inProgress" as const },
    { id: "c", name: "In Review", category: "inProgress" as const },
    { id: "d", name: "Done", category: "done" as const },
  ];
  expect(dropState(states, "inProgress")?.id).toBe("b");
  expect(dropState(states, "done")?.id).toBe("d");
  expect(dropState(states, "backlog")).toBeUndefined();
  // A state named as the column wins over one the tracker lists first.
  const named = [
    { id: "t", name: "Triage", category: "backlog" as const },
    { id: "b", name: "Backlog", category: "backlog" as const },
    { id: "u", name: "Unstarted", category: "todo" as const },
    { id: "o", name: "TODO", category: "todo" as const },
    { id: "w", name: "Won't Do", category: "done" as const },
    { id: "d", name: "Done", category: "done" as const },
  ];
  expect(dropState(named, "backlog")?.id).toBe("b");
  expect(dropState(named, "todo")?.id).toBe("o");
  expect(dropState(named, "done")?.id).toBe("d");
});

const account = (hostId: string, id: string, site: string) => ({
  hostId,
  connection: { id, provider: "jira" as const, account: "ada@example.com", site },
});

test("one account's places list with no heading, and several accounts' under each site", () => {
  const acme = account("mac", "j1", "acme.atlassian.net");
  const other = account("mac", "j2", "other.atlassian.net");
  const containers = {
    "mac\nj1": [{ id: "OPS", name: "Operations" }],
    "mac\nj2": [
      { id: "OPS", name: "Ops" },
      { id: "WEB", name: "Website" },
    ],
  };
  expect(containerChoices([acme], containers).map((c) => [c.group, c.label])).toEqual([
    [undefined, "Operations"],
  ]);
  const both = containerChoices([acme, other], containers);
  expect(both.map((c) => [c.group, c.label])).toEqual([
    ["acme.atlassian.net", "Operations"],
    ["other.atlassian.net", "Ops"],
    ["other.atlassian.net", "Website"],
  ]);
  // The same project key on two sites is two choices.
  expect(new Set(both.map((c) => c.value)).size).toBe(3);
  expect(both[1]).toMatchObject({ account: other, containerId: "OPS" });
});

test("two computers' accounts on one site are told apart by their computer", () => {
  const groups = containerChoices(
    [account("mac", "j1", "acme.atlassian.net"), account("mini", "j9", "acme.atlassian.net")],
    {
      "mac\nj1": [{ id: "OPS", name: "Operations" }],
      "mini\nj9": [{ id: "OPS", name: "Operations" }],
    },
    { mac: "MacBook", mini: "Mac mini" },
  ).map((c) => c.group);
  expect(groups).toEqual(["acme.atlassian.net · MacBook", "acme.atlassian.net · Mac mini"]);
});

test("New issue opens on the last tracker and place picked, while they're still there", () => {
  const choices = containerChoices([account("mac", "j1", "acme.atlassian.net")], {
    "mac\nj1": [
      { id: "OPS", name: "Operations" },
      { id: "REL", name: "Release" },
    ],
  });
  const saved = { provider: "jira" as const, container: "mac\nj1\nREL" };
  expect(pickedProvider(saved, ["github", "jira"])).toBe("jira");
  expect(pickedProvider(saved, ["github", "linear"])).toBe("github");
  expect(pickedProvider({}, [])).toBeUndefined();
  expect(pickedContainer(saved, choices)).toBe("mac\nj1\nREL");
  // A place that's gone picks nothing, unless only one is left.
  expect(pickedContainer({ container: "mac\nj1\nGONE" }, choices)).toBe("");
  expect(pickedContainer({}, choices.slice(0, 1))).toBe("mac\nj1\nOPS");
});

const jiraOn = (site: string, id: string, key: string): IssueEntry => ({
  hostId: "mac",
  issue: issue({
    connectionId: id,
    provider: "jira",
    key,
    url: `https://${site}/browse/${key}`,
    container: { id: "OPS", name: "Operations" },
  }),
});
const filterAccounts = [
  { hostId: "mac", connection: { id: "github", provider: "github" as const, account: "octocat" } },
  {
    hostId: "mac",
    connection: { id: "lin", provider: "linear" as const, account: "Ada", site: "Acme" },
  },
  account("mac", "j1", "acme.atlassian.net"),
  account("mac", "j2", "other.atlassian.net"),
];
const filterEntries: IssueEntry[] = [
  { hostId: "mac", issue: issue() },
  { hostId: "mac", issue: linear },
  jiraOn("acme.atlassian.net", "j1", "OPS-1"),
  jiraOn("other.atlassian.net", "j2", "OPS-9"),
];

test("the Project filter lists each place once, by tracker, and by site where a tracker has two", () => {
  const twice = [...filterEntries, { hostId: "mac", issue: issue({ url: "https://x/2" }) }];
  expect(projectChoices(twice, filterAccounts).map((c) => [c.group, c.label])).toEqual([
    ["GitHub", "octo/hello"],
    ["Linear", "Engineering"],
    ["Jira · acme.atlassian.net", "Operations"],
    ["Jira · other.atlassian.net", "Operations"],
  ]);
  // Picking a tracker narrows it to that tracker's.
  expect(projectChoices(twice, filterAccounts, ["linear"]).map((c) => c.label)).toEqual([
    "Engineering",
  ]);
});

test("the project filter shows one project's issues, and tells one key on two sites apart", () => {
  const [, , acme, other] = projectChoices(filterEntries, filterAccounts);
  const keys = (filters: Parameters<typeof matchesFilters>[2], query = "") =>
    filterEntries
      .filter((e) => matchesFilters(e, query, filters, filterAccounts))
      .map((e) => e.issue.key);
  expect(keys({ trackers: [], project: "" })).toEqual(["#12", "ENG-12", "OPS-1", "OPS-9"]);
  expect(keys({ trackers: [], project: acme!.value })).toEqual(["OPS-1"]);
  expect(keys({ trackers: [], project: other!.value })).toEqual(["OPS-9"]);
  // Tracker and project together: both must hold, with the search.
  expect(keys({ trackers: ["jira", "github"], project: "" })).toEqual(["#12", "OPS-1", "OPS-9"]);
  expect(keys({ trackers: ["jira"], project: other!.value })).toEqual(["OPS-9"]);
  expect(keys({ trackers: ["github"], project: other!.value })).toEqual([]);
  expect(keys({ trackers: ["jira"], project: other!.value }, "ops-1")).toEqual([]);
});

test("a filter for a tracker with no account, or a project no longer listed, doesn't apply", () => {
  const choices = projectChoices(filterEntries, filterAccounts, ["linear"]);
  const saved = {
    trackers: ["linear" as const, "jira" as const],
    project: "jira\nacme.atlassian.net\nOPS",
  };
  expect(activeFilters(saved, ["github", "linear"], choices)).toEqual({
    trackers: ["linear"],
    project: "",
  });
  const all = projectChoices(filterEntries, filterAccounts);
  expect(activeFilters(saved, ["linear", "jira"], all)).toEqual(saved);
});
