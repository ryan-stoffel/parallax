import {
  ArrowDownUp,
  ArrowUpRight,
  Check,
  GitPullRequest,
  ListFilter,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { PullRequest } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { locale } from "./locale";
import { lookOf, numberOf, type Linked } from "./PullRequests";
import { age } from "./Sidebar";
import { menuItem, menuPanel, moveFocus } from "./ui";

/** A pull request linked to a thread, on a host. */
export interface PrEntry {
  hostId: string;
  runId: string;
  threadTitle: string;
  url: string;
}

export type PrSort = "updated" | "newest" | "oldest" | "number" | "title";

const sorts: { id: PrSort; label: string }[] = [
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "number", label: "Number" },
  { id: "title", label: "Title" },
];

/** What a Filters choice matches: a state (draft is an open one), or what its checks say. */
const facets = [
  { group: "State", id: "open", label: "Open" },
  { group: "State", id: "draft", label: "Draft" },
  { group: "State", id: "merged", label: "Merged" },
  { group: "State", id: "closed", label: "Closed" },
  { group: "Checks", id: "passed", label: "Passing" },
  { group: "Checks", id: "failed", label: "Failing" },
  { group: "Checks", id: "pending", label: "Pending" },
] as const;

const stateOf = (pr: PullRequest) => (pr.state === "open" && pr.draft ? "draft" : pr.state);

/** A read pull request with the entry that links it. */
export interface PrRow {
  entry: PrEntry;
  read?: Linked;
}

const key = (e: PrEntry) => `${e.hostId} ${e.url}`;

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
export function sortRows(rows: PrRow[], sort: PrSort): PrRow[] {
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

const toolButton =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground aria-expanded:text-foreground [&_svg]:size-4";

/**
 * The Pull requests page, in place of the main pane: every pull request linked to a thread, on any
 * host, one row each, read with `pr/view` when the page opens and again with Refresh. A search box
 * over them (see `matches`), Sort, and Filters narrow the list. A row opens its thread, and its
 * arrow opens GitHub.
 */
export function PullRequestsPage({
  entries,
  onOpenThread,
}: {
  entries: readonly PrEntry[];
  onOpenThread: (entry: PrEntry) => void;
}) {
  const [read, setRead] = useState<Readonly<Record<string, Linked>>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PrSort>("updated");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (list: readonly PrEntry[]) => {
    setLoading(true);
    await Promise.all(
      list.map(async (e) => {
        const answer = await window.parallax.request(e.hostId, "pr/view", {
          runId: e.runId,
          url: e.url,
        });
        const at = new Date().toISOString();
        setRead((all) => ({
          ...all,
          [key(e)]:
            "error" in answer ? { ...all[key(e)], error: answer.error } : { pr: answer.result, at },
        }));
      }),
    );
    setLoading(false);
  }, []);
  // Reads the ones not read yet, so a thread linking one while the page is open shows it.
  const unread = entries.filter((e) => !read[key(e)]);
  const unreadKeys = unread.map(key).join("\n");
  useEffect(() => {
    if (unreadKeys) void load(unread);
    // `unread` follows `unreadKeys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKeys, load]);

  const rows = sortRows(
    entries
      .map((entry) => ({ entry, read: read[key(entry)] }))
      .filter((r) => matches(r, query, chosen)),
    sort,
  );
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setChosen(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pt-4">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label="Search pull requests"
            placeholder="Search pull requests, or label:bug"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <Menu
          label="Sort"
          icon={<ArrowDownUp aria-hidden />}
          items={sorts.map((s) => ({
            id: s.id,
            label: s.label,
            checked: sort === s.id,
            onPick: () => setSort(s.id),
          }))}
          closeOnPick
        />
        <Menu
          label={chosen.size ? `Filters (${chosen.size})` : "Filters"}
          icon={<ListFilter aria-hidden />}
          items={facets.map((f) => ({
            id: f.id,
            group: f.group,
            label: f.label,
            checked: chosen.has(f.id),
            onPick: () => toggle(f.id),
          }))}
        />
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          disabled={loading}
          onClick={() => void load(entries)}
          className={`${toolButton} w-9 justify-center px-0 disabled:opacity-60`}
        >
          <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {entries.length === 0 ? (
        <Empty
          title="No pull requests yet"
          note="A pull request a thread opens or links shows up here."
        />
      ) : rows.length === 0 ? (
        <Empty title="Nothing matches" note="Try another search, or clear the filters." />
      ) : (
        <ul
          aria-label="Pull requests"
          className="mx-auto mt-3 w-full max-w-3xl min-h-0 flex-1 overflow-y-auto px-4 pb-4"
        >
          {rows.map(({ entry, read: r }) => (
            <Row key={key(entry)} entry={entry} read={r} onOpen={() => onOpenThread(entry)} />
          ))}
        </ul>
      )}
      <p className="border-t border-border px-4 py-2 text-center text-[12.5px] text-faint-foreground">
        {rows.length === entries.length
          ? `${entries.length} linked`
          : `${rows.length} of ${entries.length} linked`}
      </p>
    </div>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="flex flex-col items-center gap-1 text-center">
        <GitPullRequest aria-hidden className="mb-2 size-6 text-faint-foreground" />
        <h2 className="text-[15px] font-medium">{title}</h2>
        <p className="text-[13px] text-faint-foreground">{note}</p>
      </div>
    </div>
  );
}

function Row({ entry, read, onOpen }: { entry: PrEntry; read?: Linked; onOpen: () => void }) {
  const pr = read?.pr;
  const { Icon, color } = lookOf(pr);
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full gap-2.5 rounded-lg px-2 py-2 pr-9 text-left hover:bg-hover"
      >
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[13.5px]">
            <span className="shrink-0 text-faint-foreground">#{numberOf(entry.url)}</span>
            <span className="min-w-0 flex-1 truncate">{pr?.title ?? entry.threadTitle}</span>
            {pr?.labels.map((l) => (
              <span
                key={l}
                className="shrink-0 rounded-full bg-hover px-1.5 text-[11.5px] text-muted-foreground"
              >
                {l}
              </span>
            ))}
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 text-[12px] text-faint-foreground">
            {pr ? (
              <>
                <span className="shrink-0">{pr.repo}</span>
                <span className="min-w-0 flex-1 truncate">{entry.threadTitle}</span>
                <span className="shrink-0">{age(pr.updatedAt)}</span>
              </>
            ) : (
              <span className={read?.error ? "text-danger" : ""}>
                {read?.error ? describeError(read.error) : "Loading…"}
              </span>
            )}
          </span>
        </span>
      </button>
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open #${numberOf(entry.url)} on GitHub`}
        title="Open on GitHub"
        className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-faint-foreground hover:bg-selected hover:text-foreground [&_svg]:size-3.5"
      >
        <ArrowUpRight aria-hidden />
      </a>
    </li>
  );
}

/** A toolbar button opening a popover menu of checkable items, in groups when they have one. */
function Menu({
  label,
  icon,
  items,
  closeOnPick,
}: {
  label: string;
  icon: React.ReactNode;
  items: { id: string; group?: string; label: string; checked: boolean; onPick: () => void }[];
  closeOnPick?: boolean;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  return (
    <>
      <button type="button" popoverTarget={id} className={toolButton}>
        {icon}
        {label}
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} w-48 p-1`}
      >
        {items.map((item, i) => (
          <div key={item.id}>
            {item.group && item.group !== items[i - 1]?.group && (
              <p className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-faint-foreground">
                {item.group}
              </p>
            )}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              onClick={() => {
                item.onPick();
                if (closeOnPick) menu.current?.hidePopover();
              }}
              className={menuItem}
            >
              {item.label}
              <Check aria-hidden className={`ml-auto ${item.checked ? "" : "invisible"}`} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
