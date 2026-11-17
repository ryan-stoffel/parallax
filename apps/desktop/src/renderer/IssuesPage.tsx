import { t } from "i18next";
import { ArrowDownUp, ListFilter } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  IssueConnection,
  IssueConnectionError,
  IssueProvider,
} from "../protocol/generated/protocol";
import { useShownConnections } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { icons } from "./icons";
import { IssueBoard } from "./IssueBoard";
import { connectionName, StateChip } from "./IssueParts";
import {
  boardColumns,
  dropState,
  issueSorts,
  knownConnections,
  matchesIssue,
  mergeIssues,
  providerNames,
  providers,
  sortIssues,
  type BoardColumn,
  type ConnectionEntry,
  type IssueEntry,
  type IssueSort,
} from "./issues";
import { IssueView } from "./IssueView";
import { NewIssueDialog } from "./NewIssueDialog";
import { notify } from "./notifications";
import { keyTaken, Menu } from "./PullRequestsPage";
import { age } from "./Sidebar";
import { stored } from "./stored";
import { TrackerLogo } from "./TrackerLogo";
import { Button, EmptyState, IconButton, searchField, Segmented, Spinner } from "./ui";

/** What one computer answered: its tracker accounts, its issues, and what it couldn't read. */
interface HostRead {
  connections: IssueConnection[];
  issues: IssueEntry["issue"][];
  errors: IssueConnectionError[];
  /** Why the computer itself didn't answer. */
  failed?: string;
}

const keyOf = (e: IssueEntry) => e.issue.url;

/** `all` without its entry for `url`. */
function without(all: Readonly<Record<string, IssueEntry>>, url: string) {
  const { [url]: _, ...rest } = all;
  return rest;
}

type IssuesView = "list" | "board";

/** Whether the page shows its issues as rows or as a board, kept on this computer. */
const issuesView = stored<IssuesView>("parallax.issuesView", "list", (raw, fallback) =>
  raw === "list" || raw === "board" ? raw : fallback,
);

/**
 * The Issues page, in place of the main pane (0107): the open issues assigned to you on GitHub,
 * Linear, and Jira, read with `issue/list` from every connected computer that has the `issues`
 * capability, and merged so an issue two computers read shows once. The header stays put above the
 * scrolling rows, with a search, Sort, a tracker filter, Refresh, and New issue. A tracker that
 * couldn't be read says so above the rows, which still show the others'. A row opens its issue on
 * the page. J and K move between rows. Board shows the same issues as cards in a column per kind
 * of state (IssueBoard): dragging a card to another column moves its issue there on its tracker.
 */
export function IssuesPage({
  hosts,
  settingsClosed,
  onOpenTrackers,
  onStartThread,
}: {
  hosts: Host[];
  /** How many times Settings has closed: each time, every computer is read again, since its
   * tracker accounts may have changed there. */
  settingsClosed: number;
  /** Opens Settings › Issue trackers, on `hostId` when given. */
  onOpenTrackers: (hostId?: string) => void;
  /** Opens New thread on the entry's computer with a draft of the issue and its `body`. */
  onStartThread: (entry: IssueEntry, body: string) => void;
}) {
  const connections = useShownConnections(hosts.map((h) => h.id));
  const connected = hosts.filter((_, i) => connections[i]?.status === "connected");
  const supported = hosts.filter((_, i) => {
    const c = connections[i];
    return c?.status === "connected" && "issues" in c.capabilities;
  });
  const outdated = connected.filter((h) => !supported.includes(h));
  const [read, setRead] = useState<Readonly<Record<string, HostRead>>>({});
  // How many reads are under way, and each computer's latest, the only one whose answer applies.
  const [loading, setLoading] = useState(0);
  const latest = useRef<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<IssueSort>("updated");
  const [chosen, setChosen] = useState<ReadonlySet<IssueProvider>>(new Set());
  const [open, setOpen] = useState<IssueEntry>();
  const [creating, setCreating] = useState(false);
  const view = issuesView.use();
  // The board's cards as dragged, by URL, over what the computers last listed: a card shows in its
  // new column at once, and one moved to Done, which `issue/list` leaves out, stays until Refresh.
  const [moved, setMoved] = useState<Readonly<Record<string, IssueEntry>>>({});
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(async (hostIds: readonly string[]) => {
    setLoading((n) => n + 1);
    await Promise.all(
      hostIds.map(async (hostId) => {
        const mine = (latest.current[hostId] = (latest.current[hostId] ?? 0) + 1);
        const [accounts, issues] = await Promise.all([
          window.parallax.request(hostId, "issue/connections", {}),
          window.parallax.request(hostId, "issue/list", {}),
        ]);
        // A newer read of this computer answers for it.
        if (latest.current[hostId] !== mine) return;
        const failed =
          "error" in accounts ? accounts.error : "error" in issues ? issues.error : undefined;
        setRead((all) => ({
          ...all,
          [hostId]: {
            connections: "result" in accounts ? knownConnections(accounts.result.connections) : [],
            issues: "result" in issues ? issues.result.issues : [],
            errors: "result" in issues ? issues.result.errors : [],
            failed: failed && describeError(failed),
          },
        }));
      }),
    );
    setLoading((n) => n - 1);
  }, []);
  // Each computer is read as it connects, and again with Refresh, after a write, and each time
  // Settings closes.
  const supportedKey = supported.map((h) => h.id).join("\n");
  useEffect(() => {
    setMoved({});
    if (supportedKey) void load(supportedKey.split("\n"));
  }, [supportedKey, settingsClosed, load]);

  const reads = supported.flatMap((h) => (read[h.id] ? [{ host: h, read: read[h.id]! }] : []));
  const accounts: ConnectionEntry[] = reads.flatMap(({ host, read: r }) =>
    r.connections.map((connection) => ({ hostId: host.id, connection })),
  );
  const entries = mergeIssues(reads.map(({ host, read: r }) => ({ hostId: host.id, ...r })));
  const rows = sortIssues(
    entries.filter((e) => matchesIssue(e.issue, query, chosen)),
    sort,
  );
  const boardRows = sortIssues(
    [
      ...entries.map((e) => moved[keyOf(e)] ?? e),
      ...Object.values(moved).filter((m) => !entries.some((e) => keyOf(e) === keyOf(m))),
    ].filter((e) => matchesIssue(e.issue, query, chosen)),
    sort,
  );
  const unmove = (url: string) => setMoved((all) => without(all, url));
  // Moves a dragged card's issue to `column`: the card goes there at once, then the issue to the
  // column's first state on its tracker. When it can't, the card goes back and a toast says why.
  const move = async (entry: IssueEntry, column: BoardColumn) => {
    const { hostId, issue } = entry;
    const url = keyOf(entry);
    const before = moved[url];
    const label = t(boardColumns.find((c) => c.id === column)!.label);
    const put = (next: IssueEntry["issue"]) =>
      setMoved((all) => ({ ...all, [url]: { hostId, issue: next } }));
    const back = (why: string) => {
      setMoved((all) => (before ? { ...all, [url]: before } : without(all, url)));
      notify({
        tone: "error",
        title: t("Couldn't move {{issue}}", { issue: issue.key }),
        body: why,
      });
    };
    put({ ...issue, state: { ...issue.state, name: label, category: column } });
    const params = { connectionId: issue.connectionId, id: issue.id };
    const detail = await window.parallax.request(hostId, "issue/get", params);
    if ("error" in detail) return back(describeError(detail.error));
    const state = dropState(detail.result.states, column);
    if (!state)
      return back(
        t("{{tracker}} has no {{state}} state for this issue.", {
          tracker: providerNames[issue.provider],
          state: label,
        }),
      );
    let now = detail.result.issue;
    // Already there, as when the list was behind its tracker, is nothing to send.
    if (state.id !== now.state.id) {
      const answer = await window.parallax.request(hostId, "issue/setState", {
        ...params,
        stateId: state.id,
      });
      if ("error" in answer) return back(describeError(answer.error));
      now = answer.result;
    }
    put(now);
    // An open issue is listed again in its new state. A finished one isn't listed, so its card stays.
    if (column === "done") return;
    await load([hostId]);
    unmove(url);
  };
  const named = hosts.length > 1;
  // What couldn't be read: a computer, or one of its trackers, by name.
  const notes = [
    ...outdated.map((host) => ({
      key: host.id,
      hostId: undefined,
      text: t("{{computer}} needs an update to show its issues.", { computer: host.name }),
    })),
    ...reads.flatMap(({ host, read: r }) => [
      ...(r.failed
        ? [
            {
              key: host.id,
              hostId: host.id,
              text: t("{{source}}: {{message}}", { source: host.name, message: r.failed }),
            },
          ]
        : []),
      ...r.errors.map((e) => {
        const account = r.connections.find((c) => c.id === e.connectionId);
        const tracker = account ? connectionName(account) : e.connectionId;
        return {
          key: `${host.id} ${e.connectionId}`,
          hostId: host.id,
          text: t("{{source}}: {{message}}", {
            source: named ? `${tracker} · ${host.name}` : tracker,
            message: e.message,
          }),
        };
      }),
    ]),
  ];

  const toggle = (provider: IssueProvider) => {
    const next = new Set(chosen);
    if (!next.delete(provider)) next.add(provider);
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
    setOpen(undefined);
    if (!entry) return;
    // After the list shows again, the row it opened from has focus, for the next J or K.
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`li[data-issue="${CSS.escape(keyOf(entry))}"] > div > button`)
        ?.focus(),
    );
  };

  const waiting = supported.length > reads.length;
  return (
    <>
      {open && (
        <IssueView
          key={`${open.hostId} ${keyOf(open)}`}
          entry={open}
          onBack={back}
          onChanged={() => {
            unmove(keyOf(open));
            void load([open.hostId]);
          }}
          onStartThread={(body) => onStartThread(open, body)}
        />
      )}
      {creating && (
        <NewIssueDialog
          accounts={accounts}
          hosts={hosts}
          onCreated={(hostId) => void load([hostId])}
          onDone={() => setCreating(false)}
        />
      )}
      <div className={open ? "hidden" : "contents"}>
        <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-8 pt-6 pb-4">
          {/* As tall as the toolbar, so it sits at one height with and without it. */}
          <h1 className="flex h-8 items-center text-heading font-semibold">{t("Issues")}</h1>
          {accounts.length > 0 && (
            <>
              <label className={`ml-auto w-72 ${searchField}`}>
                <icons.search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                <input
                  type="search"
                  aria-label={t("Search issues")}
                  placeholder={t("Search issues")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
                />
              </label>
              <Menu
                label={t("Sort")}
                icon={<ArrowDownUp aria-hidden />}
                items={issueSorts.map((s) => ({
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
                items={providers.map((p) => ({
                  id: p,
                  group: t("Tracker"),
                  icon: <TrackerLogo provider={p} />,
                  label: providerNames[p],
                  checked: chosen.has(p),
                  onPick: () => toggle(p),
                }))}
              />
              <Segmented
                label={t("View")}
                value={view}
                onChange={(next) => issuesView.set(next)}
                options={[
                  { value: "list", title: t("List"), name: <icons.list aria-label={t("List")} /> },
                  {
                    value: "board",
                    title: t("Board"),
                    name: <icons.board aria-label={t("Board")} />,
                  },
                ]}
              />
            </>
          )}
          {supported.length > 0 && (
            <IconButton
              label={t("Refresh")}
              aria-busy={loading > 0}
              disabled={loading > 0}
              onClick={() => {
                setMoved({});
                void load(supported.map((h) => h.id));
              }}
              className={accounts.length > 0 ? "" : "ml-auto"}
            >
              <icons.refresh
                aria-hidden
                className={loading > 0 ? "motion-safe:animate-spin" : ""}
              />
            </IconButton>
          )}
          {accounts.length > 0 && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <icons.add aria-hidden />
              {t("New issue")}
            </Button>
          )}
        </header>
        {notes.length > 0 && supported.length > 0 && (
          <ul className="mx-auto w-full max-w-5xl px-6 pb-2">
            {notes.map((note) => (
              <li
                key={note.key}
                className="flex min-h-8 items-center gap-2.5 rounded-lg px-2 text-meta text-muted-foreground"
              >
                <icons.warning aria-hidden className="size-4 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 wrap-break-word">{note.text}</span>
                {note.hostId && (
                  <IconButton
                    size="sm"
                    label={t("Open Issue trackers")}
                    onClick={() => onOpenTrackers(note.hostId)}
                  >
                    <icons.settings aria-hidden />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {supported.length === 0 ? (
          connected.length > 0 ? (
            <EmptyState
              icon={<icons.issue aria-hidden />}
              title={t("This computer needs an update")}
              body={t("Update Parallax on this computer to see your issues here.")}
              className="flex-1 justify-center"
            />
          ) : (
            <EmptyState
              icon={<icons.issue aria-hidden />}
              title={t("Not connected")}
              body={t("Your issues show up once a computer connects.")}
              className="flex-1 justify-center"
            />
          )
        ) : accounts.length === 0 && waiting ? (
          <div role="status" className="flex flex-1 items-center justify-center gap-2 text-meta">
            <Spinner />
            <span className="text-muted-foreground">{t("Loading…")}</span>
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={<icons.issue aria-hidden />}
            title={t("No tracker connected")}
            body={t("Connect GitHub, Linear, or Jira to see the issues assigned to you.")}
            action={
              <Button variant="outline" onClick={() => onOpenTrackers(supported[0]?.id)}>
                {t("Connect a tracker")}
              </Button>
            }
            className="flex-1 justify-center"
          />
        ) : view === "board" ? (
          <IssueBoard entries={boardRows} onOpen={setOpen} onMove={(e, c) => void move(e, c)} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<icons.issue aria-hidden />}
            title={t("No open issues")}
            body={t("An open issue assigned to you shows up here.")}
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
            <ul ref={list} aria-label={t("Issues")} className="mx-auto max-w-5xl px-6 pb-16">
              {rows.map((entry) => (
                <li key={keyOf(entry)} data-issue={keyOf(entry)}>
                  <IssueRow entry={entry} onOpen={() => setOpen(entry)} />
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
 * One issue in the list, shaped as a pull request's row: its tracker's logo, its title on up to
 * two lines, and its state; then its key, where it is filed, and how long since it changed. Its
 * arrow, on hover, opens it on its tracker.
 */
function IssueRow({ entry, onOpen }: { entry: IssueEntry; onOpen: () => void }) {
  const { issue } = entry;
  const tracker = providerNames[issue.provider];
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        title={`${issue.key} ${issue.title}`}
        className="flex w-full gap-2.5 rounded-lg px-2 py-2 pr-9 text-left transition-colors hover:bg-hover"
      >
        <TrackerLogo
          provider={issue.provider}
          aria-hidden={false}
          role="img"
          aria-label={tracker}
          className="mt-0.5 size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-body leading-snug wrap-break-word">
              {issue.title}
            </span>
            <StateChip state={issue.state} />
          </span>
          <span className="mt-1 flex items-baseline gap-1.5 text-meta text-faint-foreground">
            <span className="shrink-0">{issue.key}</span>
            <span className="min-w-0 flex-1 truncate">· {issue.container.name}</span>
            <span className="shrink-0">{age(issue.updatedAt)}</span>
          </span>
        </span>
      </button>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        aria-label={t("Open {{issue}} in {{tracker}}", { issue: issue.key, tracker })}
        title={t("Open in {{app}}", { app: tracker })}
        className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-faint-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-selected hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5"
      >
        <icons.external aria-hidden />
      </a>
    </div>
  );
}
