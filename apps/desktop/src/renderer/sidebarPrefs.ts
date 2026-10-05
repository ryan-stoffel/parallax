import { stored, merged } from "./stored";

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
