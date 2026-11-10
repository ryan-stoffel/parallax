import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  AgentBackgroundTask,
  AgentStatus,
  AccountChoice,
  Capabilities,
  AgentRun,
  LoggedEvent,
  Orchestrator,
  ChosenIcon,
  OrchestratorAutonomy,
  OrchestratorPermission,
  InboxItem,
  OrchestratorStartParams,
  OrchestratorUpdateParams,
  PromptImage,
  RemoteThreadRef,
  Repo,
  RepoUpdateParams,
  RunWaiting,
  Thread,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import type { RunOptions } from "./models";
import { slugify } from "./naming";
import { newThreadPrefs } from "./prefs";
import { isRunning, trackApprovals, updateRun, type ApprovalsByRun } from "./transcript";
import { useWatchKey } from "./useWatchKey";
import { uuidv7 } from "./uuidv7";

/** What a message names beyond its host (0101), beside its attached threads. */
export interface Mentions {
  computers?: string[];
  remoteThreads?: RemoteThreadRef[];
}

/** A host's orchestrators, repo entries, and normal threads (0017), and each thread's title and run. */
export interface ThreadsState {
  orchestrators: Orchestrator[];
  repos: Repo[];
  threads: Thread[];
  /**
   * By run id: a thread's own title from plxd (0041), or else its run's (`titleOf`). Runs with no
   * thread, such as an orchestrator's, have their run's.
   */
  titles: Readonly<Record<string, string>>;
  /** By run id: each run, kept current by its repo's or orchestrator's own events. */
  runs: Readonly<Record<string, AgentRun>>;
  /** By run id: the permission requests each run waits on (0033's "needs you"). */
  approvals: ApprovalsByRun;
  /**
   * By run id: how many times its checkpoints changed since this app connected, a capture or a
   * revert (0062), so its Changes view knows to reload.
   */
  checkpoints: Readonly<Record<string, number>>;
  /**
   * By run id: whether its agent waits on background work, a subagent, a Monitor, or a command,
   * or on pull requests plxd watches (PLX-777). A run waiting on neither has no entry.
   */
  waiting: Readonly<Record<string, Waiting>>;
  /**
   * By run id: when each stopped run last stopped (PLX-1043), for the sidebar's order. Unlike
   * `updatedAt`, a change after it stops, such as a linked pull request, doesn't move it.
   */
  stoppedAt: Readonly<Record<string, string>>;
}

/**
 * `stoppedAt` with `runs` applied: a run that stopped since `before`, or is new and stopped, stops
 * at `time`, or its `updatedAt` for none.
 */
function stops(
  stoppedAt: Readonly<Record<string, string>>,
  before: Readonly<Record<string, AgentRun>>,
  runs: readonly AgentRun[],
  time?: string,
): Readonly<Record<string, string>> {
  let next = stoppedAt;
  for (const run of runs) {
    if (isRunning(run.status)) continue;
    const was = before[run.id];
    if (run.id in next && was && !isRunning(was.status)) continue;
    next = { ...next, [run.id]: time ?? run.updatedAt };
  }
  return next;
}

/** What a run's agent waits on (PLX-777). */
interface Waiting {
  background: boolean;
  watching: boolean;
}

/**
 * Whether `tasks` will wake the agent. Every kind does: Claude Code wakes it when a background
 * command exits too, as a build it waits on does.
 */
const wakes = (tasks: AgentBackgroundTask[] = []) => tasks.length > 0;

/**
 * How long news that a run's agent waits on no more background work or watched pull requests is
 * held back (PLX-1015).
 */
const QUIET_MS = 5000;

// A run status that ends a hold: it woke, or it can't wake now.
const endsHold = (status: AgentStatus) =>
  isRunning(status) || status === "cancelled" || status === "failed" || status === "interrupted";

/**
 * Passes host events to `apply`, holding for `ms` an `agent.background` with no tasks or a
 * `pr.watches` with no URLs. The agent usually wakes for what ended, and plxd reports its turn
 * starting just after, so applying it at once would show the thread done for a moment. A newer
 * event of the same kind for the run replaces a held one. The run showing running applies its
 * held ones at once, since it woke, as does its stopping or failing, since it can't wake now.
 * `clear` drops every held one.
 */
export function holdQuiet(apply: (event: ParallaxEvent) => void, ms = QUIET_MS) {
  const held = new Map<
    string,
    { runId: string; event: ParallaxEvent; timer: ReturnType<typeof setTimeout> }
  >();
  return {
    pass(event: ParallaxEvent) {
      if (event.kind !== "agent.background" && event.kind !== "pr.watches") {
        apply(event);
        if (event.kind === "agent.updated" && endsHold(event.state.status))
          for (const [key, h] of held)
            if (h.runId === event.runId) {
              clearTimeout(h.timer);
              held.delete(key);
              apply(h.event);
            }
        return;
      }
      const quiet =
        event.kind === "agent.background" ? !wakes(event.tasks) : event.urls.length === 0;
      const { runId } = event;
      const key = `${event.kind}/${runId}`;
      clearTimeout(held.get(key)?.timer);
      held.delete(key);
      if (!quiet) return apply(event);
      const timer = setTimeout(() => {
        held.delete(key);
        apply(event);
      }, ms);
      held.set(key, { runId, event, timer });
    },
    clear() {
      for (const h of held.values()) clearTimeout(h.timer);
      held.clear();
    },
  };
}

export const emptyThreads: ThreadsState = {
  orchestrators: [],
  repos: [],
  threads: [],
  titles: {},
  runs: {},
  approvals: {},
  checkpoints: {},
  waiting: {},
  stoppedAt: {},
};

/** How many permission requests run `runId` waits on. */
export const asksOf = (state: ThreadsState, runId: string) =>
  state.approvals[runId]?.items.length ?? 0;

/** What run `runId`'s agent waits on (PLX-777): a watched pull request, else work that wakes it. */
export const waitingOf = (state: ThreadsState, runId: string) => {
  const waiting = state.waiting[runId];
  return waiting?.watching ? "monitoring" : waiting?.background ? "waiting" : undefined;
};

/** `waiting` with run `runId`'s `part` set to `on`, dropping the run once it waits on neither. */
function setWaiting(
  waiting: ThreadsState["waiting"],
  runId: string,
  part: keyof Waiting,
  on: boolean,
): ThreadsState["waiting"] {
  const next = { background: false, watching: false, ...waiting[runId], [part]: on };
  const { [runId]: _, ...rest } = waiting;
  return next.background || next.watching ? { ...rest, [runId]: next } : rest;
}

export type ThreadsAction =
  | {
      type: "snapshot";
      orchestrators: Orchestrator[];
      repos: Repo[];
      threads: Thread[];
      runs: AgentRun[];
      waiting?: RunWaiting[];
    }
  | { type: "runs"; runs: AgentRun[] }
  /** An orchestrator's new orchestrator, which no host-level event announces (0024). */
  | { type: "orchestrator"; run: AgentRun }
  | { type: "event"; event: ParallaxEvent }
  /** A repo's or an orchestrator's own events: its runs and their permission requests. */
  | { type: "scope"; events: LoggedEvent[] }
  /** The permission requests runs wait on, from the shell's snapshot. */
  | { type: "approvals"; events: LoggedEvent[] };

/** Applies a snapshot, runs' titles, or a host-level event. Events are upserts, so a repeat is harmless. */
export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case "snapshot":
      return {
        orchestrators: action.orchestrators,
        repos: action.repos,
        threads: action.threads,
        titles: withThreadTitles(titlesOf(action.runs), action.threads),
        runs: byId(action.runs),
        approvals: {},
        checkpoints: state.checkpoints,
        waiting: Object.fromEntries(
          (action.waiting ?? []).map((w) => [
            w.runId,
            { background: wakes(w.background), watching: !!w.watching?.length },
          ]),
        ),
        stoppedAt: stops(state.stoppedAt, state.runs, action.runs),
      };
    case "runs":
      return {
        ...state,
        titles: withThreadTitles({ ...state.titles, ...titlesOf(action.runs) }, state.threads),
        runs: { ...state.runs, ...byId(action.runs) },
        stoppedAt: stops(state.stoppedAt, state.runs, action.runs),
      };
    case "orchestrator":
      return {
        ...threadsReducer(state, { type: "runs", runs: [action.run] }),
        orchestrators: state.orchestrators.map((p) =>
          p.id === action.run.project ? { ...p, run: action.run.id } : p,
        ),
      };
    case "scope": {
      let runs = state.runs;
      let stoppedAt = state.stoppedAt;
      for (const { event, time } of action.events) {
        if (!("runId" in event)) continue;
        const before = runs[event.runId];
        const run = updateRun(before, event);
        if (!run || run === before) continue;
        // `updatedAt` marks when it last changed, so a run that stops after the user looked
        // counts as unseen (0033).
        runs = { ...runs, [run.id]: { ...run, updatedAt: time } };
        stoppedAt = stops(stoppedAt, before ? { [run.id]: before } : {}, [run], time);
      }
      const started = action.events.flatMap((e) =>
        e.event.kind === "agent.started" && e.event.run ? [e.event.run] : [],
      );
      const approvals = trackApprovals(state.approvals, action.events);
      // Output that changes neither, the bulk of a running agent's events, keeps the state.
      if (runs === state.runs && approvals === state.approvals && !started.length) return state;
      return {
        ...state,
        runs,
        stoppedAt,
        titles: started.length
          ? withThreadTitles({ ...state.titles, ...titlesOf(started) }, state.threads)
          : state.titles,
        approvals,
      };
    }
    case "approvals":
      return { ...state, approvals: trackApprovals(state.approvals, action.events) };
    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "orchestrator.created":
        case "orchestrator.updated":
          return { ...state, orchestrators: upsert(state.orchestrators, e.orchestrator) };
        case "orchestrator.deleted":
          return {
            ...state,
            orchestrators: state.orchestrators.filter((p) => p.id !== e.orchestrator),
            runs: Object.fromEntries(
              Object.entries(state.runs).filter(([, r]) => r.project !== e.orchestrator),
            ),
          };
        case "repo.added":
        case "repo.updated":
          return { ...state, repos: upsert(state.repos, e.repo) };
        case "repo.removed":
          return {
            ...state,
            repos: state.repos.filter((r) => r.id !== e.repo),
            threads: state.threads.filter((x) => x.repo !== e.repo),
          };
        case "thread.started":
        case "thread.updated": {
          const run = state.runs[e.thread.id];
          // A cleared title falls back to its run's.
          const title = e.thread.title ?? (run && titleOf(run));
          return {
            ...state,
            threads: upsert(state.threads, e.thread),
            titles: title ? { ...state.titles, [e.thread.id]: title } : state.titles,
          };
        }
        case "thread.deleted":
          return { ...state, threads: state.threads.filter((t) => t.id !== e.runId) };
        case "agent.background":
          return {
            ...state,
            waiting: setWaiting(state.waiting, e.runId, "background", wakes(e.tasks)),
          };
        case "pr.watches":
          return {
            ...state,
            waiting: setWaiting(state.waiting, e.runId, "watching", e.urls.length > 0),
          };
        case "thread.checkpoint":
        case "thread.reverted":
          return {
            ...state,
            checkpoints: { ...state.checkpoints, [e.runId]: (state.checkpoints[e.runId] ?? 0) + 1 },
          };
        default:
          return state;
      }
    }
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

function byId(runs: AgentRun[]): Record<string, AgentRun> {
  return Object.fromEntries(runs.map((r) => [r.id, r]));
}

function titlesOf(runs: AgentRun[]): Record<string, string> {
  return Object.fromEntries(runs.map((r) => [r.id, titleOf(r)]));
}

/** `titles` with each of `threads`' own title (0041) over its run's. */
function withThreadTitles(titles: Record<string, string>, threads: Thread[]) {
  for (const t of threads) if (t.title) titles[t.id] = t.title;
  return titles;
}

/**
 * A run's title: the generated title this app kept for it, or else its prompt's first line, with
 * an attached thread's or computer's `@"Name"` as its name, or "Image" for a prompt of images alone.
 * A thread's own title from plxd comes first (`titles`).
 */
export function titleOf(run: AgentRun): string {
  return (
    readTitle(run.id) ??
    (run.prompt
      .trim()
      .split("\n")[0]
      ?.replace(/@"([^"]*)"/g, "$1") ||
      "Image")
  );
}

// A thread's generated title, which earlier versions kept in this app for a plxd without
// `threadLineage`, which keeps no title. `useThreads` moves any kept here to a lineage host. Run
// ids are unique across hosts.
const titleKey = (runId: string) => `parallax:title:${runId}`;

function readTitle(runId: string): string | undefined {
  try {
    return localStorage.getItem(titleKey(runId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function forgetTitle(runId: string) {
  try {
    localStorage.removeItem(titleKey(runId));
  } catch {
    // Storage is off, so nothing was kept.
  }
}

/** The sidebar's id for "No repo", which holds plxd's scratch entry's threads, made on first use. */
export const noRepo = "no-repo";

export interface ThreadGroup {
  /** A repo entry's id, or `noRepo`. */
  id: string;
  name: string;
  /** A Project (0069): threads with no repository of the user's. */
  project?: boolean;
}

/** The sidebar's groups: each repository, oldest first, then No repo, always there. */
export function groupThreads({ repos }: ThreadsState): ThreadGroup[] {
  return [
    ...repos.filter((r) => !r.scratch).map((r) => ({ id: r.id, name: r.name, project: r.project })),
    { id: noRepo, name: "No repo" },
  ];
}

/** A repository on a computer other than the open one. */
export interface OtherRepo {
  host: Host;
  repo: Repo;
}

/**
 * The repositories on computers other than `openId` whose name the open one doesn't list, each
 * name once, from the first of `hosts` that lists it. Matched by name, since each computer's
 * entries have their own ids.
 */
export function otherRepos(
  hosts: Host[],
  views: Readonly<Record<string, ThreadsView>>,
  openId: string,
): OtherRepo[] {
  const named = (id: string) => views[id]?.state.repos.filter(isRepository) ?? [];
  const seen = new Set(named(openId).map((r) => r.name));
  const found: OtherRepo[] = [];
  for (const host of hosts) {
    if (host.id === openId) continue;
    for (const repo of named(host.id)) {
      if (seen.has(repo.name)) continue;
      seen.add(repo.name);
      found.push({ host, repo });
    }
  }
  return found;
}

/**
 * The names of the repositories that more than one of `hosts` lists, which count as one project
 * wherever the computer is chosen later (PLX-1498). Matched by name, as `otherRepos` matches.
 */
export function reposOnSeveral(
  hosts: Host[],
  views: Readonly<Record<string, ThreadsView>>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const several = new Set<string>();
  for (const host of hosts)
    for (const name of new Set(views[host.id]?.state.repos.filter(isRepository).map((r) => r.name)))
      (seen.has(name) ? several : seen).add(name);
  return several;
}

/**
 * Whether `view`'s computer has no repository named `name`. False until its first list is in (a
 * computer that never connected still has `emptyThreads`), since that can't be told yet.
 */
export const lacksRepo = (view: ThreadsView | undefined, name: string) =>
  !!view &&
  view.state !== emptyThreads &&
  !view.loading &&
  !view.error &&
  !view.state.repos.some((r) => isRepository(r) && r.name === name);

/** When a repo's icon was picked, or the earliest time for one with no pick time. */
const pickedAt = (repo: Repo) => (repo.iconAt ? Date.parse(repo.iconAt) : -Infinity);

/**
 * Each repository's icon by name, among `repos` from every computer: the one picked most recently
 * (`iconAt`), or with no pick time, as icons from before plxd kept it and logos the app found have
 * none, the one on the entry created first. Matched by name, as `otherRepos` matches.
 */
export function repoIconsByName(repos: Iterable<Repo>): ReadonlyMap<string, ChosenIcon> {
  const winners = new Map<string, Repo>();
  for (const repo of repos) {
    if (!isRepository(repo) || !repo.icon) continue;
    const held = winners.get(repo.name);
    const wins =
      !held ||
      (pickedAt(repo) !== pickedAt(held)
        ? pickedAt(repo) > pickedAt(held)
        : Date.parse(repo.createdAt) < Date.parse(held.createdAt));
    if (wins) winners.set(repo.name, repo);
  }
  return new Map([...winners].map(([name, repo]) => [name, repo.icon!]));
}

/** Every computer's repository icons by name (`repoIconsByName`), so each copy draws the same one. */
export const sharedRepoIcons = (hosts: Host[], views: Readonly<Record<string, ThreadsView>>) =>
  repoIconsByName(hosts.flatMap((host) => views[host.id]?.state.repos ?? []));

/**
 * A repo's icon: its repository's on every computer (`sharedRepoIcons`), so a copy whose own icon
 * is older draws the newest pick (PLX-1498), or else its own.
 */
export const repoIconOf = (repo: Repo, shared: ReadonlyMap<string, ChosenIcon>) =>
  (isRepository(repo) ? shared.get(repo.name) : undefined) ?? repo.icon;

/**
 * Sets `icon` on the repository named `name` on each of `views`' computers that keeps repo icons
 * (0033), so every copy draws the same one. An image goes only where its plxd takes one that big
 * (0038).
 */
export function setRepoIcons(views: ThreadsView[], name: string, icon: ChosenIcon) {
  for (const view of views) {
    if (!("threadAttention" in view.capabilities)) continue;
    if (icon.image && icon.image.data.length > (view.iconImageBytes ?? -1)) continue;
    for (const repo of view.state.repos)
      if (isRepository(repo) && repo.name === name) void view.updateRepo(repo.id, { icon });
  }
}

/** Whether a group holds chats with no repository of the user's: Chat, or a Project. */
export const repoless = (g: { id: string; project?: boolean }) => g.id === noRepo || !!g.project;

/** A repo entry that is a repository of the user's: not Chat's scratch entry, nor a Project. */
export const isRepository = (r: { scratch?: boolean; project?: boolean }) =>
  !r.scratch && !r.project;

/**
 * The Projects a thread on `view`'s computer can join: its own, then those of the other connected
 * `computers` under a name it lacks, which `addToProject` makes there. Same-named Projects count as
 * one (0097).
 */
export function joinableProjects(view: ThreadsView, computers: { view: ThreadsView }[]): Repo[] {
  const found = view.state.repos.filter((r) => r.project);
  if (!("projects" in view.capabilities)) return found;
  const names = new Set(found.map((r) => r.name));
  for (const other of computers) {
    // Offline, its capabilities are gone and its repos are only what it last reported.
    if (!("projectThreads" in other.view.capabilities)) continue;
    for (const repo of other.view.state.repos) {
      if (!repo.project || names.has(repo.name)) continue;
      names.add(repo.name);
      found.push(repo);
    }
  }
  return found;
}

/**
 * Where `thread` can be added to a Project: any computer's Projects (`joinableProjects`), and the
 * Project it was started in, which it stays in. Orchestrator threads can join Projects too (0093).
 * Undefined for an orchestrator's child, or where plxd can't add threads to Projects or none exist.
 */
export function projectChoices(
  thread: Thread,
  view: ThreadsView,
  computers: { view: ThreadsView }[],
): { projects: Repo[]; startedIn?: Repo } | undefined {
  const home = view.state.repos.find((r) => r.id === thread.repo);
  const projects = joinableProjects(view, computers);
  const orchestrator = view.state.orchestrators.some((p) => p.run === thread.id);
  if ((!home && !orchestrator) || !("projectThreads" in view.capabilities) || projects.length === 0)
    return undefined;
  return { projects, startedIn: home?.project ? home : undefined };
}

/**
 * Makes `source`, another computer's Project, on `view`'s computer: its name, icon, and instructions,
 * but not its files, which live on its own computer (0097). Resolves to the entry or an error message.
 */
async function copyProject(view: ThreadsView, source: Repo): Promise<Repo | string> {
  // An image goes only where its plxd takes one that big (0038).
  const fits = !source.icon?.image || source.icon.image.data.length <= (view.iconImageBytes ?? -1);
  const made = await view.createProject(source.name, fits ? source.icon : undefined);
  if (typeof made === "string" || !source.instructions || !("projectContext" in view.capabilities))
    return made;
  const failed = await view.updateRepo(made.id, { instructions: source.instructions });
  if (!failed) return made;
  // It's empty, and a retry would find it by name and skip the instructions.
  const stuck = await view.removeProject(made.id);
  return stuck ? `${source.name} is there now, but without its instructions: ${failed}` : failed;
}

// Copies under way, by computer and name, so threads added at once share one Project: plxd only
// treats `project/create` as a repeat when the id matches, and each copy has a new id.
const copying = new Map<string, Promise<Repo | string>>();

/**
 * `source`, or its namesake, on `view`'s computer, made if missing. A copy under way comes first: its
 * entry is listed before its instructions are set, and it goes again if they fail.
 */
function namesakeOf(view: ThreadsView, source: Repo): Promise<Repo | string> {
  const key = `${view.hostId}/${source.name}`;
  const under = copying.get(key);
  if (under) return under;
  const { repos } = view.state;
  const found =
    repos.find((r) => r.id === source.id) ?? repos.find((r) => r.project && r.name === source.name);
  if (found) return Promise.resolve(found);
  const copy = copyProject(view, source).finally(() => copying.delete(key));
  copying.set(key, copy);
  return copy;
}

/**
 * Adds `threads`, all on `view`'s computer, to `project`, or to its namesake there, made if missing
 * (0097). An archived thread comes back first, since a Project's page lists no archived ones, and
 * one that won't stays out of the Project, where adding it can be tried again. Resolves to an error
 * message, or undefined.
 */
export async function addToProject(
  view: ThreadsView,
  threads: Thread[],
  project: Repo,
): Promise<string | undefined> {
  const here = await namesakeOf(view, project);
  if (typeof here === "string") return here;
  const restored = await Promise.all(
    threads.filter((t) => t.archived).map((t) => view.archive(t.id, false)),
  );
  const failed = restored.find((error) => error !== undefined);
  if (failed) return failed;
  return view.setProject(
    threads.map((t) => t.id),
    here.id,
  );
}

/** The Project a thread is in: the one it started in, or the one the user added it to (0090). */
export const projectOf = (state: ThreadsState, thread: Thread) =>
  thread.project ??
  (state.repos.some((r) => r.id === thread.repo && r.project) ? thread.repo : undefined);

/** A thread's group id: its repository's, or `noRepo`. */
export const groupOf = (state: ThreadsState, thread: Thread) =>
  state.repos.some((r) => r.id === thread.repo && !r.scratch) ? thread.repo : noRepo;

/** A thread's parent thread (0041), if it's listed. An orchestrator's own run is no thread. */
export const parentOf = (state: ThreadsState, thread: Thread) =>
  thread.parent === undefined ? undefined : state.threads.find((t) => t.id === thread.parent);

/**
 * By thread id: the orchestrator each thread is in (0042), where its own run or an ancestor's is
 * one of an orchestrator's, as an orchestrator's child's parent is. Threads in no orchestrator are
 * left out. Such a thread shows only inside its orchestrator, never in the main sidebar. A loop of
 * parents stops where it repeats.
 */
export function threadOrchestrators(state: ThreadsState): Map<string, string> {
  const orchestrators = new Set(state.orchestrators.map((p) => p.id));
  const parents = new Map(state.threads.map((t) => [t.id, t.parent]));
  const found = new Map<string, string>();
  for (const thread of state.threads) {
    const seen = new Set<string>();
    for (let id = thread.id as string | undefined; id && !seen.has(id); id = parents.get(id)) {
      seen.add(id);
      const orchestrator = state.runs[id]?.project;
      if (orchestrator && orchestrators.has(orchestrator)) {
        found.set(thread.id, orchestrator);
        break;
      }
    }
  }
  return found;
}

/**
 * Orchestrator `orchestrator`'s runs: its own, orchestrators included, and those of the threads in
 * it (`threadOrchestrators`). Its side panel and its sidebar row count the same runs.
 */
export const orchestratorRuns = (
  state: ThreadsState,
  orchestrator: string,
  inOrchestrator: ReadonlyMap<string, string>,
) =>
  Object.values(state.runs).filter(
    (r) => r.project === orchestrator || inOrchestrator.get(r.id) === orchestrator,
  );

/** The threads `id` launched, oldest first, so their order holds as they start. */
export const childrenOf = (state: ThreadsState, id: string) =>
  state.threads
    .filter((t) => t.parent === id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * What the top bar shows of a thread's lineage: with children, the thread and them; else, as a
 * child, its parent and its unarchived siblings, itself included. Undefined for neither.
 * `parent` is the crumb before the chips.
 */
export function lineageOf(
  state: ThreadsState,
  thread: Thread,
): { parent?: Thread; chips: Thread[]; active?: string } | undefined {
  const parent = parentOf(state, thread);
  const children = childrenOf(state, thread.id).filter((t) => !t.archived);
  if (children.length > 0) return { parent, chips: children };
  if (!parent) return undefined;
  const chips = childrenOf(state, parent.id).filter((t) => !t.archived || t.id === thread.id);
  return { parent, chips, active: thread.id };
}

/** A thread's topmost listed ancestor, for the whole tree. A loop of parents stops where it repeats. */
export function rootOf(state: ThreadsState, thread: Thread): Thread {
  const seen = new Set([thread.id]);
  let root = thread;
  for (let up = parentOf(state, root); up && !seen.has(up.id); up = parentOf(state, up)) {
    seen.add(up.id);
    root = up;
  }
  return root;
}

/**
 * A thread to start in group `groupId` with `prompt` and its `images`, with `options` sent as they
 * are, on a branch named from the prompt's words. A plxd with `threadNaming` then names the thread
 * and its branch with the naming model in Settings (0058). With `checkout`, it works in the
 * repository's own checkout instead of a new worktree, so it gets no branch. Reuse `runId`, with
 * the same options, `checkout`, and `gitRef`, to retry.
 */
export interface ThreadStart {
  runId: string;
  groupId: string;
  prompt: string;
  images: PromptImage[];
  /** The run ids of the threads attached to the prompt as context (0047). */
  threads: string[];
  /** The computers and their threads the prompt names (0101). */
  mentions?: Mentions;
  options: RunOptions;
  checkout: boolean;
  /** The ref the worktree starts from, or with `checkout`, the branch the checkout switches to. */
  gitRef?: string;
}

export interface ThreadsView {
  state: ThreadsState;
  /** Why the list couldn't load or stopped updating, for people. */
  error?: string;
  /** Opens the list's subscription again after `error`. */
  retry: () => void;
  /**
   * The host's plxd predates the subscriptions this app uses (0059), so its lists can't load. A
   * notification says so (alarms.ts), not the sidebar.
   */
  outdated?: boolean;
  /**
   * While a load or resync is under way: its list can be in without the permission requests
   * that follow it, so who needs the user isn't settled yet (PLX-507's alarms wait it out).
   */
  loading?: boolean;
  /** Registers a repository (idempotent on its path). Resolves to its entry or an error message. */
  addRepo: (path: string) => Promise<Repo | string>;
  /** Starts a thread as `ThreadStart` says. Resolves to plxd's error, or undefined. */
  start: (start: ThreadStart) => Promise<RpcError | undefined>;
  /**
   * Forks thread `runId` at `turnId`, or at its latest turn (`thread/fork`, 0050), keeping its model
   * or running on `choice`'s. Resolves to the fork's id, or plxd's error.
   */
  fork: (
    runId: string,
    turnId: string | undefined,
    choice: ForkChoice,
  ) => Promise<string | RpcError>;
  archive: (runId: string, archived: boolean) => Promise<string | undefined>;
  remove: (thread: Thread) => Promise<string | undefined>;
  /**
   * Creates an orchestrator on a repository's path, with `icon` if one was chosen and `permission`
   * and `autonomy` where the host keeps them. Reuse `id`, with the same name, path, icon, mode, and
   * autonomy, to retry. Resolves to the orchestrator or an error message.
   */
  createOrchestrator: (
    id: string,
    name: string,
    repoPath: string,
    icon?: ChosenIcon,
    permission?: OrchestratorPermission,
    autonomy?: OrchestratorAutonomy,
  ) => Promise<Orchestrator | string>;
  /**
   * Renames an orchestrator or sets its icon, which replaces the whole icon (0032). Resolves to an
   * error message, or undefined.
   */
  updateOrchestrator: (
    orchestrator: string,
    change: OrchestratorChange,
  ) => Promise<string | undefined>;
  /**
   * Deletes an orchestrator with every run in it, once plxd has stopped them. Resolves to an error
   * message, or undefined.
   */
  removeOrchestrator: (orchestrator: string) => Promise<string | undefined>;
  /**
   * Starts an orchestrator with `prompt` and its `images`, or starts it over with a new
   * `runId` (0024), then keeps it as the orchestrator's. Reusing `runId` to retry is safe with any
   * prompt or options: a failed `orchestrator/start` creates nothing, and one whose answer was lost
   * shows up in `orchestrator/list` after a reconnect. Resolves to plxd's error, or undefined.
   */
  startOrchestrator: (
    orchestrator: string,
    runId: string,
    prompt: string,
    images: PromptImage[],
    options: OrchestratorOptions,
  ) => Promise<RpcError | undefined>;
  /** The host these threads are on. */
  hostId: string;
  /** The host's plxd's capabilities, or none while it isn't connected. */
  capabilities: Capabilities;
  /** The cap on an icon image's base64, where the host's plxd keeps icon images (`iconImages`, 0038). */
  iconImageBytes?: number;
  /**
   * Marks a thread seen, or snoozes it until a time (a past one ends the snooze). Resolves to an
   * error message, or undefined.
   */
  update: (runId: string, change: ThreadChange) => Promise<string | undefined>;
  /**
   * Sets a repo entry's icon, or a Project's name, instructions, or files (0090). Resolves to an
   * error message, or undefined.
   */
  updateRepo: (repo: string, change: RepoChange) => Promise<string | undefined>;
  /** Makes a Project, an orchestrator of threads with no repository (0069, 0090). Resolves to its entry or an error message. */
  createProject: (name: string, icon?: ChosenIcon) => Promise<Repo | string>;
  /** Deletes a Project and every chat in it. Resolves to an error message, or undefined. */
  removeProject: (project: string) => Promise<string | undefined>;
  /**
   * Adds threads to a Project, or with no `project` takes them out of theirs, where each keeps working
   * (0090). Resolves to an error message, or undefined.
   */
  setProject: (threads: string[], project?: string) => Promise<string | undefined>;
}

export type RepoChange = Omit<RepoUpdateParams, "repo">;

/** What a fork runs on: absent keeps the thread's model and account. */
export type ForkChoice = { model?: string; account?: AccountChoice };

/** What a fork sends to run on `m`: its model, and its instance when that isn't the run's. */
export function forkChoiceOf(
  m: { id: string; provider: string },
  run: { backend: string },
): ForkChoice {
  return {
    ...(m.id && { model: m.id }),
    ...(m.provider !== run.backend && {
      account: { kind: "subscription", backend: m.provider } as const,
    }),
  };
}

/** What `thread/update` changes. An empty `title` clears it. */
export type ThreadChange = {
  seen?: boolean;
  snoozedUntil?: string;
  pinned?: boolean;
  title?: string;
};

/** What `orchestrator/update` changes: an orchestrator's name, icon, permission mode, or autonomy. */
export type OrchestratorChange = Omit<OrchestratorUpdateParams, "orchestrator">;

/** What a new orchestrator runs on: its model, effort, permission, and account (`orchestrator/start`'s). */
export type OrchestratorOptions = Pick<
  OrchestratorStartParams,
  "model" | "effort" | "permission" | "account"
>;

/**
 * A host's threads and orchestrators, kept live through `orchestration/subscribeShell` (0059): a
 * snapshot of its orchestrators, repo entries, threads, runs, and the permission requests runs wait
 * on, then what a sidebar shows of every scope's events (0033). It opens once the host starts
 * connecting (`opening`), so its subscribe goes right behind `initialize` (PLX-1480), and stays
 * open across disconnects: a reconnect resumes after the last event, and a fresh snapshot replaces
 * the state only when the gap is too long to replay (`useWatchKey`). An older plxd has no shell
 * to load.
 * With `approvals`, the threads and orchestrators started here forward their permission
 * requests (PLX-196, 0031); with `threadLineage`, titles kept in this app move to plxd once
 * (0041); with `threadNaming`, plxd names new threads and their branches (0058). The view carries
 * them all for the sidebar and top bar. An orchestrator's new Needs you inbox item (0043) goes to
 * `onNeedsYou`.
 */
export function useThreads(
  hostId: string,
  /** plxd's, once the host is connected. */
  capabilities: Capabilities | undefined,
  /** The host is connecting or connected. */
  opening: boolean,
  iconImageBytes: number | undefined,
  /** Called for each new Needs you item in one of the host's orchestrators' inboxes (0043). */
  onNeedsYou: (orchestrator: string, item: InboxItem) => void,
): ThreadsView {
  const has = (key: string) => !!capabilities && key in capabilities;
  const connected = !!capabilities;
  const approvals = has("approvals");
  const lineage = has("threadLineage");
  const naming = has("threadNaming");
  const [state, dispatch] = useReducer(threadsReducer, emptyThreads);
  const [error, setError] = useState<string>();
  const [outdated, setOutdated] = useState(false);
  const [loading, setLoading] = useState(false);
  const needsYou = useRef(onNeedsYou);
  // Read when a snapshot arrives, so a change doesn't reopen the shell.
  const lineageNow = useRef(lineage);
  useEffect(() => {
    needsYou.current = onNeedsYou;
    lineageNow.current = lineage;
  });
  const [watchKey, failed, reopen] = useWatchKey(hostId, opening || connected, hostId);

  useEffect(() => {
    if (!watchKey) return;
    let stopped = false;
    let moved = false;

    // Titles this app kept before plxd kept them go to plxd, once each, for threads it has none for.
    async function moveTitles(threads: Thread[]) {
      for (const t of threads) {
        const title = t.title ? undefined : readTitle(t.id);
        if (!title) continue;
        const answer = await window.parallax.request(hostId, "thread/update", {
          runId: t.id,
          title,
        });
        if (stopped) return;
        if ("error" in answer) continue;
        forgetTitle(t.id);
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
      }
    }

    setLoading(true);
    const quiet = holdQuiet((event) => dispatch({ type: "event", event }));
    const stop = window.parallax.watch(hostId, { shell: true }, (message) => {
      if (stopped) return;
      if (message.type === "error") {
        failed();
        const old = message.error.code === ErrorCodes.MethodNotFound;
        setOutdated(old);
        return setError(old ? undefined : message.error.message);
      }
      if (message.type === "snapshot") {
        const { orchestrators, repos, threads, runs, requests, waiting } = message.snapshot;
        quiet.clear();
        dispatch({ type: "snapshot", orchestrators, repos, threads, runs, waiting });
        dispatch({ type: "approvals", events: requests });
        setError(undefined);
        setOutdated(false);
        setLoading(false);
        if (lineageNow.current && !moved) {
          moved = true;
          void moveTitles(threads);
        }
        return;
      }
      // A host-level event changes the lists, and a scope's its runs and their requests; each
      // action leaves the other's kinds alone.
      const logged = message.event;
      quiet.pass(logged.event);
      dispatch({ type: "scope", events: [logged] });
      const { event } = logged;
      if (event.kind === "inbox.added" && event.item.kind === "needsYou" && logged.project)
        needsYou.current(logged.project, event.item);
    });
    return () => {
      stopped = true;
      quiet.clear();
      stop();
    };
  }, [hostId, watchKey, failed]);

  // Each applies its own answer at once; the matching event repeats it harmlessly.
  const actions = useMemo(
    () => ({
      async addRepo(path: string) {
        // A fresh id is safe to retry with: plxd returns the entry a path already has.
        const answer = await window.parallax.request(hostId, "repo/add", { id: uuidv7(), path });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.added", repo: answer.result.repo } });
        return answer.result.repo;
      },

      async start({
        runId,
        groupId,
        prompt,
        images,
        threads,
        mentions,
        options,
        checkout,
        gitRef,
      }: ThreadStart) {
        const branchSlug = slugify(prompt);
        const { naming: model, namingEffort } = newThreadPrefs.get();
        const answer = await window.parallax.request(hostId, "thread/start", {
          runId,
          prompt,
          ...(images.length > 0 && { images }),
          ...(threads.length > 0 && { threads }),
          ...(!!mentions?.computers?.length && { computers: mentions.computers }),
          ...(!!mentions?.remoteThreads?.length && { remoteThreads: mentions.remoteThreads }),
          ...(groupId !== noRepo && { repo: groupId }),
          ...options,
          // The checkout keeps its own branch, so a name gives it none.
          ...(checkout ? { checkout } : branchSlug && { branchSlug }),
          ...(gitRef && (checkout ? { checkoutRef: gitRef } : { base: gitRef })),
          ...(approvals && { approvals }),
          ...(naming &&
            prompt.trim() && {
              naming: { backend: model.provider, model: model.id, effort: namingEffort },
            }),
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "runs", runs: [answer.result.run] });
        dispatch({
          type: "event",
          event: { kind: "thread.started", thread: answer.result.thread },
        });
        return undefined;
      },

      async fork(runId: string, turnId: string | undefined, choice: ForkChoice) {
        const newRunId = uuidv7();
        const answer = await window.parallax.request(hostId, "thread/fork", {
          runId,
          newRunId,
          ...(turnId && { turnId }),
          ...choice,
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "runs", runs: [answer.result.run] });
        dispatch({
          type: "event",
          event: { kind: "thread.started", thread: answer.result.thread },
        });
        return newRunId;
      },

      async archive(runId: string, archived: boolean) {
        const answer = await window.parallax.request(hostId, "thread/archive", { runId, archived });
        if ("error" in answer) return answer.error.message;
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
        return undefined;
      },

      async remove(thread: Thread) {
        const answer = await window.parallax.request(hostId, "thread/delete", { runId: thread.id });
        if ("error" in answer) return answer.error.message;
        dispatch({
          type: "event",
          event: { kind: "thread.deleted", runId: thread.id, repo: thread.repo },
        });
        return undefined;
      },

      async createOrchestrator(
        id: string,
        name: string,
        repoPath: string,
        icon?: ChosenIcon,
        permission?: OrchestratorPermission,
        autonomy?: OrchestratorAutonomy,
      ) {
        const answer = await window.parallax.request(hostId, "orchestrator/create", {
          id,
          name,
          repoPath,
          ...(icon && { icon }),
          ...(permission && { permission }),
          ...(autonomy && { autonomy }),
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "orchestrator.created", orchestrator: answer.result.orchestrator },
        });
        return answer.result.orchestrator;
      },

      async updateOrchestrator(orchestrator: string, change: OrchestratorChange) {
        const answer = await window.parallax.request(hostId, "orchestrator/update", {
          orchestrator,
          ...change,
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "orchestrator.updated", orchestrator: answer.result.orchestrator },
        });
        return undefined;
      },

      async removeOrchestrator(orchestrator: string) {
        const answer = await window.parallax.request(hostId, "orchestrator/delete", {
          orchestrator,
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "orchestrator.deleted", orchestrator } });
        return undefined;
      },

      async startOrchestrator(
        orchestrator: string,
        runId: string,
        prompt: string,
        images: PromptImage[],
        options: OrchestratorOptions,
      ) {
        const answer = await window.parallax.request(hostId, "orchestrator/start", {
          orchestrator,
          runId,
          prompt,
          ...(images.length > 0 && { images }),
          ...options,
          ...(approvals && { approvals }),
        });
        if ("error" in answer) return answer.error;
        dispatch({ type: "orchestrator", run: answer.result.run });
        return undefined;
      },

      async update(runId: string, change: ThreadChange) {
        const answer = await window.parallax.request(hostId, "thread/update", { runId, ...change });
        if ("error" in answer) return describeError(answer.error);
        dispatch({
          type: "event",
          event: { kind: "thread.updated", thread: answer.result.thread },
        });
        return undefined;
      },

      async updateRepo(repo: string, change: RepoChange) {
        const answer = await window.parallax.request(hostId, "repo/update", { repo, ...change });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.updated", repo: answer.result.repo } });
        return undefined;
      },

      async createProject(name: string, icon?: ChosenIcon) {
        const answer = await window.parallax.request(hostId, "project/create", {
          id: uuidv7(),
          name,
          ...(icon && { icon }),
        });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.added", repo: answer.result.repo } });
        return answer.result.repo;
      },

      async removeProject(project: string) {
        const answer = await window.parallax.request(hostId, "project/delete", { project });
        if ("error" in answer) return describeError(answer.error);
        dispatch({ type: "event", event: { kind: "repo.removed", repo: project } });
        return undefined;
      },

      async setProject(threads: string[], project?: string) {
        const answer = await window.parallax.request(hostId, "thread/setProject", {
          threads,
          ...(project && { project }),
        });
        if ("error" in answer) return describeError(answer.error);
        for (const thread of answer.result.threads)
          dispatch({ type: "event", event: { kind: "thread.updated", thread } });
        return undefined;
      },
    }),
    [hostId, approvals, naming],
  );

  // One object per change, so a parent can keep it and compare.
  return useMemo(
    () => ({
      state,
      error,
      retry: () => {
        setError(undefined);
        reopen();
      },
      ...(outdated && { outdated }),
      // Not while connecting, as before the shell opened that early: a list can't be loading yet.
      loading: loading && connected,
      hostId,
      capabilities: capabilities ?? noCapabilities,
      iconImageBytes,
      ...actions,
    }),
    [
      hostId,
      state,
      error,
      reopen,
      outdated,
      loading,
      connected,
      capabilities,
      iconImageBytes,
      actions,
    ],
  );
}

const notConnected = "Not connected to this host.";
/** A disconnected host's capabilities: one shared object, so a view without them stays equal. */
const noCapabilities: Capabilities = {};

/** A host's view before its list loads: empty, and every action answers that it isn't connected. */
export const idleThreads: ThreadsView = {
  hostId: "",
  state: emptyThreads,
  capabilities: noCapabilities,
  retry: () => {},
  addRepo: async () => notConnected,
  start: async () => ({ code: -32000, message: notConnected }),
  fork: async () => ({ code: -32000, message: notConnected }),
  archive: async () => notConnected,
  remove: async () => notConnected,
  createOrchestrator: async () => notConnected,
  updateOrchestrator: async () => notConnected,
  removeOrchestrator: async () => notConnected,
  startOrchestrator: async () => ({ code: -32000, message: notConnected }),
  update: async () => notConnected,
  updateRepo: async () => notConnected,
  createProject: async () => notConnected,
  removeProject: async () => notConnected,
  setProject: async () => notConnected,
};
