import {
  Brain,
  FolderTree,
  GitCompare,
  GitPullRequest,
  Globe,
  SquareKanban,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  Terminal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { Browser } from "./Browser";
import { PanelResize } from "./PanelResize";
import { numberOf } from "./PullRequests";
import { IconButton, TopBar } from "./ui";

interface Surface {
  name: string;
  icon: LucideIcon;
  /** The letter that opens it from the list; a pull request's tab has its URL. */
  key: string;
  /** Its empty state, or absent while it has a view of its own. */
  empty?: { title: string; hint: string };
  /** A pull request's tab: the URL it shows. */
  url?: string;
}

// A Project's own views, pinned first in its panel.
const overview: Surface = { name: "Project", icon: SquareKanban, key: "O" };

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
      hint: "A Project, or a thread in a repository, keeps what its agents learn.",
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
  { name: "Browser", icon: Globe, key: "B" },
  {
    name: "Pull requests",
    icon: GitPullRequest,
    key: "P",
    empty: { title: "No pull requests", hint: "Pull requests this thread opens show up here." },
  },
];

const knowledgeSurface = surfaces.find((s) => s.name === "Knowledge")!;

/**
 * The collapsible right column. Each view opens as a tab in its top bar, VS Code style; the + after
 * the tabs, or closing the last one, shows the list of views, where each view's letter opens it
 * while focus is in the panel. Open tabs stay mounted, so a view keeps its state behind another.
 * The top bar keeps the hide button where the main pane shows it while the panel is closed.
 * Expanded, it fills everything right of the sidebar, and `leading` and `topBarClassName` stand in
 * for the hidden main pane's top-left corner. `agents`, `knowledge`, and `files` are those views,
 * such as a Project's, in place of their empty states. `remoteHost` is the open host's name when
 * it's an SSH host. `terminal` draws the Terminal view, told whether it's shown and given its empty
 * state. Each new `browse` opens the Browser view at its url, or at one of `agentTabs`. `pullRequests` are the open thread's
 * linked pull requests (PLX-319): its URLs, the Pull requests view, and each one's view, shown in a
 * `#n` tab only while the thread links it. Each new `pullRequest` opens that URL's tab, or without
 * one the Pull requests view.
 */
export function SidePanel({
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
  browse,
  agentTabs,
  pullRequests,
  pullRequest,
  project,
}: {
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
  browse?: { url?: string; agentTab?: string };
  /** The open thread's agent browser tabs (PLX-639), for the Browser view. */
  agentTabs?: ComponentProps<typeof Browser>["agent"];
  pullRequests?: { urls: readonly string[]; list: ReactNode; view: (url: string) => ReactNode };
  pullRequest?: { url?: string };
  /** An open Project, whose home the panel rests on, with Knowledge beside it, and how many
   * things wait on the user there. */
  project?: { home: ReactNode; waiting: number };
}) {
  // The open views in tab order, and the one shown; with none shown, the list is.
  const [tabs, setTabs] = useState<Surface[]>([]);
  const [active, setActive] = useState<Surface>();
  // Whether + is showing the list, in a Project, where the panel otherwise rests on its Overview.
  const [listing, setListing] = useState(false);

  const available = project
    ? surfaces
    : ["Browser", "Terminal", "Files", "Changes", "Pull requests"].map((name) =>
        surfaces.find((s) => s.name === name)!,
      );
  const nameOf = (s: Surface) => (!project && s.name === "Changes" ? "Diff" : s.name);
  // A Project pins its Overview and Knowledge first, without close buttons.
  const pinned = project ? [overview, knowledgeSurface] : [];
  // Another thread's pull request tabs stay open, but hidden.
  const shown = [
    ...pinned,
    ...tabs.filter(
      (s) =>
        !pinned.includes(s) &&
        (project || (s.name !== "Knowledge" && s.name !== "Agents")) &&
        (!s.url || pullRequests?.urls.includes(s.url)),
    ),
  ];
  const current =
    active && shown.includes(active) ? active : project && !listing ? overview : undefined;

  const openView = (s: Surface) => {
    setListing(false);
    if (pinned.includes(s)) return setActive(s);
    const open = tabs.find((t) => t.key === s.key);
    if (!open) setTabs([...tabs, s]);
    setActive(open ?? s);
  };
  // Closing the shown tab shows the one after it, or before it; closing the last shows the list.
  // Focus moves to the shown tab, or to + with none shown, so it stays in the panel, where the
  // list's letters work.
  const closeView = (s: Surface) => {
    const i = shown.indexOf(s);
    const rest = shown.toSpliced(i, 1);
    const next = s === current ? rest[Math.min(i, rest.length - 1)] : current;
    setTabs(tabs.filter((t) => t !== s));
    setActive(next);
    document.getElementById(next ? `side-panel-tab-${next.key}` : "side-panel-open-view")?.focus();
  };
  const [browsed, setBrowsed] = useState(browse);
  if (browse !== browsed) {
    setBrowsed(browse);
    if (browse) openView(surfaces.find((s) => s.name === "Browser")!);
  }
  const [prOpened, setPrOpened] = useState(pullRequest);
  if (pullRequest !== prOpened) {
    setPrOpened(pullRequest);
    const url = pullRequest?.url;
    if (url) openView({ name: `#${numberOf(url)}`, icon: GitPullRequest, key: url, url });
    else if (pullRequest) openView(surfaces.find((s) => s.name === "Pull requests")!);
  }
  const emptyOf = (s: Surface) => (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <s.icon aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-[13px] font-medium text-foreground">{s.empty?.title}</p>
      <p className="text-[12.5px] text-muted-foreground">{s.empty?.hint}</p>
    </div>
  );
  const viewOf = (s: Surface) =>
    s === overview && project ? (
      project.home
    ) : s.name === "Browser" ? (
      <Browser page={browse} remoteHost={remoteHost} agent={agentTabs} />
    ) : s.name === "Agents" && agents ? (
      agents
    ) : s.name === "Knowledge" && knowledge ? (
      knowledge
    ) : s.name === "Terminal" && terminal ? (
      terminal(open && s === current, emptyOf(s))
    ) : s.name === "Files" && files ? (
      files
    ) : s.url && pullRequests ? (
      pullRequests.view(s.url)
    ) : s.name === "Pull requests" && pullRequests?.urls.length ? (
      pullRequests.list
    ) : (
      emptyOf(s)
    );

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
        openView(next);
      }}
      style={expanded ? undefined : { width }}
      className={`relative flex min-w-0 flex-col bg-background ${expanded ? "flex-1" : "shrink-0 border-l border-border"}`}
    >
      {!expanded && onResize && <PanelResize side="right" width={width} onResize={onResize} />}
      <TopBar className={`window-controls-inset px-2 ${topBarClassName}`}>
        {leading}
        <ul aria-label="Open views" className="flex min-w-0 gap-0.5 overflow-x-auto">
          {shown.map((s) => (
            <li
              key={s.key}
              className={`flex shrink-0 items-center rounded-lg ${s === current ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
            >
              <button
                type="button"
                id={`side-panel-tab-${s.key}`}
                aria-current={s === current ? "true" : undefined}
                onClick={() => setActive(s)}
                className={`flex items-center gap-1.5 py-1 pl-2 text-[13px] ${pinned.includes(s) ? "pr-2" : ""}`}
              >
                <s.icon aria-hidden className="size-3.5" />
                {nameOf(s)}
                {s === overview && !!project?.waiting && (
                  <span className="font-mono text-[11px] text-warning tabular-nums">
                    {project.waiting}
                  </span>
                )}
              </button>
              {!pinned.includes(s) && (
                <button
                  type="button"
                  aria-label={`Close ${nameOf(s)}`}
                  title={`Close ${nameOf(s)}`}
                  onClick={() => closeView(s)}
                  className="mx-0.5 grid size-5 place-items-center rounded-md hover:bg-hover [&_svg]:size-3.5"
                >
                  <X />
                </button>
              )}
            </li>
          ))}
        </ul>
        <IconButton
          id="side-panel-open-view"
          label="Open a view"
          onClick={() => {
            setActive(undefined);
            setListing(true);
          }}
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
      {shown.map((s) => (
        <div key={s.key} hidden={s !== current} className="flex min-h-0 flex-1 flex-col">
          {viewOf(s)}
        </div>
      ))}
      {!current && (
        <nav
          aria-labelledby="side-panel-views"
          className="flex flex-1 flex-col items-center justify-center px-8 pb-16"
        >
          <h2 id="side-panel-views" className="mb-4 text-[14px] font-medium">
            Open a view
          </h2>
          <ul className="w-full max-w-72">
            {available.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  aria-keyshortcuts={s.key}
                  onClick={() => openView(s)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-hover"
                >
                  <s.icon aria-hidden className="size-4 shrink-0" />
                  <span className="flex-1">{nameOf(s)}</span>
                  <kbd className="grid size-6 place-items-center rounded-md bg-selected font-sans text-[11.5px] text-muted-foreground">
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
