import { merged, stored } from "./stored";

/** How many archived threads a page lists, and how many Show more adds. */
export const archivePageSize = 25;

/**
 * Sidebar behavior kept on this computer (0033). Both default to the sections: a Working drawer
 * while a thread runs, and archived threads a page at a time. Off is the earlier list.
 */
export type SidebarPrefs = {
  /** While a top-level thread is working, list it and its children under Working. */
  workingSection: boolean;
  /** List archived threads `archivePageSize` at a time. */
  pageArchived: boolean;
};

export const sidebarDefaults: SidebarPrefs = {
  workingSection: true,
  pageArchived: true,
};

export const sidebarPrefs = stored("parallax.sidebar", sidebarDefaults, merged);

/** The sidebar's nav rows that Edit sidebar shows or hides (0090). New thread, Search, and More always show. */
export type NavRow = "projects" | "pullRequests" | "usage";

export const navDefaults: Record<NavRow, boolean> = {
  projects: true,
  pullRequests: true,
  usage: true,
};

export const sidebarNav = stored("parallax.sidebarNav", navDefaults, merged);

/**
 * Pinned projects, Projects and Spaces alike, by `<host>/<id>`, in the order pinned (0090). They
 * list under the nav rows and lead the Projects page.
 */
export const pinnedProjects = stored<string[]>("parallax.pinnedProjects", [], (raw, fallback) =>
  Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : fallback,
);

/** Pins project `key`, or unpins it if it's pinned. */
export function togglePinnedProject(key: string) {
  const pins = pinnedProjects.get();
  pinnedProjects.set(pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key]);
}
