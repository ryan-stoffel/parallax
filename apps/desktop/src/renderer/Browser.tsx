import type { DidFailLoadEvent, PageTitleUpdatedEvent, WebviewTag } from "electron";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code,
  Globe,
  Plus,
  RectangleHorizontal,
  RotateCw,
  Rows2,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { createPortal } from "react-dom";

import type { BrowserAction } from "../preload/bridge";
import type { PreviewTab } from "../protocol/generated/protocol";
import { AgentBrowser, type Driver } from "./AgentBrowser";
import { Extensions } from "./Extensions";
import { fitSize, MONITOR, PageFrame, ViewMenu, type Fit, type Size } from "./PageFrame";
import { backendLogos } from "./Sidebar";
import { instanceLogo, instanceName } from "./providers";
import { memory, stored } from "./stored";
import { IconButton, menuHeading, menuItem, MenuOption } from "./ui";

/** Google's results page for `query`. */
export const searchUrl = (query: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}`;

/**
 * The page the address bar's text opens, or undefined for nothing or a scheme other than http or
 * https. A host without a scheme is https, except localhost, an IP address, or a host with a port,
 * which are http. Anything else, such as words or a single word, searches Google.
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
 * The address bar's box, as Chrome and Helium draw it: a rounded field with an icon before the
 * text, ringed in the accent while focused. Its input takes `addressInput`.
 */
export const addressBox =
  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-selected px-2.5 text-[13px] focus-within:border-ring focus-within:bg-background [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
export const addressInput =
  "h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground";

/** A url as the address bar shows it while unfocused: without its scheme or a lone trailing slash. */
export const shortUrl = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/^([^/?#]*)\/$/, "$1");

/** How a browser lays out its bar, as Helium does (PLX-966): all in one row, or tabs over a toolbar. */
export type BrowserLayout = "compact" | "classic";
export const browserLayout = stored<BrowserLayout>("parallax.browserLayout", "compact", (raw, f) =>
  raw === "compact" || raw === "classic" ? raw : f,
);

/**
 * How the user's own pages fit: the room they have, as in any browser, until they pick Desktop.
 * The agent's tabs keep `browserFit`, whose default is a monitor (PageFrame.tsx).
 */
export const pageFit = stored<Fit>("parallax.pageFit", "panel", (raw, f) =>
  raw === "monitor" || raw === "panel" ? raw : f,
);

// The compact layout's slots in each browser's top bar, by scope: before its tabs, for back,
// forward, reload, and the address bar, and after them, for the extensions and More. The shown
// tab draws its toolbar into them.
const toolbarSlots = memory<Readonly<Record<string, { start?: HTMLElement; end?: HTMLElement }>>>(
  {},
);
function setSlot(scope: string, side: "start" | "end", el: HTMLElement | undefined) {
  const all = toolbarSlots.get();
  if (all[scope]?.[side] === el) return;
  toolbarSlots.set({ ...all, [scope]: { ...all[scope], [side]: el } });
}

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
 * One of the user's tabs, as the top bar shows it. `load` is a page for it to open. A tab
 * `restored` from before a restart has its saved `url` and no webview until it's first shown.
 */
interface OwnTab {
  id: number;
  load?: { url: string };
  restored?: boolean;
  url?: string;
  title?: string;
  icon?: string;
}

let lastTab = 0;
const ownTab = (url?: string): OwnTab => ({ id: ++lastTab, ...(url && { load: { url } }) });

/** A browser's own tabs as saved for after a restart (PLX-964): each page, and the one in front. */
export interface SavedTabs {
  tabs: { url: string; title?: string; icon?: string }[];
  current: number;
}

// The most chats' browsers whose tabs are kept, so deleted threads' don't pile up. The
// permanent browser's are always kept.
const SAVED_SCOPES = 100;
// The longest icon kept, in characters of its data URL.
const SAVED_ICON = 16_384;

/**
 * `tabs` as saved: those with a page, and a small icon. A page's icon arrives as a data URL of up
 * to 256 KB (main.ts), and a favicon is a few KB, so a larger one isn't kept. Undefined when none
 * has a page.
 */
export function savedOf(tabs: readonly OwnTab[], current: number): SavedTabs | undefined {
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
 * Every browser's saved tabs with `scope`'s set to `entry`, newest last: the permanent browser's,
 * and at most `SAVED_SCOPES` chats'.
 */
export function withSaved(
  all: Readonly<Record<string, SavedTabs>>,
  scope: string,
  entry: SavedTabs | undefined,
): Record<string, SavedTabs> {
  const { [scope]: _old, ...rest } = all;
  const next = entry ? { ...rest, [scope]: entry } : rest;
  const chats = Object.keys(next).filter((key) => key !== "permanent");
  const kept = [...(next["permanent"] ? ["permanent"] : []), ...chats.slice(-SAVED_SCOPES)];
  return Object.fromEntries(kept.map((key) => [key, next[key]!] as const));
}

const savedTabs = stored<Record<string, SavedTabs>>("parallax.browserTabs", {}, (raw, fallback) =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, SavedTabs>)
    : fallback,
);

/** The tabs `scope`'s browser opens with: its saved ones, or one blank tab. */
function restored(scope: string | undefined): { tabs: OwnTab[]; current: number } {
  const saved = scope ? savedTabs.get()[scope] : undefined;
  const pages = Array.isArray(saved?.tabs)
    ? saved.tabs.filter((t) => typeof t?.url === "string")
    : [];
  const tabs = pages.length
    ? pages.map((t) => ({ ...ownTab(), restored: true, ...t }))
    : [ownTab()];
  return { tabs, current: (tabs[saved?.current ?? 0] ?? tabs[0]!).id };
}

/**
 * A browser, laid out like Chrome (PLX-888): a chat's in the side panel, or the permanent one in
 * the main pane (PLX-964). Its tabs, the agent's (PLX-639) then the user's own, show in the top bar
 * over it (`browserTabs`, `BrowserTabBar`), so it has one row of tabs. Each own tab is a webview, which main keeps in its own session with no preload or Node (main.ts), and
 * whose new windows open as tabs here. Each new `page` opens in the current tab while it's blank,
 * or else in a new one. Its own tabs are saved under `scope` and come back after a restart
 * (PLX-964). `remoteHost`, the open host's name when it's an SSH host, notes that localhost is
 * this computer.
 */
export function Browser({
  page,
  remoteHost,
  scope,
  agent,
}: {
  page?: { url?: string; agentTab?: string };
  remoteHost?: string;
  /**
   * The side panel scope it shows in, or `permanent` for the sidebar's own browser, under which it
   * publishes its tabs (`browserTabs`) and saves them.
   */
  scope?: string;
  /** The open thread's agent tabs (PLX-639), which show before the user's own, and its backend. */
  agent?: { hostId: string; runId: string; tabs: PreviewTab[]; backend?: string };
}) {
  const driver = driverOf(agent?.backend);
  // The agent tab shown, by id, or undefined for the user's own tab `current`.
  const [agentTab, setAgentTab] = useState<string>();
  const shownTab = agent?.tabs.find((t) => t.tabId === agentTab);
  const [start] = useState(() => restored(scope));
  const [tabs, setTabs] = useState(start.tabs);
  const [current, setCurrent] = useState(start.current);

  const update = (id: number, patch: Partial<OwnTab>) =>
    setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  // A new tab after `after`, or at the end, which becomes the current one. An empty new tab
  // reuses a blank one, so they don't pile up.
  const newTab = (url?: string, after?: number) => {
    const blank = !url && tabs.find((t) => !t.url && !t.load);
    if (blank) {
      setCurrent(blank.id);
      setAgentTab(undefined);
      return;
    }
    const tab = ownTab(url);
    setTabs((all) => {
      const at = all.findIndex((t) => t.id === after);
      return at < 0 ? [...all, tab] : all.toSpliced(at + 1, 0, tab);
    });
    setCurrent(tab.id);
    setAgentTab(undefined);
  };
  // Closing the last tab leaves a blank one, as the panel has no window to close.
  const close = (id: number) => {
    const at = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) rest.push(ownTab());
    setTabs(rest);
    if (id === current) setCurrent(rest[Math.min(at, rest.length - 1)]!.id);
  };

  // A restored tab opens its page the first time it's shown.
  const shownOwn = tabs.find((t) => t.id === current);
  useEffect(() => {
    if (shownOwn?.restored && shownOwn.url)
      update(shownOwn.id, { restored: false, load: { url: shownOwn.url } });
  }, [shownOwn]);

  // Each change to the tabs' pages, or to the one in front, is saved for after a restart.
  const saved = scope ? savedOf(tabs, current) : undefined;
  const savedJson = JSON.stringify(saved);
  useEffect(() => {
    if (!scope || JSON.stringify(savedTabs.get()[scope]) === savedJson) return;
    savedTabs.set(withSaved(savedTabs.get(), scope, saved));
  }, [scope, savedJson]);

  // Only a new `page` opens a page, or shows an agent's tab.
  useEffect(() => {
    if (page?.agentTab) setAgentTab(page.agentTab);
    else if (page?.url !== undefined) {
      const tab = tabs.find((t) => t.id === current);
      if (tab && !tab.url && !tab.load) {
        update(tab.id, { load: { url: page.url } });
        setAgentTab(undefined);
      } else newTab(page.url, current);
    }
  }, [page]);

  // The side panel's top bar draws these tabs while the Browser view is in front (SidePanel.tsx).
  // Its buttons call the latest handlers, and the list is published only when what it shows
  // changes, since publishing re-renders the panel.
  const handlers = useRef({ setAgentTab, setCurrent, close, newTab });
  handlers.current = { setAgentTab, setCurrent, close, newTab };
  const faces: BrowserTabFace[] = [
    ...(agent?.tabs ?? []).map((t) => ({
      key: `a:${t.tabId}`,
      title: t.title || shortUrl(t.url) || "Agent's tab",
      url: t.url,
      Logo: driver.Logo ?? Bot,
      agent: driver.name,
    })),
    ...tabs.map((t) => ({
      key: `o:${t.id}`,
      title: t.title || (t.url ? shortUrl(t.url) : "New Tab"),
      ...(t.url && { url: t.url }),
      ...(t.icon && { icon: t.icon }),
    })),
  ];
  const selected = shownTab ? `a:${shownTab.tabId}` : `o:${current}`;
  // The agent's name stands in for its logo, which arrives with it.
  const published = JSON.stringify([
    faces.map((f) => [f.key, f.title, f.url, f.icon, f.agent]),
    selected,
  ]);
  useEffect(() => {
    if (!scope) return;
    browserTabs.set({
      ...browserTabs.get(),
      [scope]: {
        tabs: faces,
        selected,
        select: (key) => {
          if (key.startsWith("a:")) handlers.current.setAgentTab(key.slice(2));
          else {
            handlers.current.setCurrent(Number(key.slice(2)));
            handlers.current.setAgentTab(undefined);
          }
        },
        close: (key) => key.startsWith("o:") && handlers.current.close(Number(key.slice(2))),
        newTab: () => handlers.current.newTab(),
      },
    });
  }, [scope, published]);
  useEffect(
    () => () => {
      if (!scope) return;
      const { [scope]: _gone, ...rest } = browserTabs.get();
      browserTabs.set(rest);
    },
    [scope],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
      {tabs.map((t) => (
        <Tab
          key={t.id}
          scope={scope}
          shown={!shownTab && t.id === current}
          load={t.load}
          remoteHost={remoteHost}
          onChange={(patch) => update(t.id, patch)}
          onAsk={(action) => {
            if (action.kind === "open") newTab(action.url, t.id);
            else if (action.kind === "newTab") newTab();
            else if (action.kind === "closeTab") close(t.id);
            else if (action.kind === "select") {
              setCurrent(t.id);
              setAgentTab(undefined);
            }
          }}
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
        name: backendNames[backend] ?? instanceName(backend) ?? "The agent",
        Logo: backendLogos[backend] ?? instanceLogo(backend),
      }
    : { name: "The agent" };

/** A browser tab as its top bar draws it: its key is `a:` and an agent tab's id, or `o:` and an own tab's. */
export interface BrowserTabFace {
  key: string;
  title: string;
  url?: string;
  icon?: string;
  Logo?: ComponentType<SVGProps<SVGSVGElement>>;
  /** The agent driving it, for an agent's tab. */
  agent?: string;
}

/** A scope's browser tabs, which tab is in front, and what its top bar's buttons do. */
export interface BrowserTabs {
  tabs: BrowserTabFace[];
  selected: string;
  select: (key: string) => void;
  close: (key: string) => void;
  newTab: () => void;
}

/** Each browser's tabs, by its scope: a side panel's, or `permanent`. */
export const browserTabs = memory<Readonly<Record<string, BrowserTabs>>>({});

/**
 * One of the user's own tabs: back, forward, reload or stop, a loading bar, and an address bar
 * that opens a page or searches Google, over its webview. Each new `load` opens its url, even the
 * one already shown. It reports its page's url, title, and favicon, and passes on what its page
 * asks of the tab list, such as opening a tab.
 */
function Tab({
  scope,
  shown,
  load,
  remoteHost,
  onChange,
  onAsk: ask,
}: {
  scope?: string;
  shown: boolean;
  load?: { url: string };
  remoteHost?: string;
  onChange: (patch: Partial<OwnTab>) => void;
  onAsk: (action: BrowserAction) => void;
}) {
  const view = useRef<WebviewTag>(null);
  const addressBar = useRef<HTMLInputElement>(null);
  // The first page, which mounts the webview; later pages load in it.
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
  const layout = browserLayout.use();
  const slots = toolbarSlots.use()[scope ?? ""];
  const pageSize = fixed ?? fitSize(area.width, area.height, fit);
  const refit = (next: Fit) => {
    pageFit.set(next);
    setFixed(undefined);
  };
  // The latest callbacks, for the webview's listeners, which mount once per page.
  const latest = useRef({ onChange, ask });
  latest.current = { onChange, ask };

  // Extensions see the shown tab as the active one.
  useEffect(() => {
    if (shown && contentsId !== undefined) window.parallax.selectBrowserTab(contentsId);
  }, [shown, contentsId]);

  const open = (text: string) => {
    // An extension's own pages, such as its options, open as they are.
    const next = text.startsWith("chrome-extension://") ? text : browserUrl(text);
    if (!next) {
      if (text.trim()) setError({ url: text, description: "Only http and https pages open here." });
      return;
    }
    setError(undefined);
    setAddress(next);
    onChange({ url: next });
    // The view shows a load's error, so the rejection needs no handling here.
    if (view.current) view.current.loadURL(next).catch(() => {});
    else setSrc(next);
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
        else latest.current.ask(action);
      });
    };
    const navigated = () => {
      setAddress(el.getURL());
      setHistory({ back: el.canGoBack(), forward: el.canGoForward() });
      latest.current.onChange({ url: el.getURL() });
    };
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
    const titled = (e: PageTitleUpdatedEvent) => latest.current.onChange({ title: e.title });
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
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-navigate-in-page", navigated);
    el.addEventListener("did-start-navigation", starting);
    el.addEventListener("did-start-loading", started);
    el.addEventListener("did-fail-load", failed);
    el.addEventListener("did-stop-loading", stopped);
    el.addEventListener("page-title-updated", titled);
    return () => {
      stopAsking();
      el.removeEventListener("did-attach", ready);
      el.removeEventListener("dom-ready", ready);
      el.removeEventListener("did-navigate", navigated);
      el.removeEventListener("did-navigate-in-page", navigated);
      el.removeEventListener("did-start-navigation", starting);
      el.removeEventListener("did-start-loading", started);
      el.removeEventListener("did-fail-load", failed);
      el.removeEventListener("did-stop-loading", stopped);
      el.removeEventListener("page-title-updated", titled);
    };
  }, [src]);

  const navBar = (
    <>
      <IconButton label="Back" disabled={!history.back} onClick={() => view.current?.goBack()}>
        <ArrowLeft />
      </IconButton>
      <IconButton
        label="Forward"
        disabled={!history.forward}
        onClick={() => view.current?.goForward()}
      >
        <ArrowRight />
      </IconButton>
      {loading ? (
        <IconButton label="Stop" onClick={() => view.current?.stop()}>
          <X />
        </IconButton>
      ) : (
        <IconButton label="Reload" disabled={!src} onClick={() => view.current?.reload()}>
          <RotateCw />
        </IconButton>
      )}
      {/* The address bar alone is the form, so Enter opens it whatever else the toolbar holds:
            a form with two text fields and no submit button doesn't submit on Enter. */}
      <form
        // Classic's second row keeps as short as it can, since the top row's height is the
        // window's title bar (frame.ts).
        className={`mx-1 ${addressBox} ${layout === "classic" ? "h-7!" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          open(address);
        }}
      >
        <Search aria-hidden />
        <input
          ref={addressBar}
          // A new tab's address bar takes focus, as in Chrome, but not a tab shown again.
          autoFocus={!src}
          aria-label="Address"
          placeholder="Search Google or type a URL"
          spellCheck={false}
          value={editing ? address : shortUrl(address)}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            // The full url replaces the short one first, so select it once it renders.
            const input = e.target;
            requestAnimationFrame(() => input.select());
          }}
          onBlur={() => setEditing(false)}
          className={addressInput}
        />
      </form>
    </>
  );
  const toolsBar = (
    <>
      <Extensions tab={contentsId} />
      <ViewMenu fit={fit} fixed={!!fixed} size={pageSize} onFit={refit}>
        <button
          type="button"
          role="menuitem"
          disabled={!src}
          onClick={() => view.current?.openDevTools()}
          className={`${menuItem} disabled:opacity-50`}
        >
          <Code aria-hidden />
          Developer tools
        </button>
        <div className="my-1 h-px bg-border" />
        <p className={menuHeading}>Layout</p>
        <MenuOption
          option={{
            value: "compact",
            label: "Compact",
            icon: <RectangleHorizontal aria-hidden />,
            description: "Tabs and the address bar in one row",
          }}
          checked={layout === "compact"}
          onClick={() => browserLayout.set("compact")}
        />
        <MenuOption
          option={{
            value: "classic",
            label: "Classic",
            icon: <Rows2 aria-hidden />,
            description: "Tabs over the address bar",
          }}
          checked={layout === "classic"}
          onClick={() => browserLayout.set("classic")}
        />
      </ViewMenu>
    </>
  );
  // Compact draws the shown tab's toolbar into its browser's top bar, around the tabs; each tab's
  // stays mounted there, hidden behind the shown one's. Classic gives it a row under the tabs.
  const into = (slot: HTMLElement | undefined, bar: ReactNode, className: string) =>
    slot &&
    createPortal(
      <div className={shown ? `flex items-center ${className}` : "hidden"}>{bar}</div>,
      slot,
    );
  const compact = layout === "compact" && !!slots?.start && !!slots.end;

  return (
    <div className={`min-h-0 flex-1 flex-col ${shown ? "flex" : "hidden"}`}>
      {compact ? (
        <>
          {into(slots.start, navBar, "min-w-0 flex-1 gap-0.5")}
          {into(slots.end, toolsBar, "shrink-0")}
        </>
      ) : (
        <div className="flex h-8 shrink-0 items-center gap-0.5 px-2 pb-1">
          {navBar}
          {toolsBar}
        </div>
      )}
      {remoteHost && (
        <p className="border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          Pages load on this computer, so localhost isn't {remoteHost}. Forwarding its ports isn't
          built yet.
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
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
                  aria-label="Loading"
                  className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-ring"
                />
              )}
              {src && (
                // React drops a `true` attribute it doesn't know, so allowpopups is the empty
                // string. The page lays out at the frame's size, drawn at its scale.
                <webview
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
        {(error || !src) && (
          <div className="solid absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background px-8 pb-16 text-center">
            {error ? (
              <>
                <TriangleAlert aria-hidden className="mb-1 size-5 text-faint-foreground" />
                <p role="alert" className="text-[13px] font-medium text-foreground">
                  Can't open {error.url}
                </p>
                <p className="text-[12.5px] break-all text-muted-foreground">{error.description}</p>
              </>
            ) : (
              <>
                <Globe aria-hidden className="mb-1 size-5 text-faint-foreground" />
                <p className="text-[13px] font-medium text-foreground">Open a page</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Search Google, or type an address such as a dev server's localhost:5173.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A browser's top bar, as Helium draws it (PLX-966): its tabs with New tab after them, the tabs
 * the browser under `scope` publishes (`browserTabs`). In the compact layout the shown tab's back,
 * forward, reload, and address bar come before them, and its extensions and More after. The side
 * panel and the permanent browser's page show it.
 */
export function BrowserTabBar({ scope }: { scope: string }) {
  const browser = browserTabs.use()[scope];
  const compact = browserLayout.use() === "compact";
  // Stable per scope, so React doesn't detach and reattach the slots on every render.
  const start = useCallback(
    (el: HTMLDivElement | null) => {
      setSlot(scope, "start", el ?? undefined);
      return () => setSlot(scope, "start", undefined);
    },
    [scope],
  );
  const end = useCallback(
    (el: HTMLDivElement | null) => {
      setSlot(scope, "end", el ?? undefined);
      return () => setSlot(scope, "end", undefined);
    },
    [scope],
  );
  if (!browser) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {/* In a narrow panel the address bar keeps room to read, and the tabs room for one. */}
      {compact && <div ref={start} className="flex min-w-48 flex-[3] items-center" />}
      <div className={`flex min-w-16 items-center gap-0.5 ${compact ? "flex-[2]" : "flex-1"}`}>
        <div
          role="tablist"
          aria-label="Browser tabs"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {browser.tabs.map((tab) => (
            <BrowserTab
              key={tab.key}
              tab={tab}
              selected={tab.key === browser.selected}
              onSelect={() => browser.select(tab.key)}
              onClose={() => browser.close(tab.key)}
            />
          ))}
        </div>
        <IconButton label="New tab" onClick={browser.newTab}>
          <Plus />
        </IconButton>
      </div>
      {compact && <div ref={end} className="flex shrink-0 items-center" />}
    </div>
  );
}

/**
 * One of the browser's tabs in the top bar, as Helium draws one: its icon, title, and close
 * button, every tab the same width, shrinking together as more open. The close button shows on
 * the one in front and on hover. An agent's tab has its provider's logo and no close button,
 * since the agent closes it.
 */
function BrowserTab({
  tab,
  selected,
  onSelect,
  onClose,
}: {
  tab: BrowserTabFace;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const icon = tab.icon ? (
    <img src={tab.icon} alt="" className="size-3.5 shrink-0" />
  ) : tab.Logo ? (
    <tab.Logo aria-hidden className="size-3.5 shrink-0" />
  ) : (
    <Globe aria-hidden className="size-3.5 shrink-0" />
  );
  return (
    <div
      className={`group flex h-8 w-60 min-w-9 shrink items-center rounded-lg text-[12.5px] ${selected ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={tab.agent ? `${tab.agent}: ${tab.url ?? ""}` : tab.url}
        onClick={onSelect}
        // A middle click closes a tab, as in Chrome.
        onAuxClick={(e) => e.button === 1 && !tab.agent && onClose()}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left"
      >
        {icon}
        <span className="truncate">{tab.title}</span>
      </button>
      {!tab.agent && (
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onClick={onClose}
          className={`mr-1 size-5 shrink-0 place-items-center rounded-md hover:bg-hover ${selected ? "grid" : "hidden group-focus-within:grid group-hover:grid"}`}
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );
}
