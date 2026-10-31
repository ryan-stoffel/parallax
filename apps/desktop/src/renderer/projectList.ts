// Every host's Projects as one list, for the sidebar's Pinned and the Projects page (0090, 0093):
// a Project groups threads and gives each its instructions and files.
import type { ChosenIcon } from "../protocol/generated/protocol";
import { activeAt, attentionOf, mostUrgent, type Attention } from "./attention";
import type { Host } from "./hosts";
import { asksOf, projectOf, waitingOf, type ThreadsView } from "./threads";

export interface ProjectEntry {
  /** `<host>/<id>`, as pins keep it. */
  key: string;
  host: Host;
  view: ThreadsView;
  id: string;
  name: string;
  icon?: ChosenIcon;
  /** Its top-level threads. */
  threads: number;
  createdAt: string;
  /** Its last change, or its latest thread's. */
  activeAt: string;
  /** Its most urgent state across its threads, as the sidebar's cards show it. */
  attention: Attention;
  /** How many of its threads work now. */
  working: number;
  needsYou: boolean;
  /** How many files it gives its threads. */
  files: number;
  /** Whether it gives its threads instructions. */
  instructions: boolean;
  /** Its most recently active thread's title. */
  latest?: string;
}

/** A thread's title, else its first message's first line. */
const titleOf = (titles: Record<string, string>, id: string, prompt?: string) =>
  titles[id] ?? prompt?.split("\n")[0];

export type ProjectSort = "activity" | "name" | "created";

/** Every host's Projects, most recently active first. */
export function projectEntries(hosts: { host: Host; view: ThreadsView }[]): ProjectEntry[] {
  const entries = hosts.flatMap(({ host, view }) => {
    const { state } = view;
    const projects = state.repos
      .filter((r) => r.project)
      .map((r): ProjectEntry => {
        const projectThreads = state.threads.filter(
          (t) => projectOf(state, t) === r.id && !t.parent,
        );
        let latest = r.createdAt;
        let latestThread: string | undefined;
        const attentions: Attention[] = [];
        for (const t of projectThreads) {
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
          id: r.id,
          name: r.name,
          icon: r.icon,
          threads: projectThreads.length,
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
    return projects;
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
