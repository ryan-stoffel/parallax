// The Projects list's pure piece: every computer's Projects by name, as one row each (0097). Pure,
// for the test.
import type { ProjectEntry } from "../../desktop/src/renderer/projectList";

/** One row of the Projects list: the Projects of one name, on any computers. */
export interface ProjectGroup {
  name: string;
  /** The one its page opens, whose instructions and files it shows and where it starts a thread. */
  home: ProjectEntry;
  /** How many computers hold it. */
  computers: number;
  threads: number;
  activeAt: string;
}

/**
 * `entries`, which `projectEntries` gives most recently active first, as one group per name in that
 * order. A group's home is its copy on the `defaultId` computer, else its latest on a computer
 * that's online, else its latest. An offline computer has no capabilities.
 */
export function projectGroups(entries: ProjectEntry[], defaultId?: string): ProjectGroup[] {
  const named = new Map<string, ProjectEntry[]>();
  for (const entry of entries) named.set(entry.name, [...(named.get(entry.name) ?? []), entry]);
  const online = (e: ProjectEntry) => "projectThreads" in e.view.capabilities;
  return [...named].map(([name, copies]) => ({
    name,
    home:
      copies.find((e) => e.host.id === defaultId && online(e)) ?? copies.find(online) ?? copies[0]!,
    computers: new Set(copies.map((e) => e.host.id)).size,
    threads: copies.reduce((sum, e) => sum + e.threads, 0),
    activeAt: copies[0]!.activeAt,
  }));
}
