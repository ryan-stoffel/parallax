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
import { connectionName, StateChip } from "./IssueParts";
import {
  issueSorts,
  knownConnections,
  matchesIssue,
  mergeIssues,
  providerNames,
  providers,
  sortIssues,
  type ConnectionEntry,
  type IssueEntry,
  type IssueSort,
} from "./issues";
import { IssueView } from "./IssueView";
import { NewIssueDialog } from "./NewIssueDialog";
import { keyTaken, Menu } from "./PullRequestsPage";
import { age } from "./Sidebar";
import { TrackerLogo } from "./TrackerLogo";
import { Button, EmptyState, IconButton, searchField, Spinner } from "./ui";

/** What one computer answered: its tracker accounts, its issues, and what it couldn't read. */
interface HostRead {
  connections: IssueConnection[];
  issues: IssueEntry["issue"][];
  errors: IssueConnectionError[];
  /** Why the computer itself didn't answer. */
  failed?: string;
}

const keyOf = (e: IssueEntry) => e.issue.url;

/**
 * The Issues page, in place of the main pane (0107): the open issues assigned to you on GitHub,
 * Linear, and Jira, read with `issue/list` from every connected computer that has the `issues`
 * capability, and merged so an issue two computers read shows once. The header stays put above the
 * scrolling rows, with a search, Sort, a tracker filter, Refresh, and New issue. A tracker that
 * couldn't be read says so above the rows, which still show the others'. A row opens its issue on
 * the page. J and K move between rows.
 */
export function IssuesPage({
  hosts,
  onOpenTrackers,
  onStartThread,
}: {
  hosts: Host[];
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
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<IssueSort>("updated");
  const [chosen, setChosen] = useState<ReadonlySet<IssueProvider>>(new Set());
  const [open, setOpen] = useState<IssueEntry>();
  const [creating, setCreating] = useState(false);
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(async (hostIds: readonly string[]) => {
    setLoading(true);
    await Promise.all(
      hostIds.map(async (hostId) => {
        const [accounts, issues] = await Promise.all([
          window.parallax.request(hostId, "issue/connections", {}),
          window.parallax.request(hostId, "issue/list", {}),
        ]);
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
    setLoading(false);
  }, []);
  // Each computer is read as it connects, and again with Refresh and after a write.
  const supportedKey = supported.map((h) => h.id).join("\n");
  useEffect(() => {
    if (supportedKey) void load(supportedKey.split("\n"));
  }, [supportedKey, load]);

  const reads = supported.flatMap((h) => (read[h.id] ? [{ host: h, read: read[h.id]! }] : []));
  const accounts: ConnectionEntry[] = reads.flatMap(({ host, read: r }) =>
    r.connections.map((connection) => ({ hostId: host.id, connection })),
  );
  const entries = mergeIssues(reads.map(({ host, read: r }) => ({ hostId: host.id, ...r })));
  const rows = sortIssues(
    entries.filter((e) => matchesIssue(e.issue, query, chosen)),
    sort,
  );
  const named = hosts.length > 1;
  // What couldn't be read: a computer, or one of its trackers, by name.
  const notes = [
    ...outdated.map((host) => ({
      key: host.id,
      hostId: undefined,
      text: t("{{computer}} needs an update to show its issues.", { computer: host.name }),
    })),
    ...reads.flatMap(({ host, read: r }) => [
      ...(r.failed ? [{ key: host.id, hostId: host.id, text: `${host.name}: ${r.failed}` }] : []),
      ...r.errors.map((e) => {
        const account = r.connections.find((c) => c.id === e.connectionId);
        const tracker = account ? connectionName(account) : e.connectionId;
        return {
          key: `${host.id} ${e.connectionId}`,
          hostId: host.id,
          text: `${named ? `${tracker} · ${host.name}` : tracker}: ${e.message}`,
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
          onChanged={() => void load([open.hostId])}
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
          <h1 className="text-heading font-semibold">{t("Issues")}</h1>
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
              <IconButton
                label={t("Refresh")}
                aria-busy={loading}
                disabled={loading}
                onClick={() => void load(supported.map((h) => h.id))}
              >
                <icons.refresh aria-hidden className={loading ? "motion-safe:animate-spin" : ""} />
              </IconButton>
              <Button variant="primary" onClick={() => setCreating(true)}>
                <icons.add aria-hidden />
                {t("New issue")}
              </Button>
            </>
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
