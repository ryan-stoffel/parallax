import type {
  DidFailLoadEvent,
  FoundInPageEvent,
  PageTitleUpdatedEvent,
  WebviewTag,
} from "electron";
import { t } from "i18next";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { BrowserAction } from "../preload/bridge";
import type { PreviewTab } from "../protocol/generated/protocol";
import { AgentBrowser, type Driver } from "./AgentBrowser";
import {
  bookmarks,
  BookmarksBar,
  BookmarkStar,
  bookmarksBar,
  findBookmark,
  toggled,
} from "./Bookmarks";
import { ProfileButton } from "./BrowserProfile";
import {
  browserSettingsAsked,
  homeButton,
  restoreTabs,
  searchEngine,
  searchEngineName,
  searchUrlFor,
} from "./browserSettings";
import { browserTheme, browserThemes, colorsOf, useDark, type BrowserColors } from "./browserTheme";
import { suggestionsFor } from "./addressSuggestions";
import { browserHistory, titled as titled_, visited } from "./browserHistory";
import { DownloadsButton } from "./Downloads";
import { HistoryDialog } from "./HistoryDialog";
import { Extensions } from "./Extensions";
import { fitSize, MONITOR, PageFrame, type Fit, type Size } from "./PageFrame";
import { backendLogo } from "./Sidebar";
import { instanceName } from "./providers";
import { askSiteIcon, siteIcons, siteOf } from "./siteIcons";
import { stored } from "./stored";
import {
  Add,
  ArrowBack,
  ArrowDown,
  ArrowForward,
  ArrowUp,
  Bookmark,
  Close,
  Code,
  DeleteHistory,
  DesktopWindows,
  Extension,
  History,
  Home,
  MoreVert,
  Palette,
  Print,
  Public,
  Refresh,
  Remove,
  Search,
  Settings,
  Star,
  StarFilled,
  Tab as TabIcon,
  ZoomIn,
} from "./symbols";
import { IconButton, Menu, shortcut, toolbarMenuDivider, ToolbarMenuRow } from "./ui";

/** The search engine's results page for `query` (Settings › Browser), Google's by default. */
export const searchUrl = (query: string) => searchUrlFor(searchEngine.get(), query);

/**
 * The page the address bar's text opens, or undefined for nothing or a scheme other than http or
 * https. A host without a scheme is https, except localhost, an IP address, or a host with a port,
 * which are http. Anything else, such as words or a single word, searches the search engine.
 */
export function browserUrl(address: string): string | undefined {
  const text = address.trim();
  if (!text) return undefined;
  // A scheme is letters then a colon, which a port's digits don't follow.
  if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)) {
    const url = URL.parse(text);
    if (url?.protocol === "http:" || url?.protocol === "https:") return url.href;
    // Words after a colon, such as a pasted `error: cannot borrow`, are a search.
    return /\s/.test(text) ? searchUrl(text) : undefined;
  }
  if (/\s/.test(text)) return searchUrl(text);
  const url = URL.parse(`http://${text}`);
  if (!url) return searchUrl(text);
  const host = url.hostname;
  const local =
    host === "localhost" ||
    // Four dotted numbers in the text itself, since the parser reads `1.5` as 1.0.0.5.
    /^\d{1,3}(\.\d{1,3}){3}(?![\d.])/.test(text) ||
    host.startsWith("[") ||
    url.port !== "";
  if (local) return url.href;
  // A domain ends in a letters-only top-level name, as in example.com.
  if (/\.[a-z]{2,}$/i.test(host)) return url.href.replace(/^http:/, "https:");
  return searchUrl(text);
}

/**
 * The address bar's box: a short rounded field, ringed in the accent while focused. An agent's tab
 * puts its driver's logo before the text. Its input takes `addressInput`.
 */
export const addressBox =
  "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-[var(--browser-omnibox,var(--selected))] px-2.5 text-body focus-within:border-ring focus-within:bg-background [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
export const addressInput =
  "h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground";

/** Whether a key press holds the OS's Mod key: Cmd on macOS, Ctrl elsewhere, and not the other. */
const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) =>
  window.parallax.platform === "darwin" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

/** A url as the address bar shows it while unfocused: without its scheme or a lone trailing slash. */
export const shortUrl = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/^([^/?#]*)\/$/, "$1");

// Chrome's page zoom levels.
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The zoom after `factor`, one of Chrome's levels in `direction`, staying at either end. */
export function nextZoom(factor: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOMS.find((z) => z > factor + 0.001)
      : ZOOMS.findLast((z) => z < factor - 0.001);
  return next ?? factor;
}

/**
 * How the user's own pages fit: the room they have, as in any browser, until they pick Desktop.
 * The agent's tabs keep `browserFit`, whose default is a monitor (PageFrame.tsx).
 */
export const pageFit = stored<Fit>("parallax.pageFit", "panel", (raw, f) =>
  raw === "monitor" || raw === "panel" ? raw : f,
);

// Each tab's handler for what its page asks (main.ts), by its webview's webContents id, behind one
// listener however many tabs there are.
const asks = new Map<number, (action: BrowserAction) => void>();
let listening = false;
function onAsk(id: number, handler: (action: BrowserAction) => void) {
  if (!listening) {
    listening = true;
    window.parallax.onBrowser((from, action) => asks.get(from)?.(action));
  }
  asks.set(id, handler);
  return () => {
    if (asks.get(id) === handler) asks.delete(id);
  };
}

/**
 * One of the user's browser tabs, which the side panel keeps and shows in its tabs. `load` is a page
 * for it to open. A tab `restored` from before a restart has its saved `url` and no webview until
 * it's first shown.
 */
export interface OwnTab {
  id: number;
  load?: { url: string };
  restored?: boolean;
  // Opened by the user, by a shortcut, a link, or a bookmark, so its page takes focus once it
  // loads; an agent's preview doesn't take it from the composer.
  focus?: boolean;
  // A new one takes focus to its page: the user asked to show it, by a click or a shortcut.
  focusAsked?: object;
  url?: string;
  title?: string;
  icon?: string;
}

let lastTab = 0;
export const ownTab = (url?: string): OwnTab => ({ id: ++lastTab, ...(url && { load: { url } }) });

/** A browser's own tabs as saved for after a restart (PLX-964): each page, and the one in front. */
export interface SavedTabs {
  tabs: { url: string; title?: string; icon?: string }[];
  current: number;
}

// The most chats' browsers whose tabs are kept, so deleted threads' don't pile up.
const SAVED_SCOPES = 100;
// The longest icon kept, in characters of its data URL.
const SAVED_ICON = 16_384;

/**
 * `tabs` as saved: those with a page, and a small icon. A page's icon arrives as a data URL of up
 * to 256 KB (main.ts), and a favicon is a few KB, so a larger one isn't kept. Undefined when none
 * has a page.
 */
export function savedOf(tabs: readonly OwnTab[], current?: number): SavedTabs | undefined {
  const kept = tabs.filter((t) => t.url);
  if (!kept.length) return undefined;
  return {
    tabs: kept.map((t) => ({
      url: t.url!,
      ...(t.title && { title: t.title }),
      ...(t.icon && t.icon.length <= SAVED_ICON && { icon: t.icon }),
    })),
    current: Math.max(
      0,
      kept.findIndex((t) => t.id === current),
    ),
  };
}

/**
 * Every browser's saved tabs with `scope`'s set to `entry`, newest last: at most `SAVED_SCOPES`
 * chats'.
 */
export function withSaved(
  all: Readonly<Record<string, SavedTabs>>,
  scope: string,
  entry: SavedTabs | undefined,
): Record<string, SavedTabs> {
  const { [scope]: _old, ...rest } = all;
  const next = entry ? { ...rest, [scope]: entry } : rest;
  return Object.fromEntries(
    Object.keys(next)
      .slice(-SAVED_SCOPES)
      .map((key) => [key, next[key]!] as const),
  );
}

const savedTabs = stored<Record<string, SavedTabs>>("parallax.browserTabs", {}, (raw, fallback) =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, SavedTabs>)
    : fallback,
);

/** The tabs `scope`'s panel opens with, which may be none, and the one in front. */
export function restored(scope: string): { tabs: OwnTab[]; current?: number } {
  // Unless the user would rather start without them (Settings › Browser › On startup). They stay
  // saved until this scope's tabs next change.
  const saved = restoreTabs.get() ? savedTabs.get()[scope] : undefined;
  const pages = Array.isArray(saved?.tabs)
    ? saved.tabs.filter((t) => typeof t?.url === "string")
    : [];
  const tabs = pages.map((t) => ({ ...ownTab(), restored: true, ...t }));
  return { tabs, current: (tabs[saved?.current ?? 0] ?? tabs[0])?.id };
}

/** The open thread's agent browser tabs (PLX-639), its backend, and how the user closes one. */
export interface AgentTabs {
  hostId: string;
  runId: string;
  tabs: PreviewTab[];
  backend?: string;
  close: (tabId: string) => void;
}

/**
 * A panel scope's browser pages, in the side panel (PLX-888): a webview per own tab, which main keeps
 * in its own session with no preload or Node (main.ts), and the agent's tab in front. The panel
 * (SidePanel.tsx) owns the tabs and draws them in its top bar; `onChange` reports what a page learns
 * and `onAsk` what it asks of the tab list. `frontPage` or `agentTab` is the tab in front, if one is.
 * The first time a restored tab is in front while `visible`, it opens its page. Its own tabs are
 * saved under `scope`, with `lastPage` as the one in front, and come back after a restart (PLX-964).
 * `remoteHost`, the open host's name when it's an SSH host, notes that localhost is this computer
 * (PLX-1013).
 */
export function Browser({
  scope,
  pages,
  frontPage,
  lastPage,
  agentTab,
  visible,
  remoteHost,
  agent,
  onChange,
  onAsk,
}: {
  scope: string;
  pages: readonly OwnTab[];
  frontPage?: number;
  lastPage?: number;
  agentTab?: string;
  visible: boolean;
  remoteHost?: string;
  agent?: AgentTabs;
  onChange: (id: number, patch: Partial<OwnTab>) => void;
  /** `from` is the tab asking, or undefined for an agent's tab in front. */
  onAsk: (from: number | undefined, action: BrowserAction) => void;
}) {
  const driver = driverOf(agent?.backend);
  const shownTab = agent?.tabs.find((t) => t.tabId === agentTab);
  // History (PLX-976), one for the browser, which any of its tabs opens.
  const history = useRef<HTMLDialogElement>(null);

  // A restored tab opens its page the first time it's shown.
  const shownOwn = pages.find((t) => t.id === frontPage);
  useEffect(() => {
    if (visible && shownOwn?.restored && shownOwn.url)
      onChange(shownOwn.id, { restored: false, load: { url: shownOwn.url } });
  }, [visible, shownOwn]);

  // Each change to the tabs' pages, or to the one in front, is saved for after a restart.
  const saved = savedOf(pages, lastPage);
  const savedJson = JSON.stringify(saved);
  useEffect(() => {
    if (JSON.stringify(savedTabs.get()[scope]) === savedJson) return;
    savedTabs.set(withSaved(savedTabs.get(), scope, saved));
  }, [scope, savedJson]);

  return (
    // Cmd/Ctrl+Shift+T and History anywhere in the browser's own UI too, such as a blank tab's
    // address bar, which the page's shortcuts don't reach (links.ts).
    <div
      onKeyDown={(e) => {
        const key = e.key.toLowerCase();
        const mac = window.parallax.platform === "darwin";
        if (!modKey(e) || e.altKey) return;
        if (e.shiftKey && key === "t") onAsk(frontPage, { kind: "reopenTab" });
        else if (!e.shiftKey && key === (mac ? "y" : "h")) history.current?.showModal();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <HistoryDialog
        ref={history}
        onOpen={(url, inNewTab) => {
          if (inNewTab || !shownOwn) onAsk(frontPage, { kind: "open", url });
          else onChange(shownOwn.id, { load: { url } });
        }}
      />
      {shownTab && agent && (
        <AgentBrowser
          key={shownTab.tabId}
          hostId={agent.hostId}
          runId={agent.runId}
          tab={shownTab}
          driver={driver}
        />
      )}
      {/* Every own tab stays mounted, so its page keeps its state behind the others. */}
      {pages.map((t) => (
        <Tab
          key={t.id}
          shown={t.id === frontPage}
          page={t.url ? { url: t.url, title: t.title, icon: t.icon } : undefined}
          load={t.load}
          focusOnLoad={!!t.focus}
          focusAsked={t.focusAsked}
          remoteHost={remoteHost}
          onChange={(patch) => onChange(t.id, patch)}
          onAsk={(action) =>
            action.kind === "history" ? history.current?.showModal() : onAsk(t.id, action)
          }
        />
      ))}
    </div>
  );
}

// The CLIs' own names, which a provider instance's name stands in for otherwise.
const backendNames: Partial<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

/** The agent driving a thread's tabs, by its backend: its name and provider's logo. */
const driverOf = (backend?: string): Driver =>
  backend
    ? {
        name: backendNames[backend] ?? instanceName(backend) ?? t("The agent"),
        Logo: backendLogo(backend),
      }
    : { name: t("The agent") };

/** A browser tab as the side panel's top bar draws it. */
export interface BrowserTabFace {
  title: string;
  url?: string;
  icon?: string;
}

/** One of the user's tabs as the panel draws it. */
export const pageFace = (tab: OwnTab): BrowserTabFace => ({
  title: tab.title || (tab.url ? shortUrl(tab.url) : t("New Tab")),
  ...(tab.url && { url: tab.url }),
  ...(tab.icon && { icon: tab.icon }),
});

/**
 * How the panel draws an agent's tabs, which show their sites' favicons, which plxd doesn't report.
 * An SSH host's localhost isn't this computer's, which main fetches from, so it gets none.
 */
export function useAgentFace(agent: AgentTabs | undefined, remoteHost: string | undefined) {
  const icons = siteIcons.use();
  const iconSite = (url: string) =>
    remoteHost && /^(localhost|127\.|\[::1\])/.test(URL.parse(url)?.hostname ?? "")
      ? ""
      : siteOf(url);
  const urls = (agent?.tabs ?? []).map((t) => t.url).join(" ");
  useEffect(() => {
    for (const url of urls.split(" ")) askSiteIcon(iconSite(url));
  }, [urls]);
  const name = driverOf(agent?.backend).name;
  return (tab: PreviewTab): BrowserTabFace => ({
    title: tab.title || shortUrl(tab.url) || t("Agent's tab"),
    url: `${name}: ${tab.url}`,
    ...(icons[iconSite(tab.url)] && { icon: icons[iconSite(tab.url)] }),
  });
}

/**
 * One of the user's own tabs: back, forward, reload or stop, a loading bar, and an address bar
 * that opens a page or searches Google, over its webview. Each new `load` opens its url, even the
 * one already shown. It reports its page's url, title, and favicon, and passes on what its page
 * asks of the tab list, such as opening a tab.
 */
function Tab({
  shown,
  focusOnLoad,
  focusAsked,
  page,
  load,
  remoteHost,
  onChange,
  onAsk: ask,
}: {
  shown: boolean;
  focusOnLoad?: boolean;
  focusAsked?: object;
  /** The page it shows, for its bookmark star (Bookmarks.tsx). */
  page?: { url: string; title?: string; icon?: string };
  load?: { url: string };
  remoteHost?: string;
  onChange: (patch: Partial<OwnTab>) => void;
  onAsk: (action: BrowserAction) => void;
}) {
  const view = useRef<WebviewTag>(null);
  const addressBar = useRef<HTMLInputElement>(null);
  // The url the tab last showed, so a reload keeps its title.
  const shownUrl = useRef(page?.url);
  // The first page, which mounts the webview; later pages load in it. A new tab has none, so it's
  // blank until the user opens a page.
  const [src, setSrc] = useState<string>();
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState({ back: false, forward: false });
  const [error, setError] = useState<{ url: string; description: string }>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  // The webview's webContents id, which extensions know the tab by, once it attaches.
  const [contentsId, setContentsId] = useState<number>();
  // The page's size: the one the user set, or the panel's fit (PageFrame.tsx).
  const [fixed, setFixed] = useState<Size>();
  const [area, setArea] = useState<Size>(MONITOR);
  const fit = pageFit.use();
  const engine = searchEngine.use();
  const homePage = homeButton.use();
  // The address bar's suggestions while the user types in it (PLX-978), and the one picked.
  const [typed, setTyped] = useState(false);
  const [picked, setPicked] = useState(0);
  const suggestionsId = useId();
  const typedUrl = typed ? browserUrl(address) : undefined;
  const suggestions =
    typed && typedUrl
      ? suggestionsFor(
          address,
          typedUrl === searchUrl(address.trim())
            ? {
                kind: "search",
                url: typedUrl,
                title: t("{{query}} — Search {{engine}}", {
                  query: address.trim(),
                  engine: searchEngineName(engine),
                }),
              }
            : { kind: "go", url: typedUrl, title: shortUrl(typedUrl) },
          // Read, not subscribed to: typing renders the tab anyway, and every tab subscribing
          // would redraw them all on each visit any browser makes.
          bookmarks.get(),
          browserHistory.get(),
        )
      : [];
  const showBookmarks = bookmarksBar.use();
  const pageSize = fixed ?? fitSize(area.width, area.height, fit);
  const refit = (next: Fit) => {
    pageFit.set(next);
    setFixed(undefined);
  };
  // Find in page (PLX-969): whether the bar is open, its text, and the match in front of how many.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ active: number; total: number }>();
  const findBar = useRef<HTMLInputElement>(null);
  const find = (text: string, step?: 1 | -1) => {
    const el = view.current;
    if (!el || !src) return;
    if (!text) {
      el.stopFindInPage("clearSelection");
      setMatches(undefined);
    } else el.findInPage(text, { forward: step !== -1, findNext: step === undefined });
  };
  const openFind = () => {
    setFinding(true);
    requestAnimationFrame(() => findBar.current?.select());
  };
  const closeFind = () => {
    setFinding(false);
    setMatches(undefined);
    view.current?.stopFindInPage("keepSelection");
  };
  // The page's zoom, one of Chrome's levels, which Chromium keeps for the page's site.
  const [zoom, setZoom] = useState(1);
  const zoomTo = (factor: number) => {
    view.current?.setZoomFactor(factor);
    setZoom(factor);
  };
  // What the tab does itself of what its page asks: find, zoom, and the bookmark star's Cmd/Ctrl+D.
  const local = (action: BrowserAction) => {
    if (action.kind === "find") openFind();
    else if (action.kind === "findNext" || action.kind === "findPrevious") {
      if (!finding) openFind();
      find(query, action.kind === "findNext" ? 1 : -1);
    } else if (action.kind === "zoomIn") zoomTo(nextZoom(zoom, 1));
    else if (action.kind === "zoomOut") zoomTo(nextZoom(zoom, -1));
    else if (action.kind === "resetZoom") zoomTo(1);
    else if (action.kind === "bookmark") {
      if (page) bookmarks.set(toggled(bookmarks.get(), page));
    } else return false;
    return true;
  };
  // The latest callbacks, for the webview's listeners, which mount once per page.
  const latest = useRef({ onChange, ask, local, shown, focusOnLoad });
  latest.current = { onChange, ask, local, shown, focusOnLoad };
  // Whether the page has taken the focus it's due on load: its first, and again after each page
  // the user opens from the toolbar (`open`), as in Chrome.
  const focused = useRef(false);

  // A tab the user asks to show takes focus to its page, as in Chrome, so the page's shortcuts keep
  // working from it. A blank tab's address bar takes it instead. A tab that comes to the front
  // otherwise, such as on going back to a thread, leaves focus where it is.
  useEffect(() => {
    if (!focusAsked) return;
    if (src) requestAnimationFrame(() => view.current?.focus());
    else if (!page && !load) requestAnimationFrame(() => addressBar.current?.focus());
  }, [focusAsked]);

  // Extensions see the shown tab as the active one.
  useEffect(() => {
    if (shown && contentsId !== undefined) window.parallax.selectBrowserTab(contentsId);
  }, [shown, contentsId]);

  const open = (text: string) => {
    // An extension's own pages, such as its options, open as they are.
    const next = text.startsWith("chrome-extension://") ? text : browserUrl(text);
    if (!next) {
      if (text.trim())
        setError({ url: text, description: t("Only http and https pages open here.") });
      return;
    }
    setError(undefined);
    focused.current = false;
    setAddress(next);
    onChange({ url: next });
    // The view shows a load's error, so the rejection needs no handling here. A webview that
    // hasn't finished attaching throws instead, and would still load
    // its first page: a new webview opens this one (its key is its src).
    try {
      if (!view.current) throw new Error("no webview yet");
      view.current.loadURL(next).catch(() => {});
    } catch {
      setSrc(next);
    }
  };

  useEffect(() => {
    if (load) open(load.url);
  }, [load]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    let stopAsking = () => {};
    // The page's webContents exists once the webview attaches, so its asks find this tab from
    // then on, before its first page is ready.
    const ready = () => {
      stopAsking();
      setContentsId(el.getWebContentsId());
      stopAsking = onAsk(el.getWebContentsId(), (action) => {
        if (action.kind === "address") addressBar.current?.focus();
        else if (action.kind === "icon") latest.current.onChange({ icon: action.url });
        else if (!latest.current.local(action)) latest.current.ask(action);
      });
    };
    const navigated = (inPage = false) => {
      const url = el.getURL();
      setHistory({ back: el.canGoBack(), forward: el.canGoForward() });
      setZoom(el.getZoomFactor());
      // Another page has no title until it says, rather than the last page's (PLX-981). A reload
      // keeps its own, which it doesn't say again.
      const moved = url !== shownUrl.current;
      shownUrl.current = url;
      setAddress(url);
      latest.current.onChange(moved && !inPage ? { url, title: undefined } : { url });
      // Each web page visited goes in History, not an extension's own pages.
      if (/^https?:/.test(url)) browserHistory.set(visited(browserHistory.get(), url, Date.now()));
    };
    const found = (e: FoundInPageEvent) =>
      setMatches({ active: e.result.activeMatchOrdinal ?? 0, total: e.result.matches ?? 0 });
    const started = () => {
      setError(undefined);
      setLoading(true);
    };
    const stopped = () => setLoading(false);
    // -3 is a load another one replaced.
    const failed = (e: DidFailLoadEvent) => {
      if (e.isMainFrame && e.errorCode !== -3)
        setError({ url: e.validatedURL, description: e.errorDescription });
    };
    const titled = (e: PageTitleUpdatedEvent) => {
      latest.current.onChange({ title: e.title });
      const next = titled_(browserHistory.get(), el.getURL(), e.title);
      if (next !== browserHistory.get()) browserHistory.set([...next]);
    };
    // A new page has no icon until it says, rather than the last page's.
    const leaving = () => latest.current.onChange({ icon: undefined });
    const starting = (e: { isMainFrame: boolean; isInPlace: boolean }) => {
      if (e.isMainFrame && !e.isInPlace) leaving();
    };
    // The webview may attach before this runs, so it tries now, then on attaching and on its
    // first page, whichever comes first; `ready` is the same each time.
    try {
      ready();
    } catch {
      // Not attached yet: getWebContentsId throws until it is.
    }
    el.addEventListener("did-attach", ready);
    el.addEventListener("dom-ready", ready);
    const firstLoad = () => {
      // Once per page the tab opens, shown or not, so the page's own later loads don't take it.
      if (focused.current) return;
      focused.current = true;
      if (latest.current.focusOnLoad && latest.current.shown) el.focus();
    };
    el.addEventListener("dom-ready", firstLoad);
    const navigatedTo = () => navigated();
    el.addEventListener("did-navigate", navigatedTo);
    // An iframe's own in-page step isn't the page's, nor a visit.
    const navigatedInPage = (e: { isMainFrame: boolean }) => e.isMainFrame && navigated(true);
    el.addEventListener("did-navigate-in-page", navigatedInPage);
    el.addEventListener("did-start-navigation", starting);
    el.addEventListener("did-start-loading", started);
    el.addEventListener("did-fail-load", failed);
    el.addEventListener("did-stop-loading", stopped);
    el.addEventListener("page-title-updated", titled);
    el.addEventListener("found-in-page", found);
    return () => {
      stopAsking();
      el.removeEventListener("did-attach", ready);
      el.removeEventListener("dom-ready", ready);
      el.removeEventListener("dom-ready", firstLoad);
      el.removeEventListener("did-navigate", navigatedTo);
      el.removeEventListener("did-navigate-in-page", navigatedInPage);
      el.removeEventListener("did-start-navigation", starting);
      el.removeEventListener("did-start-loading", started);
      el.removeEventListener("did-fail-load", failed);
      el.removeEventListener("did-stop-loading", stopped);
      el.removeEventListener("page-title-updated", titled);
      el.removeEventListener("found-in-page", found);
    };
  }, [src]);

  const navBar = (
    <>
      <IconButton label={t("Back")} disabled={!history.back} onClick={() => view.current?.goBack()}>
        <ArrowBack />
      </IconButton>
      <IconButton
        label={t("Forward")}
        disabled={!history.forward}
        onClick={() => view.current?.goForward()}
      >
        <ArrowForward />
      </IconButton>
      {loading ? (
        <IconButton label={t("Stop")} onClick={() => view.current?.stop()}>
          <Close />
        </IconButton>
      ) : (
        <IconButton label={t("Reload")} disabled={!src} onClick={() => view.current?.reload()}>
          <Refresh />
        </IconButton>
      )}
      {/* The home page, or a new tab without one (Settings › Browser › Home button). */}
      {homePage.show && (
        <IconButton
          label={t("Home")}
          onClick={() => (homePage.url.trim() ? open(homePage.url) : ask({ kind: "newTab" }))}
        >
          <Home />
        </IconButton>
      )}
      {/* The address bar alone is the form, so Enter opens it whatever else the toolbar holds:
            a form with two text fields and no submit button doesn't submit on Enter. */}
      <form
        className={`relative mx-1 ${addressBox}`}
        onSubmit={(e) => {
          e.preventDefault();
          open(suggestions[picked]?.url ?? address);
          setTyped(false);
          addressBar.current?.blur();
        }}
      >
        <input
          ref={addressBar}
          // A new tab's address bar takes focus, as in Chrome, but not a tab shown again or one
          // opening a page, whose page takes it.
          autoFocus={!page && !load}
          aria-label={t("Address")}
          placeholder={t("Search {{engine}} or type a URL", { engine: searchEngineName(engine) })}
          spellCheck={false}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestionsId}
          aria-activedescendant={suggestions.length ? `${suggestionsId}-${picked}` : undefined}
          value={editing ? address : shortUrl(address)}
          onChange={(e) => {
            setAddress(e.target.value);
            setTyped(true);
            setPicked(0);
          }}
          onKeyDown={(e) => {
            // Keys an input method is composing with are its own.
            if (!suggestions.length || e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setPicked((picked + step + suggestions.length) % suggestions.length);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTyped(false);
            }
          }}
          onFocus={(e) => {
            setEditing(true);
            // The full url replaces the short one first, so select it once it renders.
            const input = e.target;
            requestAnimationFrame(() => input.select());
          }}
          onBlur={() => {
            setEditing(false);
            setTyped(false);
          }}
          className={addressInput}
        />
        {/* Chrome's suggestions as the address is typed (addressSuggestions.ts). */}
        {suggestions.length > 0 && (
          <ul
            id={suggestionsId}
            role="listbox"
            aria-label={t("Suggestions")}
            className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg border border-border bg-surface p-1 shadow-composer"
          >
            {suggestions.map((s, i) => {
              const Icon = { go: Public, search: Search, bookmark: StarFilled, history: History }[
                s.kind
              ];
              return (
                <li
                  key={`${s.kind}:${s.url}`}
                  id={`${suggestionsId}-${i}`}
                  role="option"
                  aria-selected={i === picked}
                  // Before the address bar loses focus, which would close the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    // A left click only, not a right click for a menu.
                    if (e.button !== 0) return;
                    open(s.url);
                    setTyped(false);
                    addressBar.current?.blur();
                  }}
                  onMouseEnter={() => setPicked(i)}
                  className={`flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-body ${i === picked ? "bg-hover" : ""}`}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{s.title}</span>
                  {s.kind !== "search" && s.kind !== "go" && (
                    <span className="shrink-0 truncate text-meta text-faint-foreground">
                      {shortUrl(s.url)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {Math.abs(zoom - 1) > 0.001 && (
          <button
            type="button"
            title={t("Reset zoom")}
            onClick={() => zoomTo(1)}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground tabular-nums hover:bg-hover hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
        <BookmarkStar page={page} />
      </form>
    </>
  );
  // The More menu (PLX-981), and what its items do: each closes it, but zoom's, as in Chrome.
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const pick = (action: () => void) => () => {
    menu.current?.hidePopover();
    action();
  };
  const settingsAt = (title?: string) =>
    pick(() => browserSettingsAsked.set(title ? { title } : {}));
  const tree = bookmarks.use();
  const bookmarked = !!page && !!findBookmark(tree, page.url);
  const desktop = fit === "monitor" && !fixed;
  const toolsBar = (
    <>
      <DownloadsButton />
      <Extensions tab={contentsId} onOpen={(url) => ask({ kind: "open", url })} />
      <ProfileButton onOpen={(url) => ask({ kind: "open", url })} />
      <IconButton label={t("More")} popoverTarget={menuId} aria-haspopup="menu">
        <MoreVert />
      </IconButton>
      <Menu ref={menu} id={menuId} label={t("More")} align="end" className="w-72 p-1.5">
        <ToolbarMenuRow
          icon={<TabIcon aria-hidden />}
          label={t("New tab")}
          keys={shortcut("T")}
          onClick={pick(() => ask({ kind: "newTab" }))}
        />
        <hr className={toolbarMenuDivider} />
        <ToolbarMenuRow
          icon={<History aria-hidden />}
          label={t("History")}
          keys={window.parallax.platform === "darwin" ? shortcut("Y") : "Ctrl+H"}
          onClick={pick(() => ask({ kind: "history" }))}
        />
        <ToolbarMenuRow
          icon={bookmarked ? <StarFilled aria-hidden /> : <Star aria-hidden />}
          label={bookmarked ? t("Remove bookmark") : t("Bookmark this tab")}
          keys={shortcut("D")}
          disabled={!page}
          onClick={pick(() => local({ kind: "bookmark" }))}
        />
        <ToolbarMenuRow
          icon={<Bookmark aria-hidden />}
          label={t("Show bookmarks bar")}
          checked={showBookmarks}
          onClick={pick(() => bookmarksBar.set(!showBookmarks))}
        />
        <hr className={toolbarMenuDivider} />
        <ToolbarMenuRow
          icon={<Extension aria-hidden />}
          label={t("Extensions")}
          onClick={settingsAt("Extensions")}
        />
        <ToolbarMenuRow
          icon={<DeleteHistory aria-hidden />}
          label={t("Delete browsing data…")}
          onClick={settingsAt("Clear browsing data")}
        />
        <hr className={toolbarMenuDivider} />
        <div
          role="group"
          aria-label={t("Zoom")}
          className="flex h-9 items-center gap-3 pr-1 pl-2.5"
        >
          <ZoomIn aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-body">{t("Zoom")}</span>
          <span className="flex items-center rounded-lg bg-selected">
            {(
              [
                [t("Zoom out"), -1, Remove],
                [t("Zoom in"), 1, Add],
              ] as const
            ).map(([label, direction, Icon], i) => (
              <span key={label} className="contents">
                {i === 1 && (
                  <span className="w-11 text-center text-body tabular-nums">
                    {Math.round(zoom * 100)}%
                  </span>
                )}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={label}
                  title={label}
                  disabled={!src}
                  onClick={() => zoomTo(nextZoom(zoom, direction))}
                  className="grid size-7 place-items-center rounded-lg text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-40 [&_svg]:size-4"
                >
                  <Icon aria-hidden />
                </button>
              </span>
            ))}
          </span>
        </div>
        <hr className={toolbarMenuDivider} />
        <ToolbarMenuRow
          icon={<Search aria-hidden />}
          label={t("Find…")}
          keys={shortcut("F")}
          disabled={!src}
          onClick={pick(openFind)}
        />
        <ToolbarMenuRow
          icon={<Print aria-hidden />}
          label={t("Print…")}
          keys={shortcut("P")}
          disabled={!src}
          onClick={pick(() => void view.current?.print().catch(() => {}))}
        />
        {/* The page laid out as on a monitor, scaled to fit, rather than at the room it has. */}
        <ToolbarMenuRow
          icon={<DesktopWindows aria-hidden />}
          label={t("Desktop site")}
          checked={desktop}
          onClick={pick(() => refit(desktop ? "panel" : "monitor"))}
        />
        <ToolbarMenuRow
          icon={<Code aria-hidden />}
          label={t("Developer tools")}
          disabled={!src}
          onClick={pick(() => view.current?.openDevTools())}
        />
        <hr className={toolbarMenuDivider} />
        <ToolbarMenuRow
          icon={<Palette aria-hidden />}
          label={t("Customize")}
          onClick={settingsAt("Theme")}
        />
        <ToolbarMenuRow
          icon={<Settings aria-hidden />}
          label={t("Settings")}
          onClick={settingsAt()}
        />
      </Menu>
    </>
  );

  return (
    // Chrome's find, bookmark, and print keys in the tab's own UI too, its address bar and find bar
    // rather than the app's Find in thread.
    <div
      onKeyDown={(e) => {
        if (!modKey(e) || e.altKey) return;
        const key = e.key.toLowerCase();
        const action: BrowserAction | undefined =
          key === "f" && !e.shiftKey
            ? { kind: "find" }
            : key === "g"
              ? { kind: e.shiftKey ? "findPrevious" : "findNext" }
              : key === "d" && !e.shiftKey
                ? { kind: "bookmark" }
                : undefined;
        if (key === "p" && !e.shiftKey && src) void view.current?.print().catch(() => {});
        else if (!action || !local(action)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      // The theme's toolbar color around the page (browserTheme.ts).
      className={`min-h-0 flex-1 flex-col bg-[var(--browser-toolbar,transparent)] ${shown ? "flex" : "hidden"}`}
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-1">
        {navBar}
        {toolsBar}
      </div>
      <BookmarksBar onOpen={(url, newTab) => (newTab ? ask({ kind: "open", url }) : open(url))} />
      {remoteHost && (
        <p className="border-b border-border px-3 py-1.5 text-meta text-muted-foreground">
          {t(
            "Pages load on this computer, so localhost isn't {{host}}. Forwarding its ports isn't built yet.",
            { host: remoteHost },
          )}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {finding && (
          <form
            role="search"
            aria-label={t("Find in page")}
            onSubmit={(e) => e.preventDefault()}
            className="absolute top-1 right-3 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-surface py-1 pr-1 pl-2.5 text-body shadow-composer"
          >
            <input
              ref={findBar}
              autoFocus
              aria-label={t("Find")}
              placeholder={t("Find in page")}
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                find(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(query, e.shiftKey ? -1 : 1);
                else if (e.key === "Escape") closeFind();
              }}
              className="w-44 bg-transparent outline-none placeholder:text-faint-foreground"
            />
            <span className="w-14 text-right text-meta text-muted-foreground tabular-nums">
              {query && matches
                ? t("{{active}} of {{total}}", { active: matches.active, total: matches.total })
                : ""}
            </span>
            <IconButton label={t("Previous match")} onClick={() => find(query, -1)}>
              <ArrowUp />
            </IconButton>
            <IconButton label={t("Next match")} onClick={() => find(query, 1)}>
              <ArrowDown />
            </IconButton>
            <IconButton label={t("Close find")} onClick={closeFind}>
              <Close />
            </IconButton>
          </form>
        )}
        <PageFrame
          size={pageSize}
          fixed={!!fixed}
          fit={fit}
          onResize={setFixed}
          onFit={refit}
          // A hidden tab keeps the room it had, so its page doesn't lay out again.
          onArea={(room) => room.width > 0 && room.height > 0 && setArea(room)}
        >
          {(scale) => (
            <>
              {loading && (
                <div
                  role="progressbar"
                  aria-label={t("Loading")}
                  className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-ring"
                />
              )}
              {src && (
                // React drops a `true` attribute it doesn't know, so allowpopups is the empty
                // string. The page lays out at the frame's size, drawn at its scale.
                <webview
                  key={src}
                  ref={view}
                  src={src}
                  {...{ allowpopups: "" as unknown as boolean }}
                  style={{
                    width: pageSize.width,
                    height: pageSize.height,
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                  }}
                  className="flex"
                />
              )}
            </>
          )}
        </PageFrame>
        {error && (
          <div className="solid absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background px-8 pb-16 text-center">
            <TriangleAlert aria-hidden className="mb-1 size-5 text-faint-foreground" />
            <p role="alert" className="text-body font-medium text-foreground">
              {t("Can't open {{url}}", { url: error.url })}
            </p>
            <p className="text-body break-all text-muted-foreground">{error.description}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// The theme picker's groups: the app's own colors, Helium's, then Chrome's.
const themeGroups = [
  { name: "Parallax", ids: ["parallax"] },
  { name: "Helium", ids: ["helium"] },
  { name: "Chrome", ids: browserThemes.slice(2).map((t) => t.id) },
];

// Match Parallax previews the app's own tokens, which its browser paints in.
const appColors: BrowserColors = {
  frame: "var(--pane)",
  toolbar: "var(--background)",
  tab: "var(--selected)",
  omnibox: "var(--selected)",
  icon: "var(--muted-foreground)",
  text: "var(--foreground)",
  accent: "var(--accent)",
};

/**
 * The browser's themes (PLX-981), a named tile each, grouped by where they're from. Each tile is
 * a small browser in the theme's colors for the app's light or dark mode: its frame, the tab in
 * front, and the toolbar with its address bar. The picked one is ringed. Settings › Browser
 * shows it.
 */
export function ThemePicker() {
  const picked = browserTheme.use();
  const dark = useDark();
  return (
    <div
      role="radiogroup"
      aria-label={t("Theme")}
      className="flex flex-wrap gap-x-8 gap-y-4 px-4 pt-1 pb-4"
    >
      {/* Parallax and Helium side by side, Chrome's many on a row of their own. */}
      {themeGroups.map((group) => (
        <div key={group.name} className={group.ids.length > 1 ? "basis-full" : ""}>
          <p className="mb-2 text-meta text-muted-foreground">{group.name}</p>
          <div className="grid grid-cols-[repeat(auto-fill,7rem)] gap-3">
            {group.ids.map((id) => {
              const theme = browserThemes.find((t) => t.id === id)!;
              const c = colorsOf(id, dark) ?? appColors;
              const on = picked === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => browserTheme.set(id)}
                  className="group flex flex-col gap-1.5 rounded-lg text-left focus-visible:outline-none"
                >
                  <span
                    aria-hidden
                    style={{ background: c.frame }}
                    className={`flex h-14 w-full flex-col overflow-hidden rounded-lg border ${on ? "border-accent ring-2 ring-accent/40" : "border-border group-hover:border-faint-foreground"} group-focus-visible:ring-2 group-focus-visible:ring-ring`}
                  >
                    <span className="flex h-4 items-end gap-1 px-1.5">
                      <span style={{ background: c.tab }} className="h-3 w-7 rounded-t-sm" />
                      <span
                        style={{ background: c.icon }}
                        className="mb-1 h-1 w-4 rounded-full opacity-40"
                      />
                    </span>
                    <span
                      style={{ background: c.toolbar }}
                      className="flex flex-1 items-start gap-1 px-1.5 pt-1.5"
                    >
                      <span
                        style={{ background: c.omnibox }}
                        className="h-2.5 flex-1 rounded-full"
                      />
                      <span style={{ background: c.accent }} className="size-2.5 rounded-full" />
                    </span>
                  </span>
                  <span
                    className={`truncate text-meta ${on ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {t(theme.name)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
