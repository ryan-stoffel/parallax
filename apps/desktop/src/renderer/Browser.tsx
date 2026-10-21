import type { DidFailLoadEvent, PageTitleUpdatedEvent, WebviewTag } from "electron";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code,
  Globe,
  RotateCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";

import type { BrowserAction } from "../preload/bridge";
import type { PreviewTab } from "../protocol/generated/protocol";
import { AgentBrowser, type Driver } from "./AgentBrowser";
import { Extensions } from "./Extensions";
import {
  browserFit,
  fitSize,
  MONITOR,
  PageFrame,
  ViewMenu,
  type Fit,
  type Size,
} from "./PageFrame";
import { backendLogos } from "./Sidebar";
import { instanceLogo, instanceName } from "./providers";
import { memory } from "./stored";
import { IconButton, menuItem } from "./ui";

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

/** One of the user's tabs, as the top bar shows it. `load` is a page for it to open. */
interface OwnTab {
  id: number;
  load?: { url: string };
  url?: string;
  title?: string;
  icon?: string;
}

let lastTab = 0;
const ownTab = (url?: string): OwnTab => ({ id: ++lastTab, ...(url && { load: { url } }) });

/**
 * The side panel's browser, laid out like Chrome (PLX-888). Its tabs, the agent's (PLX-639) then
 * the user's own, show in the side panel's top bar while it's in front (`browserTabs`), so the
 * panel has one row of tabs. Each own tab is a webview, which main keeps in its own session with no preload or Node (main.ts), and
 * whose new windows open as tabs here. Each new `page` opens in the current tab while it's blank,
 * or else in a new one. `remoteHost`, the open host's name when it's an SSH host, notes that
 * localhost is this computer.
 */
export function Browser({
  page,
  remoteHost,
  scope,
  agent,
}: {
  page?: { url?: string; agentTab?: string };
  remoteHost?: string;
  /** The side panel scope it shows in, under which it publishes its tabs (`browserTabs`). */
  scope?: string;
  /** The open thread's agent tabs (PLX-639), which show before the user's own, and its backend. */
  agent?: { hostId: string; runId: string; tabs: PreviewTab[]; backend?: string };
}) {
  const driver = driverOf(agent?.backend);
  // The agent tab shown, by id, or undefined for the user's own tab `current`.
  const [agentTab, setAgentTab] = useState<string>();
  const shownTab = agent?.tabs.find((t) => t.tabId === agentTab);
  const [tabs, setTabs] = useState(() => [ownTab()]);
  const [current, setCurrent] = useState(tabs[0]!.id);

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
  const published = JSON.stringify([faces.map((f) => [f.key, f.title, f.url, f.icon]), selected]);
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

/** A browser tab as the side panel's top bar draws it: its key is `a:` and an agent tab's id, or `o:` and an own tab's. */
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

/** Each side panel scope's browser tabs, by scope. */
export const browserTabs = memory<Readonly<Record<string, BrowserTabs>>>({});

/**
 * One of the user's own tabs: back, forward, reload or stop, a loading bar, and an address bar
 * that opens a page or searches Google, over its webview. Each new `load` opens its url, even the
 * one already shown. It reports its page's url, title, and favicon, and passes on what its page
 * asks of the tab list, such as opening a tab.
 */
function Tab({
  shown,
  load,
  remoteHost,
  onChange,
  onAsk: ask,
}: {
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
  const fit = browserFit.use();
  const pageSize = fixed ?? fitSize(area.width, area.height, fit);
  const refit = (next: Fit) => {
    browserFit.set(next);
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

  return (
    <div className={`min-h-0 flex-1 flex-col ${shown ? "flex" : "hidden"}`}>
      <div className="flex items-center gap-0.5 border-b border-border px-2 pb-2">
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
          className={`mx-1 ${addressBox}`}
          onSubmit={(e) => {
            e.preventDefault();
            open(address);
          }}
        >
          <Search aria-hidden />
          <input
            ref={addressBar}
            autoFocus
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
        </ViewMenu>
      </div>
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
