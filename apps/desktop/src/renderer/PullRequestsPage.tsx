import { t } from "i18next";
import { ArrowDownUp, ListFilter } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { msg } from "../i18n";
import { useShownConnection } from "./ConnectionStatus";
import { icons } from "./icons";
import { PrRow } from "./pr/parts";
import { PullRequestView, usePullRequests, type Linked } from "./PullRequests";
import {
  facets,
  matches,
  numberOf,
  sortRows,
  type PrEntry,
  type PrSort,
} from "./pullRequestSearch";
import {
  Button,
  buttonClass,
  EmptyState,
  IconButton,
  menuItem,
  menuPanel,
  moveFocus,
  searchField,
} from "./ui";

const sorts: { id: PrSort; label: string }[] = [
  { id: "updated", label: msg("Recently updated") },
  { id: "newest", label: msg("Newest") },
  { id: "oldest", label: msg("Oldest") },
  { id: "number", label: msg("Number") },
  { id: "title", label: msg("Title") },
];

const key = (e: PrEntry) => `${e.hostId} ${e.url}`;

/** Whether a key press belongs to what has focus, or to a dialog or menu open over the page. */
const keyTaken = (e: KeyboardEvent) => {
  const target = e.target instanceof HTMLElement ? e.target : undefined;
  return (
    e.defaultPrevented ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    !!target?.closest("input, textarea, select, [contenteditable]") ||
    // A notification is a manual popover, and doesn't take the keys under it.
    !!document.querySelector('dialog[open], [popover]:not([popover="manual"]):popover-open')
  );
};

/**
 * The Pull requests page, in place of the main pane: every pull request linked to a thread, on any
 * host, one row each, read with `pr/view` when the page opens and again with Refresh. The header
 * stays put above the scrolling rows, with a search box over them (see `matches`), Sort, and
 * Filters. Each is a PrRow with its thread's title: it opens its PR view on the page, and its arrow,
 * on hover, opens GitHub. J and K move between rows. The list stays mounted under an open pull
 * request, so going back finds its search, filters, and scroll position as they were.
 */
export function PullRequestsPage({
  entries,
  onOpenThread,
  onCompose,
  onSetUpGithub,
}: {
  entries: readonly PrEntry[];
  onOpenThread: (entry: PrEntry) => void;
  /** Puts text in the entry's thread's composer, opening the thread, and sends it with `send`. */
  onCompose: (entry: PrEntry, text: string, send: boolean) => void;
  onSetUpGithub: (entry: PrEntry) => void;
}) {
  const [read, setRead] = useState<Readonly<Record<string, Linked>>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PrSort>("updated");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string>();
  const list = useRef<HTMLUListElement>(null);
  // An unlinked one closes, rather than showing a view with no run to read it through.
  const open = entries.find((e) => key(e) === openKey);

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

  const opened = !!open;
  useEffect(() => {
    if (opened) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "j" && e.key !== "k") || keyTaken(e)) return;
      const buttons = [...(list.current?.querySelectorAll<HTMLElement>("li > div > button") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? 0 : at + (e.key === "j" ? 1 : -1);
      buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened]);

  const back = () => {
    const entry = open;
    setOpenKey(undefined);
    if (!entry) return;
    // What the view changed, such as a merge, shows in its row.
    void load([entry]);
    // After the list shows again, the row it opened from has focus, for the next J or K.
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`li[data-pr="${CSS.escape(key(entry))}"] > div > button`)
        ?.focus(),
    );
  };

  return (
    <>
      {open && (
        <OpenPullRequest
          key={key(open)}
          entry={open}
          onBack={back}
          onOpenThread={() => onOpenThread(open)}
          onCompose={(text, send) => onCompose(open, text, send)}
          onSetUpGithub={() => onSetUpGithub(open)}
        />
      )}
      <div className={open ? "hidden" : "contents"}>
        <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-8 pt-6 pb-4">
          <h1 className="text-heading font-semibold">{t("Pull requests")}</h1>
          {entries.length > 0 && (
            <>
              <label className={`ml-auto w-72 ${searchField}`}>
                <icons.search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                <input
                  type="search"
                  aria-label={t("Search pull requests")}
                  placeholder={t("Search pull requests, or label:bug")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
                />
              </label>
              <Menu
                label={t("Sort")}
                icon={<ArrowDownUp aria-hidden />}
                items={sorts.map((s) => ({
                  id: s.id,
                  label: t(s.label),
                  checked: sort === s.id,
                  onPick: () => setSort(s.id),
                }))}
                closeOnPick
              />
              <Menu
                label={
                  chosen.size ? t("Filters ({{count}})", { count: chosen.size }) : t("Filters")
                }
                icon={<ListFilter aria-hidden />}
                items={facets.map((f) => ({
                  id: f.id,
                  group: t(f.group),
                  label: t(f.label),
                  checked: chosen.has(f.id),
                  onPick: () => toggle(f.id),
                }))}
              />
              <IconButton
                label={t("Refresh")}
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
            title={t("No pull requests yet")}
            body={t("A pull request a thread opens or links shows up here.")}
            className="flex-1 justify-center"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<icons.search aria-hidden />}
            title={t("Nothing matches")}
            body={t("Try another search, or clear the filters.")}
            className="flex-1 justify-center"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul ref={list} aria-label={t("Pull requests")} className="mx-auto max-w-5xl px-6 pb-16">
              {rows.map(({ entry, read: r }) => (
                <li key={key(entry)} data-pr={key(entry)}>
                  <PrRow
                    url={entry.url}
                    pr={r?.pr}
                    error={r?.error}
                    context={entry.threadTitle}
                    labels
                    onOpen={() => setOpenKey(key(entry))}
                    action={
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={t("Open #{{number}} on GitHub", {
                          number: numberOf(entry.url),
                        })}
                        title={t("Open on GitHub")}
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
      </div>
    </>
  );
}

/**
 * One pull request's PR view on the page: Back to the list, or Escape, and Open thread above it.
 * It reads through the thread the pull request is linked to.
 */
function OpenPullRequest({
  entry,
  onBack,
  onOpenThread,
  onCompose,
  onSetUpGithub,
}: {
  entry: PrEntry;
  onBack: () => void;
  onOpenThread: () => void;
  onCompose: (text: string, send: boolean) => void;
  onSetUpGithub: () => void;
}) {
  const connection = useShownConnection(entry.hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const prs = usePullRequests(
    entry.hostId,
    entry.runId,
    [entry.url],
    !!capabilities && "prDiff" in capabilities,
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !keyTaken(e)) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <>
      <nav
        aria-label={t("Pull request")}
        className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-2 px-4 pt-2"
      >
        <Button size="sm" variant="quiet" onClick={onBack}>
          <icons.back aria-hidden />
          {t("Pull requests")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          title={t("Open the thread {{title}}", { title: entry.threadTitle })}
          onClick={onOpenThread}
          className="min-w-0"
        >
          <span className="truncate">{entry.threadTitle}</span>
          <icons.external aria-hidden />
        </Button>
      </nav>
      <PullRequestView
        url={entry.url}
        prs={prs}
        onCompose={onCompose}
        onSetUpGithub={capabilities && "githubSetup" in capabilities ? onSetUpGithub : undefined}
      />
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
