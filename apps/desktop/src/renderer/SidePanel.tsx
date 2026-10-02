import {
  FolderTree,
  GitCompare,
  Globe,
  Maximize2,
  Minimize2,
  NotebookText,
  PanelRight,
  Plus,
  Terminal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Browser } from "./Browser";
import { IconButton, TopBar } from "./ui";

interface Surface {
  name: string;
  icon: LucideIcon;
  /** The letter that opens it from the list. */
  key: string;
  /** Its empty state, or absent while it isn't built or has a view of its own. */
  empty?: { title: string; hint: string };
}

const isBuilt = (s: Surface) => !!s.empty || s.name === "Browser";

const surfaces: Surface[] = [
  {
    name: "Changes",
    icon: GitCompare,
    key: "D",
    empty: { title: "No changes yet", hint: "Edits from this thread show up here for review." },
  },
  {
    name: "Context",
    icon: NotebookText,
    key: "C",
    empty: { title: "No shared context", hint: "Only a Project's agents share context." },
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
  { name: "Files", icon: FolderTree, key: "F" },
  { name: "Browser", icon: Globe, key: "B" },
];

/**
 * The collapsible right column. Each view opens as a tab in its top bar, VS Code style; the + after
 * the tabs, or closing the last one, shows the list of views, where each view's letter opens it
 * while focus is in the panel and the ones not built yet are dimmed. Open tabs stay mounted, so
 * a view keeps its state behind another. The top bar keeps the hide button where the main pane
 * shows it while the panel is closed. Expanded, it fills everything right of the sidebar, and
 * `leading` and `topBarClassName` stand in for the hidden main pane's top-left corner. `agents` and
 * `context` are those views, such as a Project's, in place of their empty states. `remoteHost` is
 * the open host's name when it's an SSH host. `terminal` draws the Terminal view, told whether
 * it's shown and given its empty state.
 */
export function SidePanel({
  open,
  onClose,
  expanded,
  onExpandedChange,
  leading,
  topBarClassName = "",
  agents,
  context,
  remoteHost,
  terminal,
}: {
  open: boolean;
  onClose: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  leading?: ReactNode;
  topBarClassName?: string;
  agents?: ReactNode;
  context?: ReactNode;
  remoteHost?: string;
  terminal?: (shown: boolean, empty: ReactNode) => ReactNode;
}) {
  // The open views in tab order, and the one shown; with none shown, the list is.
  const [tabs, setTabs] = useState<Surface[]>([]);
  const [active, setActive] = useState<Surface>();

  const openView = (s: Surface) => {
    if (!tabs.includes(s)) setTabs([...tabs, s]);
    setActive(s);
  };
  // Closing the shown tab shows the one after it, or before it; closing the last shows the list.
  // Focus moves to the shown tab, or to + with none shown, so it stays in the panel, where the
  // list's letters work.
  const closeView = (s: Surface) => {
    const i = tabs.indexOf(s);
    const rest = tabs.toSpliced(i, 1);
    const next = s === active ? rest[Math.min(i, rest.length - 1)] : active;
    setTabs(rest);
    setActive(next);
    document.getElementById(next ? `side-panel-tab-${next.key}` : "side-panel-open-view")?.focus();
  };
  const emptyOf = (s: Surface) => (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <s.icon aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-[13px] font-medium text-foreground">{s.empty?.title}</p>
      <p className="text-[12.5px] text-muted-foreground">{s.empty?.hint}</p>
    </div>
  );
  const viewOf = (s: Surface) =>
    s.name === "Browser" ? (
      <Browser remoteHost={remoteHost} />
    ) : s.name === "Agents" && agents ? (
      agents
    ) : s.name === "Context" && context ? (
      context
    ) : s.name === "Terminal" && terminal ? (
      terminal(open && s === active, emptyOf(s))
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
        if (active || e.metaKey || e.ctrlKey || e.altKey) return;
        const next = surfaces.find((s) => isBuilt(s) && s.key === e.key.toUpperCase());
        if (!next) return;
        e.preventDefault();
        openView(next);
      }}
      className={`flex flex-col bg-background ${expanded ? "min-w-0 flex-1" : "w-[26rem] shrink-0 border-l border-border"}`}
    >
      <TopBar className={`window-controls-inset px-2 ${topBarClassName}`}>
        {leading}
        <ul aria-label="Open views" className="flex min-w-0 gap-0.5 overflow-x-auto">
          {tabs.map((s) => (
            <li
              key={s.name}
              className={`flex shrink-0 items-center rounded-lg ${s === active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
            >
              <button
                type="button"
                id={`side-panel-tab-${s.key}`}
                aria-current={s === active ? "true" : undefined}
                onClick={() => setActive(s)}
                className="flex items-center gap-1.5 py-1 pl-2 text-[13px]"
              >
                <s.icon aria-hidden className="size-3.5" />
                {s.name}
              </button>
              <button
                type="button"
                aria-label={`Close ${s.name}`}
                title={`Close ${s.name}`}
                onClick={() => closeView(s)}
                className="mx-0.5 grid size-5 place-items-center rounded-md hover:bg-hover [&_svg]:size-3.5"
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
        <IconButton
          id="side-panel-open-view"
          label="Open a view"
          onClick={() => setActive(undefined)}
        >
          <Plus />
        </IconButton>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={expanded ? "Shrink panel" : "Expand panel"}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <IconButton
            label="Hide side panel"
            keys="Alt+B"
            aria-expanded
            aria-controls="side-panel"
            onClick={onClose}
          >
            <PanelRight />
          </IconButton>
        </div>
      </TopBar>
      {tabs.map((s) => (
        <div key={s.name} hidden={s !== active} className="flex min-h-0 flex-1 flex-col">
          {viewOf(s)}
        </div>
      ))}
      {!active && (
        <nav
          aria-labelledby="side-panel-views"
          className="flex flex-1 flex-col items-center justify-center px-8 pb-16"
        >
          <h2 id="side-panel-views" className="mb-4 text-[14px] font-medium">
            Open a view
          </h2>
          <ul className="w-full max-w-72">
            {surfaces.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  disabled={!isBuilt(s)}
                  title={isBuilt(s) ? undefined : "Not built yet"}
                  aria-keyshortcuts={isBuilt(s) ? s.key : undefined}
                  onClick={() => openView(s)}
                  className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] enabled:hover:bg-hover disabled:text-faint-foreground"
                >
                  <s.icon aria-hidden className="size-4 shrink-0" />
                  <span className="flex-1">{s.name}</span>
                  <kbd className="grid size-6 place-items-center rounded-md bg-selected font-sans text-[11.5px] text-muted-foreground group-disabled:opacity-50">
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
