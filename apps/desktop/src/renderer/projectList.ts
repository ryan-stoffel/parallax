// Every host's projects as one list, for the sidebar's Pinned and the Projects page (0090): a
// Project, which a coordinator runs on a repository, or a Space, which groups threads with no
// repository and gives each its instructions and files.
import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { activeAt, attentionOf, projectAttention } from "./attention";
import type { Host } from "./hosts";
import { asksOf, projectRuns, threadProjects, waitingOf, type ThreadsView } from "./threads";

export interface ProjectEntry {
  /** `<host>/<id>`, as pins keep it. */
  key: string;
  host: Host;
  view: ThreadsView;
  kind: "project" | "space";
  id: string;
  name: string;
  icon?: ProjectIconValue;
  /** Its threads: a Project's runs, or a Space's top-level threads. */
  threads: number;
  createdAt: string;
  /** Its last change, or its latest thread's. */
  activeAt: string;
  needsYou: boolean;
}

export type ProjectSort = "activity" | "name" | "created";

/** Every host's Projects and Spaces, most recently active first. */
export function projectEntries(hosts: { host: Host; view: ThreadsView }[]): ProjectEntry[] {
  const entries = hosts.flatMap(({ host, view }) => {
    const { state } = view;
    const inProject = threadProjects(state);
    const projects = state.projects.map((p): ProjectEntry => {
      const runs = projectRuns(state, p.id, inProject);
      return {
        key: `${host.id}/${p.id}`,
        host,
        view,
        kind: "project",
        id: p.id,
        name: p.name,
        icon: p.icon,
        threads: runs.length,
        createdAt: p.createdAt,
        activeAt: p.updatedAt,
        needsYou: projectAttention(runs, (id) => asksOf(state, id)) === "needsYou",
      };
    });
    const spaces = state.repos
      .filter((r) => r.space)
      .map((r): ProjectEntry => {
        const spaceThreads = state.threads.filter((t) => t.repo === r.id && !t.parent);
        let latest = r.createdAt;
        let needsYou = false;
        for (const t of spaceThreads) {
          const run = state.runs[t.id];
          const at = activeAt(t, run, state.stoppedAt[t.id]);
          if (Date.parse(at) > Date.parse(latest)) latest = at;
          if (
            !t.archived &&
            attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)) === "needsYou"
          )
            needsYou = true;
        }
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
          needsYou,
        };
      });
    return [...projects, ...spaces];
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
