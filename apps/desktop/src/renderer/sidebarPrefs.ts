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
 * Which sidebar shows (0091). Inbox, the default, is 0087's: the search box and its buttons in its
 * head and the threads as one list, most recently active first. Traditional has 0090's head (New
 * thread, Search, and Projects as rows, and Pinned projects) and lists the threads in a folder per
 * repo. Settings › Appearance › Sidebar switches it.
 */
export type SidebarMode = "inbox" | "traditional";

/**
 * A stored mode, read from any name it had: Classic is Inbox, and Beta and Folders, the two with
 * 0090's head, are Traditional.
 */
export function readMode(raw: unknown): SidebarMode | undefined {
  if (raw === "inbox" || raw === "classic") return "inbox";
  if (raw === "traditional" || raw === "beta" || raw === "folders") return "traditional";
  return undefined;
}

/** The mode before 0091, when the new sidebar was Settings › Beta's switch: on reads as Traditional. */
export function legacyMode(): SidebarMode {
  try {
    return localStorage.getItem("parallax.beta.newSidebar") === "true" ? "traditional" : "inbox";
  } catch {
    return "inbox";
  }
}

/** The sidebar's mode, kept on this computer. */
export const sidebarMode = stored<SidebarMode>(
  "parallax.sidebarMode",
  legacyMode(),
  (raw, fallback) => readMode(raw) ?? fallback,
);
