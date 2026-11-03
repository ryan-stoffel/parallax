import { ArrowDownUp, ListFilter } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { icons } from "./icons";
import { PrRow } from "./pr/parts";
import type { Linked } from "./PullRequests";
import {
  facets,
  matches,
  numberOf,
  sortRows,
  type PrEntry,
  type PrSort,
} from "./pullRequestSearch";
import {
  buttonClass,
  EmptyState,
  IconButton,
  menuItem,
  menuPanel,
  moveFocus,
  searchField,
} from "./ui";

const sorts: { id: PrSort; label: string }[] = [
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "number", label: "Number" },
  { id: "title", label: "Title" },
];

const key = (e: PrEntry) => `${e.hostId} ${e.url}`;

/**
 * The Pull requests page, in place of the main pane: every pull request linked to a thread, on any
 * host, one row each, read with `pr/view` when the page opens and again with Refresh. The header
 * stays put above the scrolling rows, with how many show, a search box over them (see `matches`),
 * Sort, and Filters. Each is a PrRow with its thread's title: it opens its thread, and its arrow, on
 * hover, opens GitHub.
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
    <>
      <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-8 pt-6 pb-4">
        <h1 className="text-heading font-semibold">Pull requests</h1>
        {entries.length > 0 && (
          <>
            <span className="text-body text-faint-foreground tabular-nums">
              {rows.length === entries.length
                ? entries.length
                : `${rows.length} of ${entries.length}`}
              <span className="sr-only"> linked</span>
            </span>
            <label className={`ml-auto w-72 ${searchField}`}>
              <icons.search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
              <input
                type="search"
                aria-label="Search pull requests"
                placeholder="Search pull requests, or label:bug"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
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
            <IconButton
              label="Refresh"
              aria-busy={loading}
              disabled={loading}
              onClick={() => void load(entries)}
            >
              <icons.refresh aria-hidden className={loading ? "motion-safe:animate-spin" : ""} />
            </IconButton>
          </>
        )}
      </header>
      {entries.length === 0 ? (
        <EmptyState
          icon={<icons.pullRequest aria-hidden />}
          title="No pull requests yet"
          body="A pull request a thread opens or links shows up here."
          className="flex-1 justify-center"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<icons.search aria-hidden />}
          title="Nothing matches"
          body="Try another search, or clear the filters."
          className="flex-1 justify-center"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul aria-label="Pull requests" className="mx-auto max-w-5xl px-6 pb-16">
            {rows.map(({ entry, read: r }) => (
              <li key={key(entry)}>
                <PrRow
                  url={entry.url}
                  pr={r?.pr}
                  error={r?.error}
                  context={entry.threadTitle}
                  labels
                  onOpen={() => onOpenThread(entry)}
                  action={
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open #${numberOf(entry.url)} on GitHub`}
                      title="Open on GitHub"
                      className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-faint-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-selected hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5"
                    >
                      <icons.external aria-hidden />
                    </a>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
      <button type="button" popoverTarget={id} className={buttonClass("outline")}>
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
              <p className="px-2 pt-1.5 pb-1 text-meta font-medium text-faint-foreground">
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
              <icons.done aria-hidden className={`ml-auto ${item.checked ? "" : "invisible"}`} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
