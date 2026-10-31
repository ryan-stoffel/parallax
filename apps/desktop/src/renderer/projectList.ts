// Every host's Projects as one list, for the sidebar's Pinned and the Projects page (0090, 0093):
// a Project groups threads and gives each its instructions and files.
import type { ChosenIcon } from "../protocol/generated/protocol";
import { activeAt } from "./attention";
import type { Host } from "./hosts";
import { projectOf, type ThreadsView } from "./threads";

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
  /** How many files it gives its threads. */
  files: number;
  /** Whether it gives its threads instructions. */
  instructions: boolean;
}

/** The Projects page's orders: by latest activity, name, creation, or most threads. */
export type ProjectSort = "activity" | "name" | "created" | "threads";

/** Which Projects the Projects page shows: all, the pinned, or those with files or instructions. */
export type ProjectFilter = "all" | "pinned" | "files" | "instructions";

/** Every host's Projects, most recently active first. */
export function projectEntries(hosts: { host: Host; view: ThreadsView }[]): ProjectEntry[] {
  const entries = hosts.flatMap(({ host, view }) => {
    const { state } = view;
    return state.repos
      .filter((r) => r.project)
      .map((r): ProjectEntry => {
        const threads = state.threads.filter((t) => projectOf(state, t) === r.id && !t.parent);
        const latest = threads.reduce((at, t) => {
          const active = activeAt(t, state.runs[t.id], state.stoppedAt[t.id]);
          return Date.parse(active) > Date.parse(at) ? active : at;
        }, r.createdAt);
        return {
          key: `${host.id}/${r.id}`,
          host,
          view,
          id: r.id,
          name: r.name,
          icon: r.icon,
          threads: threads.length,
          createdAt: r.createdAt,
          activeAt: latest,
          files: r.files?.length ?? 0,
          instructions: !!r.instructions,
        };
      });
  });
  return sortProjects(entries, "activity");
}

/**
 * `entries` in `sort`'s order: newest first by activity or creation, by name, or most threads
 * first. Ties go by name.
 */
export function sortProjects(entries: ProjectEntry[], sort: ProjectSort): ProjectEntry[] {
  const byName = (a: ProjectEntry, b: ProjectEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const time = (e: ProjectEntry) => Date.parse(sort === "created" ? e.createdAt : e.activeAt);
  return entries.toSorted((a, b) =>
    sort === "name"
      ? byName(a, b)
      : (sort === "threads" ? b.threads - a.threads : time(b) - time(a)) || byName(a, b),
  );
}

/** The `entries` `filter` keeps, given the `pins`, whose names hold every word of `query`. */
export function filterProjects(
  entries: ProjectEntry[],
  filter: ProjectFilter,
  pins: readonly string[],
  query: string,
): ProjectEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = {
    all: () => true,
    pinned: (e: ProjectEntry) => pins.includes(e.key),
    files: (e: ProjectEntry) => e.files > 0,
    instructions: (e: ProjectEntry) => e.instructions,
  }[filter];
  return entries.filter((e) => kept(e) && words.every((w) => e.name.toLowerCase().includes(w)));
}
