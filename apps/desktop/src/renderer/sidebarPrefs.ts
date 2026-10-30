import { merged, stored } from "./stored";

/** How many archived threads a page lists, and how many Show more adds. */
export const archivePageSize = 25;

/**
 * Sidebar behavior kept on this computer (0033), set in Settings › Appearance › Sidebar. Both
 * default to the sections: a Working drawer while a thread runs, and archived threads a page at a
 * time. Off is the earlier list.
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

/** The sidebar's pages that Settings › Appearance › Sidebar shows or leaves under More (0090). New thread, Search, and More always show. */
export type NavRow = "projects" | "pullRequests" | "usage";

/** Projects shows by default; Pull requests and Usage wait under More until chosen. */
export const navDefaults: Record<NavRow, boolean> = {
  projects: true,
  pullRequests: false,
  usage: false,
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

/**
 * Which sidebar shows (0091). Classic, the default, is 0087's: the search box and filter in its
 * head and the threads as one list. Beta is 0090's: New thread, Search, and Projects as rows, and
 * Pinned projects. Folders has Beta's head and lists the threads in a folder per repo, as Codex
 * does. Settings › Appearance › Sidebar switches it.
 */
export type SidebarMode = "classic" | "beta" | "folders";

const isMode = (raw: unknown): raw is SidebarMode =>
  raw === "classic" || raw === "beta" || raw === "folders";

// Before 0091 the new sidebar was Settings › Beta's switch: on reads as Beta.
function legacyMode(): SidebarMode {
  try {
    return localStorage.getItem("parallax.beta.newSidebar") === "true" ? "beta" : "classic";
  } catch {
    return "classic";
  }
}

/** The sidebar's mode, kept on this computer. */
export const sidebarMode = stored<SidebarMode>(
  "parallax.sidebarMode",
  legacyMode(),
  (raw, fallback) => (isMode(raw) ? raw : fallback),
);
