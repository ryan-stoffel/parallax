// What the sidebar lists (0094): every host's threads and orchestrators as rows, the unsent New
// Thread drafts, and how rows group, as pure functions, so a sidebar mode is mostly its grouping.
import type { AgentRun, Orchestrator, Repo, Thread } from "../protocol/generated/protocol";
import { activeAt, attentionOf, orchestratorAttention, type Attention } from "./attention";
import type { Draft } from "./drafts";
import { numberOf } from "./github";
import type { Host } from "./hosts";
import { parseScope, type Scope } from "./scope";
import {
  asksOf,
  orchestratorRuns,
  threadOrchestrators,
  waitingOf,
  type ThreadsView,
} from "./threads";
import { isRunning } from "./transcript";

/** A host and its threads and orchestrators, as the sidebar merges them. */
export interface HostThreads {
  host: Host;
  view: ThreadsView;
}

/** One row of the list: a thread, or an orchestrator, with its host and what it asks of the user. */
export type Item = (
  | {
      kind: "thread";
      thread: Thread;
      run?: AgentRun;
      orchestration?: { orchestrator: Orchestrator; runs: AgentRun[] };
    }
  | { kind: "orchestrator"; orchestrator: Orchestrator; runs: AgentRun[] }
) & {
  key: string;
  host: Host;
  view: ThreadsView;
  repo?: Repo;
  attention: Attention;
  /** When it was last active (`activeAt`), for the order. */
  at: string;
  title: string;
  /** What search reads besides its messages: its title, repo, branch, and pull request numbers. */
  text: string;
};

/**
 * A thread's attention, Done or Failed again while it's marked unread (pins.ts) and finished, as
 * though never seen.
 */
export const markedUnread = (attention: Attention, run: AgentRun | undefined, marked: boolean) =>
  marked && attention === "settled" && run && !isRunning(run.status) && run.status !== "waiting"
    ? run.status === "failed"
      ? "failed"
      : "done"
    : attention;

/**
 * Every host's threads and orchestrators as rows, unsorted. An orchestrator's threads don't list
 * apart from it (0042); `unread` holds the keys of threads marked unread.
 */
export function sidebarItems(hosts: readonly HostThreads[], unread: readonly string[]): Item[] {
  return hosts.flatMap(({ host: h, view }) => {
    const { state } = view;
    const repoOf = (id: string) => state.repos.find((r) => r.id === id);
    const inOrchestrator = threadOrchestrators(state);
    const threads = state.threads
      .filter((t) => !inOrchestrator.get(t.id) && !state.orchestrators.some((p) => p.run === t.id))
      .map((t): Item => {
        const run = state.runs[t.id];
        const repo = repoOf(t.repo);
        const title = state.titles[t.id] ?? "Thread";
        return {
          kind: "thread",
          thread: t,
          run,
          key: `${h.id}/${t.id}`,
          host: h,
          view,
          repo,
          attention: markedUnread(
            attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)),
            run,
            unread.includes(`${h.id}/${t.id}`),
          ),
          at: activeAt(t, run, state.stoppedAt[t.id]),
          title,
          text: [
            title,
            repo && !repo.scratch ? repo.name : "No repo",
            run?.branch,
            ...(run?.pullRequests ?? []).map((url) => `#${numberOf(url)}`),
          ].join(" "),
        };
      });
    const orchestrators = state.orchestrators.map((p): Item => {
      const runs = orchestratorRuns(state, p.id, inOrchestrator);
      const thread = state.threads.find((t) => t.id === p.run);
      const run = p.run ? state.runs[p.run] : undefined;
      const key = `${h.id}/${p.id}`;
      const attention = orchestratorAttention(runs, (id) => asksOf(state, id));
      return {
        ...(thread
          ? { kind: "thread" as const, thread, run, orchestration: { orchestrator: p, runs } }
          : { kind: "orchestrator" as const, orchestrator: p, runs }),
        key,
        host: h,
        view,
        repo: state.repos.find((r) => r.path === p.repoPath),
        attention: markedUnread(attention, run, unread.includes(key)),
        // Its last change, or when one of its runs last stopped, so finished work raises it too.
        at: runs.reduce((at, r) => {
          const stopped = state.stoppedAt[r.id];
          return stopped && !isRunning(r.status) && Date.parse(stopped) > Date.parse(at)
            ? stopped
            : at;
        }, p.updatedAt),
        title: p.name,
        text: p.name,
      };
    });
    return [...threads, ...orchestrators];
  });
}

/**
 * Where a row lives, for its place and its folder: the Project a thread was added to (0090), else its
 * repo, or none for No repo.
 */
export function placeOf(item: Item): Repo | undefined {
  const project = item.kind === "thread" ? item.thread.project : undefined;
  const repo = (project && item.view.state.repos.find((r) => r.id === project)) || item.repo;
  return repo && !repo.scratch ? repo : undefined;
}

/** An unsent New Thread prompt's row (PLX-788): the draft, its repo, and its key in the list. */
export interface DraftItem {
  key: string;
  draft: Draft;
  repo?: Repo;
}

/**
 * The drafts the list shows, newest first: those on hosts still listed, in `scope`, and holding
 * every word of a search.
 */
export function draftItems(
  list: readonly Draft[],
  hosts: readonly HostThreads[],
  scope: Scope,
  words: readonly string[],
): DraftItem[] {
  const s = parseScope(scope);
  return list.flatMap((d) => {
    const view = hosts.find((h) => h.host.id === d.hostId)?.view;
    if (!view) return [];
    const repo = view.state.repos.find((r) => r.id === d.groupId);
    const inScope =
      s.kind === "all" ||
      (s.kind === "none" ? !repo || !!repo.scratch : s.hostId === d.hostId && s.id === repo?.id);
    const text = d.text.toLowerCase();
    return inScope && words.every((w) => text.includes(w))
      ? [{ key: `draft:${d.id}`, draft: d, repo }]
      : [];
  });
}

/**
 * A group of rows under a heading that folds it: a repo's, with `repo` unset for No repo, or a
 * day's. `host` names the computer when repos on several share a name.
 */
export interface Group {
  key: string;
  label: string;
  /** Whether it's a repo's group, which shows the repo's icon. */
  byRepo: boolean;
  repo?: Repo;
  host?: string;
  rows: Item[];
}

/** Which day `at` falls on, from `now`: Today, Yesterday, Earlier this week, or Older. */
export function dayOf(at: string, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - day.getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Earlier this week" : "Older";
}

/**
 * Today's rows grouped as View says (Inbox): under each repo, or each day, a group
 * where its newest row falls, so `rows` should come newest first. A repo's group shows its host
 * when there are `many`.
 */
export function todayGroups(
  rows: readonly Item[],
  by: "repo" | "day",
  now: number,
  many: boolean,
): Group[] {
  const groups = new Map<string, Group>();
  for (const i of rows) {
    const repo = i.repo && !i.repo.scratch ? i.repo : undefined;
    const key = by === "repo" ? `${i.host.id}/${repo?.id ?? "none"}` : dayOf(i.at, now);
    const group = groups.get(key) ?? {
      key,
      label: by === "repo" ? (repo?.name ?? "No repo") : key,
      byRepo: by === "repo",
      repo,
      host: by === "repo" && many ? i.host.name : undefined,
      rows: [],
    };
    group.rows.push(i);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Traditional's folders (0094), as Codex groups threads: one per `host/repo`, a thread added
 * to a Project under that Project, each holding its rows in `rows`' order. Folders sort by name, then
 * computer, so they don't move as threads do, with No repo last. The computer shows only when
 * there are `many`.
 */
export function folderGroups(rows: readonly Item[], many: boolean): Group[] {
  const folders = new Map<string, Group>();
  for (const i of rows) {
    const repo = placeOf(i);
    const key = `${i.host.id}/${repo?.id ?? "none"}`;
    const folder = folders.get(key) ?? {
      key,
      label: repo?.name ?? "No repo",
      byRepo: true,
      repo,
      host: many ? i.host.name : undefined,
      rows: [],
    };
    folder.rows.push(i);
    folders.set(key, folder);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return [...folders.values()].sort(
    (a, b) =>
      Number(!a.repo) - Number(!b.repo) ||
      byName(a.label, b.label) ||
      byName(a.host ?? "", b.host ?? "") ||
      a.key.localeCompare(b.key),
  );
}
