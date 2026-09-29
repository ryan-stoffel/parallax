import {
  ChevronLeft,
  FolderTree,
  GitCompare,
  Globe,
  Maximize2,
  Minimize2,
  NotebookText,
  PanelRight,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { IconButton, TopBar } from "./ui";

interface Surface {
  name: string;
  icon: LucideIcon;
  /** The letter that opens it from the list. */
  key: string;
  /** Its empty state, or absent while it isn't built. */
  empty?: { title: string; hint: string };
}

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
    empty: { title: "No context yet", hint: "Notes your agents share show up here." },
  },
  {
    name: "Agents",
    icon: Workflow,
    key: "A",
    empty: { title: "No agents running", hint: "Subagents this thread starts show up here." },
  },
  { name: "Terminal", icon: Terminal, key: "T" },
  { name: "Files", icon: FolderTree, key: "F" },
  { name: "Browser", icon: Globe, key: "B" },
];

/**
 * The collapsible right column. It opens on a list of views, each with a letter that opens it;
 * the ones not built yet are dimmed. Its top bar keeps the hide button where the main pane
 * shows it while the panel is closed. Expanded, it fills everything right of the sidebar, and
 * `leading` and `topBarClassName` stand in for the hidden main pane's top-left corner.
 */
export function SidePanel({
  open,
  onClose,
  expanded,
  onExpandedChange,
  leading,
  topBarClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  leading?: ReactNode;
  topBarClassName?: string;
}) {
  const [surface, setSurface] = useState<Surface>();

  // From the list, a view's letter opens it, unless the user is typing or in a dialog or menu.
  useEffect(() => {
    if (!open || surface) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element).closest("input, textarea, [contenteditable], dialog, [popover]"))
        return;
      const next = surfaces.find((s) => s.empty && s.key === e.key.toUpperCase());
      if (!next) return;
      e.preventDefault();
      setSurface(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, surface]);

  return (
    <aside
      id="side-panel"
      aria-label="Side panel"
      hidden={!open}
      className={`flex flex-col bg-background ${expanded ? "min-w-0 flex-1" : "w-[26rem] shrink-0 border-l border-border"}`}
    >
      <TopBar className={`window-controls-inset px-2 ${topBarClassName}`}>
        {leading}
        {surface && (
          <button
            type="button"
            onClick={() => setSurface(undefined)}
            className="flex items-center gap-1 rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <ChevronLeft aria-hidden className="size-4" />
            {surface.name}
          </button>
        )}
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
      {surface?.empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
          <surface.icon aria-hidden className="mb-1 size-5 text-faint-foreground" />
          <p className="text-[13px] font-medium text-foreground">{surface.empty.title}</p>
          <p className="text-[12.5px] text-muted-foreground">{surface.empty.hint}</p>
        </div>
      ) : (
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
                  disabled={!s.empty}
                  title={s.empty ? undefined : "Not built yet"}
                  aria-keyshortcuts={s.empty ? s.key : undefined}
                  onClick={() => setSurface(s)}
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
