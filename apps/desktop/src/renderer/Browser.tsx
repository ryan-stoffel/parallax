import type { DidFailLoadEvent, PageTitleUpdatedEvent, WebviewTag } from "electron";
import { ArrowLeft, ArrowRight, Bot, Globe, Plus, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { BrowserAction } from "../preload/bridge";
import type { PreviewTab } from "../protocol/generated/protocol";
import { AgentBrowser, type Driver } from "./AgentBrowser";
import { fitSize, MONITOR, PageFrame, type Size } from "./PageFrame";
import { backendLogos } from "./Sidebar";
import { instanceLogo, instanceName } from "./providers";
import { IconButton } from "./ui";

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

/** One of the user's tabs, as the tab strip shows it. `load` is a page for it to open. */
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
 * The side panel's browser, laid out like Chrome (PLX-888): one strip of tabs, the agent's
 * (PLX-639) then the user's own, each with its favicon and title, and a new tab button. Each own
 * tab is a webview, which main keeps in its own session with no preload or Node (main.ts), and
 * whose new windows open as tabs here. Each new `page` opens in the current tab while it's blank,
 * or else in a new one. `remoteHost`, the open host's name when it's an SSH host, notes that
 * localhost is this computer.
 */
export function Browser({
  page,
  remoteHost,
  agent,
}: {
  page?: { url?: string; agentTab?: string };
  remoteHost?: string;
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
  // A new tab after `after`, or at the end, which becomes the current one.
  const newTab = (url?: string, after?: number) => {
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

  const strip = (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-2 pb-1.5"
    >
      {agent?.tabs.map((t) => (
        <TabButton
          key={t.tabId}
          selected={shownTab === t}
          label={t.title || shortUrl(t.url) || t.tabId}
          title={`${driver.name}: ${t.url}`}
          icon={
            driver.Logo ? (
              <driver.Logo aria-label={driver.name} className="size-3.5 shrink-0" />
            ) : (
              <Bot aria-label={driver.name} className="size-3.5 shrink-0" />
            )
          }
          onSelect={() => setAgentTab(t.tabId)}
        />
      ))}
      {tabs.map((t) => (
        <TabButton
          key={t.id}
          selected={!shownTab && t.id === current}
          label={t.title || (t.url ? shortUrl(t.url) : "New Tab")}
          title={t.url}
          icon={
            t.icon ? (
              <img src={t.icon} alt="" className="size-3.5 shrink-0" />
            ) : (
              <Globe aria-hidden className="size-3.5 shrink-0" />
            )
          }
          onSelect={() => {
            setCurrent(t.id);
            setAgentTab(undefined);
          }}
          onClose={() => close(t.id)}
        />
      ))}
      <span className="shrink-0">
        <IconButton label="New tab" onClick={() => newTab()}>
          <Plus />
        </IconButton>
      </span>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {strip}
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

/** A tab in the strip: its icon and title, and a close button for one of the user's own. */
function TabButton({
  selected,
  label,
  title,
  icon,
  onSelect,
  onClose,
}: {
  selected: boolean;
  label: string;
  title?: string;
  icon: ReactNode;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={`group flex h-7 max-w-44 min-w-9 flex-1 items-center rounded-md text-[12px] ${selected ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover"}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={title}
        onClick={onSelect}
        // A middle click closes a tab, as in Chrome.
        onAuxClick={(e) => e.button === 1 && onClose?.()}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-left"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={`mr-1 grid size-4.5 shrink-0 place-items-center rounded hover:bg-hover ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * One of the user's own tabs: back, forward, reload or stop, a loading bar, and an address bar
 * that opens a page or searches Google, over its webview. Each new `load` opens its url, even the
 * one already shown. It reports its page's url, title, and favicon, and passes on what its page
 * asks that the tab strip does, such as opening a tab.
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
  // The page's size: the one the user set, or the panel's fit (PageFrame.tsx).
  const [fixed, setFixed] = useState<Size>();
  const [area, setArea] = useState<Size>(MONITOR);
  const pageSize = fixed ?? fitSize(area.width, area.height);
  // The latest callbacks, for the webview's listeners, which mount once per page.
  const latest = useRef({ onChange, ask });
  latest.current = { onChange, ask };

  const open = (text: string) => {
    const next = browserUrl(text);
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
    el.addEventListener("did-attach", ready);
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
      <form
        className="flex items-center gap-0.5 border-b border-border px-2 pb-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          open(address);
        }}
      >
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
          className="ml-1 min-w-0 flex-1 rounded-md bg-selected px-2 py-1 text-[12.5px] placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      </form>
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
          onResize={setFixed}
          onFit={() => setFixed(undefined)}
          onArea={setArea}
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
