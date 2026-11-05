import {
  Brain,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderTree,
  GitCompare,
  GitPullRequest,
  Globe,
  SquareKanban,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  Presentation,
  Smartphone,
  Terminal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode, Fragment } from "react";

import type { BrowserAction } from "../preload/bridge";
import {
  Browser,
  ownTab,
  pageFace,
  restored,
  useAgentFace,
  type AgentTabs,
  type OwnTab,
} from "./Browser";
import { useBrowserTheme } from "./browserTheme";
import type { DocRef } from "./documents";
import { PanelResize } from "./PanelResize";
import { numberOf } from "./github";
import { lookOf, type PullRequests } from "./PullRequests";
import { isMedia } from "./transcript";
import { IconButton, TopBar } from "./ui";
import { threadTabs } from "./tabState";

interface Surface {
  name: string;
  icon: LucideIcon;
  /** The letter that opens it from the list; a pull request's tab has its URL. */
  key: string;
  /** Its empty state, or absent while it has a view of its own. */
  empty?: { title: string; hint: string };
  /** A pull request's tab: the URL it shows. */
  url?: string;
  /** A presented file's tab (PLX-755). */
  doc?: DocRef;
  /** One of the user's browser tabs: its id in `Scoped.pages`. */
  page?: number;
  /** One of an agent's browser tabs (PLX-639). */
  agent?: { runId: string; tabId: string };
}

const isBrowserTab = (s: Surface | undefined) => s?.page !== undefined || !!s?.agent;
const pageSurface = (page: number): Surface => ({
  name: "New Tab",
  icon: Globe,
  key: `page:${page}`,
  page,
});
const agentSurface = (runId: string, tabId: string): Surface => ({
  name: "Agent's tab",
  icon: Globe,
  key: `agent:${runId}:${tabId}`,
  agent: { runId, tabId },
});

const docIcons = {
  docx: FileText,
  pdf: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  file: File,
};

// An orchestrator's own views, pinned first in its panel.
const overview: Surface = { name: "Orchestrator", icon: SquareKanban, key: "O" };

const surfaces: Surface[] = [
  {
    name: "Changes",
    icon: GitCompare,
    key: "D",
    empty: { title: "No changes yet", hint: "Edits from this thread show up here for review." },
  },
  {
    name: "Knowledge",
    icon: Brain,
    key: "K",
    empty: {
      title: "Nothing known here yet",
      hint: "An orchestrator, or a thread in a repository, keeps what its agents learn.",
    },
  },
  {
    name: "Agents",
    icon: Workflow,
    key: "A",
    empty: { title: "No agents running", hint: "Subagents this thread starts show up here." },
  },
  {
    name: "Terminal",
    icon: Terminal,
    key: "T",
    empty: { title: "No folder here", hint: "A thread's terminal opens in its folder." },
  },
  {
    name: "Files",
    icon: FolderTree,
    key: "F",
    empty: { title: "No thread open", hint: "Open a thread to browse its folder." },
  },
  {
    name: "Device",
    icon: Smartphone,
    key: "M",
    empty: { title: "No devices here", hint: "Simulators and emulators show up here." },
  },
  {
    name: "Pull requests",
    icon: GitPullRequest,
    key: "P",
    empty: { title: "No pull requests", hint: "Pull requests this thread opens show up here." },
  },
  // Picking it opens a browser tab, rather than a tab of its own.
  { name: "Browser", icon: Globe, key: "B" },
];

const knowledgeSurface = surfaces.find((s) => s.name === "Knowledge")!;
const deviceSurface = surfaces.find((s) => s.name === "Device")!;
const terminalSurface = surfaces.find((s) => s.name === "Terminal")!;

/**
 * One `scope`'s panel: its open tabs in order, and each in the order it was last shown, with the
 * thread (`documents.runId`) it was shown in, as an orchestrator's subagents share its panel;
 * whether + is showing the list; whether its browser has mounted; its browser tabs' pages, which
 * `tabs` orders; and the pages of the tabs closed, the last last, for Cmd/Ctrl+Shift+T (PLX-969).
 */
interface Scoped {
  tabs: Surface[];
  recent: [Surface, string | undefined][];
  listing: boolean;
  browsed?: boolean;
  pages: OwnTab[];
  closed: string[];
}
const unopened: Scoped = { tabs: [], recent: [], listing: false, pages: [], closed: [] };

/** `s` in front of `panel`, shown in `thread`. */
const activated = (panel: Scoped, s: Surface, thread: string | undefined): Partial<Scoped> => ({
  listing: false,
  recent: [...panel.recent.filter(([t, at]) => t !== s || at !== thread), [s, thread]],
});

/** `s` in front of `panel` because the user asked, which takes focus to its page once it's loaded. */
const revealed = (panel: Scoped, s: Surface, thread: string | undefined): Partial<Scoped> => ({
  ...activated(panel, s, thread),
  pages: panel.pages.map((p) => (p.id === s.page ? { ...p, focusAsked: {} } : p)),
});

/** `panel` without its tab `s`, keeping a closed page for Cmd/Ctrl+Shift+T. */
function withoutTab(panel: Scoped, s: Surface): Partial<Scoped> {
  const url = panel.pages.find((p) => p.id === s.page)?.url;
  return {
    tabs: panel.tabs.filter((t) => t !== s),
    recent: panel.recent.filter(([t]) => t !== s),
    ...(s.page !== undefined && {
      pages: panel.pages.filter((p) => p.id !== s.page),
      closed: url ? [...panel.closed.slice(-24), url] : panel.closed,
      // The browser saves its tabs, even one closed before any of them showed.
      browsed: true,
    }),
  };
}

/** A scope's panel the first time it's seen: its saved browser tabs, the last shown in front. */
function firstPanel(scope: string, orchestrated: boolean): Scoped {
  const { tabs: pages, current } = restored(scope);
  const tabs = pages.map((page) => pageSurface(page.id));
  const front = tabs.find((s) => s.page === current);
  // An orchestrator's panel rests on its home.
  return { ...unopened, pages, tabs, recent: front && !orchestrated ? [[front, undefined]] : [] };
}

/**
 * The collapsible right column. Each `scope`, such as a thread or an orchestrator, keeps its own
 * tabs, so a view opened in one thread doesn't open in another (PLX-872). Each view and each browser
 * tab, the user's and the agent's, opens as a tab in its top bar, VS Code style, in the order
 * opened; the + after the tabs, or closing the shown one with none after, shows the list of views,
 * where each view's letter opens it while focus is in the panel. Open tabs stay mounted, so a view
 * keeps its state behind another, and closing the last one collapses the panel. The top bar keeps
 * the hide button where the main pane shows it while the panel is closed. Expanded, it fills
 * everything right of the sidebar, and `leading` and `topBarClassName` stand in for the hidden main
 * pane's top-left corner. `agents`, `knowledge`, `files`, and `changesView` are those views, such as
 * an orchestrator's, in place of their empty states. `remoteHost` is the open host's name when it's
 * an SSH host. `terminal` draws the Terminal view, told whether it's shown and given its empty
 * state. Each new `browse` shows one of `agentTabs`, opens its url in a browser tab, or with neither
 * shows the last browser tab or a new one. `pullRequests` are the open thread's linked pull requests
 * (PLX-319): its URLs, each one's read, the Pull requests view, and each one's view, shown in a `#n`
 * tab, colored by its state, only while the thread links it. Each new `pullRequest` opens that URL's
 * tab, or without one the Pull requests view. Each new `documents.open` opens that presented file's
 * tab (PLX-755), shown only while its thread, `documents.runId`, is open, as a pull request's is.
 * `device` draws the Device view (PLX-886), told whether it's shown, and each new `showDevice` opens
 * it. Each new `showOrchestrator` shows an open orchestrator's Orchestrator tab, and each new
 * `showFiles` opens the Files view. `filesTabs` draws the Files view's tab with its open files.
 */
/** A tab in the panel's row, as the Files view's file tabs draw theirs too. */
export const panelTab = (shown: boolean) =>
  `group flex items-center rounded-lg ${shown ? "bg-[var(--browser-tab,var(--selected))] text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`;
export const panelTabButton =
  "flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left text-body";
export const panelTabClose =
  "mx-0.5 grid size-5 shrink-0 place-items-center rounded-md hover:bg-hover [&_svg]:size-3.5";

/**
 * What draws the Files view's tab, with its open files after it in the same row, as T3 Code's
 * panel does: `current` while the Files view is in front, `show` brings it there, and `close`
 * closes it.
 */
export type FilesTabs = (tab: {
  /** The Files tab's id, which the panel moves focus to. */
  id: string;
  /** Whether the row has room for every tab's name: the panel is full screen or wide. */
  roomy: boolean;
  current: boolean;
  show: () => void;
  close: () => void;
  icon: Surface["icon"];
}) => ReactNode;

export function SidePanel({
  scope,
  width = 416,
  onResize,
  open,
  onClose,
  expanded,
  onExpandedChange,
  leading,
  topBarClassName = "",
  agents,
  knowledge,
  remoteHost,
  terminal,
  files,
  changesView,
  browse,
  changes,
  agentTabs,
  pullRequests,
  pullRequest,
  documents,
  orchestrator,
  device,
  showDevice,
  showOrchestrator,
  showFiles,
  filesTabs,
}: {
  scope: string;
  width?: number;
  onResize?: (width: number) => void;
  open: boolean;
  onClose: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  leading?: ReactNode;
  topBarClassName?: string;
  agents?: ReactNode;
  knowledge?: ReactNode;
  remoteHost?: string;
  terminal?: (shown: boolean, empty: ReactNode) => ReactNode;
  files?: ReactNode;
  /** Draws the Files view's tab and its open files. */
  filesTabs?: FilesTabs;
  changesView?: ReactNode;
  browse?: { url?: string; agentTab?: string };
  /** A new request opens the Changes view. */
  changes?: object;
  agentTabs?: AgentTabs;
  pullRequests?: {
    urls: readonly string[];
    get: PullRequests["get"];
    list: ReactNode;
    view: (url: string) => ReactNode;
  };
  pullRequest?: { url?: string };
  documents?: { runId?: string; open?: DocRef; view: (doc: DocRef) => ReactNode };
  /** An open orchestrator, whose home the panel rests on, with Knowledge beside it, and how many
   * things wait on the user there. */
  orchestrator?: { home: ReactNode; waiting: number };
  device?: (shown: boolean) => ReactNode;
  showDevice?: object;
  /** A new request shows an open orchestrator's Orchestrator tab. */
  showOrchestrator?: object;
  /** A new request opens the Files view, as the command menu's file picks do (PLX-993). */
  showFiles?: object;
}) {
  const tabbed = threadTabs.use();
  // Each scope's panel. A thread shows the last view it showed that's still open, else the last one
  // its scope showed, else the list.
  const [scopes, setScopes] = useState<Record<string, Scoped>>({});
  if (!scopes[scope]) {
    const first = firstPanel(scope, !!orchestrator);
    setScopes((all) => (all[scope] ? all : { ...all, [scope]: first }));
  }
  const { tabs, recent, listing, pages } = scopes[scope] ?? unopened;
  const updateIn = (key: string, next: (panel: Scoped) => Partial<Scoped>) =>
    setScopes((all) => {
      const panel = all[key] ?? unopened;
      return { ...all, [key]: { ...panel, ...next(panel) } };
    });
  const update = (next: (panel: Scoped) => Partial<Scoped>) => updateIn(scope, next);
  const thread = documents?.runId;
  const setActive = (s: Surface) => update((panel) => activated(panel, s, thread));
  const reveal = (s: Surface) => update((panel) => revealed(panel, s, thread));
  // The thread a tab shown in `key`'s panel counts as shown in: the open one, or for another scope,
  // the one that scope last showed a tab in.
  const threadIn = (key: string, panel: Scoped) =>
    key === scope ? thread : panel.recent.at(-1)?.[1];

  const browserStyle = useBrowserTheme();
  const agentFace = useAgentFace(agentTabs, remoteHost);
  const agentTabOf = (s: Surface) =>
    s.agent?.runId === agentTabs?.runId
      ? agentTabs?.tabs.find((t) => t.tabId === s.agent?.tabId)
      : undefined;
  // Each of the agent's tabs joins the panel's tabs as it opens, and shows only while the thread has
  // it.
  if (agentTabs) {
    const { runId } = agentTabs;
    const added = agentTabs.tabs
      .map((t) => agentSurface(runId, t.tabId))
      .filter((s) => !tabs.some((t) => t.key === s.key));
    if (added.length) update((panel) => ({ tabs: [...panel.tabs, ...added] }));
  }
  const available = orchestrator
    ? surfaces
    : ["Browser", "Device", "Terminal", "Files", "Changes", "Pull requests"].map((name) =>
        surfaces.find((s) => s.name === name)!,
      );
  const nameOf = (s: Surface) => (!orchestrator && s.name === "Changes" ? "Diff" : s.name);
  // An orchestrator pins its Overview and Knowledge first, without close buttons.
  const pinned = orchestrator ? [overview, knowledgeSurface] : [];
  // A pull request tab the thread no longer links stays open, but hidden.
  const shown = [
    ...pinned,
    ...tabs.filter(
      (s) =>
        !pinned.includes(s) &&
        (orchestrator || (s.name !== "Knowledge" && s.name !== "Agents")) &&
        (!s.url || pullRequests?.urls.includes(s.url)) &&
        (!s.doc || s.doc.runId === documents?.runId) &&
        (!s.agent || agentTabOf(s)),
    ),
  ];
  const lastShown = (entries: typeof recent) => entries.findLast(([s]) => shown.includes(s))?.[0];
  const current = listing
    ? undefined
    : (lastShown(recent.filter(([, at]) => at === thread)) ??
      lastShown(recent) ??
      (orchestrator ? overview : undefined));
  const browsing = isBrowserTab(current);
  // The browser mounts the first time one of its tabs shows, and stays.
  if (open && browsing && !scopes[scope]?.browsed) update(() => ({ browsed: true }));

  const openView = (s: Surface) => {
    if (pinned.includes(s)) return setActive(s);
    update((panel) => {
      const kept = panel.tabs.find((t) => t.key === s.key);
      return {
        tabs: kept ? panel.tabs : [...panel.tabs, s],
        ...activated(panel, kept ?? s, thread),
      };
    });
  };
  // A new browser tab in `key`'s panel, after the tab `after` or else last, which comes to the front.
  // An empty one reuses a blank tab, so they don't pile up.
  const openPage = (
    key: string,
    url?: string,
    { after, focus = true }: { after?: number; focus?: boolean } = {},
  ) =>
    updateIn(key, (panel) => {
      const blank = !url && panel.pages.find((p) => !p.url && !p.load);
      const reused = blank && panel.tabs.find((t) => t.page === blank.id);
      if (reused) return revealed(panel, reused, threadIn(key, panel));
      const page = { ...ownTab(url), focus };
      const surface = pageSurface(page.id);
      // `pages` keeps the strip's order, which is the order they're saved in.
      const pageAt = panel.pages.findIndex((p) => p.id === after);
      const tabAt = panel.tabs.findIndex((t) => t.page === after);
      return {
        pages: panel.pages.toSpliced(pageAt < 0 ? panel.pages.length : pageAt + 1, 0, page),
        tabs: panel.tabs.toSpliced(tabAt < 0 ? panel.tabs.length : tabAt + 1, 0, surface),
        ...activated(panel, surface, threadIn(key, panel)),
      };
    });
  const changePage = (key: string, id: number, patch: Partial<OwnTab>) =>
    updateIn(key, (panel) => ({
      pages: panel.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  const pick = (s: Surface) => (s.name === "Browser" ? openPage(scope) : openView(s));
  // Closing the shown tab shows the one after it, or before it; closing the last collapses the
  // panel. Otherwise focus moves to the shown tab, or to + with none shown, so it stays in the
  // panel, where the list's letters work.
  const closeView = (s: Surface) => {
    const i = shown.indexOf(s);
    const rest = shown.toSpliced(i, 1);
    const next = s === current ? rest[Math.min(i, rest.length - 1)] : current;
    update((panel) => withoutTab(panel, s));
    if (s.agent) agentTabs?.close(s.agent.tabId);
    if (next && s === current) reveal(next);
    if (!rest.length) return onClose();
    document.getElementById(next ? `side-panel-tab-${next.key}` : "side-panel-open-view")?.focus();
  };
  // What a page in `key`'s panel asks of its tabs: Chrome's tab shortcuts, among the user's own,
  // from the place of the tab `from`.
  const pageAsked = (key: string, from: number | undefined, action: BrowserAction) => {
    const panel = scopes[key] ?? unopened;
    const own = panel.tabs.filter((t) => t.page !== undefined);
    const at = own.findIndex((t) => t.page === from);
    const show = (to: Surface | undefined) =>
      to && updateIn(key, (latest) => revealed(latest, to, threadIn(key, latest)));
    if (action.kind === "open") openPage(key, action.url, { after: from });
    else if (action.kind === "newTab") openPage(key);
    else if (action.kind === "closeTab") {
      const s = own[at];
      if (s && key === scope) closeView(s);
      // An extension can close a tab in a scope that isn't open.
      else if (s) updateIn(key, (latest) => withoutTab(latest, s));
    } else if (action.kind === "select") {
      // An extension's choice, which leaves focus where it is.
      const s = own[at];
      if (s) updateIn(key, (latest) => activated(latest, s, threadIn(key, latest)));
    } else if (action.kind === "nextTab") show(own[(at + 1) % own.length]);
    else if (action.kind === "previousTab") show(own[(at - 1 + own.length) % own.length]);
    else if (action.kind === "tab") show(own[action.index]);
    else if (action.kind === "lastTab") show(own.at(-1));
    else if (action.kind === "reopenTab") {
      const url = panel.closed.at(-1);
      if (!url) return;
      updateIn(key, (latest) => ({ closed: latest.closed.slice(0, -1) }));
      openPage(key, url, { after: from });
    }
  };
  const [changesOpened, setChangesOpened] = useState(changes);
  if (changes !== changesOpened) {
    setChangesOpened(changes);
    if (changes) openView(surfaces.find((surface) => surface.name === "Changes")!);
  }
  const [browsed, setBrowsed] = useState(browse);
  if (browse !== browsed) {
    setBrowsed(browse);
    if (browse?.agentTab) {
      // Its thread is no longer the open one if the user moved on while plxd listed its tabs.
      if (agentTabs) openView(agentSurface(agentTabs.runId, browse.agentTab));
    } else if (browse?.url) {
      // It opens in the tab in front while that's blank, and doesn't take focus from the composer.
      const blank = pages.find((p) => p.id === current?.page && !p.url && !p.load);
      if (blank) changePage(scope, blank.id, { load: { url: browse.url }, focus: false });
      else openPage(scope, browse.url, { after: current?.page, focus: false });
    } else if (browse) {
      const last =
        lastShown(recent.filter(([s]) => isBrowserTab(s))) ?? shown.findLast(isBrowserTab);
      if (last) reveal(last);
      else openPage(scope);
    }
  }
  const [deviceShown, setDeviceShown] = useState(showDevice);
  if (showDevice !== deviceShown) {
    setDeviceShown(showDevice);
    if (showDevice) openView(deviceSurface);
  }
  const [filesShown, setFilesShown] = useState(showFiles);
  if (showFiles !== filesShown) {
    setFilesShown(showFiles);
    if (showFiles) openView(surfaces.find((surface) => surface.name === "Files")!);
  }
  const [orchestratorShown, setOrchestratorShown] = useState(showOrchestrator);
  if (showOrchestrator !== orchestratorShown) {
    setOrchestratorShown(showOrchestrator);
    if (showOrchestrator && orchestrator) setActive(overview);
  }
  const [prOpened, setPrOpened] = useState(pullRequest);
  if (pullRequest !== prOpened) {
    setPrOpened(pullRequest);
    const url = pullRequest?.url;
    if (url) openView({ name: `#${numberOf(url)}`, icon: GitPullRequest, key: url, url });
    else if (pullRequest) openView(surfaces.find((s) => s.name === "Pull requests")!);
  }
  const [docOpened, setDocOpened] = useState(documents?.open);
  if (documents?.open !== docOpened) {
    setDocOpened(documents?.open);
    const doc = documents?.open;
    if (doc)
      openView({
        name: doc.name,
        // An image or video opens here from a link in the transcript (PLX-834).
        icon: isMedia(doc.kind) ? FileImage : docIcons[doc.kind],
        key: `doc:${doc.runId}:${doc.path}`,
        doc,
      });
  }
  const emptyOf = (s: Surface) => (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <s.icon aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-body font-medium text-foreground">{s.empty?.title}</p>
      <p className="text-body text-muted-foreground">{s.empty?.hint}</p>
    </div>
  );
  const viewOf = (s: Surface) =>
    s === overview && orchestrator
      ? orchestrator.home
      : s.name === "Agents" && agents
        ? agents
        : s.name === "Knowledge" && knowledge
          ? knowledge
          : s.name === "Terminal" && terminal
            ? terminal(open && s === current, emptyOf(s))
            : s.name === "Device" && device
              ? device(open && s === current)
              : s.name === "Files" && files
                ? files
                : s.name === "Changes" && changesView
                  ? changesView
                  : s.doc && documents
                    ? documents.view(s.doc)
                    : s.url && pullRequests
                      ? pullRequests.view(s.url)
                      : s.name === "Pull requests" && pullRequests?.urls.length
                        ? pullRequests.list
                        : emptyOf(s);

  return (
    <aside
      id="side-panel"
      aria-label="Side panel"
      hidden={!open}
      // From the list, a view's letter opens it while focus is in the panel.
      onKeyDown={(e) => {
        if (current || e.metaKey || e.ctrlKey || e.altKey) return;
        const next = available.find((s) => s.key === e.key.toUpperCase());
        if (!next) return;
        e.preventDefault();
        pick(next);
      }}
      style={expanded ? undefined : { width }}
      className={
        tabbed
          ? `pane-edge pane-card relative m-1.5 ml-0 flex min-w-0 flex-col overflow-clip rounded-prompt bg-pane ${expanded ? "flex-1" : "shrink-0"}`
          : `relative flex min-w-0 flex-col bg-pane ${expanded ? "flex-1" : "shrink-0 border-l border-border"}`
      }
    >
      {!expanded && onResize && <PanelResize side="right" width={width} onResize={onResize} />}
      {/* While a browser tab is in front, the browser's theme paints the top bar and the browser, and
          nothing else, such as the terminals mounted behind it (browserTheme.ts). */}
      <TopBar
        style={browsing ? browserStyle : undefined}
        className={`window-controls-inset px-2 ${browsing && browserStyle ? "bg-pane" : ""} ${topBarClassName}`}
      >
        {leading}
        <ul aria-label="Open views" className="flex min-w-0 gap-0.5 overflow-x-auto">
          {shown.map((s) => {
            const agentTab = agentTabOf(s);
            const page = pages.find((p) => p.id === s.page);
            const face = agentTab ? agentFace(agentTab) : page && pageFace(page);
            const look = s.url ? lookOf(pullRequests?.get(s.url)?.pr) : undefined;
            const Icon = look?.Icon ?? s.icon;
            const name = face?.title ?? nameOf(s);
            // A browser tab shrinks with the others as more open, and shows its close button only
            // in front and on hover, so its title keeps the room.
            const browserTab = !!face;
            if (s.name === "Files" && filesTabs)
              return (
                <Fragment key={s.key}>
                  {filesTabs({
                    id: `side-panel-tab-${s.key}`,
                    roomy: expanded || width >= 720,
                    current: s === current,
                    show: () => reveal(s),
                    close: () => closeView(s),
                    icon: s.icon,
                  })}
                </Fragment>
              );
            return (
              <li
                key={s.key}
                className={`${panelTab(s === current)} ${browserTab ? "w-40 min-w-9 shrink" : "shrink-0"}`}
              >
                <button
                  type="button"
                  id={`side-panel-tab-${s.key}`}
                  aria-current={s === current ? "true" : undefined}
                  title={face?.url}
                  onClick={() => reveal(s)}
                  // A middle click closes a browser tab, as in Chrome.
                  onAuxClick={(e) => browserTab && e.button === 1 && closeView(s)}
                  className={`${panelTabButton} ${pinned.includes(s) ? "pr-2" : ""}`}
                >
                  {face?.icon ? (
                    <img src={face.icon} alt="" className="size-3.5 shrink-0" />
                  ) : (
                    <Icon aria-hidden className={`size-3.5 shrink-0 ${look?.color ?? ""}`} />
                  )}
                  <span className="truncate">{name}</span>
                  {s === overview && !!orchestrator?.waiting && (
                    <span className="font-mono text-caption text-warning tabular-nums">
                      {orchestrator.waiting}
                    </span>
                  )}
                </button>
                {!pinned.includes(s) && (
                  <button
                    type="button"
                    aria-label={`Close ${name}`}
                    title={`Close ${name}`}
                    onClick={() => closeView(s)}
                    className={`${panelTabClose} ${browserTab && s !== current ? "hidden! group-focus-within:grid! group-hover:grid!" : ""}`}
                  >
                    <X />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <IconButton
          id="side-panel-open-view"
          label="Open a view"
          onClick={() => update(() => ({ listing: true }))}
        >
          <Plus />
        </IconButton>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={expanded ? "Exit full screen" : "Full screen"}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <IconButton
            label="Hide side panel"
            command="panel"
            aria-expanded
            aria-controls="side-panel"
            onClick={onClose}
          >
            <PanelRight />
          </IconButton>
        </div>
      </TopBar>
      {shown
        .filter((s) => s !== terminalSurface && !isBrowserTab(s))
        .map((s) => (
          <div key={s.key} hidden={s !== current} className="flex min-h-0 flex-1 flex-col">
            {viewOf(s)}
          </div>
        ))}
      {/* The browser and Terminal stay mounted while any scope has them open, so a thread's page
          and shells are still there on coming back to it. The terminal pool shows the open thread's. */}
      {Object.values(scopes).some((panel) => panel.tabs.includes(terminalSurface)) && (
        <div hidden={current !== terminalSurface} className="flex min-h-0 flex-1 flex-col">
          {viewOf(terminalSurface)}
        </div>
      )}
      {Object.entries(scopes)
        .filter(([, panel]) => panel.browsed)
        .map(([key, panel]) => {
          // Another scope's stays as it left it.
          const front = key === scope ? current : panel.recent.at(-1)?.[0];
          return (
            <div
              key={`${key}/B`}
              hidden={key !== scope || !browsing}
              style={browserStyle}
              className="flex min-h-0 flex-1 flex-col bg-pane"
            >
              <Browser
                scope={key}
                pages={panel.pages}
                frontPage={front?.page}
                lastPage={panel.recent.findLast(([s]) => s.page !== undefined)?.[0].page}
                agentTab={front?.agent?.tabId}
                visible={key === scope && open}
                remoteHost={remoteHost}
                agent={key === scope ? agentTabs : undefined}
                onChange={(id, patch) => changePage(key, id, patch)}
                onAsk={(from, action) => pageAsked(key, from, action)}
              />
            </div>
          );
        })}
      {!current && (
        <nav
          aria-labelledby="side-panel-views"
          className="flex flex-1 flex-col items-center justify-center px-8 pb-16"
        >
          <h2 id="side-panel-views" className="mb-4 text-reading font-medium">
            Open a view
          </h2>
          <ul className="w-full max-w-72">
            {available.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  aria-keyshortcuts={s.key}
                  onClick={() => pick(s)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-body hover:bg-hover"
                >
                  <s.icon aria-hidden className="size-4 shrink-0" />
                  <span className="flex-1">{nameOf(s)}</span>
                  <kbd className="grid size-6 place-items-center rounded-md bg-selected font-sans text-meta text-muted-foreground">
                    {s.key}
                  </kbd>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </aside>
  );
}
