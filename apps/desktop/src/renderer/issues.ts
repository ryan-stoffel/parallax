// The Issues page's merge, search, filter, and sort, and the New thread draft an issue starts,
// pure so they test without a page (0107).
import { msg } from "../i18n";
import type {
  Issue,
  IssueConnection,
  IssueProvider,
  IssueState,
  IssueStateCategory,
} from "../protocol/generated/protocol";
import type { Draft } from "./drafts";
import { locale } from "./locale";
import { uuidv7 } from "./uuidv7";

/** The trackers this version knows, in the order they list. A newer plxd's others are skipped. */
export const providers: readonly IssueProvider[] = ["github", "linear", "jira"];

/** Each tracker's name, which no language translates. */
export const providerNames: Record<IssueProvider, string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
};

const known = (provider: string): provider is IssueProvider =>
  (providers as readonly string[]).includes(provider);

/** An issue, and the computer it was read on, which its writes go through. */
export interface IssueEntry {
  hostId: string;
  issue: Issue;
}

/** A tracker account, and the computer it is saved on. */
export interface ConnectionEntry {
  hostId: string;
  connection: IssueConnection;
}

/** `connections` of the trackers this version knows. */
export const knownConnections = (connections: readonly IssueConnection[]) =>
  connections.filter((c) => known(c.provider));

/**
 * Every computer's issues as one list: an issue two computers both read shows once, by its `url`,
 * as the first computer's copy. Issues of a tracker this version doesn't know are left out.
 */
export function mergeIssues(
  perHost: readonly { hostId: string; issues: readonly Issue[] }[],
): IssueEntry[] {
  const byUrl = new Map<string, IssueEntry>();
  for (const { hostId, issues } of perHost)
    for (const issue of issues)
      if (known(issue.provider) && !byUrl.has(issue.url)) byUrl.set(issue.url, { hostId, issue });
  return [...byUrl.values()];
}

/**
 * Whether `issue` matches the search and the chosen trackers. The search is words that each must
 * appear in its key, title, state, container, assignee, or tracker's name. No tracker chosen
 * matches them all.
 */
export function matchesIssue(
  issue: Issue,
  query: string,
  chosen: ReadonlySet<IssueProvider>,
): boolean {
  if (chosen.size > 0 && !chosen.has(issue.provider)) return false;
  const haystack = [
    issue.key,
    issue.title,
    issue.state.name,
    issue.container.name,
    issue.assignee,
    providerNames[issue.provider],
  ]
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/** The Issues page's filters, shared by List and Board. */
export interface IssueFilters {
  /** The trackers shown. None shows them all. */
  trackers: readonly IssueProvider[];
  /** The one repository, team, or project shown, as a `ProjectChoice`'s value. Empty shows them all. */
  project: string;
}

/** The site or workspace of the account an issue was read with. Empty where it has none, as GitHub. */
const siteOf = (entry: IssueEntry, accounts: readonly ConnectionEntry[]) =>
  accounts.find((a) => a.hostId === entry.hostId && a.connection.id === entry.issue.connectionId)
    ?.connection.site ?? "";

/**
 * The key of the repository, team, or project `entry` is filed in: its tracker, its account's
 * site, and the container's id, so one Jira key on two sites is two projects.
 */
export const projectOf = (entry: IssueEntry, accounts: readonly ConnectionEntry[]) =>
  [entry.issue.provider, siteOf(entry, accounts), entry.issue.container.id].join("\n");

/** A repository, team, or project the Project filter offers. */
export interface ProjectChoice {
  value: string;
  label: string;
  /** Its tracker, and its account's site too when the tracker has several accounts. */
  group: string;
  provider: IssueProvider;
}

/**
 * The repositories, teams, and projects `entries` are filed in, once each, by tracker in the
 * trackers' order and then by name. With `trackers` chosen, only theirs.
 */
export function projectChoices(
  entries: readonly IssueEntry[],
  accounts: readonly ConnectionEntry[],
  trackers: readonly IssueProvider[] = [],
): ProjectChoice[] {
  const sites = (p: IssueProvider) =>
    new Set(accounts.filter((a) => a.connection.provider === p).map((a) => a.connection.site));
  const byValue = new Map<string, ProjectChoice>();
  for (const entry of entries) {
    const { provider, container } = entry.issue;
    if (trackers.length > 0 && !trackers.includes(provider)) continue;
    const site = siteOf(entry, accounts);
    const value = projectOf(entry, accounts);
    if (!byValue.has(value))
      byValue.set(value, {
        value,
        label: container.name,
        group:
          sites(provider).size > 1 && site
            ? `${providerNames[provider]} · ${site}`
            : providerNames[provider],
        provider,
      });
  }
  return [...byValue.values()].sort(
    (a, b) =>
      providers.indexOf(a.provider) - providers.indexOf(b.provider) ||
      a.group.localeCompare(b.group, locale()) ||
      a.label.localeCompare(b.label, locale()),
  );
}

/**
 * Whether `entry` passes the search and the filters: `matchesIssue` for the search and the
 * trackers, and filed in the filters' project when they name one.
 */
export const matchesFilters = (
  entry: IssueEntry,
  query: string,
  filters: IssueFilters,
  accounts: readonly ConnectionEntry[],
) =>
  matchesIssue(entry.issue, query, new Set(filters.trackers)) &&
  (!filters.project || projectOf(entry, accounts) === filters.project);

/**
 * `filters` as they apply now: without a tracker that has no account in `connected`, and without a
 * project that isn't among `choices`, as one of a tracker just filtered out isn't.
 */
export function activeFilters(
  filters: IssueFilters,
  connected: readonly IssueProvider[],
  choices: readonly ProjectChoice[],
): IssueFilters {
  return {
    trackers: filters.trackers.filter((p) => connected.includes(p)),
    project: choices.some((c) => c.value === filters.project) ? filters.project : "",
  };
}

export type IssueSort = "updated" | "state" | "title";

export const issueSorts: { id: IssueSort; label: string }[] = [
  { id: "updated", label: msg("Recently updated") },
  { id: "state", label: msg("State") },
  { id: "title", label: msg("Title") },
];

/** A state's category this version knows; a newer plxd's other reads as `todo`. */
export function categoryOf(category: string): IssueStateCategory {
  return category in categoryOrder ? (category as IssueStateCategory) : "todo";
}

/** The order State sorts in: what's under way first, then what's planned, then what's over. */
const categoryOrder: Record<IssueStateCategory, number> = {
  inProgress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  canceled: 4,
};

/** `entries` ordered by `sort`. State and Title fall back to the most recently updated first. */
export function sortIssues(entries: readonly IssueEntry[], sort: IssueSort): IssueEntry[] {
  const updated = (a: IssueEntry, b: IssueEntry) =>
    Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt);
  const by: Record<IssueSort, (a: IssueEntry, b: IssueEntry) => number> = {
    updated,
    state: (a, b) =>
      categoryOrder[categoryOf(a.issue.state.category)] -
        categoryOrder[categoryOf(b.issue.state.category)] || updated(a, b),
    title: (a, b) => a.issue.title.localeCompare(b.issue.title, locale()) || updated(a, b),
  };
  return [...entries].sort(by[sort]);
}

/** A tracker account's key among every computer's: its computer, then its id. */
export const accountKey = (a: ConnectionEntry) => `${a.hostId}\n${a.connection.id}`;

/** A place New issue can file in, as its second dropdown lists it. */
export interface ContainerChoice {
  /** The account's key, then the container's id. */
  value: string;
  label: string;
  /** Its account's site or workspace, as a heading, when the tracker has several accounts. */
  group?: string;
  account: ConnectionEntry;
  containerId: string;
}

/**
 * Every repository, team, or project of `accounts`, one tracker's, from each account's
 * `containers` once read, by `accountKey`. With several accounts, as two Jira sites or two Linear
 * workspaces have, each account's are under its site, or its name where it has none, and under
 * its computer's name too when two computers hold an account of that name.
 */
export function containerChoices(
  accounts: readonly ConnectionEntry[],
  containers: Readonly<Record<string, readonly { id: string; name: string }[]>>,
  hostNames: Readonly<Record<string, string>> = {},
): ContainerChoice[] {
  const name = (a: ConnectionEntry) => a.connection.site ?? a.connection.account;
  const group = (a: ConnectionEntry) =>
    accounts.length < 2
      ? undefined
      : accounts.some((b) => b !== a && name(b) === name(a))
        ? `${name(a)} · ${hostNames[a.hostId] ?? a.hostId}`
        : name(a);
  return accounts.flatMap((account) =>
    (containers[accountKey(account)] ?? []).map((c) => ({
      value: `${accountKey(account)}\n${c.id}`,
      label: c.name,
      group: group(account),
      account,
      containerId: c.id,
    })),
  );
}

/** The tracker and the place New issue last filed in, which it opens on. */
export interface IssuePick {
  provider?: IssueProvider;
  /** A `ContainerChoice`'s value. */
  container?: string;
}

/** The tracker New issue opens on: the last one picked while it's connected, else the first connected. */
export const pickedProvider = (saved: IssuePick, connected: readonly IssueProvider[]) =>
  saved.provider && connected.includes(saved.provider) ? saved.provider : connected[0];

/**
 * The place New issue starts on among `choices`: the last one picked while it's still there, else
 * the only one, else none.
 */
export const pickedContainer = (saved: IssuePick, choices: readonly ContainerChoice[]) =>
  choices.find((c) => c.value === saved.container)?.value ??
  (choices.length === 1 ? choices[0]!.value : "");

/** The Board's columns, in order. Canceled issues have none. */
export const boardColumns = [
  { id: "backlog", label: msg("Backlog") },
  { id: "todo", label: msg("To do") },
  { id: "inProgress", label: msg("In progress") },
  { id: "done", label: msg("Done") },
] as const satisfies readonly { id: IssueStateCategory; label: string }[];

export type BoardColumn = (typeof boardColumns)[number]["id"];

/** `entries` by the Board column their state leans to, in the order given. Canceled ones are left out. */
export function boardGroups(entries: readonly IssueEntry[]): Record<BoardColumn, IssueEntry[]> {
  const groups: Record<BoardColumn, IssueEntry[]> = {
    backlog: [],
    todo: [],
    inProgress: [],
    done: [],
  };
  for (const entry of entries) {
    const category = categoryOf(entry.issue.state.category);
    if (category !== "canceled") groups[category].push(entry);
  }
  return groups;
}

/** A name as columns and states compare: "To do", "Todo", and "TO DO" are one. */
const plain = (name: string) => name.toLowerCase().replace(/\s+/g, "");

/**
 * The state a card dropped on `column` moves to, among the issue's `states` that lean that way: the
 * one named as the column (Backlog, To do, In progress, Done), else the first in the tracker's
 * order, since a tracker can have several. So a Backlog drop stays out of Linear's Triage, and a
 * Done drop off a Jira workflow's Won't Do. Undefined when the issue can't go there.
 */
export function dropState(states: readonly IssueState[], column: BoardColumn) {
  const fits = states.filter((s) => categoryOf(s.category) === column);
  const name = plain(boardColumns.find((c) => c.id === column)!.label);
  return fits.find((s) => plain(s.name) === name) ?? fits[0];
}

/**
 * The repository a thread about `issue` starts in. A GitHub issue's is the computer's repository
 * named as the issue's, never a Project, and `none` when it has no such repository, so an agent
 * never works on it in another codebase. Another tracker's issue names no repository and starts
 * in `fallback`.
 */
export function draftGroup(
  issue: Issue,
  groups: readonly { id: string; name: string; project?: boolean }[],
  fallback: string,
  none: string,
): string {
  if (issue.provider !== "github") return fallback;
  const repo = issue.container.name.split("/").pop();
  return groups.find((g) => !g.project && g.name === repo)?.id ?? none;
}

/**
 * The New thread Start thread opens: the issue's key and title, its URL, and its body, for the
 * agent to work on. Plain text, a line to a paragraph, which the composer sends as written.
 */
export function issueDraft(hostId: string, groupId: string, issue: Issue, body: string): Draft {
  const text = [`Work on ${issue.key}: ${issue.title}`, issue.url, "", body.trim()]
    .join("\n")
    .trimEnd();
  return {
    id: uuidv7(),
    hostId,
    groupId,
    text,
    doc: {
      type: "doc",
      content: text
        .split("\n")
        .map((line) =>
          line
            ? { type: "paragraph", content: [{ type: "text", text: line }] }
            : { type: "paragraph" },
        ),
    },
    images: [],
    files: [],
    threads: [],
  };
}
