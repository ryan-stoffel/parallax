import {
  ArchiveRestore,
  ArrowLeft,
  Bot,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleSlash,
  Download,
  Ellipsis,
  FileDiff,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitMerge,
  House,
  Laptop,
  LoaderCircle,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
  type ToggleEvent,
} from "react";

import type { UpdateState } from "../preload/bridge";
import type { AgentRun, AgentStatus, Thread } from "../protocol/generated/protocol";
import type { Selection, SettingsSection } from "./App";
import { ConnectionStatus, StatusDot, statusLabel, useConnection } from "./ConnectionStatus";
import { localId, type Host } from "./hosts";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { groupOf, groupThreads, noRepo, type ThreadsView } from "./threads";
import { accountLabel, statusLabel as runStatusLabel } from "./transcript";
import { IconButton, menuItem, menuPanel, moveFocus, TopBar } from "./ui";

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

/**
 * The left column. Its top row holds the macOS traffic lights, then the toggle at the same
 * spot the main pane shows it while this column is hidden, then the app's name.
 */
export function Sidebar({ open, onClose, onNewThread, children }: SidebarProps) {
  return (
    <nav
      id="sidebar"
      aria-label="Sidebar"
      hidden={!open}
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <TopBar className="traffic-light-inset">
        <IconButton
          label="Hide sidebar"
          keys="B"
          aria-expanded
          aria-controls="sidebar"
          onClick={onClose}
        >
          <PanelLeft />
        </IconButton>
        <span className="flex-1 text-[13px] font-bold text-muted-foreground">wisp</span>
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
  /** The open host, whose Projects and threads show under its row. */
  host: Host;
  onHostChange: (hostId: string) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenSettings: (section: SettingsSection, addHost?: boolean) => void;
  threads: ThreadsView;
  /** Deletes a thread. Resolves to an error message, or undefined. */
  onDelete: (thread: Thread) => Promise<string | undefined>;
}

/** Every Project's icon, in the sidebar, the breadcrumb, and its chat. -500 reads on both themes. */
export function ProjectIcon({ className = "" }: { className?: string }) {
  return <FolderKanban aria-hidden className={`text-violet-500 ${className}`} />;
}

// How long a pointer rests on a thread before its card shows. Moving to another thread while
// one shows switches at once.
const cardDelay = 450;

/**
 * Search, then the hosts: the open one shows its Projects (one row each) and its repositories
 * with their threads, and Archived sits under the list. Resting on a thread shows a card with
 * where and how it runs.
 */
export function ThreadList({
  hosts,
  host,
  onHostChange,
  selection,
  onSelect,
  onOpenSettings,
  threads,
  onDelete,
}: ThreadListProps) {
  const newProject = useRef<HTMLDialogElement>(null);
  const addRepositoryDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [toDelete, setToDelete] = useState<Thread>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [card, setCard] = useState<{ thread: Thread; top: number; left: number }>();
  const cardTimer = useRef<number>(undefined);
  // Repositories listed again since the card opened, so sweeping across rows lists each once.
  const refreshed = useRef(new Set<string>());
  const { groups, archived } = groupThreads(threads.state);
  const title = (t: Thread) => threads.state.titles[t.id] ?? "Thread";

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  // Most recently active first, as threads are newest first.
  const shownProjects = threads.state.projects
    .filter((p) => matches(p.name))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shownGroups = groups
    .map((g) => ({ ...g, threads: g.threads.filter((t) => matches(title(t))) }))
    .filter((g) => !q || g.threads.length > 0);
  const shownArchived = archived.filter((t) => matches(title(t)));

  const showCard = (thread: Thread, row: HTMLElement) => {
    window.clearTimeout(cardTimer.current);
    const open = () => {
      const rect = row.getBoundingClientRect();
      // A little clear of the sidebar, and kept on screen: it is at most about 15rem tall.
      const edge = (row.closest("#sidebar") ?? row).getBoundingClientRect().right;
      setCard({ thread, top: Math.min(rect.top, window.innerHeight - 248), left: edge + 12 });
      if (!refreshed.current.has(thread.repo)) {
        refreshed.current.add(thread.repo);
        threads.refresh(thread.repo);
      }
    };
    if (card) open();
    // A card that shows after the delay starts afresh; moving between rows keeps the set.
    else
      cardTimer.current = window.setTimeout(() => {
        refreshed.current.clear();
        open();
      }, cardDelay);
  };
  const hideCard = () => {
    window.clearTimeout(cardTimer.current);
    setCard(undefined);
  };

  const threadRow = (t: Thread) => (
    <ThreadRow
      key={t.id}
      thread={t}
      title={title(t)}
      run={threads.state.runs[t.id]}
      selected={selection.kind === "thread" && selection.threadId === t.id}
      onOpen={() => onSelect({ kind: "thread", threadId: t.id })}
      onArchive={async () => setActionError(await threads.archive(t.id, !t.archived))}
      onDelete={() => {
        setToDelete(t);
        setDeleteError(undefined);
        deleteDialog.current?.showModal();
      }}
      onRest={(row) => showCard(t, row)}
      onLeave={hideCard}
    />
  );

  const addRepository = async () => {
    const path = await window.wisp.pickFolder();
    if (!path) return;
    const repo = await threads.addRepo(path);
    if (typeof repo === "string") return setActionError(repo);
    setActionError(undefined);
    onSelect({ kind: "new", groupId: repo.id });
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    // A running thread's agent is stopped first, so this can take a moment.
    const error = await onDelete(toDelete);
    setDeleting(false);
    if (error) setDeleteError(error);
    else deleteDialog.current?.close();
  };

  const cardGroup = card && groups.find((g) => g.id === groupOf(threads.state, card.thread));

  // The open host's Projects and repositories, under its row.
  const openHost = (
    <div className="pb-3">
      {(!q || shownProjects.length > 0) && (
        <section aria-labelledby="projects-heading" className="mt-2">
          <header className="flex items-center justify-between pr-0.5 pl-2">
            <h2 id="projects-heading" className={heading}>
              Projects
            </h2>
            <IconButton label="New project" onClick={() => newProject.current?.showModal()}>
              <Plus />
            </IconButton>
          </header>
          <ul>
            {shownProjects.map((p) => {
              const selected = selection.kind === "project" && selection.projectId === p.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelect({ kind: "project", projectId: p.id })}
                    className={`${row} ${selected ? current : "text-foreground/80"}`}
                  >
                    <ProjectIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-[11.5px] text-faint-foreground">
                      {age(p.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="repositories-heading" className="mt-4">
        <header className="flex items-center justify-between pr-0.5 pl-2">
          <h2 id="repositories-heading" className={heading}>
            Repositories
          </h2>
          <IconButton
            label="Add repository"
            onClick={() => addRepositoryDialog.current?.showModal()}
          >
            <FolderPlus />
          </IconButton>
        </header>
        {(threads.error ?? actionError) && (
          <p role="alert" className="px-2 pb-1 text-[12px] text-danger">
            {threads.error ?? actionError}
          </p>
        )}
        {shownGroups.map((g) => {
          // A search shows every match, collapsed or not.
          const open = !!q || !collapsed.has(g.id);
          const Icon = g.id === noRepo ? House : open ? FolderOpen : Folder;
          const Chevron = open ? ChevronDown : ChevronRight;
          return (
            <div key={g.id} className="mb-1">
              {/* Clicking shows or hides its threads; hovering swaps the icon for a chevron
                  and shows New thread, lined up with the header's buttons. */}
              <div className="group/repo relative">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(g.id)) next.add(g.id);
                      return next;
                    })
                  }
                  className={`${row} pr-9 text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0`}
                >
                  <Icon
                    aria-hidden
                    className="group-has-[:focus-visible]/repo:hidden group-hover/repo:hidden"
                  />
                  <Chevron
                    aria-hidden
                    className="hidden group-has-[:focus-visible]/repo:block group-hover/repo:block"
                  />
                  <span className="truncate">{g.name}</span>
                </button>
                <div className="absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 group-has-[:focus-visible]/repo:opacity-100 group-hover/repo:opacity-100">
                  <IconButton
                    label={`New thread in ${g.name}`}
                    onClick={() => onSelect({ kind: "new", groupId: g.id })}
                  >
                    <SquarePen />
                  </IconButton>
                </div>
              </div>
              {open &&
                (g.threads.length > 0 ? (
                  <ul>{g.threads.map(threadRow)}</ul>
                ) : (
                  g.id !== noRepo && (
                    <p className="py-1 pl-7.5 text-[12.5px] text-faint-foreground">
                      No threads yet
                    </p>
                  )
                ))}
            </div>
          );
        })}
        {q &&
          shownGroups.length === 0 &&
          shownProjects.length === 0 &&
          shownArchived.length === 0 && (
            <p className="px-2 py-1 text-[12.5px] text-faint-foreground">Nothing matches</p>
          )}
      </section>
    </div>
  );

  return (
    <>
      <div className="px-2">
        <label className="flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5 focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label="Search threads and Projects"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
      </div>
      <div onScroll={hideCard} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <header className="mt-3 flex items-center justify-between pr-0.5 pl-2">
          <h2 id="hosts-heading" className={heading}>
            Hosts
          </h2>
          <IconButton label="Add host" onClick={() => onOpenSettings("hosts", true)}>
            <Plus />
          </IconButton>
        </header>
        <ul aria-labelledby="hosts-heading">
          {hosts.map((h) => (
            <li key={h.id}>
              <HostRow host={h} open={h.id === host.id} onOpen={() => onHostChange(h.id)} />
              {h.id === host.id && openHost}
            </li>
          ))}
        </ul>
      </div>
      {shownArchived.length > 0 && (
        // Pinned under the list, like a drawer: the threads you're done with.
        <details className="group/archived max-h-[40%] shrink-0 overflow-y-auto px-2 pb-1">
          <summary className="flex cursor-default list-none items-center gap-3 rounded-md px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>
              Archived <span className="text-faint-foreground">({shownArchived.length})</span>
            </span>
            <span aria-hidden className="h-px flex-1 bg-border" />
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 transition-transform group-open/archived:rotate-180"
            />
          </summary>
          <ul>{shownArchived.map(threadRow)}</ul>
        </details>
      )}
      {card && (
        <ThreadCard
          title={title(card.thread)}
          run={threads.state.runs[card.thread.id]}
          repo={{
            name: cardGroup?.name ?? "No Repo",
            icon: cardGroup && cardGroup.id !== noRepo ? <FolderOpen /> : <House />,
          }}
          host={host}
          top={card.top}
          left={card.left}
        />
      )}
      <NewProjectDialog
        ref={newProject}
        repos={threads.state.repos}
        local={host.id === localId}
        addRepo={threads.addRepo}
        create={threads.createProject}
        onCreated={(project) => onSelect({ kind: "project", projectId: project.id })}
      />
      <AddRepositoryDialog
        ref={addRepositoryDialog}
        local={host.id === localId}
        onLocalFolder={() => void addRepository()}
      />
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
        <ConnectionStatus hostId={host.id} />
        <Footer onOpenSettings={onOpenSettings} onOpenUsage={() => onSelect({ kind: "usage" })} />
      </div>
    </>
  );
}

/**
 * The footer's buttons: Settings, Usage, and Update when `updatable`, which shows a download
 * icon with a dot while an update is ready to install: a downloaded release, or under `pnpm dev`
 * the commits the channel's branch has. Its label carries the updater's note, such as an error.
 */
function Footer({
  onOpenSettings,
  onOpenUsage,
}: Pick<ThreadListProps, "onOpenSettings"> & { onOpenUsage: () => void }) {
  // "Updating…" while Update runs, then its answer until the next click.
  const [update, setUpdate] = useState<string>();
  const updating = update === "Updating…";
  const [state, setState] = useState<UpdateState>({});
  useEffect(() => (window.wisp.updatable ? window.wisp.onUpdateState(setState) : undefined), []);
  const ready = state.ready !== undefined && !updating;
  const runUpdate = async () => {
    setUpdate("Updating…");
    setUpdate(await window.wisp.update());
  };
  return (
    <>
      {update && (
        <p role="status" className="px-2 py-1 text-[12px] text-muted-foreground">
          {update}
        </p>
      )}
      <div className="flex items-center gap-1">
        <IconButton label="Settings" keys="," onClick={() => onOpenSettings("general")}>
          <Settings />
        </IconButton>
        <IconButton label="Usage" onClick={onOpenUsage}>
          <ChartNoAxesColumn />
        </IconButton>
        {window.wisp.updatable && (
          <span className="ml-auto">
            <IconButton
              label={ready ? `Update ready: ${state.ready}` : (state.note ?? "Update wisp")}
              disabled={updating}
              onClick={() => void runUpdate()}
            >
              {ready ? (
                <span className="relative grid">
                  <Download />
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent"
                  />
                </span>
              ) : (
                <RefreshCw className={updating ? "animate-spin" : undefined} />
              )}
            </IconButton>
          </span>
        )}
      </div>
    </>
  );
}

/** A host's row: its name and a status dot. The open host's error is in the footer. */
function HostRow({ host, open, onOpen }: { host: Host; open: boolean; onOpen: () => void }) {
  const state = useConnection(host.id);
  const Icon = host.destination ? Server : Laptop;
  const status = state && statusLabel(state);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onOpen}
      title={state?.status === "failed" ? state.error.message : status}
      className={`${row} font-medium ${open ? "text-foreground" : "text-muted-foreground"}`}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{host.name}</span>
      <StatusDot state={state} />
      {status && <span className="sr-only">{status}</span>}
    </button>
  );
}

/** Each backend's logo, by its name in `AgentRun.backend`. */
export const backendLogos: Partial<Record<string, ComponentType<SVGProps<SVGSVGElement>>>> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
  cursor: CursorLogo,
};

/**
 * A thread's row: its title and age (or Failed), then its branch, diff, and provider. Resting
 * on it shows its card; hovering or focusing it swaps the age for Archive and more actions,
 * which also open by right-clicking the row: a native popover, so Escape and clicking away
 * close it.
 */
function ThreadRow({
  thread,
  title,
  run,
  selected,
  onOpen,
  onArchive,
  onDelete,
  onRest,
  onLeave,
}: {
  thread: Thread;
  title: string;
  run?: AgentRun;
  selected: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRest: (row: HTMLElement) => void;
  onLeave: () => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    onLeave();
    action();
  };
  const Logo = run?.backend ? backendLogos[run.backend] : undefined;
  const hasDetails = !!(run?.branch || run?.diff || Logo);
  const archiveLabel = (
    <>
      {thread.archived ? <ArchiveRestore aria-hidden /> : <Check aria-hidden />}
      {thread.archived ? "Unarchive" : "Archive"}
    </>
  );
  return (
    <li
      className="group/row relative"
      onMouseEnter={(e) => onRest(e.currentTarget)}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          onLeave();
          actions.current?.click();
        }}
        className={`flex w-full flex-col gap-0.5 rounded-lg py-1.5 pr-2 pl-7.5 text-left hover:bg-hover ${selected ? current : ""}`}
      >
        <span className="flex w-full items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${selected ? "text-foreground" : "text-foreground/80"}`}
          >
            {title}
          </span>
          <span className="shrink-0 text-[11.5px] text-faint-foreground group-has-[:focus-visible]/row:hidden group-hover/row:hidden">
            {run?.status === "failed" ? (
              <span className="flex items-center gap-1 text-danger">
                <CircleAlert aria-hidden className="size-3.5" />
                Failed
              </span>
            ) : (
              age(thread.createdAt)
            )}
          </span>
          {/* An invisible copy of the actions below, holding their width while they show, so a
              long title ends in an ellipsis before them. pr-7.5 is Archive's right padding, the
              gap, and the actions button. */}
          <span
            aria-hidden
            className="invisible hidden shrink-0 items-center gap-1 pr-7.5 pl-1.5 text-[11.5px] group-has-[:focus-visible]/row:flex group-hover/row:flex [&_svg]:size-3.5"
          >
            {archiveLabel}
          </span>
        </span>
        {hasDetails && (
          <span className="flex w-full items-center gap-2 text-[11.5px] text-faint-foreground">
            <span className="min-w-0 flex-1 truncate">{run?.branch}</span>
            {run?.diff && (
              <span className="shrink-0 tabular-nums">
                <span className="text-emerald-500">+{run.diff.insertions}</span>{" "}
                <span className="text-danger">−{run.diff.deletions}</span>
              </span>
            )}
            {Logo && <Logo className="size-3.5 shrink-0" />}
          </span>
        )}
      </button>
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100">
        <button
          type="button"
          onClick={() => {
            onLeave();
            onArchive();
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          {archiveLabel}
        </button>
        <button
          ref={actions}
          type="button"
          aria-label="Thread actions"
          title="Thread actions"
          popoverTarget={menuId}
          className="grid size-5.5 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
        >
          <Ellipsis />
        </button>
      </div>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label="Thread actions"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open")
            e.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} min-w-36 p-1`}
      >
        <button type="button" role="menuitem" className={menuItem} onClick={choose(onArchive)}>
          {thread.archived ? "Unarchive" : "Archive"}
        </button>
        <button
          type="button"
          role="menuitem"
          className={`${menuItem} text-danger`}
          onClick={choose(onDelete)}
        >
          Delete…
        </button>
      </div>
    </li>
  );
}

/** A run's status as its icon and color, in a thread's card and the Agents list. */
export const statusLooks: Partial<Record<AgentStatus, { Icon: LucideIcon; color: string }>> = {
  starting: { Icon: LoaderCircle, color: "text-emerald-500 [&_svg]:animate-spin" },
  running: { Icon: LoaderCircle, color: "text-emerald-500 [&_svg]:animate-spin" },
  completed: { Icon: CircleCheck, color: "text-muted-foreground" },
  failed: { Icon: CircleAlert, color: "text-danger" },
  cancelled: { Icon: CircleSlash, color: "text-muted-foreground" },
  interrupted: { Icon: CirclePause, color: "text-amber-500" },
  accepted: { Icon: GitMerge, color: "text-violet-500" },
};

/**
 * What a thread is, shown beside its row: its title, repository, computer, branch, account,
 * changes, and status, from its run as last listed (resting on the row lists it again).
 */
function ThreadCard({
  title,
  run,
  repo,
  host,
  top,
  left,
}: {
  title: string;
  run?: AgentRun;
  repo: { name: string; icon: ReactNode };
  host: Host;
  top: number;
  left: number;
}) {
  const Logo = run?.backend ? backendLogos[run.backend] : undefined;
  const look = run && (statusLooks[run.status] ?? statusLooks.completed!);
  return (
    <div
      role="tooltip"
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-64 rounded-lg border border-border bg-surface p-3 text-foreground shadow-composer"
    >
      <p className="line-clamp-2 text-[13px] font-medium">{title}</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-2">
        <li>
          {repo.icon}
          <span className="truncate">{repo.name}</span>
        </li>
        <li>
          {host.destination ? <Server /> : <Laptop />}
          <span className="truncate">{host.name}</span>
        </li>
        {run?.branch && (
          <li>
            <GitBranch />
            <span className="truncate">{run.branch}</span>
          </li>
        )}
        {run?.accountId && (
          <li>
            {Logo ? <Logo /> : <Bot />}
            <span className="truncate">{accountLabel(run.accountId)}</span>
          </li>
        )}
        {run?.diff && (
          <li>
            <FileDiff />
            <span className="tabular-nums">
              {run.diff.files} {run.diff.files === 1 ? "file" : "files"}{" "}
              <span className="text-emerald-500">+{run.diff.insertions}</span>{" "}
              <span className="text-danger">−{run.diff.deletions}</span>
            </span>
          </li>
        )}
        {run && look && (
          <li className={look.color}>
            <look.Icon />
            <span className="line-clamp-2">
              {runStatusLabel(run.status)}
              {run.status === "failed" && run.error && `: ${run.error}`}
            </span>
          </li>
        )}
      </ul>
    </div>
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

/** Each Settings section's name, in the nav's order. */
export const settingsNames: Record<SettingsSection, string> = {
  general: "General",
  hosts: "Hosts",
  providers: "Providers",
};
const sections = Object.entries(settingsNames).map(([id, name]) => ({
  id: id as SettingsSection,
  name,
}));

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
