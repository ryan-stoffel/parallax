// The Issues page's merge, search, filter, and sort, and the New thread draft an issue starts,
// pure so they test without a page (0107).
import { msg } from "../i18n";
import type {
  Issue,
  IssueConnection,
  IssueProvider,
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

/**
 * The state in `states` an issue is in now, which the picker shows as chosen and never sends to
 * `issue/setState`: by id, or by name where a tracker lists it under a move's id.
 */
export const currentState = <S extends { id: string; name: string }>(
  issue: Issue,
  states: readonly S[],
): S | undefined =>
  states.find((s) => s.id === issue.state.id) ?? states.find((s) => s.name === issue.state.name);

/**
 * The repository a thread about `issue` starts in: on GitHub, the computer's repository named as
 * the issue's, and `fallback` otherwise.
 */
export function draftGroup(
  issue: Issue,
  groups: readonly { id: string; name: string }[],
  fallback: string,
): string {
  const repo = issue.provider === "github" ? issue.container.name.split("/").pop() : undefined;
  return groups.find((g) => g.name === repo)?.id ?? fallback;
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
