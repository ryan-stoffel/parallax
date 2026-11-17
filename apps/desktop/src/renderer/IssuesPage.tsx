import { t } from "i18next";
import { ArrowDownUp } from "lucide-react";
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
import {
  boardEntries,
  canMove,
  failMove,
  forgetMove,
  listEntries,
  refreshMoves,
  settleMove,
  startMove,
  type Moves,
} from "./issueMoves";
import { connectionName, StateChip } from "./IssueParts";
import { issueFilters, issuesView } from "./issuePrefs";
import {
  boardColumns,
  dropState,
  issueSorts,
  knownConnections,
  activeFilters,
  matchesFilters,
  projectChoices,
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
import { useShortcutLabel } from "./keybindings";
import { notify } from "./notifications";
import { keyTaken, Menu } from "./PullRequestsPage";
import { TrackerSetupDialog } from "./settings/TrackerSetupDialog";
import { age } from "./Sidebar";
import { TrackerLogo } from "./TrackerLogo";
import { Button, EmptyState, IconButton, Picker, searchField, Segmented, Spinner } from "./ui";

/** What one computer answered: its tracker accounts, its issues, and what it couldn't read. */
interface HostRead {
  connections: IssueConnection[];
  issues: IssueEntry["issue"][];
  errors: IssueConnectionError[];
  /** Why the computer itself didn't answer. */
  failed?: string;
}

const keyOf = (e: IssueEntry) => e.issue.url;

/** A filter row's toggle chip: quiet until it's on. */
const filterChip =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-meta text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:border-transparent aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-3.5";

/**
 * The Issues page, in place of the main pane (0107): the open issues assigned to you on GitHub,
 * Linear, and Jira, read with `issue/list` from every connected computer that has the `issues`
 * capability, and merged so an issue two computers read shows once. The header stays put above the
 * scrolling rows, with the List and Board switch, a search, Sort, Refresh, and New issue, and under
 * it the filters both views share: a chip for each connected tracker, a Project dropdown of where
 * the loaded issues are filed, and Clear while one is on, all kept on this computer. A tracker that
 * couldn't be read says so above the rows, which still show the others'. A row opens its issue on
 * the page. J and K move between rows. Board shows the same issues as cards in a column per kind
 * of state (IssueBoard): dragging a card to another column moves its issue there on its tracker.
 * With no tracker connected, the page offers each one's set-up, which opens over it.
 */
export function IssuesPage({
  hosts,
  settingsClosed,
  onOpenTrackers,
  onOpenSourceControl,
  onStartThread,
}: {
  hosts: Host[];
  /** How many times Settings has closed: each time, every computer is read again, since its
   * tracker accounts may have changed there. */
  settingsClosed: number;
  /** Opens Settings › Issue trackers, on `hostId` when given. */
  onOpenTrackers: (hostId?: string) => void;
  /** Opens Settings › Source control on a computer, where GitHub signs in. */
  onOpenSourceControl: (hostId: string) => void;
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
  const [open, setOpen] = useState<IssueEntry>();
  const [creating, setCreating] = useState(false);
  // The tracker whose set-up is open over the page, from its empty state.
  const [settingUp, setSettingUp] = useState<IssueProvider>();
  const view = issuesView.use();
  // The Issues: Switch List and Board command's keys, for the switch's tooltips.
  const viewKeys = useShortcutLabel("issuesView");
  // The board's cards as dragged (issueMoves.ts), over what the computers last listed: a card
  // shows in its new column at once, and one moved to Done, which `issue/list` leaves out, stays
  // until Refresh. The ref holds the same moves, for a drop to check before the next render.
  const [moves, setMoves] = useState<Moves>({});
  const movesNow = useRef<Moves>({});
  const changeMoves = useCallback((change: (moves: Moves) => Moves) => {
    movesNow.current = change(movesNow.current);
    setMoves(movesNow.current);
  }, []);
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
    changeMoves(refreshMoves);
    if (supportedKey) void load(supportedKey.split("\n"));
  }, [supportedKey, settingsClosed, load, changeMoves]);

  const reads = supported.flatMap((h) => (read[h.id] ? [{ host: h, read: read[h.id]! }] : []));
  const accounts: ConnectionEntry[] = reads.flatMap(({ host, read: r }) =>
    r.connections.map((connection) => ({ hostId: host.id, connection })),
  );
  const entries = mergeIssues(reads.map(({ host, read: r }) => ({ hostId: host.id, ...r })));
  // The filters, as List and Board both show them: the trackers with an account as chips, and the
  // places the loaded issues are filed in, narrowed to the chosen trackers.
  const withAccount = providers.filter((p) => accounts.some((a) => a.connection.provider === p));
  const saved = issueFilters.use();
  const trackers = saved.trackers.filter((p) => withAccount.includes(p));
  const projects = projectChoices(boardEntries(entries, moves), accounts, trackers);
  const filters = activeFilters(saved, withAccount, projects);
  const filtered = filters.trackers.length > 0 || !!filters.project;
  const matching = (e: IssueEntry) => matchesFilters(e, query, filters, accounts);
  const rows = sortIssues(listEntries(entries, moves).filter(matching), sort);
  const boardRows = sortIssues(boardEntries(entries, moves).filter(matching), sort);
  // Moves a dragged card's issue to `column`, one move per card at a time: the card goes there at
  // once, then the issue to the column's state on its tracker, and its computer is read again.
  // When it can't, the card goes back and a toast says why.
  const move = async (entry: IssueEntry, column: BoardColumn) => {
    const { hostId, issue } = entry;
    const url = keyOf(entry);
    if (!canMove(movesNow.current, url)) return;
    const label = t(boardColumns.find((c) => c.id === column)!.label);
    const back = (why: string) => {
      changeMoves((all) => failMove(all, url));
      notify({
        tone: "error",
        title: t("Couldn't move {{issue}}", { issue: issue.key }),
        body: why,
      });
    };
    changeMoves((all) => startMove(all, entry, column, label));
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
    // The card keeps what its tracker answered until Refresh, whatever the read below lists.
    changeMoves((all) => settleMove(all, url, now));
    void load([hostId]);
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

  const toggle = (provider: IssueProvider) =>
    issueFilters.set({
      ...filters,
      trackers: filters.trackers.includes(provider)
        ? filters.trackers.filter((p) => p !== provider)
        : [...filters.trackers, provider],
    });

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
            changeMoves((all) => forgetMove(all, keyOf(open)));
            void load([open.hostId]);
          }}
          onStartThread={(body) => onStartThread(open, body)}
        />
      )}
      {creating && (
        <NewIssueDialog
          accounts={accounts}
          hosts={hosts}
          setUpOn={supported[0]?.id}
          onCreated={(hostId) => void load([hostId])}
          onConnected={(hostId) => void load([hostId])}
          onSourceControl={onOpenSourceControl}
          onDone={() => setCreating(false)}
        />
      )}
      {settingUp && supported[0] && (
        <TrackerSetupDialog
          provider={settingUp}
          hostId={supported[0].id}
          onSourceControl={() => onOpenSourceControl(supported[0]!.id)}
          onConnected={() => void load([supported[0]!.id])}
          onDone={() => setSettingUp(undefined)}
        />
      )}
      <div className={open ? "hidden" : "contents"}>
        <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-8 pt-6 pb-4">
          {/* As tall as the toolbar, so it sits at one height with and without it. */}
          <h1 className="flex h-8 items-center text-heading font-semibold">{t("Issues")}</h1>
          {accounts.length > 0 && (
            <>
              <Segmented
                label={t("View")}
                value={view}
                onChange={(next) => issuesView.set(next)}
                options={[
                  {
                    value: "list",
                    title: viewKeys ? `${t("List")} (${viewKeys})` : t("List"),
                    name: (
                      <>
                        <icons.list aria-hidden />
                        {t("List")}
                      </>
                    ),
                  },
                  {
                    value: "board",
                    title: viewKeys ? `${t("Board")} (${viewKeys})` : t("Board"),
                    name: (
                      <>
                        <icons.board aria-hidden />
                        {t("Board")}
                      </>
                    ),
                  },
                ]}
              />
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
            </>
          )}
          {supported.length > 0 && (
            <IconButton
              label={t("Refresh")}
              aria-busy={loading > 0}
              disabled={loading > 0}
              onClick={() => {
                changeMoves(refreshMoves);
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
        {accounts.length > 0 && (
          <div
            role="group"
            aria-label={t("Filters")}
            className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-8 pb-3"
          >
            {withAccount.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={filters.trackers.includes(p)}
                onClick={() => toggle(p)}
                className={filterChip}
              >
                <TrackerLogo provider={p} />
                {providerNames[p]}
              </button>
            ))}
            <Picker
              label={t("Project")}
              value={filters.project}
              onChange={(project) => issueFilters.set({ ...filters, project })}
              options={[
                { value: "", label: t("All projects") },
                ...projects.map((c) => ({ value: c.value, label: c.label, group: c.group })),
              ]}
              search={projects.length > 8 ? t("Search") : undefined}
              // Shaped as the chips beside it, and on, as they are, while a project is picked.
              className={`h-7 max-w-64 rounded-full! border py-0! pr-2! pl-2.5! text-meta! ${filters.project ? "border-transparent bg-selected text-foreground!" : "border-border"}`}
            />
            {filtered && (
              <Button
                size="sm"
                onClick={() => issueFilters.set({ trackers: [], project: "" })}
                aria-label={t("Clear filters")}
              >
                {t("Clear", { context: "filters" })}
              </Button>
            )}
          </div>
        )}
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
              <div className="flex gap-2">
                {providers.map((p) => (
                  <Button
                    key={p}
                    variant="outline"
                    aria-label={t("Set up {{name}}", { name: providerNames[p] })}
                    onClick={() => setSettingUp(p)}
                  >
                    <TrackerLogo provider={p} />
                    {providerNames[p]}
                  </Button>
                ))}
              </div>
            }
            className="flex-1 justify-center"
          />
        ) : view === "board" ? (
          <IssueBoard
            entries={boardRows}
            moving={new Set(Object.keys(moves).filter((url) => moves[url]!.pending))}
            onOpen={setOpen}
            onMove={(e, c) => void move(e, c)}
          />
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
