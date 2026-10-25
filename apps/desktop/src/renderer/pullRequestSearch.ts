// The Pull requests page's search, filters, and sort, pure so the mobile app's pull request sheet
// matches and orders them the same way.
import type { PullRequest } from "../protocol/generated/protocol";
import { locale } from "./locale";

/** A pull request's number, from its URL. */
export const numberOf = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? "?";

/** A pull request linked to a thread, on a host. */
export interface PrEntry {
  hostId: string;
  runId: string;
  threadTitle: string;
  url: string;
}

export type PrSort = "updated" | "newest" | "oldest" | "number" | "title";

/** What a Filters choice matches: a state (draft is an open one), or what its checks say. */
export const facets = [
  { group: "State", id: "open", label: "Open" },
  { group: "State", id: "draft", label: "Draft" },
  { group: "State", id: "merged", label: "Merged" },
  { group: "State", id: "closed", label: "Closed" },
  { group: "Checks", id: "passed", label: "Passing" },
  { group: "Checks", id: "failed", label: "Failing" },
  { group: "Checks", id: "pending", label: "Pending" },
] as const;

const stateOf = (pr: PullRequest) => (pr.state === "open" && pr.draft ? "draft" : pr.state);

/** An entry with what was read of its pull request, if anything yet. */
export interface PrRow {
  entry: PrEntry;
  read?: { pr?: PullRequest };
}

/**
 * Whether `row` matches the search and filters. The search is words that each must appear in its
 * number, title, repo, author, branches, labels, or thread's title, plus `label:`, `state:`, and
 * `author:` terms. Filters match a state or checks result in each group they choose from.
 * A pull request not read yet matches only words in its thread's title, number, or URL.
 */
export function matches(row: PrRow, query: string, chosen: ReadonlySet<string>): boolean {
  const { entry, read } = row;
  const pr = read?.pr;
  for (const group of ["State", "Checks"]) {
    const ids = facets.filter((f) => f.group === group && chosen.has(f.id)).map((f) => f.id);
    if (ids.length === 0) continue;
    const has = !pr ? undefined : group === "State" ? stateOf(pr) : pr.checksState;
    if (!has || !(ids as string[]).includes(has === "skipped" ? "" : has)) return false;
  }
  const haystack = [
    `#${numberOf(entry.url)}`,
    entry.threadTitle,
    entry.url,
    pr?.title,
    pr?.repo,
    pr?.author,
    pr?.headBranch,
    pr?.baseBranch,
    ...(pr?.labels ?? []),
  ]
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      const [field, ...rest] = term.split(":");
      const value = rest.join(":");
      if (rest.length > 0 && value) {
        if (field === "label") return !!pr?.labels.some((l) => l.toLowerCase().includes(value));
        if (field === "state") return !!pr && stateOf(pr) === value;
        if (field === "author") return !!pr?.author.toLowerCase().includes(value);
      }
      return haystack.includes(term.replace(/^#/, ""));
    });
}

/** `rows` ordered by `sort`. Not yet read ones go last. */
export function sortRows<R extends PrRow>(rows: R[], sort: PrSort): R[] {
  const time = (r: PrRow, field: "updatedAt" | "createdAt") =>
    Date.parse(r.read?.pr?.[field] ?? r.read?.pr?.updatedAt ?? "") || 0;
  const num = (r: PrRow) => Number(numberOf(r.entry.url)) || 0;
  const by: Record<PrSort, (a: PrRow, b: PrRow) => number> = {
    updated: (a, b) => time(b, "updatedAt") - time(a, "updatedAt"),
    newest: (a, b) => time(b, "createdAt") - time(a, "createdAt"),
    oldest: (a, b) => time(a, "createdAt") - time(b, "createdAt"),
    number: (a, b) => num(b) - num(a),
    title: (a, b) => (a.read?.pr?.title ?? "￿").localeCompare(b.read?.pr?.title ?? "￿", locale()),
  };
  return [...rows].sort((a, b) => (!a.read?.pr ? 1 : !b.read?.pr ? -1 : by[sort](a, b)));
}
