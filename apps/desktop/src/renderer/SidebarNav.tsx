// The sidebar's head (0090): New thread and Search as rows, the pages Edit sidebar chooses, More,
// and the projects pinned under them.
import {
  ChartNoAxesColumn,
  ChevronDown,
  Ellipsis,
  FolderPlus,
  GitPullRequest,
  LayoutGrid,
  SlidersHorizontal,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, type ReactNode, type Ref } from "react";

import { useShortcutLabel } from "./keybindings";
import type { ProjectEntry } from "./projectList";
import type { FavoriteAction } from "./Favorites";
import { ProjectMenu, ProjectTile } from "./ProjectsPage";
import { navDefaults, sidebarNav, togglePinnedProject, type NavRow } from "./sidebarPrefs";
import { stored } from "./stored";
import { Menu, menuItem, openOnContextMenu } from "./ui";

/** A row in the sidebar's head: its icon and label, and something at its end. */
export const navRow =
  "group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-body text-foreground/90 hover:bg-hover hover:text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground [&>svg]:transition-colors hover:[&>svg]:text-foreground";
const navCurrent = "bg-selected text-foreground [&>svg]:text-foreground";

/** The rows Edit sidebar chooses between, in the order they list. */
export const navChoices: { id: NavRow; label: string; Icon: LucideIcon }[] = [
  { id: "projects", label: "Projects", Icon: LayoutGrid },
  { id: "pullRequests", label: "Pull requests", Icon: GitPullRequest },
  { id: "usage", label: "Usage", Icon: ChartNoAxesColumn },
];

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
  const editDialog = useRef<HTMLDialogElement>(null);
  const moreMenu = useId();
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
      {search}
      {navChoices
        .filter((c) => shown[c.id])
        .map(({ id, label, Icon }) => (
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
        ))}
      <button type="button" popoverTarget={moreMenu} aria-haspopup="menu" className={navRow}>
        <Ellipsis />
        More
      </button>
      <Menu id={moreMenu} label="More" className="w-56 p-1">
        {hidden.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            popoverTarget={moreMenu}
            popoverTargetAction="hide"
            onClick={() => onOpen(id)}
            className={menuItem}
          >
            <Icon />
            {label}
          </button>
        ))}
        {hidden.length > 0 && <hr className="-mx-1 my-1 border-border" />}
        <button
          type="button"
          role="menuitem"
          popoverTarget={moreMenu}
          popoverTargetAction="hide"
          onClick={onAdd}
          className={menuItem}
        >
          <FolderPlus />
          New project or repository
        </button>
        <button
          type="button"
          role="menuitem"
          popoverTarget={moreMenu}
          popoverTargetAction="hide"
          onClick={() => editDialog.current?.showModal()}
          className={menuItem}
        >
          <SlidersHorizontal />
          Edit sidebar…
        </button>
      </Menu>
      <EditSidebar ref={editDialog} />
      {pinned.length > 0 && (
        <section aria-label="Pinned" className="mt-4">
          <button
            type="button"
            aria-expanded={!folded}
            aria-controls={pinnedList}
            onClick={() => pinnedFolded.set(!folded)}
            className="group/fold flex h-7 items-center gap-1 rounded-md px-2 text-meta font-medium text-faint-foreground hover:text-muted-foreground"
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
        className={`${navRow} pr-8 ${open ? navCurrent : ""}`}
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

/** Edit sidebar: which of the pages' rows the sidebar lists. Those it hides stay under More. */
function EditSidebar({ ref }: { ref: Ref<HTMLDialogElement> }) {
  const shown = { ...navDefaults, ...sidebarNav.use() };
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto w-[26rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form method="dialog" className="p-5">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-reading font-semibold">
            Edit sidebar
          </h2>
          <button
            type="submit"
            aria-label="Close"
            className="-mr-1.5 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-body text-muted-foreground">
          Choose which pages appear in your sidebar. Hidden ones stay under More.
        </p>
        <ul className="mt-4 flex flex-col gap-0.5">
          {navChoices.map(({ id, label, Icon }) => (
            <li key={id}>
              <label className="flex h-9 cursor-default items-center gap-3 rounded-lg px-2 text-body hover:bg-hover">
                <input
                  type="checkbox"
                  checked={shown[id]}
                  onChange={(e) => sidebarNav.set({ ...shown, [id]: e.target.checked })}
                  className="size-4 accent-accent"
                />
                <Icon aria-hidden className="size-4 text-muted-foreground" />
                {label}
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-primary px-3.5 py-1.5 text-body font-medium text-primary-foreground hover:opacity-90"
          >
            Done
          </button>
        </div>
      </form>
    </dialog>
  );
}
