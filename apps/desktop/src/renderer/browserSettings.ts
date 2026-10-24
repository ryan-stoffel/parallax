import { merged, stored } from "./stored";

// The browser's settings (PLX-974), kept on this computer and set in Settings › Browser.

/**
 * The search engines the address bar can search with, Helium's list, with Chrome's query URLs
 * (search_engines_data's prepopulated_engines.json).
 */
export const searchEngines = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q={searchTerms}" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q={searchTerms}" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q={searchTerms}" },
  { id: "brave", name: "Brave", url: "https://search.brave.com/search?q={searchTerms}" },
  { id: "ecosia", name: "Ecosia", url: "https://www.ecosia.org/search?q={searchTerms}" },
  { id: "kagi", name: "Kagi", url: "https://kagi.com/search?q={searchTerms}" },
  {
    id: "startpage",
    name: "Startpage",
    url: "https://www.startpage.com/sp/search?q={searchTerms}",
  },
  { id: "qwant", name: "Qwant", url: "https://www.qwant.com/?q={searchTerms}" },
] as const;

/** The engine the address bar searches with, Google's until the user picks another. */
export const searchEngine = stored<string>("parallax.searchEngine", "google", (raw, fallback) =>
  searchEngines.some((e) => e.id === raw) ? (raw as string) : fallback,
);

/** `engine`'s results page for `query`, Google's for an engine it doesn't know. */
export function searchUrlFor(engine: string, query: string): string {
  const { url } = searchEngines.find((e) => e.id === engine) ?? searchEngines[0];
  return url.replace("{searchTerms}", encodeURIComponent(query));
}

/** The engine's name, for the address bar's placeholder. */
export const searchEngineName = (engine: string) =>
  (searchEngines.find((e) => e.id === engine) ?? searchEngines[0]).name;

/**
 * On startup, whether each browser opens its tabs from before, Chrome's "Continue where you left
 * off", or a new tab.
 */
export const restoreTabs = stored<boolean>("parallax.restoreTabs", true, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** The toolbar's home button: whether it shows, and the page it opens, or a new tab when empty. */
export const homeButton = stored<{ show: boolean; url: string }>(
  "parallax.homeButton",
  { show: false, url: "" },
  merged,
);

/**
 * Where downloads go, the OS's downloads folder when empty, and whether to ask each time (PLX-975).
 * Main saves them, so it hears the settings at startup and on each change.
 */
export const downloadPrefs = stored<{ dir: string; ask: boolean }>(
  "parallax.downloadPrefs",
  { dir: "", ask: false },
  merged,
);
// Tests load this without a window.
if (typeof window !== "undefined") window.parallax?.setDownloadPrefs?.(downloadPrefs.get());

export function setDownloadPrefs(next: { dir: string; ask: boolean }) {
  downloadPrefs.set(next);
  window.parallax.setDownloadPrefs(next);
}
