import {
  ArrowLeft,
  Bug,
  ChevronRight,
  Code,
  Ellipsis,
  Flame,
  Folder,
  House,
  Laptop,
  PanelLeft,
  Plus,
  Search,
  Server,
  Settings,
  SquarePen,
  User,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import type { Thread } from "../protocol/generated/protocol";
import type { Selection, SettingsSection } from "./App";
import { ConnectionStatus } from "./ConnectionStatus";
import { NewProjectDialog } from "./NewProjectDialog";
import type { Host, ModelGroup, ProjectIcon } from "./placeholder";
import { groupThreads, noRepo, type ThreadsView } from "./threads";
import { IconButton, Picker, TopBar } from "./ui";

const row =
  "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover";
const current = "bg-selected text-foreground";
const heading = "text-[11.5px] font-medium text-faint-foreground";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNewThread: () => void;
  children: ReactNode;
}

/** The left column. Its top row holds the macOS traffic lights. */
export function Sidebar({ open, onClose, onNewThread, children }: SidebarProps) {
  return (
    <nav
      id="sidebar"
      aria-label="Sidebar"
      hidden={!open}
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <TopBar className="traffic-light-inset justify-end gap-0.5 px-2">
        <IconButton
          label="Hide sidebar"
          keys="B"
          aria-expanded
          aria-controls="sidebar"
          onClick={onClose}
        >
          <PanelLeft />
        </IconButton>
        <IconButton label="New thread" keys="N" onClick={onNewThread}>
          <SquarePen />
        </IconButton>
      </TopBar>
      {children}
    </nav>
  );
}

interface ThreadListProps {
  hosts: Host[];
  host: Host;
  onHostChange: (hostId: string) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenSettings: () => void;
  models: ModelGroup[];
  threads: ThreadsView;
  /** Deletes a thread. Resolves to an error message, or undefined. */
  onDelete: (thread: Thread) => Promise<string | undefined>;
}

// Glyph and color per ProjectIcon. -500 shades read on both themes.
const projectIcons: Record<ProjectIcon, { Icon: LucideIcon; color: string }> = {
  code: { Icon: Code, color: "text-violet-500" },
  flame: { Icon: Flame, color: "text-orange-500" },
  search: { Icon: Search, color: "text-sky-500" },
  bug: { Icon: Bug, color: "text-amber-600" },
  user: { Icon: User, color: "text-rose-500" },
};

/** Hosts, their Projects (one row each), and repositories with their threads. */
export function ThreadList({
  hosts,
  host,
  onHostChange,
  selection,
  onSelect,
  onOpenSettings,
  models,
  threads,
  onDelete,
}: ThreadListProps) {
  const newProject = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [toDelete, setToDelete] = useState<Thread>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const { groups, archived } = groupThreads(threads.state);
  const title = (t: Thread) => threads.state.titles[t.id] ?? "Thread";

  const threadRow = (t: Thread) => (
    <ThreadRow
      key={t.id}
      thread={t}
      title={title(t)}
      selected={selection.kind === "thread" && selection.threadId === t.id}
      onOpen={() => onSelect({ kind: "thread", threadId: t.id })}
      onArchive={async () => setActionError(await threads.archive(t.id, !t.archived))}
      onDelete={() => {
        setToDelete(t);
        setDeleteError(undefined);
        deleteDialog.current?.showModal();
      }}
    />
  );

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    // A running thread's agent is stopped first, so this can take a moment.
    const error = await onDelete(toDelete);
    setDeleting(false);
    if (error) setDeleteError(error);
    else deleteDialog.current?.close();
  };

  return (
    <>
      <div className="px-2">
        <Picker
          label="Host"
          icon={host.local ? <Laptop /> : <Server />}
          value={host.id}
          onChange={(e) => onHostChange(e.target.value)}
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Picker>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <section aria-labelledby="projects-heading" className="mt-4">
          <div className="flex items-center justify-between pr-0.5 pl-2">
            <h2 id="projects-heading" className={heading}>
              Projects
            </h2>
            <IconButton label="New project" onClick={() => newProject.current?.showModal()}>
              <Plus />
            </IconButton>
          </div>
          <ul>
            {host.projects.map((p) => {
              const { Icon, color } = projectIcons[p.icon];
              const selected = selection.kind === "project" && selection.projectId === p.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelect({ kind: "project", projectId: p.id })}
                    className={`${row} ${selected ? current : "text-foreground/80"}`}
                  >
                    <Icon aria-hidden className={`size-4 shrink-0 ${color}`} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-[11.5px] text-faint-foreground">{p.age}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="repositories-heading" className="mt-4">
          <h2 id="repositories-heading" className={`${heading} px-2 pb-1`}>
            Repositories
          </h2>
          {(threads.error ?? actionError) && (
            <p role="alert" className="px-2 pb-1 text-[12px] text-danger">
              {threads.error ?? actionError}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.id} className="mb-1">
              <button
                type="button"
                title={`New thread in ${g.name}`}
                onClick={() => onSelect({ kind: "new", groupId: g.id })}
                className={`${row} text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0`}
              >
                {g.id === noRepo ? <House aria-hidden /> : <Folder aria-hidden />}
                <span className="truncate">{g.name}</span>
              </button>
              <ul>{g.threads.map(threadRow)}</ul>
            </div>
          ))}
          {archived.length > 0 && (
            <details className="group/archived mt-2">
              <summary
                className={`${row} list-none text-muted-foreground [&::-webkit-details-marker]:hidden`}
              >
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 transition-transform group-open/archived:rotate-90"
                />
                Archived
                <span className="text-faint-foreground">{archived.length}</span>
              </summary>
              <ul>{archived.map(threadRow)}</ul>
            </details>
          )}
        </section>
      </div>
      <NewProjectDialog ref={newProject} repositories={threads.state.repos} models={models} />
      <dialog
        ref={deleteDialog}
        aria-labelledby="delete-thread-title"
        className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form method="dialog" className="px-5 pt-4 pb-4">
          <h2 id="delete-thread-title" className="text-[15px] font-semibold">
            Delete this thread?
          </h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            “{toDelete && title(toDelete)}” goes for good, with its transcript, worktree, and
            branch.
          </p>
          {deleteError && (
            <p role="alert" className="mt-2 text-[12.5px] text-danger">
              {deleteError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="submit"
              value="cancel"
              className="rounded-md px-3 py-1.5 text-[13px] hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void confirmDelete()}
              className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </dialog>
      <div className="border-t border-border p-2">
        {/* Only this Mac's wispd is connected so far (RYA-12); SSH hosts come with RYA-26. */}
        {host.local && <ConnectionStatus hostId="local" />}
        <button type="button" onClick={onOpenSettings} className={`${row} text-muted-foreground`}>
          <Settings className="size-4" />
          Settings
        </button>
      </div>
    </>
  );
}

const menuItem = "flex w-full rounded-md px-2 py-1 text-left text-[13px] hover:bg-hover";

/**
 * A thread's row. Its actions open from a button that shows on hover or focus, or by
 * right-clicking the row: a native popover, so Escape and clicking away close it.
 */
function ThreadRow({
  thread,
  title,
  selected,
  onOpen,
  onArchive,
  onDelete,
}: {
  thread: Thread;
  title: string;
  selected: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    action();
  };
  return (
    <li className="group/row relative">
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          actions.current?.click();
        }}
        className={`${row} pl-7.5 ${selected ? current : "text-foreground/80"}`}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-[11.5px] text-faint-foreground group-focus-within/row:invisible group-hover/row:invisible">
          {age(thread.createdAt)}
        </span>
      </button>
      <button
        ref={actions}
        type="button"
        aria-label="Thread actions"
        title="Thread actions"
        popoverTarget={menuId}
        className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground [&_svg]:size-4"
      >
        <Ellipsis />
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        className="inset-auto m-0 min-w-36 rounded-lg border border-border bg-surface p-1 text-foreground shadow-composer [position-area:bottom_span-left]"
      >
        <button type="button" className={menuItem} onClick={choose(onArchive)}>
          {thread.archived ? "Unarchive" : "Archive"}
        </button>
        <button type="button" className={`${menuItem} text-danger`} onClick={choose(onDelete)}>
          Delete…
        </button>
      </div>
    </li>
  );
}

/** How long ago, as the sidebar writes it: "now", "12m", "3h", "2d", "1w". */
export function age(time: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(time)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

const sections: { id: SettingsSection; name: string }[] = [
  { id: "general", name: "General" },
  { id: "providers", name: "Providers" },
];

/** The sidebar while Settings is open. */
export function SettingsNav({
  section,
  onSection,
  onBack,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-px px-2">
      <button type="button" onClick={onBack} className={`${row} mb-3 text-muted-foreground`}>
        <ArrowLeft className="size-4" />
        Back to app
      </button>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-current={s.id === section ? "page" : undefined}
          onClick={() => onSection(s.id)}
          className={`${row} ${s.id === section ? current : "text-foreground/80"}`}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}
