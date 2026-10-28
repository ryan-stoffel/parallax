// The sidebar's head (0090): New thread, New project or repository, and Search as rows, then the
// pages Settings shows there, More, and the projects pinned under them.
import {
  ChartNoAxesColumn,
  ChevronDown,
  FolderPlus,
  GitPullRequest,
  LayoutGrid,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, type ReactNode } from "react";

import { useShortcutLabel } from "./keybindings";
import type { ProjectEntry } from "./projectList";
import type { FavoriteAction } from "./Favorites";
import { ProjectMenu, ProjectTile } from "./ProjectsPage";
import { navDefaults, sidebarNav, togglePinnedProject, type NavRow } from "./sidebarPrefs";
import { stored } from "./stored";
import { openOnContextMenu } from "./ui";

/** A row in the sidebar's head: its icon and label, and something at its end. */
const navBase =
  "group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-body text-foreground/90 hover:bg-hover hover:text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground [&>svg]:transition-colors";
export const navRow = `${navBase} hover:[&>svg]:text-foreground`;
const navCurrent = "bg-selected text-foreground [&>svg]:text-foreground";
/** More's and Pinned's headings, which fold what's under them. */
const sectionToggle =
  "flex h-7 items-center gap-1 self-start rounded-md px-2 text-meta font-medium text-faint-foreground hover:text-muted-foreground";

/** A pinned project's row: its glyph gray until hovered, focused, or open, then its color. */
const pinRow = `${navBase} hover:[&>svg]:text-(--tint) focus-visible:[&>svg]:text-(--tint) aria-[current=page]:bg-selected aria-[current=page]:text-foreground aria-[current=page]:[&>svg]:text-(--tint)`;

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

/** Whether the Pinned list is folded, on this computer. */
const pinnedFolded = stored("parallax.pinnedFolded", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

export function SidebarNav({
  search,
  current,
  pinned,
  openKey,
  onNewThread,
  onOpen,
  onOpenProject,
  onAdd,
  pinActions,
}: {
  /** The search box, which reads as a row. */
  search: ReactNode;
  /** The page open in the main pane, which its row shows as selected. */
  current?: NavRow;
  /** The pinned projects that still exist, in the order pinned. */
  pinned: ProjectEntry[];
  /** The open project's key, which its pinned row shows as selected. */
  openKey?: string;
  onNewThread: () => void;
  onOpen: (row: NavRow) => void;
  onOpenProject: (entry: ProjectEntry) => void;
  /** Opens the add palette: a new Project, or a repository. */
  onAdd: () => void;
  /** A pinned project's menu items after Unpin. */
  pinActions: (entry: ProjectEntry) => FavoriteAction[];
}) {
  const shown = { ...navDefaults, ...sidebarNav.use() };
  const folded = pinnedFolded.use();
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
  const pinnedList = useId();
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
        New project or repository
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
      {pinned.length > 0 && (
        <section aria-label="Pinned" className="mt-3">
          <button
            type="button"
            aria-expanded={!folded}
            aria-controls={pinnedList}
            onClick={() => pinnedFolded.set(!folded)}
            className={sectionToggle}
          >
            Pinned
            <ChevronDown
              aria-hidden
              className={`size-3 transition-transform duration-150 ${folded ? "-rotate-90" : ""}`}
            />
          </button>
          {!folded && (
            <ul id={pinnedList} className="flex flex-col">
              {pinned.map((p) => (
                <PinnedRow
                  key={p.key}
                  entry={p}
                  open={p.key === openKey}
                  onOpen={() => onOpenProject(p)}
                  actionsFor={() => pinActions(p)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** A pinned project's row: its tile and name, a dot while it needs the user, and its menu. */
function PinnedRow({
  entry,
  open,
  onOpen,
  actionsFor,
}: {
  entry: ProjectEntry;
  open: boolean;
  onOpen: () => void;
  actionsFor: () => FavoriteAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <li onContextMenu={(e) => openOnContextMenu(e, trigger.current)} className="group/pin relative">
      <button
        type="button"
        aria-current={open ? "page" : undefined}
        onClick={onOpen}
        className={`${pinRow} pr-8`}
      >
        <ProjectTile entry={entry} size="glyph" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.needsYou && (
          <span
            role="img"
            aria-label="Needs you"
            className="size-1.5 shrink-0 rounded-full bg-warning group-hover/pin:hidden"
          />
        )}
      </button>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/pin:opacity-100 group-hover/pin:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        <ProjectMenu
          entry={entry}
          pinned
          onTogglePin={() => togglePinnedProject(entry.key)}
          actionsFor={actionsFor}
          trigger={trigger}
          className="grid size-6 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground"
        />
      </div>
    </li>
  );
}
