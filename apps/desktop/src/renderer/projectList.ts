// Every host's orchestrators as one list, for the sidebar's Pinned and the orchestrators page
// (0090): a Orchestrator, which an orchestrator runs on a repository, or a Space, which groups
// threads with no repository and gives each its instructions and files.
import type { ChosenIcon } from "../protocol/generated/protocol";
import {
  activeAt,
  attentionOf,
  mostUrgent,
  orchestratorAttention,
  type Attention,
} from "./attention";
import type { Host } from "./hosts";
import {
  asksOf,
  orchestratorRuns,
  spaceOf,
  threadOrchestrators,
  waitingOf,
  type ThreadsView,
} from "./threads";
import { isRunning } from "./transcript";

export interface ProjectEntry {
  /** `<host>/<id>`, as pins keep it. */
  key: string;
  host: Host;
  view: ThreadsView;
  kind: "orchestrator" | "space";
  id: string;
  name: string;
  icon?: ChosenIcon;
  /** Its threads: an orchestrator's runs, or a Space's top-level threads. */
  threads: number;
  createdAt: string;
  /** Its last change, or its latest thread's. */
  activeAt: string;
  /** Its most urgent state across its threads, as the sidebar's cards show it. */
  attention: Attention;
  /** How many of its threads work now. */
  working: number;
  needsYou: boolean;
  /** An orchestrator's branch: its integration branch, else its checkout's. */
  branch?: string;
  /** How many files a Space gives its threads. */
  files: number;
  /** Whether a Space gives its threads instructions. */
  instructions: boolean;
  /** Its most recently active thread's title, its orchestrator's aside. */
  latest?: string;
}

/** A thread's title, else its first message's first line. */
const titleOf = (titles: Record<string, string>, id: string, prompt?: string) =>
  titles[id] ?? prompt?.split("\n")[0];

export type ProjectSort = "activity" | "name" | "created";

/** Every host's orchestrators and Spaces, most recently active first. */
export function projectEntries(hosts: { host: Host; view: ThreadsView }[]): ProjectEntry[] {
  const entries = hosts.flatMap(({ host, view }) => {
    const { state } = view;
    const inOrchestrator = threadOrchestrators(state);
    const orchestrators = state.orchestrators.map((p): ProjectEntry => {
      const runs = orchestratorRuns(state, p.id, inOrchestrator);
      const attention = orchestratorAttention(runs, (id) => asksOf(state, id));
      const latest = runs
        .filter((r) => r.id !== p.run)
        .reduce<(typeof runs)[number] | undefined>(
          (a, r) => (!a || Date.parse(r.updatedAt) > Date.parse(a.updatedAt) ? r : a),
          undefined,
        );
      return {
        key: `${host.id}/${p.id}`,
        host,
        view,
        kind: "orchestrator",
        id: p.id,
        name: p.name,
        icon: p.icon,
        threads: runs.length,
        createdAt: p.createdAt,
        activeAt: p.updatedAt,
        attention,
        working: runs.filter((r) => isRunning(r.status)).length,
        needsYou: attention === "needsYou",
        branch: p.integrationBranch ?? p.branch,
        files: 0,
        instructions: false,
        latest: latest && titleOf(state.titles, latest.id, latest.prompt),
      };
    });
    const spaces = state.repos
      .filter((r) => r.space)
      .map((r): ProjectEntry => {
        const spaceThreads = state.threads.filter((t) => spaceOf(state, t) === r.id && !t.parent);
        let latest = r.createdAt;
        let latestThread: string | undefined;
        const attentions: Attention[] = [];
        for (const t of spaceThreads) {
          const run = state.runs[t.id];
          const at = activeAt(t, run, state.stoppedAt[t.id]);
          if (Date.parse(at) > Date.parse(latest)) {
            latest = at;
            latestThread = titleOf(state.titles, t.id, run?.prompt);
          }
          attentions.push(attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)));
        }
        const attention = mostUrgent(attentions);
        return {
          key: `${host.id}/${r.id}`,
          host,
          view,
          kind: "space",
          id: r.id,
          name: r.name,
          icon: r.icon,
          threads: spaceThreads.length,
          createdAt: r.createdAt,
          activeAt: latest,
          attention,
          working: attentions.filter((a) => a === "working").length,
          needsYou: attention === "needsYou",
          files: r.files?.length ?? 0,
          instructions: !!r.instructions,
          latest: latestThread,
        };
      });
    return [...orchestrators, ...spaces];
  });
  return sortProjects(entries, "activity");
}

/** `entries` in `sort`'s order: newest first by activity or creation, or by name. */
export function sortProjects(entries: ProjectEntry[], sort: ProjectSort): ProjectEntry[] {
  const time = (e: ProjectEntry) => Date.parse(sort === "created" ? e.createdAt : e.activeAt);
  return entries.toSorted((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : time(b) - time(a) || a.name.localeCompare(b.name),
  );
}
