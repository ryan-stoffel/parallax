import { isFolder, type Bookmark, type BookmarkNode } from "./Bookmarks";
import type { Visit } from "./browserHistory";

// The address bar's suggestions (PLX-978), as Chrome's: what Enter does, then the bookmarks and
// pages visited that match what's typed.

/** A suggestion: going to an address, searching, a bookmark, or a page from history. */
export interface Suggestion {
  kind: "go" | "search" | "bookmark" | "history";
  url: string;
  title: string;
}

// The most bookmarks and pages listed under what Enter does.
const MATCHES = 6;

const flatten = (nodes: readonly BookmarkNode[]): Bookmark[] =>
  nodes.flatMap((n) => (isFolder(n) ? flatten(n.children) : [n]));

/**
 * The suggestions for `text`: first `enter`, what Enter opens (a search, or an address), then up
 * to six bookmarks and pages from `visits` whose title or address holds every word typed.
 * Bookmarks come first; pages follow by how often they were visited, then how lately. A page whose
 * host starts with what's typed, as "git" does github.com, comes before the rest of its kind.
 */
export function suggestionsFor(
  text: string,
  enter: Suggestion,
  bookmarks: readonly BookmarkNode[],
  visits: readonly Visit[],
): Suggestion[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (url: string, title = "") =>
    words.every((w) => `${title} ${url}`.toLowerCase().includes(w));
  const host = (url: string) => (URL.parse(url)?.host ?? "").replace(/^www\./, "");
  const leads = (url: string) => (host(url).startsWith(words[0]!) ? 0 : 1);

  const marked = flatten(bookmarks)
    .filter((b) => matches(b.url, b.title))
    .sort((a, b) => leads(a.url) - leads(b.url))
    .map((b): Suggestion => ({ kind: "bookmark", url: b.url, title: b.title || b.url }));

  // Each page once, with how often and how lately it was visited, and its latest title.
  const pages = new Map<string, { count: number; time: number; title?: string }>();
  for (const v of visits) {
    const page = pages.get(v.url) ?? { count: 0, time: 0 };
    pages.set(v.url, { count: page.count + 1, time: v.time, title: v.title ?? page.title });
  }
  const visited = [...pages]
    .filter(([url, p]) => matches(url, p.title))
    .sort(([a, x], [b, y]) => leads(a) - leads(b) || y.count - x.count || y.time - x.time)
    .map(([url, p]): Suggestion => ({ kind: "history", url, title: p.title || url }));

  const seen = new Set([enter.url]);
  const rest = [...marked, ...visited].filter((s) => !seen.has(s.url) && seen.add(s.url));
  return [enter, ...rest.slice(0, MATCHES)];
}
