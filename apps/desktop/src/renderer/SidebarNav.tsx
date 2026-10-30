// The Traditional sidebar's head (0090, 0091): New thread, New project, and Search as rows, then
// the pages Settings shows there and More. Its Pinned section, which folds, sits atop the list.
import {
  ChartNoAxesColumn,
  ChevronDown,
  FolderPlus,
  GitPullRequest,
  LayoutGrid,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import { useShortcutLabel } from "./keybindings";
import { navDefaults, sidebarNav, type NavRow } from "./sidebarPrefs";
import { Fold } from "./SidebarParts";
import { stored } from "./stored";

/** A row in the sidebar's head: its icon and label, and something at its end. */
const navBase =
  "group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-body text-foreground/90 hover:bg-hover hover:text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground [&>svg]:transition-colors";
export const navRow = `${navBase} hover:[&>svg]:text-foreground`;
const navCurrent = "bg-selected text-foreground [&>svg]:text-foreground";

/** The pages Settings › Appearance › Sidebar chooses between, in the order they list. */
export const navChoices: { id: NavRow; label: string; Icon: LucideIcon }[] = [
  { id: "projects", label: "Projects", Icon: LayoutGrid },
  { id: "pullRequests", label: "Pull requests", Icon: GitPullRequest },
  { id: "usage", label: "Usage", Icon: ChartNoAxesColumn },
];

/** Whether More is open, showing the pages Settings leaves out of the head, on this computer. */
export const moreShown = stored("parallax.moreShown", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** Whether the Traditional sidebar's Pinned section is folded, on this computer. */
export const pinnedFolded = stored("parallax.pinnedFolded", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

export function SidebarNav({
  search,
  current,
  onNewThread,
  onOpen,
  onAdd,
}: {
  /** The search box, which reads as a row. */
  search: ReactNode;
  /** The page open in the main pane, which its row shows as selected. */
  current?: NavRow;
  onNewThread: () => void;
  onOpen: (row: NavRow) => void;
  /** Opens the add palette: a new Project or repository. */
  onAdd: () => void;
}) {
  const shown = { ...navDefaults, ...sidebarNav.use() };
  const newKeys = useShortcutLabel("newThread");
  const moreList = useId();
  const moreOpen = moreShown.use();
  // A page's row, under the head or under More.
  const page = ({ id, label, Icon }: (typeof navChoices)[number]) => (
    <button
      key={id}
      type="button"
      aria-current={current === id ? "page" : undefined}
      onClick={() => onOpen(id)}
      className={`${navRow} ${current === id ? navCurrent : ""}`}
    >
      <Icon />
      {label}
    </button>
  );
  const hidden = navChoices.filter((c) => !shown[c.id]);
  return (
    <div className="flex flex-col px-2">
      <button type="button" onClick={onNewThread} className={navRow}>
        <SquarePen />
        <span className="flex-1">New thread</span>
        {newKeys && (
          <kbd
            aria-hidden
            className="font-sans text-meta text-faint-foreground opacity-0 transition-opacity group-hover/nav:opacity-100"
          >
            {newKeys}
          </kbd>
        )}
      </button>
      <button type="button" onClick={onAdd} className={navRow}>
        <FolderPlus />
        New project
      </button>
      {search}
      {navChoices.filter((c) => shown[c.id]).map(page)}
      {/* The pages left out of the head grow in under the rest, the divider moving below them. */}
      <div
        id={moreList}
        inert={!moreOpen}
        className={`grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-out ${moreOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="flex min-h-0 flex-col overflow-hidden *:shrink-0">{hidden.map(page)}</div>
      </div>
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-controls={moreList}
        onClick={() => moreShown.set(!moreOpen)}
        className="group/more mt-1 flex h-6 items-center gap-1 rounded-md px-2 text-meta font-medium text-faint-foreground hover:text-muted-foreground"
      >
        {moreOpen ? "Less" : "More"}
        <ChevronDown
          aria-hidden
          className={`size-3 motion-safe:transition-transform motion-safe:duration-200 ${moreOpen ? "rotate-180" : ""}`}
        />
        <span aria-hidden className="ml-1.5 h-px flex-1 bg-border" />
      </button>
    </div>
  );
}

/**
 * The Traditional sidebar's Pinned section (0091, 0093): one heading that folds its cards, the
 * pinned Projects, orchestrator threads, and threads, as one list.
 */
export function PinnedSection({ children }: { children: ReactNode }) {
  const folded = pinnedFolded.use();
  const list = useId();
  return (
    <section aria-label="Pinned" className="mb-1">
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={list}
        onClick={() => pinnedFolded.set(!folded)}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-meta font-medium text-faint-foreground hover:text-muted-foreground"
      >
        Pinned
        <ChevronDown
          aria-hidden
          className={`size-3 transition-transform ${folded ? "-rotate-90" : ""}`}
        />
      </button>
      <Fold open={!folded}>
        <div id={list} className="flex flex-col gap-1">
          {children}
        </div>
      </Fold>
    </section>
  );
}
