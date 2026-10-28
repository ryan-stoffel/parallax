import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowUp,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleX,
  Ellipsis,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  GitMerge,
  Globe,
  HardDrive,
  Keyboard,
  Layers,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  MousePointerClick,
  Palette,
  PanelLeftClose,
  PencilLine,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  MessagesSquare,
  Laptop,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type SVGProps,
  type ToggleEvent,
} from "react";

import type {
  AgentRun,
  AgentStatus,
  GitStatus,
  Project,
  ProjectAutonomy,
  ProjectIcon as ProjectIconValue,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import type { RpcError } from "../preload/bridge";
import type { Selection, SettingsSection, Split } from "./App";
import { clock } from "./Approval";
import { drafts, threadDrafts, type Draft } from "./drafts";
import { AddDialog, type AddDialogHandle } from "./AddDialog";
import {
  highlight,
  jumpTarget,
  parseScope,
  scopeStore,
  searchMatch,
  searchWords,
  type Scope,
} from "./scope";
import {
  activeAt,
  attentionOf,
  shortBranch,
  initials,
  lastUserPrompt,
  mostUrgent,
  projectAttention,
  snoozeChoices,
  snoozed,
  type Attention,
} from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { locale } from "./locale";
import { AutonomyChoice } from "./ProjectPermission";
import { resumeTime } from "./ResumeCard";
import { ConnectionStatus } from "./ConnectionStatus";
import { DeviceIcon } from "./DeviceIcon";
import { hostIcon } from "./RunTargetMenu";
import { ProfileButton } from "./ProfileMenu";
import { localId, type Host } from "./hosts";
import { IconPicker } from "./IconPicker";
import { imageUrl } from "./images";
import { ClaudeLogo, CursorLogo, OpenAILogo, ParallaxMark } from "./logos";
import { NightSky } from "./NightSky";
import { dismiss, notify } from "./notifications";
import { iconColors, iconLook } from "./projectIcons";
import { ForkMenu } from "./Fork";
import { archivePageSize, pinnedProjects, sidebarPrefs, type NavRow } from "./sidebarPrefs";
import { SidebarNav, navRow } from "./SidebarNav";
import { projectEntries, type ProjectEntry } from "./projectList";
import { stored } from "./stored";

import { useFlip } from "./flip";
import { draggedThread, dragThread } from "./threadDrag";
import {
  asksOf,
  groupOf,
  waitingOf,
  projectRuns,
  repoIconOf,
  setRepoIcons,
  threadProjects,
  type ForkChoice,
  type ProjectChange,
  type ThreadsView,
} from "./threads";
import { accountLabel, isRunning, statusLabel as runStatusLabel } from "./transcript";
import {
  ConfirmDialog,
  IconButton,
  Menu,
  menuItem,
  menuPanel,
  moveFocus,
  openOnContextMenu,
  RowBadge,
  rowShortcut,
  shortcut,
  TopBar,
  useModHeld,
} from "./ui";
import { PanelResize } from "./PanelResize";
import { numberOf } from "./github";
import { lookOf, usePullRequests, type PullRequests } from "./PullRequests";
import { instanceLogo, instanceName } from "./providers";
import { UpdateButton } from "./Update";
import { clockOptions } from "./prefs";
import { bindingsOf, formatKeybinding, tileCommands, useKeybindings } from "./keybindings";
import { TileGlyph } from "./SplitTiles";
import { flushToasts, toast, undo, useToasts } from "./undo";

import {
  autoClear,
  compactRows,
  draggedPin,
  favoriteOrder,
  forgetPin,
  pinDragType,
  pinIcons,
  orderOf,
  pinFavorites,
  pinLayout,
  pinUnread,
  todayGroup,
  todayFolded,
} from "./pins";
import { Favorites, type FavoriteAction } from "./Favorites";
import { Fold, quietFor, shownRows, Tick, ViewOptions } from "./SidebarParts";
import { DropLine, PinList, type PinDrag } from "./PinList";
import { searchSettings, settingsSections } from "./settings/search";
import { cancelPrefetch, prefetchThread } from "./threadWatches";

const row =
  "flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left text-body hover:bg-hover";
const current = "bg-selected text-foreground";
const sectionHeading =
  "flex h-7 items-center gap-1 px-2 text-meta font-medium text-faint-foreground";
const emptyNote = "px-2 py-1 text-body text-faint-foreground";

interface SidebarProps {
  width?: number;
  onResize?: (width: number) => void;
  open: boolean;
  onClose: () => void;
  onNewThread: () => void;
  children: ReactNode;
}

/**
 * The left column. Its top row holds the macOS traffic lights, then the toggle at the same
 * spot the main pane shows it while this column is hidden, then the app's mark and name, which
 * open a new thread. A nightly build paints a sky behind that row and the Search row under it, as
 * the column's own background (index.css), with stars and clouds (NightSky.tsx).
 */
export function Sidebar({
  open,
  onClose,
  onNewThread,
  children,
  width = 288,
  onResize,
}: SidebarProps) {
  return (
    <nav
      id="sidebar"
      aria-label="Sidebar"
      hidden={!open}
      style={{ width }}
      className="night-sky-host relative flex min-w-0 shrink-0 flex-col border-r border-border bg-pane-sidebar"
    >
      <NightSky />
      {onResize && <PanelResize side="left" width={width} onResize={onResize} />}
      {/* Positioned, so it paints over the sky. */}
      <TopBar className="traffic-light-inset night-sky-text relative">
        <IconButton
          label="Hide sidebar"
          command="sidebar"
          aria-expanded
          aria-controls="sidebar"
          onClick={onClose}
        >
          <PanelLeftClose />
        </IconButton>
        <button
          type="button"
          onClick={onNewThread}
          className="mr-auto flex items-center gap-1.5 rounded-md px-1 py-0.5 font-brand text-reading font-semibold tracking-tight text-foreground hover:bg-hover"
        >
          <ParallaxMark className="size-5" />
          Parallax
        </button>
      </TopBar>
      {children}
    </nav>
  );
}

/** A host and its threads and Projects, as the sidebar merges them. */
export interface HostThreads {
  host: Host;
  view: ThreadsView;
}

interface ThreadListProps {
  /** Every host's list, this computer first. */
  hosts: HostThreads[];
  /** The open host: where a new Project goes by default, and whose connection the footer shows. */
  host: Host;
  selection: Selection;
  /** Opens something on `hostId`, which becomes the open host. */
  onSelect: (hostId: string, selection: Selection) => void;
  /** Opens a Project, on another host by opening that host first. */
  onOpenProject: (hostId: string, projectId: string) => void;
  onOpenSettings: (section: SettingsSection) => void;
  /** The page open in place of the main pane, whose nav row reads as selected (0090). */
  page?: NavRow;
  /** Opens Projects, Pull requests, or Usage in place of the main pane. */
  onOpenPage: (page: NavRow) => void;
  /** The open Space, as `<host>/<id>`, whose pinned row reads as selected. */
  openSpace?: string;
  /** A project's menu, for the Projects page's cards (0090). */
  projectMenu?: Ref<ProjectMenuHandle>;
  /** Opens Create Space, from the add palette's New Space, where the open host makes Spaces. */
  onNewSpace?: () => void;
  /** Deletes a thread. Resolves to an error message, or undefined. */
  onDelete: (hostId: string, thread: Thread) => Promise<string | undefined>;
  /** The add palette, for the command menu's New Project and Add repository (PLX-993). */
  addDialog?: Ref<AddDialogHandle>;
  /** New thread, which opens Mod+N's picker of the repository it goes in. */
  onNewThread: () => void;
  /** The two threads open side by side (PLX-587), shown together above the list. */
  split?: Split;
  /** Opens a thread of the open host beside the open thread. */
  onOpenBeside: (threadId: string) => void;
  /** Closes a thread's side of the split. */
  onClosePane: (threadId: string) => void;
}

/**
 * A Project's icon, in the sidebar, the breadcrumb, its chat, and Create Project: its uploaded
 * image as a rounded square (0038), else its glyph in its color, or `Layers` in the accent
 * for none, or for a name or color this app doesn't know.
 */
export function ProjectIcon({
  icon,
  className = "",
}: {
  icon?: ProjectIconValue;
  className?: string;
}) {
  // An <svg> like the glyph's, so every place's glyph size (`[&_svg]:size-*`) fits the image too.
  if (icon?.image)
    return (
      <svg
        aria-hidden
        data-icon-image
        viewBox="0 0 24 24"
        width={24}
        height={24}
        className={`[clip-path:inset(0_round_22%)] ${className}`}
      >
        <image
          href={imageUrl(icon.image)}
          width={24}
          height={24}
          preserveAspectRatio="xMidYMid slice"
        />
      </svg>
    );
  const { Icon, color } = iconLook(icon);
  return <Icon aria-hidden className={`${color} ${className}`} />;
}

/**
 * Every computer's repository icons by name (`sharedRepoIcons`), which App provides, so a repo
 * with no icon of its own draws its namesake's.
 */
export const SharedRepoIcons = createContext<ReadonlyMap<string, ProjectIconValue>>(new Map());

/**
 * A repo's color: `icon`'s, its own or its namesake's (`repoIconOf`), or else one picked from its
 * name, as its initials' tile shows.
 */
function repoColor(repo: Repo, icon: ProjectIconValue | undefined) {
  const palette = iconColors.slice(1);
  if (icon?.color) return `var(--project-${icon.color})`;
  if (icon) return "var(--accent)";
  let hash = 0;
  for (let i = 0; i < repo.name.length; i++) hash = (hash * 31 + repo.name.charCodeAt(i)) | 0;
  return `var(--project-${palette[Math.abs(hash) % palette.length]!.key})`;
}

/**
 * A repo's icon: the one the user chose, in a Project's shape (0033), or its namesake's on
 * another computer, or else its initials on a tile in a color picked from its name. No repo is a
 * laptop, and a Space with no icon of its own two speech bubbles (0090).
 */
export function RepoIcon({ repo }: { repo?: Repo }) {
  const shared = useContext(SharedRepoIcons);
  const size = "size-4";
  if (!repo || repo.scratch)
    return <Laptop aria-hidden className={`${size} shrink-0 text-faint-foreground`} />;
  const icon = repoIconOf(repo, shared);
  if (icon) return <ProjectIcon icon={icon} className={`${size} shrink-0`} />;
  // A Space with no icon draws the Space glyph, as on the Projects page (0090).
  if (repo.space)
    return <MessagesSquare aria-hidden className={`${size} shrink-0 text-project-gray`} />;
  return (
    <span
      aria-hidden
      style={{ color: repoColor(repo, undefined) }}
      className={`grid ${size} shrink-0 place-items-center rounded-sm bg-current/15 text-micro leading-none font-semibold`}
    >
      {/* Drawn from the attribute, so the tile adds nothing to the text around it. */}
      <span data-initials={initials(repo.name)} className="before:content-[attr(data-initials)]" />
    </span>
  );
}

// How long a pointer rests on a thread before its card shows. Moving to another thread while
// one shows switches at once.
const cardDelay = 450;

/** A scope's drawers, by whether each is open. Working stays tucked away until asked for. */
type Sections = Record<"working" | "snoozed" | "archived", boolean>;
const sectionDefaults: Sections = {
  working: false,
  snoozed: false,
  archived: false,
};
const record = <T,>(raw: unknown, fallback: Record<string, T>) =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, T>) : fallback;
/** Which drawers each scope has open (PLX-789), kept on this computer. */
export const sectionsStore = stored<Record<string, Partial<Sections>>>(
  "parallax:sections",
  {},
  record,
);
/** Each scope's last open row, by key, so switching back reopens it. */
const lastOpenStore = stored<Record<string, string>>("parallax:lastOpen", {}, record);

/** One row of the list: a thread, or a Project, with its host and what it asks of the user. */
type Item = (
  | { kind: "thread"; thread: Thread; run?: AgentRun }
  | { kind: "project"; project: Project; runs: AgentRun[] }
) & {
  key: string;
  host: Host;
  view: ThreadsView;
  repo?: Repo;
  attention: Attention;
  /** When it was last active (`activeAt`), for the order. */
  at: string;
  title: string;
  /** What search reads besides its messages: its title, repo, branch, and pull request numbers. */
  text: string;
};

/**
 * A thread's attention, Done or Failed again while it's marked unread (pins.ts) and finished, as
 * though never seen.
 */
const markedUnread = (attention: Attention, run: AgentRun | undefined, marked: boolean) =>
  marked && attention === "settled" && run && !isRunning(run.status) && run.status !== "waiting"
    ? run.status === "failed"
      ? "failed"
      : "done"
    : attention;

/**
 * Why Local folder can't browse a computer, by id. This computer's folders are read by main, so it
 * always can; another needs a connected plxd with `hostFolders`.
 */
const unbrowsable = (hosts: HostThreads[]) =>
  new Map(
    hosts.flatMap(({ host, view }): [string, string][] =>
      host.id === localId || "hostFolders" in view.capabilities
        ? []
        : [[host.id, Object.keys(view.capabilities).length ? "Update plxd to browse" : "Offline"]],
    ),
  );

const mac = () => window.parallax.platform === "darwin";
/** Whether a press is Mod (Cmd on macOS, Ctrl elsewhere) and nothing else, as with Mod+Z. */
const modOnly = (e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) =>
  (mac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey;
/** The threads auto-archive archived this session, each once, so an Undo sticks. */
const autoArchived = new Set<string>();

/** Text cut to fit a toast. */
const short = (text: string) => (text.length > 30 ? `${text.slice(0, 28).trimEnd()}…` : text);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const working = (a: Attention) => a === "working" || a === "monitoring" || a === "waiting";
/** Whether a host keeps thread pins: `pins`, or `areas` on a plxd from before areas were removed. */
const pinsOn = (view: ThreadsView) => "pins" in view.capabilities || "areas" in view.capabilities;

/**
 * Slides sidebar rows out, each `stagger` ms after the one above, before they're archived; the
 * rows under them then close the gap (flip.ts). `done` settles once they're gone, and is absent
 * with nothing to slide, as under reduced motion, so archiving waits only on a slide.
 * `restore(keys)` brings those rows back, every one by default, for archives that failed.
 */
function sweepOut(keys: string[], to: string, stagger = 0) {
  const still = document.documentElement.classList.contains("reduce-motion");
  const moves = new Map(
    (still ? [] : keys).flatMap((key, n) => {
      const row = document.querySelector<HTMLElement>(`#sidebar [data-flip="${CSS.escape(key)}"]`);
      if (typeof row?.animate !== "function") return [];
      const move = row.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: to },
        ],
        // A long sweep staggers only its first rows, so it never drags on.
        {
          duration: 180,
          delay: Math.min(n, 8) * stagger,
          easing: "cubic-bezier(.4,0,1,1)",
          fill: "forwards",
        },
      );
      return [[key, move] as const];
    }),
  );
  return {
    done: moves.size
      ? Promise.all([...moves.values()].map((m) => m.finished.catch(() => {}))).then(() => {})
      : undefined,
    restore: (back = keys) => {
      for (const key of back) moves.get(key)?.cancel();
    },
  };
}

/**
 * Search, the repo filter, a menu to create a Project or add a repository, and New thread, then
 * every host's Projects as rows (PLX-1043), the favorites (pinned threads moved up), the other
 * pinned threads (0075), a divider with Clear and the View panel, and Today: every other open
 * thread, most recently active first, so one that finishes rises to the top, grouped as View says.
 * Nothing left, Today is blank. A thread row shows its title, how long ago it was last active or
 * what it asks of the user, its repo, git status, and pull request; its card adds its branch, which
 * search also matches. Threads another thread started don't list (0041); a Project's show only
 * inside it (0042). While a thread is working it sits in a Working drawer above Snoozed and Archived, until it
 * finishes. Rows that move slide to their place. Changes the user makes show a toast with Undo,
 * which ⌘Z also runs. Resting on a thread shows a card.
 */
export function ThreadList({
  hosts,
  host,
  selection,
  onSelect,
  onOpenProject,
  onOpenSettings,
  page,
  onOpenPage,
  openSpace,
  projectMenu,
  onNewSpace,
  onDelete,
  addDialog: addDialogRef,
  onNewThread,
  split,
  onOpenBeside,
  onClosePane,
}: ThreadListProps) {
  const addDialog = useRef<AddDialogHandle>(null);
  useImperativeHandle(addDialogRef, () => ({ open: (start) => addDialog.current?.open(start) }));
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const projectDialogs = useRef<ProjectDialogsHandle>(null);
  const spaceDelete = useRef<HTMLDialogElement>(null);
  // The Space the delete dialog asks about, and its host's view.
  const [spaceToDelete, setSpaceToDelete] = useState<ProjectEntry>();
  const pins = pinnedProjects.use();
  // The thread or Project the delete dialog asks about.
  const [toDelete, setToDelete] = useState<Item>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  // Threads deleted with Undo still offered: hidden until the toast goes, then deleted.
  const [doomed, setDoomed] = useState<ReadonlySet<string>>(new Set());
  // Threads sliding out to be archived, so a second E, click, or Clear meanwhile does nothing.
  const leaving = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const { workingSection, pageArchived } = sidebarPrefs.use();
  // The rows picked with ⌘-click, ⇧-click, or X, by key, and where a ⇧-click range starts.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string>(undefined);
  const [renaming, setRenaming] = useState<string>();
  // Threads that just finished, flashing once.
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  // The row to focus after the next render: by key, or by place, as the one that takes an
  // archived row's place.
  const focusNext = useRef<{ key?: string; index?: number; skip?: string }>(undefined);
  // Bumped to render once more after setting `focusNext` outside a render, as when plxd answers.
  const [, refocus] = useState(0);
  const card = useRef<CardHandle>(null);
  // Snoozes end on time even with nothing else changing.
  const now = useMinute();
  // The hosts as they are now, for an Undo that runs after later changes.
  const latest = useRef(hosts);
  useEffect(() => {
    latest.current = hosts;
  });
  const viewOf = (hostId: string) => latest.current.find((h) => h.host.id === hostId)?.view;
  // Changes that aren't moves, such as switching repos or typing a search, don't slide rows.
  const quiet = useFlip("#sidebar");

  const open = hosts.find((h) => h.host.id === host.id)?.view;
  const many = hosts.length > 1;
  // Threads marked unread (pins.ts) read as Done or Failed again until opened.
  const unread = pinUnread.use();
  const sharedIcons = useContext(SharedRepoIcons);

  // A chosen repo that's gone, deleted or not loaded yet, shows everything, keeping the choice
  // for its return. A Space chosen while Spaces showed (0073) shows everything too.
  const chosen = scopeStore.use();
  const parsed = parseScope(chosen);
  const scopeRepo =
    parsed.kind === "repo"
      ? hosts
          .find((h) => h.host.id === parsed.hostId)
          ?.view.state.repos.find((r) => !r.scratch && !r.space && r.id === parsed.id)
      : undefined;
  const scope: Scope = parsed.kind === "repo" && !scopeRepo ? "all" : chosen;
  const scopeLabel = scopeRepo
    ? { name: scopeRepo.name, color: repoColor(scopeRepo, repoIconOf(scopeRepo, sharedIcons)) }
    : scope === "none"
      ? { name: "No repo", color: "var(--faint-foreground)" }
      : undefined;
  const sections = { ...sectionDefaults, ...sectionsStore.use()[scope] };
  const toggleSection = (name: keyof Sections, value = !sections[name]) => {
    quiet();
    const all = sectionsStore.get();
    sectionsStore.set({ ...all, [scope]: { ...all[scope], [name]: value } });
  };

  // What arrives animates in (index.css), but not the first load: the sidebar settles a moment
  // after its threads first list, and again each time the list mounts, as back from Settings.
  const loaded = hosts.some(({ view }) => view.state.threads.length > 0);
  useEffect(() => {
    if (!loaded) return;
    const sidebar = document.getElementById("sidebar");
    const timer = window.setTimeout(() => sidebar?.setAttribute("data-settled", ""), 400);
    return () => {
      window.clearTimeout(timer);
      sidebar?.removeAttribute("data-settled");
    };
  }, [loaded]);

  const items: Item[] = hosts.flatMap(({ host: h, view }) => {
    const { state } = view;
    const repoOf = (id: string) => state.repos.find((r) => r.id === id);
    // A Project's children show only inside it, and count toward its row's status (0042).
    const inProject = threadProjects(state);
    const threads = state.threads
      .filter((t) => !inProject.get(t.id))
      .map((t): Item => {
        const run = state.runs[t.id];
        const repo = repoOf(t.repo);
        const title = state.titles[t.id] ?? "Thread";
        return {
          kind: "thread",
          thread: t,
          run,
          key: `${h.id}/${t.id}`,
          host: h,
          view,
          repo,
          attention: markedUnread(
            attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)),
            run,
            unread.includes(`${h.id}/${t.id}`),
          ),
          at: activeAt(t, run, state.stoppedAt[t.id]),
          title,
          text: [
            title,
            repo && !repo.scratch ? repo.name : "No repo",
            run?.branch,
            ...(run?.pullRequests ?? []).map((url) => `#${numberOf(url)}`),
          ].join(" "),
        };
      });
    const projects = state.projects.map((p): Item => {
      const runs = projectRuns(state, p.id, inProject);
      return {
        kind: "project",
        project: p,
        runs,
        key: `${h.id}/${p.id}`,
        host: h,
        view,
        repo: state.repos.find((r) => r.path === p.repoPath),
        attention: projectAttention(runs, (id) => asksOf(state, id)),
        // Its last change, or when one of its runs last stopped, so finished work raises it too.
        at: runs.reduce((at, r) => {
          const stopped = state.stoppedAt[r.id];
          return stopped && !isRunning(r.status) && Date.parse(stopped) > Date.parse(at)
            ? stopped
            : at;
        }, p.updatedAt),
        title: p.name,
        text: p.name,
      };
    });
    return [...threads, ...projects];
  });
  const byKey = new Map(items.map((i) => [i.key, i]));
  // The thread at the top of `key`'s family, as far up as it lists; `key` for one no thread started.
  const topOf = (key: string) => {
    let top = key;
    for (const seen = new Set<string>(); !seen.has(top);) {
      seen.add(top);
      const i = byKey.get(top);
      const up =
        i?.kind === "thread" && i.thread.parent ? `${i.host.id}/${i.thread.parent}` : undefined;
      if (!up || !byKey.has(up)) break;
      top = up;
    }
    return top;
  };
  // Threads another started don't list (0075), so the row at the top of a family also says when one
  // of them waits on the user, or failed since that row was last read. Counts and ⌥↓ go by each
  // thread's own status. A family with one still working, or waiting out a usage limit, isn't
  // cleared.
  const familyNews = new Map<string, Attention>();
  const busyFamilies = new Set<string>();
  for (const i of items) {
    const top = byKey.get(topOf(i.key));
    if (i.kind !== "thread" || top === i || top?.kind !== "thread") continue;
    if (working(i.attention) || i.run?.status === "waiting") busyFamilies.add(top.key);
    const read = top.thread.seenAt ? Date.parse(top.thread.seenAt) : 0;
    const failedSince = i.attention === "failed" && !!i.run && Date.parse(i.run.updatedAt) > read;
    if (i.attention === "needsYou" || failedSince)
      familyNews.set(top.key, mostUrgent([familyNews.get(top.key) ?? top.attention, i.attention]));
  }
  // What a row shows, and where: its own status, or its family's news.
  const rowAttention = (i: Item) => familyNews.get(i.key) ?? i.attention;
  // Where a thread is, for its card: its repo, or No repo.
  // The Space a thread was added to (0090), which it shows and filters as, over where it works.
  const addedTo = (item: Item) => (item.kind === "thread" ? item.thread.space : undefined);
  const placeOf = (item: Item) => {
    const space = addedTo(item);
    const repo = (space && item.view.state.repos.find((r) => r.id === space)) || item.repo;
    return {
      name: repo && !repo.scratch ? repo.name : "No repo",
      icon: <RepoIcon repo={repo} />,
    };
  };

  const inScope = (item: Item, s: Scope) => {
    const p = parseScope(s);
    if (p.kind === "all") return true;
    if (p.kind === "none") return (!item.repo || item.repo.scratch) && !addedTo(item);
    return (
      p.kind === "repo" &&
      item.host.id === p.hostId &&
      (item.repo?.id === p.id || addedTo(item) === p.id)
    );
  };
  const isArchived = (i: Item) => i.kind === "thread" && !!i.thread.archived;
  // A snoozed thread wakes early when it, or one it started, needs the user.
  const isSnoozed = (i: Item) => i.kind === "thread" && snoozed(i.thread, rowAttention(i), now);
  const needsYou = (i: Item) => i.attention === "needsYou" && !isArchived(i) && !doomed.has(i.key);
  const needsIn = (s: Scope) => items.filter((i) => needsYou(i) && inScope(i, s)).length;
  const outside =
    scope === "all" ? 0 : items.filter((i) => needsYou(i) && !inScope(i, scope)).length;
  // Every row that needs the user, newest first, in one order across every scope (PLX-789).
  const jumpList = items
    .filter(needsYou)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key))
    .map((i) => i.key);

  // Search reads each row's text, and plxd's index of its messages (PLX-372), word by word.
  const words = searchWords(query);
  const wordsKey = words.join(" ");
  const [found, setFound] = useState<{
    words: string;
    hits: Map<string, Set<string>>;
    snippets: Map<string, string>;
  }>();
  useEffect(() => {
    if (!wordsKey) return;
    let live = true;
    const timer = setTimeout(async () => {
      const hits = new Map<string, Set<string>>();
      const snippets = new Map<string, string>();
      const searchable = latest.current.filter(({ view }) => "threadContext" in view.capabilities);
      await Promise.all(
        wordsKey.split(" ").flatMap((word) =>
          searchable.map(async ({ host: h }) => {
            const answer = await window.parallax.request(h.id, "thread/search", {
              query: word,
              limit: 100,
            });
            if (!("result" in answer)) return;
            const set = hits.get(word) ?? new Set<string>();
            hits.set(word, set);
            for (const t of answer.result.threads) set.add(`${h.id}/${t.id}`);
            for (const [id, text] of Object.entries(answer.result.snippets ?? {}))
              if (text && !snippets.has(`${h.id}/${id}`)) snippets.set(`${h.id}/${id}`, text);
          }),
        ),
      );
      if (live) setFound({ words: wordsKey, hits, snippets });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wordsKey]);
  const hits = found?.words === wordsKey ? found : undefined;
  // By key: the words each shown row matched only in its messages.
  const matched = new Map<string, string[]>();
  for (const i of items) {
    const m = searchMatch(words, i.text, (w) => !!hits?.hits.get(w)?.has(i.key));
    if (m) matched.set(i.key, m);
  }
  // While plxd's matches in messages are on their way, an empty list isn't "No matches" yet.
  const searching = !hits && hosts.some(({ view }) => "threadContext" in view.capabilities);
  const snippetOf = (i: Item) =>
    matched.get(i.key)?.length ? hits?.snippets.get(i.key) : undefined;

  // Threads another thread started, subagents among them, don't list (0075).
  const shown = items
    .filter((i) => inScope(i, scope) && matched.has(i.key) && !doomed.has(i.key))
    .filter((i) => !(i.kind === "thread" && i.thread.parent))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // The favorite threads stay in the order they're moved into (pins.ts).
  const favOrder = favoriteOrder.use();
  const favRank = (key: string) => {
    const n = favOrder.indexOf(key);
    return n < 0 ? Infinity : n;
  };
  const pool = shown.filter((i) => i.kind === "thread" && !isArchived(i) && !isSnoozed(i));
  const snoozedItems = shown.filter((i) => !isArchived(i) && isSnoozed(i));
  const archived = shown.filter(isArchived);
  // Unsent New Thread prompts (PLX-788), above the threads, on hosts still listed.
  const draftRows = drafts.use().flatMap((d) => {
    const view = hosts.find((h) => h.host.id === d.hostId)?.view;
    if (!view) return [];
    const repo = view.state.repos.find((r) => r.id === d.groupId);
    const inRepo =
      scope === "all" ||
      (scope === "none" ? !repo || repo.scratch : scope === `repo:${d.hostId}/${repo?.id}`);
    return inRepo && words.every((w) => d.text.toLowerCase().includes(w))
      ? [{ draft: d, repo }]
      : [];
  });

  // Pinned threads stay put; the rest sit in Working while they work (PLX-777: a thread waiting on
  // background work or a watched pull request stays there too).
  const pinned = pool.filter((i) => i.kind === "thread" && i.thread.pinned);
  const unpinned = pool.filter((i) => !pinned.includes(i));
  // The pinned threads moved up into the favorites, which leave the pinned rows.
  const favoriteKeys = pinFavorites.use();
  const favoriteThreads = favoriteKeys.flatMap((k) => {
    const i = byKey.get(k);
    return i?.kind === "thread" &&
      i.thread.pinned &&
      !isArchived(i) &&
      !isSnoozed(i) &&
      !doomed.has(k) &&
      matched.has(k)
      ? [i]
      : [];
  });
  // The other pinned threads, as rows atop Today in the order dragged into (PLX-1043).
  const pinOrder = pinLayout.use();
  const pinnedRows = orderOf(
    pinOrder,
    pinned.flatMap((i) => (favoriteThreads.some((f) => f === i) ? [] : [i.key])),
  ).map((k) => byKey.get(k)!);
  const workingTops = workingSection ? unpinned.filter((i) => working(rowAttention(i))) : [];
  const topThreads = unpinned.filter((i) => !workingTops.includes(i));
  const selectedKey =
    selection.kind === "thread"
      ? `${host.id}/${selection.threadId}`
      : selection.kind === "project"
        ? `${host.id}/${selection.projectId}`
        : undefined;
  // The row that reads as open: the open thread's, or while a thread another started is open, which
  // doesn't list, the row of the thread at the top of its family.
  const openKey = selectedKey && topOf(selectedKey);
  // Opening a thread marked unread reads it.
  useEffect(() => {
    if (selectedKey && unread.includes(selectedKey))
      pinUnread.set(pinUnread.get().filter((k) => k !== selectedKey));
  }, [selectedKey, unread.includes(selectedKey ?? "")]);
  // Today, grouped as its View says: under each repo, most recent first, or under each day, as a
  // list over time reads.
  const groupBy = todayGroup.use();
  const compact = compactRows.use();
  const foldedGroups = todayFolded.use();
  // A search shows every match, folded or not.
  const isFolded = (key: string) => !words.length && foldedGroups.includes(key);
  const dayOf = (at: string) => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = new Date(at);
    day.setHours(0, 0, 0, 0);
    const days = Math.round((start.getTime() - day.getTime()) / 864e5);
    return days <= 0
      ? "Today"
      : days === 1
        ? "Yesterday"
        : days < 7
          ? "Earlier this week"
          : "Older";
  };
  const repoOfRow = (i: Item) => (i.repo && !i.repo.scratch ? i.repo : undefined);
  const groupKey = (i: Item) =>
    groupBy === "repo" ? `${i.host.id}/${repoOfRow(i)?.id ?? "none"}` : dayOf(i.at);
  // Today's rows in the order they show: each group where its newest row falls, and none from a
  // folded group.
  const groupPlace = new Map<string, number>();
  for (const i of topThreads)
    if (!groupPlace.has(groupKey(i))) groupPlace.set(groupKey(i), groupPlace.size);
  const todayRows =
    groupBy === "none"
      ? topThreads
      : topThreads
          .filter((i) => !isFolded(groupKey(i)))
          .sort((a, b) => groupPlace.get(groupKey(a))! - groupPlace.get(groupKey(b))!);
  // Mod+1 to Mod+9 open the first nine rows shown, which show their badges while Mod is held: the
  // pinned threads' rows, then Today's threads, then Working's, while it's open.
  const listed = [...pinnedRows, ...todayRows, ...(sections.working ? workingTops : [])];
  const modHeld = useModHeld();
  // Opening a row hides its card, which would cover what it opens.
  const openItem = (item: Item) => {
    hideCard();
    onSelect(
      item.host.id,
      item.kind === "thread"
        ? { kind: "thread", threadId: item.thread.id }
        : { kind: "project", projectId: item.project.id },
    );
  };

  // Switching scope reopens the row last open there, if it still is and isn't archived.
  const setScope = (next: Scope, reopen = true) => {
    quiet();
    scopeStore.set(next);
    setPicked(new Set());
    const last = reopen ? byKey.get(lastOpenStore.get()[next] ?? "") : undefined;
    if (last && last.key !== selectedKey && inScope(last, next) && !isArchived(last))
      openItem(last);
  };
  useEffect(() => {
    const item = selectedKey ? byKey.get(selectedKey) : undefined;
    if (!item || !inScope(item, scope) || lastOpenStore.get()[scope] === selectedKey) return;
    lastOpenStore.set({ ...lastOpenStore.get(), [scope]: selectedKey! });
  });

  // ⌥↓ and ⌥↑: the next or previous row that needs the user, switching to every thread when it's
  // outside this scope.
  const jump = (step: 1 | -1) => {
    const key = jumpTarget(jumpList, selectedKey, step);
    const item = key ? byKey.get(key) : undefined;
    if (!item) return toast("Nothing needs you right now");
    if (!inScope(item, scope)) {
      setScope("all", false);
      toast(`Switched to All threads for “${short(item.title)}”`);
    }
    if (!matched.has(item.key)) setQuery("");
    focusNext.current = { key: item.key };
    openItem(item);
  };

  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    const rows = shownRows().filter((r) => r.dataset["row"] !== next.skip);
    focusNext.current = undefined;
    const row =
      next.key !== undefined
        ? rows.find((r) => r.dataset["row"] === next.key)
        : rows[Math.min(next.index ?? 0, rows.length - 1)];
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  });

  // A thread that just finished flashes once.
  const lastAttention = useRef(new Map<string, Attention>());
  useEffect(() => {
    const done = items.filter(
      (i) => i.attention === "done" && working(lastAttention.current.get(i.key) ?? "settled"),
    );
    lastAttention.current = new Map(items.map((i) => [i.key, i.attention]));
    if (!done.length) return;
    const keys = done.map((i) => i.key);
    setFlashing((f) => new Set([...f, ...keys]));
    setTimeout(() => setFlashing((f) => new Set([...f].filter((k) => !keys.includes(k)))), 1800);
  });

  // Held-back deletes go through once the list closes, or the window does, so nothing is left
  // half done; their Undo ends then.
  useEffect(() => {
    window.addEventListener("beforeunload", flushToasts);
    return () => {
      window.removeEventListener("beforeunload", flushToasts);
      flushToasts();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const target = e.target as HTMLElement;
      const n = rowShortcut(e);
      const item = n === undefined ? undefined : listed[n];
      if (item) {
        e.preventDefault();
        return openItem(item);
      }
      // ⌥↓ and ⌥↑, but not where they move the caret through text.
      const prose = target.tagName === "TEXTAREA" || target.isContentEditable;
      const plainAlt = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
      if (plainAlt && !prose && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        return jump(e.key === "ArrowDown" ? 1 : -1);
      }
      const typing = prose || target.tagName === "INPUT" || target.tagName === "SELECT";
      if (typing) return;
      if (modOnly(e) && e.code === "KeyZ") {
        if (undo()) e.preventDefault();
      } else if (e.key === "Escape" && picked.size) {
        e.preventDefault();
        setPicked(new Set());
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const hideCard = () => {
    cancelPrefetch();
    card.current?.hide();
  };

  const askDelete = (item: Item) => {
    setToDelete(item);
    setDeleteError(undefined);
    deleteDialog.current?.showModal();
  };

  // What the user changes shows a toast with Undo, which puts back only what they changed.
  // After E or S on the row `key`, once plxd answers: focus the row now at `focusAt`, the one that
  // took its place, unless focus has moved on since, as to another row or into the search box. The
  // row that left can still list for a render, until its host's change arrives, so it's skipped.
  const focusAfter = (key: string, focusAt?: number) => {
    const here = document.activeElement;
    const on = here?.closest<HTMLElement>("[data-row]")?.dataset["row"];
    if (focusAt === undefined || (here && here !== document.body && on !== key)) return;
    focusNext.current = { index: focusAt, skip: key };
    refocus((n) => n + 1);
  };
  // `focusAt` comes from E, for `focusAfter`.
  const archive = async (item: Item, focusAt?: number) => {
    if (item.kind !== "thread" || leaving.current.has(item.key)) return;
    const { thread: t, host: h } = item;
    const was = !!t.archived;
    leaving.current.add(item.key);
    // Archiving, the row slides away first; it comes back if plxd says no.
    const sweep = was ? undefined : sweepOut([item.key], "translateX(-12px)");
    if (sweep?.done) await sweep.done;
    const error = await item.view.archive(t.id, !was);
    leaving.current.delete(item.key);
    actionFailed(error, was ? "Couldn't unarchive the thread" : "Couldn't archive the thread");
    if (error) return sweep?.restore();
    focusAfter(item.key, focusAt);
    toast(was ? "Unarchived" : `Archived “${short(item.title)}”`, () => {
      void viewOf(h.id)?.archive(t.id, was);
    });
  };
  const snoozeUntil = async (item: Item, until: Date, focusAt?: number) => {
    if (item.kind !== "thread") return;
    const { thread: t, host: h } = item;
    const was = t.snoozedUntil;
    const error = await item.view.update(t.id, { snoozedUntil: until.toISOString() });
    actionFailed(error, "Couldn't snooze the thread");
    if (error) return;
    // A row that stays, as one already snoozed or archived or that needs the user, keeps focus.
    const stays = isSnoozed(item) || isArchived(item) || rowAttention(item) === "needsYou";
    focusAfter(item.key, stays ? undefined : focusAt);
    const ending = until.getTime() <= Date.now();
    toast(ending ? "Unsnoozed" : `Snoozed until ${when(until)}`, () => {
      // A snooze that ended meanwhile ends now.
      void viewOf(h.id)?.update(t.id, { snoozedUntil: was ?? new Date().toISOString() });
    });
  };
  // A thread row dragged onto another section (PLX-1095): Today takes it out of Archived or
  // Snoozed, Snoozed snoozes it for an hour, and Archived archives it.
  const takes = (to: "today" | "snoozed" | "archived", item: Item) =>
    to === "today"
      ? isArchived(item) || isSnoozed(item)
      : to === "snoozed"
        ? "threadAttention" in item.view.capabilities && (isArchived(item) || !isSnoozed(item))
        : !isArchived(item);
  const moveTo = async (to: "today" | "snoozed" | "archived", item: Item) => {
    setMovingKey(undefined);
    if (to === "archived") return archive(item);
    if (isArchived(item)) await archive(item);
    if (to === "snoozed") await snoozeUntil(item, new Date(Date.now() + 36e5));
    else if (isSnoozed(item)) await snoozeUntil(item, new Date());
  };
  // The section a dragged row would land in, if it takes the row.
  const dropOn = (to: "snoozed" | "archived") =>
    moving && takes(to, moving) ? () => void moveTo(to, moving) : undefined;
  const markUnread = (item: Item) => {
    pinUnread.set([...pinUnread.get().filter((k) => k !== item.key), item.key]);
    toast(`Marked “${short(item.title)}” unread`, () =>
      pinUnread.set(pinUnread.get().filter((k) => k !== item.key)),
    );
  };
  const pin = async (item: Item) => {
    if (item.kind !== "thread" || item.thread.parent) return;
    const { thread: t, host: h } = item;
    const was = !!t.pinned;
    const error = await item.view.update(t.id, { pinned: !was });
    actionFailed(error, was ? "Couldn't unpin the thread" : "Couldn't pin the thread");
    if (!error)
      toast(was ? "Unpinned" : "Pinned to top", () => {
        void viewOf(h.id)?.update(t.id, { pinned: was });
      });
  };
  const rename = async (item: Item, title: string | undefined) => {
    setRenaming(undefined);
    focusNext.current = { key: item.key };
    const next = title?.trim();
    if (item.kind !== "thread" || !next || next === item.title) return;
    const { thread: t, host: h } = item;
    const was = t.title ?? "";
    const error = await item.view.update(t.id, { title: next });
    actionFailed(error, "Couldn't rename the thread");
    if (!error)
      toast("Renamed", () => {
        void viewOf(h.id)?.update(t.id, { title: was });
      });
  };
  // The picked threads that are still listed. Projects can't be picked.
  const pickedItems = [...picked].flatMap((k) => {
    const i = byKey.get(k);
    return i?.kind === "thread" && !doomed.has(k) ? [i] : [];
  });
  const pick = (item: Item, range: boolean) => {
    if (item.kind !== "thread") return;
    const next = new Set(picked);
    const from = anchor.current;
    if (range && from) {
      const keys = shownRows('[data-kind="thread"]').map((r) => r.dataset["row"]!);
      const [a, b] = [keys.indexOf(from), keys.indexOf(item.key)];
      if (a >= 0 && b >= 0)
        for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k);
    } else if (!next.delete(item.key)) next.add(item.key);
    anchor.current = item.key;
    setPicked(next);
  };
  const bulk = async (action: "archive" | "snooze" | "pin") => {
    const list = pickedItems.map((i) => ({ item: i, t: i.thread }));
    if (!list.length) return;
    const n = plural(list.length, "thread");
    const errors: (string | undefined)[] = [];
    if (action === "archive") {
      const keys = list.map(({ item }) => item.key);
      if (keys.some((k) => leaving.current.has(k))) return;
      for (const k of keys) leaving.current.add(k);
      const sweep = sweepOut(keys, "translateX(-12px)", 25);
      if (sweep.done) await sweep.done;
      errors.push(...(await Promise.all(list.map(({ item, t }) => item.view.archive(t.id, true)))));
      for (const k of keys) leaving.current.delete(k);
      sweep.restore(keys.filter((_, n) => errors[n]));
      setPicked(new Set());
      toast(`Archived ${n}`, () => {
        for (const { item, t } of list)
          if (!t.archived) void viewOf(item.host.id)?.archive(t.id, false);
      });
    } else if (action === "snooze") {
      // Only where plxd keeps snoozes (`threadAttention`).
      const able = list.filter(({ item }) => "threadAttention" in item.view.capabilities);
      if (!able.length) return;
      const until = new Date(Date.now() + 3_600_000).toISOString();
      errors.push(
        ...(await Promise.all(
          able.map(({ item, t }) => item.view.update(t.id, { snoozedUntil: until })),
        )),
      );
      setPicked(new Set());
      toast(`Snoozed ${plural(able.length, "thread")} for an hour`, () => {
        for (const { item, t } of able)
          void viewOf(item.host.id)?.update(t.id, {
            snoozedUntil: t.snoozedUntil ?? new Date().toISOString(),
          });
      });
    } else {
      // Only top-level threads, where plxd keeps pins.
      const tops = list.filter(({ item, t }) => !t.parent && pinsOn(item.view));
      if (!tops.length) return;
      const on = !tops.every(({ t }) => t.pinned);
      errors.push(
        ...(await Promise.all(tops.map(({ item, t }) => item.view.update(t.id, { pinned: on })))),
      );
      toast(`${on ? "Pinned" : "Unpinned"} ${plural(tops.length, "thread")}`, () => {
        for (const { item, t } of tops)
          void viewOf(item.host.id)?.update(t.id, { pinned: !!t.pinned });
      });
    }
    actionFailed(errors.find(Boolean), `Couldn't ${action} every thread`);
  };
  const rowKeys = (e: ReactKeyboardEvent<HTMLElement>, item: Item) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    const rows = shownRows();
    const at = rows.indexOf(e.currentTarget);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const thread = item.kind === "thread";
    const can = (capability: string) => thread && capability in item.view.capabilities;
    const act = (run: () => void, after?: { key?: string }) => {
      e.preventDefault();
      focusNext.current = after;
      run();
    };
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      const next = rows[at + (key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (key === "e" && thread) act(() => void archive(item, at));
    else if (key === "s" && can("threadAttention") && !e.shiftKey)
      act(() => void snoozeUntil(item, new Date(Date.now() + 3_600_000), at));
    else if (key === "p" && thread && pinsOn(item.view) && !item.thread.parent)
      act(() => void pin(item), { key: item.key });
    else if (key === "r" && can("threadLineage")) act(() => setRenaming(item.key));
    else if (key === "u" && thread && item.attention === "settled") act(() => markUnread(item));
    else if (key === "a")
      act(() =>
        e.currentTarget
          .closest("li")
          ?.querySelector<HTMLElement>('[aria-label$="actions"]')
          ?.click(),
      );
    else if (key === "x" && thread) act(() => pick(item, e.shiftKey), { key: item.key });
    else if ((key === "Backspace" || key === "Delete") && thread) act(() => askDelete(item));
  };

  // A thread's row. `nested`, under its repo's heading, it needn't name the repo. A pinned one
  // moves among the pins with `pinDrag`.
  const row = (item: Item, nested = false, pinDrag?: PinDrag) => {
    if (item.kind !== "thread") return null;
    const n = modHeld ? listed.indexOf(item) : -1;
    const badge = n >= 0 && n < 9 ? <RowBadge index={n} /> : undefined;
    const selected = item.key === openKey;
    const { thread: t, view } = item;
    const pinnable = pinsOn(view) && !t.parent;
    return (
      <ThreadRow
        key={item.key}
        look={compact ? "compact" : undefined}
        at={item.at}
        {...(pinDrag && { pinDrag })}
        rowKey={item.key}
        thread={t}
        hostId={item.host.id}
        device={many && item.host.icon ? item.host : undefined}
        title={item.title}
        run={item.run}
        repo={item.repo}
        attention={rowAttention(item)}
        selected={selected}
        picked={picked.has(item.key)}
        flash={flashing.has(item.key)}
        badge={badge}
        nested={nested}
        words={words}
        snippet={snippetOf(item)}
        renaming={renaming === item.key}
        snoozable={"threadAttention" in view.capabilities}
        renamable={"threadLineage" in view.capabilities}
        autoResumable={"autoResume" in view.capabilities}
        onOpen={(e) => {
          const mod = mac() ? e.metaKey : e.ctrlKey;
          if (mod || e.shiftKey) return pick(item, e.shiftKey);
          setPicked(new Set());
          anchor.current = item.key;
          openItem(item);
        }}
        onOpenPr={(pr) => {
          setPicked(new Set());
          anchor.current = item.key;
          onSelect(item.host.id, { kind: "thread", threadId: t.id, pr });
        }}
        onKeys={(e) => rowKeys(e, item)}
        onArchive={() => void archive(item)}
        onSnooze={(until) => void snoozeUntil(item, until)}
        onPin={pinnable ? () => void pin(item) : undefined}
        onMarkUnread={
          item.attention === "settled" && item.run && !isRunning(item.run.status)
            ? () => markUnread(item)
            : undefined
        }
        onRename={(title) => void rename(item, title)}
        onStartRename={() => setRenaming(item.key)}
        onDelete={() => askDelete(item)}
        onOpenBeside={
          item.host.id === host.id && selection.kind === "thread" && !selected
            ? () => onOpenBeside(t.id)
            : undefined
        }
        onFork={
          "threadFork" in view.capabilities
            ? async (choice) => {
                const forked = await view.fork(t.id, undefined, choice);
                if (typeof forked !== "string") return forked;
                onSelect(item.host.id, { kind: "thread", threadId: forked });
                return undefined;
              }
            : undefined
        }
        onAutoResume={async (autoResume) => {
          const answer = await window.parallax.request(item.host.id, "agent/autoResume", {
            runId: t.id,
            ...(autoResume !== undefined && { autoResume }),
          });
          actionFailed(
            "error" in answer ? answer.error.message : undefined,
            "Couldn't change auto-resume",
          );
        }}
        onRest={restCard(item)}
        onLeave={hideCard}
      />
    );
  };
  // The open thread's card would only repeat what the thread shows. Another's watch opens, so a
  // click shows it at once.
  const restCard = (item: Item) => (el: HTMLElement) => {
    if (item.kind !== "thread" || item.key === selectedKey) return;
    prefetchThread(item.host.id, item.thread.id);
    card.current?.show(el, {
      title: item.title,
      run: item.run,
      repo: placeOf(item),
      host: item.host,
      snoozedUntil: item.thread.snoozedUntil,
    });
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    if (toDelete.kind === "thread") {
      // Held back while Undo can take it back; it goes once the toast does.
      const { key, host: h, thread: t, title } = toDelete;
      deleteDialog.current?.close();
      setDoomed((d) => new Set(d).add(key));
      if (key === selectedKey)
        onSelect(h.id, { kind: "new", groupId: groupOf(toDelete.view.state, t) });
      const restore = () =>
        setDoomed((d) => {
          const next = new Set(d);
          next.delete(key);
          return next;
        });
      toast(`Deleted “${short(title)}”`, restore, () => {
        void onDelete(h.id, t).then((error) => {
          restore();
          actionFailed(error, "Couldn't delete the thread");
        });
      });
      return;
    }
    setDeleting(true);
    // Running agents are stopped first, so this can take a moment. Deleting the open Project
    // leaves it once it's gone from the list (App.tsx).
    const error = await toDelete.view.removeProject(toDelete.project.id);
    setDeleting(false);
    if (error) setDeleteError(error);
    else deleteDialog.current?.close();
  };

  const confirmSpaceDelete = async () => {
    if (!spaceToDelete) return;
    setDeleting(true);
    const error = await spaceToDelete.view.removeSpace(spaceToDelete.id);
    setDeleting(false);
    if (error) return setDeleteError(error);
    spaceDelete.current?.close();
    pinnedProjects.set(pinnedProjects.get().filter((k) => k !== spaceToDelete.key));
    if (openSpace === spaceToDelete.key) onSelect(spaceToDelete.host.id, { kind: "new" });
  };

  // Each favorite's icon, chosen for it, else its repo's.
  const pinIconsNow = pinIcons.use();
  const [listOver, setListOver] = useState(false);
  // The thread row being dragged, for the sections it could move to (PLX-1095).
  const [movingKey, setMovingKey] = useState<string>();
  useEffect(() => {
    const start = (e: DragEvent) => {
      const t = e.dataTransfer ? draggedThread(e.dataTransfer) : undefined;
      setMovingKey(t && `${t.hostId}/${t.runId}`);
    };
    const end = () => setMovingKey(undefined);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
    };
  }, []);
  const moving = movingKey === undefined ? undefined : byKey.get(movingKey);
  // A thread's own actions where it shows out of Today, pinned or a favorite, as on its row.
  const threadActions = (i: Item & { kind: "thread" }): FavoriteAction[] => [
    ...(i.host.id === host.id && selection.kind === "thread" && i.key !== openKey
      ? [
          {
            label: "Open side by side",
            icon: <Columns2 aria-hidden />,
            run: () => onOpenBeside(i.thread.id),
          },
        ]
      : []),
    { label: "Archive", icon: <Archive aria-hidden />, shortcut: "E", run: () => void archive(i) },
    ...("threadAttention" in i.view.capabilities
      ? [
          {
            label: "Snooze for an hour",
            icon: <AlarmClock aria-hidden />,
            shortcut: "S",
            run: () => void snoozeUntil(i, new Date(Date.now() + 3_600_000)),
          },
        ]
      : []),
    {
      label: "Delete…",
      icon: <Trash2 aria-hidden />,
      danger: true,
      shortcut: "⌫",
      run: () => askDelete(i),
    },
  ];
  // A favorite's square: its chosen icon, else its repo's, its status, and its thread's actions.
  const pinOf = (i: Item & { kind: "thread" }) => {
    const chosen = pinIconsNow[i.key];
    const repo = repoOfRow(i);
    return {
      icon: chosen ? (
        <ProjectIcon icon={chosen} className="size-4" />
      ) : repo ? (
        <RepoIcon repo={repo} />
      ) : (
        <MessageSquare aria-hidden className="size-4 text-muted-foreground" />
      ),
      attention: rowAttention(i),
      thread: { hostId: i.host.id, id: i.thread.id },
      actions: threadActions(i),
      onKeys: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (/^(e|s|backspace|delete)$/i.test(e.key)) rowKeys(e, i);
      },
    };
  };
  // Moves `key` into the favorites, last (pins.ts).
  const favorite = (key: string) =>
    pinFavorites.set([...pinFavorites.get().filter((k) => k !== key), key]);
  const unfavorite = (key: string) => {
    if (pinFavorites.get().includes(key))
      pinFavorites.set(pinFavorites.get().filter((k) => k !== key));
  };
  const unpinKey = (key: string) => {
    const item = byKey.get(key);
    if (item?.kind === "thread" && item.thread.pinned) void pin(item);
  };
  // A favorite's or pin's row opens, or shows its card, by its key.
  const openKeyed = (key: string) => {
    const item = byKey.get(key);
    if (item) openItem(item);
  };
  const restKeyed = (key: string, el: HTMLElement) => {
    const item = byKey.get(key);
    if (item) restCard(item)(el);
  };

  const pinList = (
    <PinList
      keys={pinnedRows.map((i) => i.key)}
      searching={words.length > 0}
      row={(key, drag) => {
        const item = byKey.get(key);
        return item && row(item, false, drag);
      }}
      onPinThread={(hostId, threadId) => {
        const item = byKey.get(`${hostId}/${threadId}`);
        if (item?.kind !== "thread") return;
        // An archived or snoozed row dropped on the pins comes back too (PLX-1095).
        if (takes("today", item)) void moveTo("today", item);
        if (!item.thread.pinned && !item.thread.parent) void pin(item);
      }}
      onPlaced={unfavorite}
    />
  );
  // A pinned thread dragged onto the thread list unpins, and an archived or snoozed one comes back.
  const unpinning = (e: ReactDragEvent<HTMLElement>) =>
    e.dataTransfer.types.includes(pinDragType) && draggedPin()?.kind === "thread";
  const listZone = {
    onDragOver: (e: ReactDragEvent<HTMLElement>) => {
      if (!unpinning(e) && !(moving && takes("today", moving))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setListOver(true);
    },
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setListOver(false);
    },
    onDrop: (e: ReactDragEvent<HTMLElement>) => {
      setListOver(false);
      const dragged = draggedPin();
      if (dragged?.kind === "thread") {
        e.preventDefault();
        forgetPin(dragged.key);
        unfavorite(dragged.key);
        unpinKey(dragged.key);
      } else if (moving && takes("today", moving)) {
        e.preventDefault();
        void moveTo("today", moving);
      }
    },
  };
  const listLook = listOver ? dropLook : "";
  const newsDot: Partial<Record<Attention, string>> = {
    failed: "bg-danger",
    done: "bg-added",
    needsYou: "bg-warning",
  };
  // Opening a thread in a folded group opens the group, so its row shows.
  const openGroup = groupBy === "none" ? undefined : topThreads.find((i) => i.key === openKey);
  const openGroupKey = openGroup && groupKey(openGroup);
  useEffect(() => {
    if (openGroupKey && todayFolded.get().includes(openGroupKey))
      todayFolded.set(todayFolded.get().filter((k) => k !== openGroupKey));
  }, [openKey]);
  const grouped = (rows: Item[]): ReactNode => {
    if (groupBy === "none") return rows.map((i) => row(i));
    const groups = new Map<string, { label: ReactNode; rows: Item[] }>();
    for (const i of rows) {
      const repo = repoOfRow(i);
      const key = groupKey(i);
      const label =
        groupBy === "repo" ? (
          <>
            <RepoIcon repo={repo} />
            <span className="min-w-0 truncate">{repo?.name ?? "No repo"}</span>
            {/* Repos on two computers can share a name. */}
            {many && (
              <span className="min-w-0 truncate font-normal text-faint-foreground">
                {i.host.name}
              </span>
            )}
          </>
        ) : (
          key
        );
      groups.set(key, { label, rows: [...(groups.get(key)?.rows ?? []), i] });
    }
    // Each group under a heading that folds it, which while folded shows whether anything in it
    // finished or failed, and sticks to the top while its rows scroll under it. Alt-click folds or
    // opens them all.
    return [...groups].map(([key, g]) => {
      const open = !isFolded(key);
      const urgent = mostUrgent(g.rows.map(rowAttention));
      return (
        <li key={key} className="mt-2 first:mt-0">
          <div className="sticky top-0 z-10 bg-sidebar">
            <button
              type="button"
              aria-expanded={open}
              disabled={words.length > 0}
              onClick={(e) =>
                todayFolded.set(
                  e.altKey
                    ? open
                      ? [...new Set([...foldedGroups, ...groups.keys()])]
                      : foldedGroups.filter((k) => !groups.has(k))
                    : open
                      ? [...foldedGroups, key]
                      : foldedGroups.filter((k) => k !== key),
                )
              }
              className="group/heading flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-meta font-medium text-muted-foreground transition-colors outline-none enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              {g.label}
              <span className="shrink-0 overflow-hidden rounded-full bg-foreground/[0.06] px-1.5 text-caption leading-4 text-faint-foreground">
                <Tick value={g.rows.length} />
              </span>
              {!open && newsDot[urgent] && (
                <span aria-hidden className={`dot-in size-1.5 rounded-full ${newsDot[urgent]}`} />
              )}
              <span aria-hidden className="mx-1 h-px flex-1 bg-border" />
              <ChevronDown
                aria-hidden
                className={`text-faint-foreground transition-[transform,opacity] duration-200 ${open ? "opacity-0 group-enabled/heading:group-hover/heading:opacity-100" : "-rotate-90"}`}
              />
            </button>
          </div>
          <Fold open={open}>
            {/* Under its repo's heading, a row needn't name the repo: title and status, then details. */}
            <ul className={cardGap}>{g.rows.map((i) => row(i, groupBy === "repo"))}</ul>
          </Fold>
        </li>
      );
    });
  };
  // With nothing left, Today is blank (PLX-1043); a search that finds nothing says so.
  const threadList = (rows: Item[]) => {
    const empty = draftRows.length === 0 && rows.length === 0;
    return (
      // It fills the space left, so a pinned, archived, or snoozed thread can drop anywhere in it.
      <div {...listZone} className={`flex-1 rounded-lg transition-colors ${listLook}`}>
        <ul aria-label="Threads" className={cardGap}>
          {draftRows.map(({ draft, repo }) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              repo={repo}
              onOpen={() =>
                onSelect(draft.hostId, { kind: "new", groupId: draft.groupId, draft: draft.id })
              }
            />
          ))}
          {grouped(rows)}
        </ul>
        {empty && words.length > 0 && <p className={emptyNote}>Nothing matches</p>}
      </div>
    );
  };

  // What auto-archive may archive: a finished thread in Today already seen, but not one waiting
  // out a usage limit (0049), which resumes on its own, or one whose family is still at work.
  const archivable = topThreads.filter(
    (i) =>
      i.kind === "thread" &&
      rowAttention(i) === "settled" &&
      i.run?.status !== "waiting" &&
      !busyFamilies.has(i.key),
  );
  // Arc archives a tab left alone long enough; so does Today, for a finished thread you've seen
  // that's been quiet, neither prompted nor running, longer than you chose.
  const autoHours = autoClear.use();
  useEffect(() => {
    if (autoHours === null) return;
    const cutoff = now - autoHours * 36e5;
    const stale = archivable.flatMap((i) =>
      i.kind === "thread" &&
      Math.max(Date.parse(i.at), i.run ? Date.parse(i.run.updatedAt) : 0) < cutoff &&
      !autoArchived.has(i.key)
        ? [i]
        : [],
    );
    if (!stale.length) return;
    for (const i of stale) autoArchived.add(i.key);
    void Promise.all(stale.map((i) => i.view.archive(i.thread.id, true))).then((errors) => {
      const archived = stale.filter((_, n) => !errors[n]);
      if (!archived.length) return;
      toast(
        `Archived ${plural(archived.length, "thread")} quiet for over ${quietFor(autoHours)}`,
        () => {
          for (const i of archived) void viewOf(i.host.id)?.archive(i.thread.id, false);
        },
      );
    });
  });
  // A Project's own menu items, where its plxd allows each (0043, PLX-803).
  const projectActions = (item: Item & { kind: "project" }): FavoriteAction[] => {
    const { project, view } = item;
    const open = (what: ProjectDialog) => (square: HTMLElement) =>
      projectDialogs.current?.open(what, project, view, square);
    const can = (capability: string) => capability in view.capabilities;
    return [
      ...(can("projectEdit")
        ? [
            { label: "Rename…", icon: <PencilLine aria-hidden />, run: open("rename") },
            { label: "Change icon…", icon: <Palette aria-hidden />, run: open("icon") },
          ]
        : []),
      ...(can("projectPermission") && project.permission !== "bypass"
        ? [{ label: "Full access…", icon: <ShieldCheck aria-hidden />, run: open("access") }]
        : []),
      ...(can("projectAutonomy")
        ? [{ label: "Autonomy…", icon: <Bot aria-hidden />, run: open("autonomy") }]
        : []),
      // Its coordinator's next message starts a new session from the Project's state (0079).
      ...(can("coordinatorEpochs") && project.coordinator
        ? [
            {
              label: "Fresh session",
              icon: <RotateCcw aria-hidden />,
              run: async () => {
                const answer = await window.parallax.request(item.host.id, "coordinator/fresh", {
                  project: project.id,
                });
                actionFailed(
                  "error" in answer ? answer.error.message : undefined,
                  "Couldn't start a fresh session",
                );
              },
            },
          ]
        : []),
      ...(can("projectDelete")
        ? [
            {
              label: "Delete…",
              icon: <Trash2 aria-hidden />,
              danger: true,
              run: () => askDelete(item),
            },
          ]
        : []),
    ];
  };
  // A Space's menu items (0090): Rename and Change icon where its plxd keeps icons, and
  // Delete.
  const spaceActions = (entry: ProjectEntry): FavoriteAction[] => {
    const space = entry.view.state.repos.find((r) => r.id === entry.id);
    if (!space) return [];
    const open = (what: ProjectDialog) => (square: HTMLElement) =>
      projectDialogs.current?.open(what, space, entry.view, square);
    return [
      { label: "Rename…", icon: <PencilLine aria-hidden />, run: open("rename") },
      ...("threadAttention" in entry.view.capabilities
        ? [{ label: "Change icon…", icon: <Palette aria-hidden />, run: open("icon") }]
        : []),
      {
        label: "Delete…",
        icon: <Trash2 aria-hidden />,
        danger: true,
        run: () => {
          setSpaceToDelete(entry);
          setDeleteError(undefined);
          spaceDelete.current?.showModal();
        },
      },
    ];
  };
  const entryActions = (entry: ProjectEntry): FavoriteAction[] => {
    if (entry.kind === "space") return spaceActions(entry);
    const item = byKey.get(entry.key);
    return item?.kind === "project" ? projectActions(item) : [];
  };
  useImperativeHandle(projectMenu, () => ({ actionsFor: entryActions }));
  // Every project, Projects and Spaces, for Pinned, in the order pinned.
  const entries = projectEntries(hosts);
  const pinnedEntries = pins.flatMap((key) => entries.filter((e) => e.key === key));
  const openEntry = (entry: ProjectEntry) => {
    hideCard();
    onSelect(
      entry.host.id,
      entry.kind === "project"
        ? { kind: "project", projectId: entry.id }
        : { kind: "new", groupId: entry.id },
    );
  };

  // The pinned threads moved up into the favorites, in the order moved into.
  const favorites = favoriteThreads
    .map((i) => {
      const pin = pinOf(i);
      return {
        key: i.key,
        title: i.title,
        icon: pin.icon,
        attention: pin.attention,
        selected: i.key === openKey,
        thread: pin.thread,
        actions: pin.actions,
        onKeys: pin.onKeys,
      };
    })
    .sort((a, b) => favRank(a.key) - favRank(b.key));
  // No line or Clear between what's kept and Today (PLX-1043); View lives in the filter menu.
  const list = (
    <>
      <Favorites
        items={favorites}
        onReorder={
          words.length
            ? undefined
            : (keys) =>
                favoriteOrder.set([
                  ...keys,
                  ...favoriteOrder.get().filter((k) => !keys.includes(k)),
                ])
        }
        onRest={restKeyed}
        onLeave={hideCard}
        onOpen={openKeyed}
        onAdd={(key) => {
          forgetPin(key);
          favorite(key);
        }}
        onPinRow={(hostId, threadId) => {
          const item = byKey.get(`${hostId}/${threadId}`);
          if (item?.kind !== "thread" || item.thread.parent) return;
          if (!item.thread.pinned) void pin(item);
          favorite(item.key);
        }}
        onRemove={unfavorite}
      />
      {pinList}
      {threadList(topThreads)}
    </>
  );

  // Why a host's list couldn't load or stopped updating, which is the list's own state.
  const errors = [...new Set(hosts.map((h) => h.view.error).filter(Boolean))];
  const nothingShown =
    !pool.length && !snoozedItems.length && !archived.length && !draftRows.length;

  return (
    <>
      <SidebarNav
        current={page}
        pinned={pinnedEntries}
        openKey={openSpace ?? (selection.kind === "project" ? openKey : undefined)}
        onNewThread={onNewThread}
        onOpen={onOpenPage}
        onOpenProject={openEntry}
        onAdd={() => addDialog.current?.open()}
        pinActions={(entry) => entryActions(entry)}
        search={
          <label className={`sky-search ${navRow} focus-within:bg-hover`}>
            <Search aria-hidden />
            <input
              ref={search}
              type="search"
              aria-label={scopeLabel ? `Search ${scopeLabel.name}` : "Search threads and Projects"}
              placeholder={scopeLabel ? `Search ${scopeLabel.name}` : "Search"}
              value={query}
              onChange={(e) => {
                quiet();
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                } else if (e.key === "Enter" || e.key === "ArrowDown") {
                  // Into the list: Enter opens the first row, Down focuses it.
                  const first = shownRows()[0];
                  if (!first) return;
                  e.preventDefault();
                  if (e.key === "Enter") first.click();
                  else first.focus();
                }
              }}
              className="min-w-0 flex-1 truncate bg-transparent text-body text-foreground placeholder:text-foreground/90 focus:placeholder:text-faint-foreground focus-visible:outline-none"
            />
            <ScopeMenu
              hosts={hosts}
              scope={scope}
              current={scopeLabel}
              onScope={(next) => setScope(next)}
              many={many}
              needs={needsIn}
              outside={outside}
              view={
                <ViewOptions
                  autoHours={autoHours}
                  onAutoHours={(hours) => autoClear.set(hours)}
                  compact={compact}
                  onCompact={(on) => compactRows.set(on)}
                  group={groupBy}
                  onGroup={(next) => todayGroup.set(next)}
                />
              }
            />
          </label>
        }
      />
      <div
        onScroll={hideCard}
        data-flip-scroll
        className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 *:shrink-0"
      >
        {errors.map((e) => (
          <p key={e} role="alert" className="px-2 pb-1 text-meta text-danger">
            {e}
          </p>
        ))}
        {split && (
          <SplitGroup
            split={split}
            hosts={hosts}
            selection={selection}
            hostId={host.id}
            onOpen={(threadId) => onSelect(split.hostId, { kind: "thread", threadId })}
            onClose={onClosePane}
          />
        )}
        {words.length > 0 && nothingShown && !searching ? (
          <EmptyCard title={`No matches${scopeLabel ? ` in ${scopeLabel.name}` : ""}`}>
            Nothing matches “{query.trim()}”.
            {scope !== "all" && (
              <button type="button" onClick={() => setScope("all", false)} className={cardButton}>
                Search all threads
              </button>
            )}
          </EmptyCard>
        ) : (
          list
        )}
      </div>
      <Drawer
        label="Working"
        items={workingTops}
        row={(item) => row(item)}
        open={sections.working}
        onOpenChange={(o) => toggleSection("working", o)}
      />
      <Drawer
        label="Snoozed"
        items={snoozedItems}
        row={(i) => row(i)}
        open={sections.snoozed}
        onOpenChange={(o) => toggleSection("snoozed", o)}
        onDrop={dropOn("snoozed")}
      />
      <Drawer
        label="Archived"
        items={archived}
        row={(i) => row(i)}
        open={sections.archived}
        onOpenChange={(o) => toggleSection("archived", o)}
        onDrop={dropOn("archived")}
        pageSize={pageArchived ? archivePageSize : undefined}
      />
      {pickedItems.length > 0 && (
        <BulkBar
          count={pickedItems.length}
          can={{
            snooze: pickedItems.some((i) => "threadAttention" in i.view.capabilities),
            pin: pickedItems.some((i) => !i.thread.parent && pinsOn(i.view)),
          }}
          onAction={(a) => void bulk(a)}
          onClear={() => setPicked(new Set())}
        />
      )}
      <RowCard ref={card} />
      <Toasts />
      <AddDialog
        ref={addDialog}
        hosts={hosts.map((h) => h.host)}
        unbrowsable={unbrowsable(hosts)}
        hostId={host.id}
        repos={open?.state.repos ?? []}
        create={open?.createProject ?? (async () => "Not connected")}
        onCreated={(hostId, project) => onOpenProject(hostId, project.id)}
        onNewSpace={onNewSpace}
      />
      <ProjectDialogs
        ref={projectDialogs}
        onError={(error) => actionFailed(error, "Couldn't change the Project")}
      />
      <ConfirmDialog
        ref={deleteDialog}
        title={toDelete?.kind === "project" ? "Delete this Project?" : "Delete this thread?"}
        action="Delete"
        busy={deleting ? "Deleting…" : undefined}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
      >
        “{toDelete?.title}” goes for good
        {toDelete?.kind === "project"
          ? projectLoss(toDelete.runs.length)
          : ", with its transcript, worktree, and branch."}
      </ConfirmDialog>
      <ConfirmDialog
        ref={spaceDelete}
        title="Delete this Space?"
        action="Delete"
        busy={deleting ? "Deleting…" : undefined}
        error={deleteError}
        onConfirm={() => void confirmSpaceDelete()}
      >
        “{spaceToDelete?.name}” goes for good, with{" "}
        {spaceToDelete?.threads === 1 ? "its thread" : `its ${spaceToDelete?.threads ?? 0} threads`}
        , instructions, and files.
      </ConfirmDialog>
      <div className="border-t border-border p-2">
        <ConnectionStatus hostId={host.id} />
        <Footer listed={hosts} onOpenSettings={onOpenSettings} />
      </div>
    </>
  );
}

/** A section a dragged row is over and would drop into. */
const dropLook = "bg-hover outline-1 outline-border outline-dashed";

const cardButton =
  "mx-auto mt-3 flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1 text-body font-medium text-foreground hover:bg-hover";

/** A dashed card in place of the list, for a search with no matches. */
function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-1 my-3.5 flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-5 text-center text-body leading-normal text-faint-foreground">
      <p className="text-body font-semibold text-foreground">{title}</p>
      <div className="mt-0.75">{children}</div>
    </div>
  );
}

/**
 * The bar over the footer while threads are picked (PLX-789): how many, then Archive, Snooze for
 * an hour, Pin, and Clear, as Escape does.
 */
function BulkBar({
  count,
  can,
  onAction,
  onClear,
}: {
  count: number;
  /** Whether any picked thread's host keeps snoozes, and pins. */
  can: { snooze: boolean; pin: boolean };
  onAction: (action: "archive" | "snooze" | "pin") => void;
  onClear: () => void;
}) {
  const button =
    "grid h-6 min-w-6 place-items-center rounded-md px-1 text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5";
  return (
    <div
      role="toolbar"
      aria-label="Selected threads"
      className="mx-2 mt-1 mb-1.5 flex shrink-0 items-center gap-0.5 rounded-xl bg-surface py-1 pr-1 pl-3 shadow-composer ring-1 ring-border motion-safe:animate-[sidebar-rise_140ms_ease-out]"
    >
      <span className="flex-1 text-meta font-semibold tabular-nums">{count} selected</span>
      <button
        type="button"
        aria-label="Archive"
        title="Archive (E)"
        onClick={() => onAction("archive")}
        className={button}
      >
        <Archive />
      </button>
      <button
        type="button"
        aria-label="Snooze"
        title="Snooze for an hour (S)"
        disabled={!can.snooze}
        onClick={() => onAction("snooze")}
        className={`${button} disabled:pointer-events-none disabled:opacity-40`}
      >
        <AlarmClock />
      </button>
      <button
        type="button"
        aria-label="Pin"
        title="Pin (P)"
        disabled={!can.pin}
        onClick={() => onAction("pin")}
        className={`${button} disabled:pointer-events-none disabled:opacity-40`}
      >
        <Pin />
      </button>
      <button
        type="button"
        aria-label="Clear selection"
        title="Clear selection (Esc)"
        onClick={onClear}
        className={button}
      >
        <X />
      </button>
    </div>
  );
}

/** The undo toasts (undo.ts), at the bottom left of the main pane, newest last. */
function Toasts() {
  const list = useToasts();
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-3.5 left-[calc(100%+1rem)] z-50 flex w-max flex-col items-start gap-1.5"
    >
      {list.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-85 items-center gap-2.5 rounded-xl bg-foreground py-1.5 pr-1.5 pl-3 text-body text-background shadow-composer motion-safe:animate-[sidebar-rise_160ms_ease-out]"
        >
          <span className="min-w-0 truncate">{t.text}</span>
          {t.undo && (
            <button
              type="button"
              onClick={() => undo(t.id)}
              title={`Undo (${shortcut("Z")})`}
              className="shrink-0 rounded-md bg-background/15 px-2.25 py-0.75 font-semibold hover:bg-background/25"
            >
              Undo
            </button>
          )}
          {!t.undo && <span className="w-1.5" />}
        </div>
      ))}
    </div>
  );
}

/** The rest of Delete Project's warning, after "“name” goes for good", for a Project of `agents` runs. */
function projectLoss(agents: number): string {
  if (agents === 0) return ".";
  if (agents === 1)
    return ", with its agent's transcript, worktree, and branch. A running agent is stopped first.";
  return `, with its ${agents} agents' transcripts, worktrees, and branches. Running agents are stopped first.`;
}

/** `Date.now()`, again each minute. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * A drawer pinned under the list, such as Working, Snoozed, or Archived, shown while it holds any
 * rows, which render only while it's open. It scrolls under a cap, and its summary sticks to the
 * top, so collapsing stays reachable. With `pageSize`, the first page shows and each click reveals
 * that many more. Whether it's open is the scope's (PLX-789). With `onDrop`, a row it would take is
 * dragging: it shows even while empty, and a drop on it moves the row in (PLX-1095).
 */
function Drawer<T>({
  label,
  items,
  row,
  pageSize,
  open,
  onOpenChange,
  onDrop,
}: {
  label: string;
  items: T[];
  row: (item: T) => ReactNode;
  pageSize?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDrop?: () => void;
}) {
  const [pages, setPages] = useState(1);
  // Its rows rise in as the user opens it, but not when it mounts open.
  const [opened, setOpened] = useState(false);
  const [over, setOver] = useState(false);
  if (over && !onDrop) setOver(false);
  if (items.length === 0 && !onDrop) return null;
  const visible = pageSize ? items.slice(0, pageSize * pages) : items;
  const remaining = items.length - visible.length;
  const more = pageSize && remaining > 0 ? Math.min(pageSize, remaining) : 0;
  return (
    <details
      open={open}
      onToggle={(e) => e.currentTarget.open !== open && onOpenChange(e.currentTarget.open)}
      onDragOver={
        onDrop &&
        ((e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        })
      }
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={
        onDrop &&
        ((e) => {
          e.preventDefault();
          setOver(false);
          onDrop();
        })
      }
      data-flip-scroll
      className={`group/drawer max-h-[40%] min-h-0 shrink-0 overflow-y-auto rounded-lg px-2 pb-1 transition-colors ${over ? dropLook : ""}`}
    >
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpened(!open);
          onOpenChange(!open);
        }}
        className="group/summary sticky top-0 z-10 flex cursor-default list-none items-center gap-1.5 bg-sidebar px-2 py-1.5 text-meta font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        {label}
        <span className="ml-auto text-faint-foreground tabular-nums group-hover/summary:text-muted-foreground">
          <Tick value={items.length} />
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-open/drawer:rotate-90"
        />
      </summary>
      {open && <ul className={`${cardGap} ${opened ? "rise-in" : ""}`}>{visible.map(row)}</ul>}
      {open && more > 0 && (
        <button
          type="button"
          onClick={() => setPages((n) => n + 1)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <Plus aria-hidden className="size-3.5 shrink-0" />
          Show {more} more
        </button>
      )}
    </details>
  );
}

/**
 * The repo filter (PLX-789, 0033): a searchable menu of All threads, every repo, and Chat, each
 * row with how many of its threads need the user, then the sidebar's View options (PLX-1043).
 * Where the repo's plxd keeps icons, its gear opens the icon picker. Its button stays pressed while
 * a repo is chosen, with a dot in its color, and counts what needs the user elsewhere.
 */
function ScopeMenu({
  hosts,
  scope,
  current,
  onScope,
  many,
  needs,
  outside,
  view,
}: {
  hosts: HostThreads[];
  scope: Scope;
  /** What's chosen, unless every thread is. */
  current?: { name: string; color: string };
  onScope: (scope: Scope) => void;
  many: boolean;
  /** How many threads in `scope` need the user. */
  needs: (scope: Scope) => number;
  /** How many threads outside the chosen scope need the user. */
  outside: number;
  /** The View options (PLX-1043), under the repos. */
  view: ReactNode;
}) {
  const menuId = useId();
  const pickerId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ view: ThreadsView; repo: Repo }>();
  const sharedIcons = useContext(SharedRepoIcons);
  const q = query.trim().toLowerCase();
  // Spaces (0069) don't list.
  const repos = hosts
    .flatMap(({ host, view }) =>
      view.state.repos.filter((r) => !r.scratch && !r.space).map((repo) => ({ host, view, repo })),
    )
    .filter((r) => !q || r.repo.name.toLowerCase().includes(q));
  const choose = (next: Scope) => {
    onScope(next);
    menu.current?.hidePopover();
  };
  const check = (on: boolean) => (
    <Check aria-hidden className={`text-accent ${on ? "" : "hidden"}`} />
  );
  const count = (n: number) =>
    n > 0 && (
      <span
        title={`${n} ${n === 1 ? "needs" : "need"} you`}
        className="grid h-4.25 min-w-4.25 place-items-center rounded-full bg-warning/15 px-1.25 text-caption font-semibold text-warning tabular-nums"
      >
        {n}
      </span>
    );
  const heading = (text: string, extra?: ReactNode) => (
    <p
      role="presentation"
      className="flex items-center px-2 pt-2.5 pb-1 text-caption font-medium text-faint-foreground"
    >
      {text}
      {extra}
    </p>
  );
  const trailing =
    "ml-auto flex shrink-0 items-center gap-2 pl-1.5 text-meta text-faint-foreground";
  const actionButton =
    "grid size-6 place-items-center rounded-md text-faint-foreground hover:bg-background hover:text-foreground [&_svg]:size-3.5";

  const row = ({ host, view, repo }: (typeof repos)[number]) => {
    const key = `repo:${host.id}/${repo.id}` as const;
    const canIcon = "threadAttention" in view.capabilities;
    return (
      <div key={key} className="group/repo relative">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={scope === key}
          className={`${menuItem} ${canIcon ? "group-focus-within/repo:pr-8 group-hover/repo:pr-8" : ""}`}
          onClick={() => choose(key)}
        >
          <RepoIcon repo={repo} />
          <span className="min-w-0 truncate">{repo.name}</span>
          <span
            className={`${trailing} ${canIcon ? "group-focus-within/repo:hidden group-hover/repo:hidden" : ""}`}
          >
            {many && <span className="truncate">{host.name}</span>}
            {count(needs(key))}
            {check(scope === key)}
          </span>
        </button>
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5 opacity-0 group-hover/repo:opacity-100 focus-within:opacity-100">
          {canIcon && (
            <button
              type="button"
              aria-label={`Change ${repo.name}'s icon`}
              title="Change icon"
              onClick={(e) => {
                setEditing({ view, repo });
                picker.current?.showPopover({ source: e.currentTarget });
              }}
              className={actionButton}
            >
              <Settings />
            </button>
          )}
        </div>
      </div>
    );
  };

  // The All threads and Chat rows, around the repos.
  const fixedRow = (key: "all" | "none", icon: ReactNode, name: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={scope === key}
      className={menuItem}
      onClick={() => choose(key)}
    >
      {icon}
      {name}
      <span className={trailing}>
        {count(needs(key))}
        {check(scope === key)}
      </span>
    </button>
  );

  const label = current?.name ?? "All threads";
  const title = current
    ? `Showing ${current.name}${outside ? `. ${outside} waiting elsewhere` : ""}`
    : "Filter by repo";
  return (
    <>
      <button
        type="button"
        aria-label={`Showing ${label}`}
        title={title}
        aria-pressed={scope !== "all"}
        aria-haspopup="menu"
        popoverTarget={menuId}
        // It sits in the Search row (0090), shown there on hover or focus, or while a scope is
        // chosen, when its dot says so.
        className={`relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-opacity hover:bg-hover hover:text-foreground aria-pressed:text-foreground [&_svg]:size-4 ${scope === "all" && !outside ? "opacity-0 group-focus-within/nav:opacity-100 group-hover/nav:opacity-100" : ""}`}
      >
        <ListFilter />
        {current && (
          <span
            aria-hidden
            style={{ background: current.color }}
            className="absolute top-1 right-1 size-1.75 rounded-full ring-2 ring-sidebar"
          />
        )}
        {outside > 0 && (
          <span
            aria-hidden
            className="absolute -right-1 -bottom-0.75 grid h-3.25 min-w-3.25 place-items-center rounded-full bg-warning px-0.75 text-micro font-semibold text-white ring-2 ring-sidebar tabular-nums"
          >
            {outside}
          </span>
        )}
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label="Repos"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open") e.currentTarget.querySelector("input")?.focus();
          else setQuery("");
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} open:flex max-h-[min(70vh,32rem)] w-72 flex-col overflow-hidden p-0`}
      >
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <input
            aria-label="Search repos"
            placeholder="Search repos…"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.currentTarget
                .closest('[role="menu"]')
                ?.querySelector<HTMLElement>('[role^="menuitem"]')
                ?.click();
            }}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="min-h-0 overflow-y-auto p-1.5">
          {!q && fixedRow("all", <Layers aria-hidden />, "All threads")}
          {(repos.length > 0 || !q) && heading("Repos")}
          {repos.map(row)}
          {!q && fixedRow("none", <Laptop aria-hidden />, "No repo")}
          {q && repos.length === 0 && (
            <p className="px-2 py-1.5 text-body text-faint-foreground">No repos match</p>
          )}
        </div>
        <div className="shrink-0 border-t border-border p-3">{view}</div>
        <div className="flex shrink-0 gap-3 border-t border-border px-3.5 py-1.5 text-caption text-faint-foreground">
          <span>↑↓ move</span>
          <span>↵ open</span>
        </div>
      </div>
      {/* Each pick saves at once; the picker stays open for the next. */}
      <IconPicker
        ref={picker}
        id={pickerId}
        value={editing && repoIconOf(editing.repo, sharedIcons)}
        onPick={(icon) =>
          editing &&
          setRepoIcons(
            hosts.map((h) => h.view),
            editing.repo.name,
            icon,
          )
        }
        maxImageBytes={editing?.view.iconImageBytes}
      />
    </>
  );
}

/**
 * The footer's buttons: Profile, which shows the account's picture or initials and opens its menu
 * (ProfileMenu.tsx), then the places that open in the main pane, Pull requests and Usage, and at
 * the far end Settings, then Update when `updatable` (Update.tsx), where it has always been.
 */
function Footer({
  listed,
  onOpenSettings,
}: Pick<ThreadListProps, "onOpenSettings"> & {
  listed: HostThreads[];
}) {
  return (
    <div className="flex items-center gap-1">
      <ProfileButton listed={listed} />
      <span className="flex-1" />
      <IconButton label="Settings" command="settings" onClick={() => onOpenSettings("general")}>
        <Settings />
      </IconButton>
      {window.parallax.updatable && <UpdateButton />}
    </div>
  );
}

/** `text` with a search's words marked. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlight(text, words).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-sm bg-warning/30 px-px text-inherit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** What a Project row's menu opens. */
type ProjectDialog = "rename" | "icon" | "access" | "autonomy";
/** Says why a sidebar action failed, when `error` says one did, and closes that once one works. */
function actionFailed(error: string | undefined, title: string) {
  if (error) notify({ key: "sidebar", tone: "error", title, body: error });
  else dismiss("sidebar");
}

type ProjectDialogsHandle = {
  /** Opens `what` for a Project, or for a Space's entry (0090), which renames and recolors only. */
  open: (
    what: ProjectDialog,
    project: Project | Repo,
    view: ThreadsView,
    square: HTMLElement,
  ) => void;
};

/** Project handle the Projects page reads a project's menu through (0090). */
export type ProjectMenuHandle = { actionsFor: (entry: ProjectEntry) => FavoriteAction[] };

/**
 * A Project's dialogs, opened from its row's menu: Rename, the icon picker beside its row,
 * Full access (a one-way move to Bypass), and Autonomy (0043). Each saves through `project/update`
 * and reports plxd's error through `onError`. Only the one open is drawn.
 */
function ProjectDialogs({
  ref,
  onError,
}: {
  ref: RefObject<ProjectDialogsHandle | null>;
  onError: (error?: string) => void;
}) {
  const [opened, setOpened] = useState<{
    what: ProjectDialog;
    project: Project | Repo;
    view: ThreadsView;
    square: HTMLElement;
  }>();
  const [name, setName] = useState("");
  const [autonomy, setAutonomy] = useState<ProjectAutonomy>("routine");
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  useImperativeHandle(ref, () => ({
    open(what, project, view, square) {
      setName(project.name);
      setAutonomy(("autonomy" in project && project.autonomy) || "routine");
      setOpened({ what, project, view, square });
    },
  }));
  // What was just opened shows once it's drawn.
  useEffect(() => {
    if (opened?.what === "icon") picker.current?.showPopover({ source: opened.square });
    else if (opened) dialog.current?.showModal();
  }, [opened]);
  const update = async (change: ProjectChange) => {
    if (!opened) return;
    const { project, view } = opened;
    onError(
      "repoPath" in project
        ? await view.updateProject(project.id, change)
        : await view.updateRepo(project.id, {
            ...(change.name && { name: change.name }),
            ...(change.icon && { icon: change.icon }),
          }),
    );
  };
  const project = opened?.project;
  const close = () => setOpened(undefined);
  return (
    <>
      {/* Each pick saves at once; the picker stays open for the next. */}
      <IconPicker
        ref={picker}
        id={pickerId}
        value={project?.icon}
        onPick={(icon) => void update({ icon })}
        maxImageBytes={opened?.view.iconImageBytes}
      />
      {opened?.what === "rename" && (
        <SettingDialog
          ref={dialog}
          label={opened.project && "repoPath" in opened.project ? "Rename Project" : "Rename Space"}
          action="Rename"
          onClose={close}
          onSave={() => {
            // An empty name, or the same one, saves nothing.
            const next = name.trim();
            if (next && next !== opened.project.name) void update({ name: next });
          }}
        >
          <label className="block text-body font-medium">
            Name
            <input
              aria-label="Project name"
              autoFocus
              value={name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 font-normal focus-visible:outline-none"
            />
          </label>
        </SettingDialog>
      )}
      {opened?.what === "access" && (
        <SettingDialog
          ref={dialog}
          label={`${opened.project.name} full access`}
          action="Give full access"
          onClose={close}
          onSave={() => void update({ permission: "bypass" })}
        >
          <p className="text-body font-medium">Full access</p>
          <p className="mt-1 text-body text-muted-foreground">
            New agents in this Project run commands and edit files without asking, as in new
            Projects. Agents running now keep asking until they next start. Agents on Cursor, Grok
            Build, Hermes Agent, Ollama Cloud, OpenRouter, and local models need it. You can't
            switch back.
          </p>
        </SettingDialog>
      )}
      {opened?.what === "autonomy" && (
        <SettingDialog
          ref={dialog}
          label={`${opened.project.name} autonomy`}
          onClose={close}
          onSave={() => void update({ autonomy })}
        >
          <AutonomyChoice value={autonomy} onChange={setAutonomy} />
        </SettingDialog>
      )}
    </>
  );
}

/** A Project setting's dialog: its choice, then Cancel and `action`, which closes it and saves. */
function SettingDialog({
  ref,
  label,
  action = "Save",
  onSave,
  onClose,
  children,
}: {
  ref: RefObject<HTMLDialogElement | null>;
  label: string;
  action?: string;
  onSave: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      className="m-auto w-[26rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      {/* Save is the submit button, so Enter on a radio saves. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ref.current?.close();
          onSave();
        }}
        className="px-5 pt-4 pb-4"
      >
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-md px-3 py-1.5 text-body hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground hover:opacity-90"
          >
            {action}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Each backend's logo, by its name in `AgentRun.backend`. */
export const backendLogos: Partial<Record<string, ComponentType<SVGProps<SVGSVGElement>>>> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
  cursor: CursorLogo,
};

/** A backend's logo: its own, or a provider instance's (providers.ts). */
export const backendLogo = (backend: string) => backendLogos[backend] ?? instanceLogo(backend);

/**
 * A row's first line: `icon`, if any, its title, then `status`: what it asks of the user, or how
 * long ago it was last active. Hovering or focusing the row hides the status and keeps the title
 * clear of the row's actions.
 */
function RowHead({
  icon,
  title,
  titleColor = "text-foreground",
  status,
  renaming = false,
  oneAction = false,
}: {
  /** Where it is, on a one-line row. */
  icon?: ReactNode;
  title: ReactNode;
  titleColor?: string;
  status: ReactNode;
  /** While its title is edited in place, the line is the box's, with the actions hidden. */
  renaming?: boolean;
  /** Whether the row shows only its actions button, so the title keeps more of the line. */
  oneAction?: boolean;
}) {
  const clear = renaming
    ? ""
    : oneAction
      ? "group-has-[:focus-visible]/row:pr-7 group-hover/row:pr-7"
      : "group-has-[:focus-visible]/row:pr-34 group-hover/row:pr-34";
  return (
    <span className={`flex w-full items-center gap-2 ${clear}`}>
      {icon}
      <span
        data-title
        className={`min-w-0 flex-1 truncate text-body font-medium transition-colors ${titleColor}`}
      >
        {title}
      </span>
      <span
        data-status
        className="shrink-0 text-meta text-faint-foreground group-has-[:focus-visible]/row:hidden group-hover/row:hidden"
      >
        {status}
      </span>
    </span>
  );
}

/** Where a row's thread is, at the start of its second line: its repo's icon and name, or No repo. */
function RowPlace({ repo, words = [] }: { repo?: Repo; words?: readonly string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <RepoIcon repo={repo} />
      <span className="min-w-0 truncate">
        <Marked text={repo && !repo.scratch ? repo.name : "No repo"} words={words} />
      </span>
    </span>
  );
}

/**
 * A card's top line (PLX-1043): where it is, its icon and name, then `status` at the end, what it
 * asks of the user or how long ago it was last active. Hovering or focusing the card hides the
 * status for its actions and keeps the place clear of them.
 */
function RowTop({
  place,
  status,
  oneAction = false,
}: {
  place?: ReactNode;
  status: ReactNode;
  /** Whether the card shows only its actions button. */
  oneAction?: boolean;
}) {
  const clear = oneAction
    ? "group-has-[:focus-visible]/row:pr-7 group-hover/row:pr-7"
    : "group-has-[:focus-visible]/row:pr-34 group-hover/row:pr-34";
  return (
    <span
      className={`flex h-4.5 w-full items-center gap-2 text-meta text-faint-foreground ${clear}`}
    >
      <span className="flex min-w-0 flex-1 items-center">{place}</span>
      <span
        data-status
        className="shrink-0 group-has-[:focus-visible]/row:hidden group-hover/row:hidden"
      >
        {status}
      </span>
    </span>
  );
}

/** A card's title (PLX-1043): bold, and bolder while hovered. */
function RowTitle({ title, color }: { title: ReactNode; color: string }) {
  return (
    <span
      data-title
      className={`w-full min-w-0 truncate text-body font-semibold transition-colors group-hover/row:font-bold ${color}`}
    >
      {title}
    </span>
  );
}

// Measures text for `BranchName`, made once.
let measure: CanvasRenderingContext2D | null | undefined;

/**
 * A branch name in the room its line leaves, cut in the middle at word breaks to fit
 * (`shortBranch`), as `feature/PLX-49-…implementation`, and refit as the sidebar resizes. Its title
 * is the whole name.
 */
function BranchName({ branch, words }: { branch: string; words: readonly string[] }) {
  const self = useRef<HTMLSpanElement>(null);
  const [max, setMax] = useState(branch.length);
  useLayoutEffect(() => {
    const el = self.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      measure ??= document.createElement("canvas").getContext("2d");
      if (!measure || !el.clientWidth) return;
      measure.font = getComputedStyle(el).font;
      let n = branch.length;
      while (n > 12 && measure.measureText(shortBranch(branch, n)).width > el.clientWidth) n--;
      setMax(n);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [branch]);
  return (
    <span ref={self} title={branch} className="min-w-0 flex-1 truncate">
      <Marked text={shortBranch(branch, max)} words={words} />
    </span>
  );
}

/** The space between cards in a list. */
const cardGap = "flex flex-col gap-1";

/**
 * The look of a thread's linked pull requests: that of the most common state among those read,
 * and the newest linked one on a tie.
 */
function majorityLook(prs: PullRequests) {
  const read = prs.urls.flatMap((url) => prs.get(url)?.pr ?? []);
  let best: (typeof read)[number] | undefined;
  let top = 0;
  for (const pr of read) {
    const n = read.filter((p) => p.state === pr.state).length;
    if (n >= top) [best, top] = [pr, n];
  }
  return lookOf(best);
}

/** Space between a draft's outlined row and its neighbors, so the outline doesn't touch them. */
const draftGap = "my-1 first:mt-0 last:mb-0";

/** A draft's status: a New Thread draft's row, or a thread's with an unsent prompt (PLX-887). */
function DraftStatus() {
  return (
    <span className="flex items-center gap-1 text-meta font-medium text-warning [&_svg]:size-3.5">
      <PencilLine aria-hidden />
      Draft
    </span>
  );
}

/**
 * An unsent New Thread prompt's card (PLX-788): its repo and a Draft status, then its first line,
 * outlined in the warning color and spaced off its neighbors (PLX-932). Opening it reopens New
 * Thread with it, which takes it off the list.
 */
function DraftRow({ draft, repo, onOpen }: { draft: Draft; repo?: Repo; onOpen: () => void }) {
  const attached = draft.images.length + draft.files.length + draft.threads.length;
  const title =
    draft.text.trim().split("\n")[0] ||
    `${attached} ${attached === 1 ? "attachment" : "attachments"}`;
  return (
    <li data-kind="draft" className={draftGap}>
      <button
        type="button"
        onClick={onOpen}
        className="group/row flex w-full flex-col gap-0.5 rounded-lg border border-warning px-2.5 py-2 text-left hover:bg-hover"
      >
        <RowTop place={<RowPlace repo={repo} />} status={<DraftStatus />} oneAction />
        <RowTitle title={title} color="text-foreground" />
      </button>
    </li>
  );
}

/**
 * A thread's card (0033, 0075, PLX-1043): its repo's icon and name with its status at the end (what
 * it asks of the user, or how long ago it was last active), its title in bold, then its branch (not
 * a Chat's), cut in the middle (`shortBranch`), its git status, a pin, linked pull requests (the
 * number of one, or +N for more) and their checks, its computer, and its provider, in color while
 * it's open. Under a search, the words found are marked, and a match only in its messages shows a
 * line of them. Resting on it shows its card; hovering or focusing it swaps the status for Snooze,
 * Archive, and more actions, which also open by right-clicking the row: native popovers, so
 * Escape and clicking away close them. Double-clicking the title renames it in place.
 */
function ThreadRow({
  look,
  at,
  rowKey,
  thread,
  hostId,
  device,
  title,
  run,
  repo,
  attention,
  selected,
  picked,
  flash,
  badge,
  nested,
  words,
  snippet,
  renaming,
  snoozable,
  renamable,
  autoResumable,
  onOpen,
  onOpenPr,
  onKeys,
  onArchive,
  onSnooze,
  onPin,
  onMarkUnread,
  onRename,
  onStartRename,
  onDelete,
  onOpenBeside,
  onFork,
  onAutoResume,
  onRest,
  onLeave,
  pinDrag,
}: {
  /** Today's one-line look (pins.ts): where it is, its title, and its status. */
  look?: "compact";
  /** A pinned row's move among the pins (PinList.tsx). */
  pinDrag?: PinDrag;
  /** When it was last active (`activeAt`), for its age. */
  at: string;
  /** Its key in the list, for keyboard moves and sliding when the list moves. */
  rowKey: string;
  thread: Thread;
  /** Its host, which a drag onto the composer names (PLX-378). */
  hostId: string;
  /** Its computer, whose icon shows beside the provider's while there are several (0056). */
  device?: Host;
  title: string;
  run?: AgentRun;
  repo?: Repo;
  attention: Attention;
  selected: boolean;
  /** Whether it's one of the threads picked for a bulk action. */
  picked: boolean;
  /** Whether it just finished, so it flashes once. */
  flash: boolean;
  /** Its Mod+number badge, shown in place of its status while Mod is held. */
  badge?: ReactNode;
  /** Under its repo's heading, which names the repo: its status goes beside its title instead. */
  nested?: boolean;
  /** A search's words, marked where they're found. */
  words: readonly string[];
  /** A line of its messages where the search found what its title and branch don't have. */
  snippet?: string;
  /** Whether its title is being edited in place. */
  renaming: boolean;
  /** Whether its plxd keeps seen and snooze state (`threadAttention`). */
  snoozable: boolean;
  /** Whether its plxd keeps its title (`threadLineage`). */
  renamable: boolean;
  /** Whether its plxd resumes runs after usage limits (`autoResume`, 0049). */
  autoResumable: boolean;
  /** A click: opens it, or with Mod or Shift, picks it. */
  onOpen: (e: MouseEvent<HTMLElement>) => void;
  /** Opens it with the pull request `url` in its side panel. */
  onOpenPr: (url: string) => void;
  /** Keyboard triage on the focused row (PLX-789). */
  onKeys: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onArchive: () => void;
  onSnooze: (until: Date) => void;
  /** Pins or unpins it, for a top-level thread where its plxd keeps pins. */
  onPin?: () => void;
  /** Mark as unread (pins.ts), for a finished thread already seen. */
  onMarkUnread?: () => void;
  /** Ends a rename: saves `title`, or with undefined, keeps the old one. */
  onRename: (title: string | undefined) => void;
  onStartRename: () => void;
  onDelete: () => void;
  /** Opens it beside the open thread (PLX-587), while another thread of its host is open. */
  onOpenBeside?: () => void;
  /** Forks it at its latest turn and opens the fork (0050), where its plxd forks threads. */
  onFork?: (choice: ForkChoice) => Promise<RpcError | undefined>;
  /** Sets its run's auto-resume override, or clears it with undefined. */
  onAutoResume: (autoResume?: boolean) => void;
  onRest: (row: HTMLElement) => void;
  onLeave: () => void;
}) {
  const menuId = useId();
  const snoozeId = useId();
  const forkId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const forkMenu = useRef<HTMLDivElement>(null);
  const snoozeMenu = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const [custom, setCustom] = useState("");
  // Each menu's items render only while it's open: set before it shows, so its first item takes
  // focus, and cleared once it has hidden, so focus goes back to its button.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Set while the title box is open, so Enter and the blur that follows save once.
  const editing = useRef(false);
  if (renaming) editing.current = true;
  // The host's auto-resume setting, read as the menu opens, for the run's own toggle.
  const [hostResumes, setHostResumes] = useState<boolean>();
  const resumes = run?.autoResume ?? hostResumes ?? false;
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    snoozeMenu.current?.hidePopover();
    onLeave();
    action();
  };
  const endRename = (value: string | undefined) => {
    if (!editing.current) return;
    editing.current = false;
    onRename(value);
  };
  const Logo = run?.backend ? backendLogo(run.backend) : undefined;
  // Read once, not polled: a row's state is as of when the sidebar loaded it.
  const prs = usePullRequests(hostId, run?.id, run?.pullRequests ?? [], false, false);
  const prLook = majorityLook(prs);
  // A worktree's or checkout's status is read, for what's unpushed and uncommitted, again as its
  // run's status changes. A plxd without `git` leaves it out.
  const [git, setGit] = useState<GitStatus | null>(null);
  const statusRun = run?.checkout || run?.branch ? run.id : undefined;
  const runStatus = run?.status;
  useEffect(() => {
    if (!statusRun) return;
    let live = true;
    void window.parallax
      .request(hostId, "agent/gitStatus", { runId: statusRun })
      .then((answer) => live && setGit("result" in answer ? answer.result : null));
    return () => {
      live = false;
    };
  }, [hostId, statusRun, runStatus]);
  // The open pull requests' checks, as one: failed if any failed, else running if any are, else
  // passed once all have.
  const checks = prs.urls.flatMap((url) => {
    const pr = prs.get(url)?.pr;
    return pr?.state === "open" && pr.checksState ? [pr.checksState] : [];
  });
  const checksState = checks.includes("failed")
    ? "failed"
    : checks.includes("pending")
      ? "pending"
      : checks.length && checks.every((c) => c === "passed")
        ? "passed"
        : undefined;
  // A thread with no repo leaves out its scratch branch, and a Space's thread the branch plxd made
  // in its repository.
  const branch = repo && !repo.scratch && !repo.space ? run?.branch : undefined;
  const hasDetails = !!(
    (git && (git.ahead || git.changes)) ||
    prs.urls.length ||
    Logo ||
    device ||
    thread.pinned
  );
  const snoozedNow = !!thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now();
  const mainLabel = (
    <>
      {thread.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
      {thread.archived ? "Unarchive" : "Archive"}
    </>
  );
  // An unsent prompt left in its composer (PLX-887): outlined, and Draft in place of its age.
  const drafted = threadDrafts.use(`${hostId}/${thread.id}`);
  const status =
    badge ??
    (run?.status === "waiting" && attention === "settled" && !thread.archived ? (
      <span className="flex items-center gap-1 text-meta font-medium text-warning [&_svg]:size-3.5">
        <AlarmClock aria-hidden />
        {run.resumeAt ? `Resumes ${resumeTime(run.resumeAt)}` : "Waiting"}
      </span>
    ) : attention === "settled" ? (
      drafted ? (
        <DraftStatus />
      ) : (
        age(at)
      )
    ) : (
      <AttentionBadge attention={attention} since={lastUserPrompt(thread)} />
    ));
  // A one-line row has no details line for its pin, so the pin leads its status.
  const shownStatus =
    look === "compact" && thread.pinned && !badge ? (
      <span className="flex items-center gap-1.5">
        <Pin aria-label="Pinned" className="size-3" />
        {status}
      </span>
    ) : (
      status
    );
  const titleColor =
    selected || attention !== "settled"
      ? "text-foreground"
      : "text-foreground/70 group-hover/row:text-foreground";
  const titleText = renaming ? (
    <input
      aria-label="Thread name"
      defaultValue={title}
      autoFocus
      maxLength={256}
      spellCheck={false}
      autoComplete="off"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Enter and Escape belong to an input method while it composes.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") endRename(e.currentTarget.value);
        else if (e.key === "Escape") endRename(undefined);
      }}
      onBlur={(e) => endRename(e.currentTarget.value)}
      className="-mx-1 w-[calc(100%+0.5rem)] min-w-0 rounded-sm bg-background px-1 text-body font-medium text-foreground ring-[1.5px] ring-ring focus-visible:outline-none"
    />
  ) : (
    <span
      onDoubleClick={
        renamable
          ? (e) => {
              e.preventDefault();
              onStartRename();
            }
          : undefined
      }
    >
      <Marked text={title} words={words} />
    </span>
  );
  // A rename's input can't sit in a button, so the row is a plain box while it's open.
  const Main = renaming ? "div" : "button";
  // A one-line row leads with where it is, unless it's under its repo's heading.
  const oneLine = look === "compact" && !nested;
  // A draft outlines the row in the warning color, as a New Thread draft's row is (PLX-887), and
  // spaces it off its neighbors. An open thread holds its own draft, so neither shows while it's open.
  const rowLook = picked
    ? "bg-accent/14 ring-1 ring-accent/38 ring-inset"
    : selected
      ? current
      : `group-hover/row:bg-hover ${drafted ? "ring-1 ring-warning ring-inset" : ""}`;
  return (
    <li
      data-kind="thread"
      data-flip={rowKey}
      className={`group/row relative rounded-lg transition-[background-color,opacity] duration-100 ${rowLook} ${drafted ? draftGap : ""} ${flash ? "row-flash" : ""} ${pinDrag?.dragging ? "opacity-40" : ""}`}
      onMouseEnter={(e) => onRest(e.currentTarget)}
      onMouseLeave={onLeave}
      {...(pinDrag && {
        onDragOver: pinDrag.onDragOver,
        onDragLeave: pinDrag.onDragLeave,
        onDrop: pinDrag.onDrop,
      })}
    >
      {pinDrag?.drop && <DropLine edge={pinDrag.drop} />}
      <Main
        {...(!renaming && { type: "button" as const })}
        aria-current={selected ? "page" : undefined}
        aria-description={picked ? "Selected" : undefined}
        data-row={rowKey}
        data-kind="thread"
        onClick={renaming ? undefined : onOpen}
        onKeyDown={renaming ? undefined : onKeys}
        onContextMenu={(e) => {
          onLeave();
          openOnContextMenu(e, actions.current);
        }}
        // Dropped on the composer, it attaches the thread to the message (PLX-378).
        draggable={!renaming}
        onDragStart={(e) => {
          onLeave();
          dragThread(e.dataTransfer, hostId, thread.id);
          pinDrag?.onDragStart(e);
        }}
        onDragEnd={pinDrag?.onDragEnd}
        className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 text-left -outline-offset-2 transition-transform duration-100 active:scale-[0.985] ${look === "compact" ? "py-[5px]" : "py-2"}`}
      >
        {look === "compact" ? (
          <RowHead
            icon={oneLine && <RepoIcon repo={repo} />}
            title={titleText}
            titleColor={titleColor}
            status={shownStatus}
            renaming={!oneLine && renaming}
          />
        ) : (
          // A card (PLX-1043): where it is and its status, its title in bold, then its branch and
          // details. Under its repo's heading, it leaves out the repo.
          <>
            <RowTop
              place={!nested && <RowPlace repo={repo} words={words} />}
              status={shownStatus}
            />
            <RowTitle title={titleText} color={titleColor} />
            {(branch || hasDetails) && (
              <span className="flex w-full items-center gap-2 text-meta text-faint-foreground">
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {branch && (
                    <>
                      <GitBranch aria-hidden className="size-3 shrink-0" />
                      <BranchName branch={branch} words={words} />
                    </>
                  )}
                  {git && <GitCounts git={git} />}
                </span>
                {thread.pinned && (
                  <span title="Pinned" role="img" aria-label="Pinned" className="flex shrink-0">
                    <Pin className="size-3" />
                  </span>
                )}
                {prs.urls.length > 0 && (
                  <span
                    title={`${prs.urls.length} linked pull ${prs.urls.length === 1 ? "request" : "requests"}`}
                    className={`flex shrink-0 items-center gap-0.5 tabular-nums ${prLook.color}`}
                  >
                    <prLook.Icon aria-hidden className="size-3.5" />
                    {prs.urls.length > 1 ? (
                      <span>+{prs.urls.length - 1}</span>
                    ) : (
                      // Inside the row's button, so a span: clicking it opens the thread with the PR
                      // in its side panel, not GitHub.
                      <span
                        className="hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPr(prs.urls[0]!);
                        }}
                      >
                        <Marked text={`#${numberOf(prs.urls[0]!)}`} words={words} />
                      </span>
                    )}
                    {checksState && <ChecksMark state={checksState} />}
                  </span>
                )}
                {device?.icon && (
                  <span
                    title={device.name}
                    role="img"
                    aria-label={device.name}
                    className="flex shrink-0"
                  >
                    <DeviceIcon icon={device.icon} className="size-3.5" />
                  </span>
                )}
                {/* In gray, so a list isn't striped with providers' colors, but in color while open. */}
                {Logo && (
                  <Logo className={`size-3.5 shrink-0 ${selected ? "" : "opacity-80 grayscale"}`} />
                )}
              </span>
            )}
          </>
        )}
        {snippet && (
          <span className="flex w-full min-w-0 items-center gap-1.5 text-meta text-faint-foreground">
            <Search aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              <Marked text={snippet} words={words} />
            </span>
          </span>
        )}
      </Main>
      <div
        className={`absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100 [&_button]:cursor-pointer ${renaming && !oneLine ? "hidden" : ""}`}
      >
        {snoozable && (
          <button
            type="button"
            aria-label={snoozedNow ? "Snoozed" : "Snooze"}
            title={snoozedNow ? `Snoozed until ${clock(thread.snoozedUntil!)}` : "Snooze (S)"}
            popoverTarget={snoozeId}
            onClick={onLeave}
            className="grid size-5.5 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
          >
            <AlarmClock />
          </button>
        )}
        <button
          type="button"
          title={`${thread.archived ? "Unarchive" : "Archive"} (E)`}
          onClick={() => {
            onLeave();
            onArchive();
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          {mainLabel}
        </button>
        <button
          ref={actions}
          type="button"
          aria-label="Thread actions"
          title="More (or right-click)"
          popoverTarget={menuId}
          onClick={onLeave}
          className="grid size-5.5 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
        >
          <Ellipsis />
        </button>
      </div>
      {snoozable && (
        <Menu
          ref={snoozeMenu}
          id={snoozeId}
          label="Snooze"
          align="end"
          className="min-w-56 p-1"
          onBeforeToggle={(e) => e.newState === "open" && setSnoozeOpen(true)}
          onClose={() => setSnoozeOpen(false)}
        >
          {snoozeOpen && (
            <>
              {snoozeChoices().map((c) => (
                <button
                  key={c.label}
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => onSnooze(c.until))}
                >
                  {c.label}
                  <span className="ml-auto text-meta text-faint-foreground tabular-nums">
                    {c.label.startsWith("In") ? clock(c.until.toISOString()) : when(c.until)}
                  </span>
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
              <form
                className="flex items-center gap-1 px-1 py-0.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const until = new Date(custom);
                  if (!Number.isNaN(until.getTime())) choose(() => onSnooze(until))();
                }}
              >
                <input
                  type="datetime-local"
                  aria-label="Snooze until"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  className="min-w-0 flex-1 rounded-md bg-hover px-1.5 py-1 text-meta [color-scheme:inherit]"
                />
                <button
                  type="submit"
                  disabled={!custom}
                  className="rounded-md px-2 py-1 text-meta hover:bg-hover disabled:opacity-50"
                >
                  Custom
                </button>
              </form>
              {snoozedNow && (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => onSnooze(new Date()))}
                >
                  Unsnooze
                </button>
              )}
            </>
          )}
        </Menu>
      )}
      <Menu
        ref={menu}
        id={menuId}
        label="Thread actions"
        align="end"
        focus='[role^="menuitem"]'
        className="min-w-56 p-1"
        onBeforeToggle={(e) => e.newState === "open" && setMenuOpen(true)}
        onClose={() => setMenuOpen(false)}
        onOpen={() => {
          if (autoResumable && run)
            void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
              if ("result" in answer) setHostResumes(answer.result.autoResume);
            });
        }}
      >
        {menuOpen && (
          <>
            {onOpenBeside && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={choose(onOpenBeside)}
              >
                <Columns2 aria-hidden />
                Open side by side
              </button>
            )}
            {onOpenBeside && <div role="separator" className="my-1 h-px bg-border" />}
            {onPin && (
              <button type="button" role="menuitem" className={menuItem} onClick={choose(onPin)}>
                <Pin aria-hidden />
                {thread.pinned ? "Unpin" : "Pin to top"}
                <MenuKey>P</MenuKey>
              </button>
            )}
            {onMarkUnread && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={choose(onMarkUnread)}
              >
                <CircleDot aria-hidden />
                Mark as unread
                <MenuKey>U</MenuKey>
              </button>
            )}
            {renamable && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={choose(onStartRename)}
              >
                <PencilLine aria-hidden />
                Rename
                <MenuKey>R</MenuKey>
              </button>
            )}
            <button type="button" role="menuitem" className={menuItem} onClick={choose(onArchive)}>
              {mainLabel}
              <MenuKey>E</MenuKey>
            </button>
            {onFork && run && (
              // Its latest turn forks once it ends; Fork's own menu opens under the actions button.
              <button
                type="button"
                role="menuitem"
                disabled={isRunning(run.status)}
                title={isRunning(run.status) ? "Fork once this turn finishes" : undefined}
                className={`${menuItem} disabled:opacity-50`}
                onClick={choose(() =>
                  forkMenu.current?.showPopover({ source: actions.current ?? undefined }),
                )}
              >
                <GitFork aria-hidden />
                Fork…
              </button>
            )}
            {autoResumable && run && (
              // Choosing the host's setting clears the override, so the thread follows the host again.
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={resumes}
                className={menuItem}
                onClick={choose(() =>
                  onAutoResume(!resumes === hostResumes ? undefined : !resumes),
                )}
              >
                <AlarmClock aria-hidden />
                Resume after usage limits
                {resumes && <Check aria-hidden className="ml-auto size-3.5" />}
              </button>
            )}
            <div role="separator" className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              className={`${menuItem} text-danger`}
              onClick={choose(onDelete)}
            >
              <Trash2 aria-hidden />
              Delete…
              <MenuKey>⌫</MenuKey>
            </button>
          </>
        )}
      </Menu>
      {onFork && run && (
        <ForkMenu
          ref={forkMenu}
          id={forkId}
          hostId={hostId}
          run={run}
          onFork={onFork}
          align="end"
        />
      )}
    </li>
  );
}

/**
 * A row's git status, after its repo: commits not pushed, then uncommitted lines.
 * plxd doesn't count commits behind yet.
 */
function GitCounts({ git }: { git: GitStatus }) {
  return (
    <>
      {git.ahead > 0 && (
        <span
          title={`${plural(git.ahead, "commit")} not pushed`}
          className="flex shrink-0 items-center tabular-nums"
        >
          <ArrowUp aria-hidden className="size-3" />
          {git.ahead}
        </span>
      )}
      {git.changes > 0 && (
        <span
          title={`${plural(git.changes, "file")} uncommitted`}
          className="shrink-0 tabular-nums"
        >
          <span className="text-added">+{git.insertions ?? 0}</span>{" "}
          <span className="text-danger">−{git.deletions ?? 0}</span>
        </span>
      )}
    </>
  );
}

const checksLook = {
  passed: { Icon: CircleCheck, color: "text-added", label: "Checks passed" },
  failed: { Icon: CircleX, color: "text-danger", label: "Checks failed" },
  pending: { Icon: CircleDashed, color: "text-warning", label: "Checks running" },
};

/** A pull request's checks, as one mark beside its number. */
function ChecksMark({ state }: { state: keyof typeof checksLook }) {
  const { Icon, color, label } = checksLook[state];
  return <Icon role="img" aria-label={label} className={`ml-0.5 size-3 ${color}`} />;
}

/** A menu item's key, at its end. */
export function MenuKey({ children }: { children: string }) {
  // Drawn from the attribute, so the item's name stays its whole text.
  return (
    <kbd
      aria-hidden
      data-key={children}
      className="ml-auto pl-3 font-sans text-caption text-faint-foreground before:content-[attr(data-key)]"
    />
  );
}

/**
 * The threads tiled side by side (PLX-587, PLX-1082), joined in one box above the list: each with
 * a map of its tile, its Focus thread key, and a button that closes its tile. Choosing one
 * focuses it.
 */
function SplitGroup({
  split,
  hosts,
  selection,
  hostId,
  onOpen,
  onClose,
}: {
  split: Split;
  hosts: HostThreads[];
  selection: Selection;
  hostId: string;
  onOpen: (threadId: string) => void;
  onClose: (threadId: string) => void;
}) {
  useKeybindings();
  const keys = tileCommands.map((c) => bindingsOf(c)[0] && formatKeybinding(bindingsOf(c)[0]!));
  const titles = hosts.find((h) => h.host.id === split.hostId)?.view.state.titles ?? {};
  return (
    <div className="mb-2">
      <div className={sectionHeading}>
        <Columns2 aria-hidden className="size-3.5" />
        Side by side
      </div>
      <ul
        aria-label="Side by side"
        className="flex flex-col gap-0.5 rounded-lg border border-border p-0.5"
      >
        {split.threadIds.map((id, side) => {
          const title = titles[id] ?? "Thread";
          const focused =
            hostId === split.hostId && selection.kind === "thread" && selection.threadId === id;
          return (
            <li key={id} className="group/pane relative">
              <button
                type="button"
                aria-current={focused ? "page" : undefined}
                onClick={() => onOpen(id)}
                className={`${row} pr-8 ${focused ? current : ""}`}
              >
                <span className={focused ? "text-accent" : "text-muted-foreground"}>
                  <TileGlyph count={split.threadIds.length} index={side} />
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {keys[side] && (
                  <kbd className="shrink-0 font-sans text-caption text-faint-foreground tabular-nums">
                    {keys[side]}
                  </kbd>
                )}
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                title="Close this tile"
                onClick={() => onClose(id)}
                className="absolute top-1/2 right-1 grid size-5.5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
              >
                <X />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A day and time a snooze ends, as its menu writes it: "Mon 9:00 AM". */
function when(date: Date): string {
  return date.toLocaleString(locale(), { weekday: "short", ...clockOptions() });
}

/** A run's status as its icon and color, in a thread's card and the Agents list. */
export const statusLooks: Partial<Record<AgentStatus, { Icon: LucideIcon; color: string }>> = {
  starting: { Icon: LoaderCircle, color: "text-emerald-500 [&_svg]:animate-spin" },
  running: { Icon: LoaderCircle, color: "text-emerald-500 [&_svg]:animate-spin" },
  completed: { Icon: CircleCheck, color: "text-muted-foreground" },
  failed: { Icon: CircleAlert, color: "text-danger" },
  cancelled: { Icon: CircleSlash, color: "text-muted-foreground" },
  interrupted: { Icon: CirclePause, color: "text-amber-500" },
  waiting: { Icon: AlarmClock, color: "text-warning" },
  accepted: { Icon: GitMerge, color: "text-violet-500" },
};

type CardContent = Omit<ComponentProps<typeof ThreadCard>, "top" | "left">;
type CardHandle = { show: (row: HTMLElement, content: CardContent) => void; hide: () => void };

/**
 * The card of the thread row the pointer rests on, which the rows show and hide through `ref`, so
 * resting on one re-renders only the card, not the list.
 */
function RowCard({ ref }: { ref: RefObject<CardHandle | null> }) {
  const [card, setCard] = useState<ComponentProps<typeof ThreadCard>>();
  const timer = useRef<number>(undefined);
  // The row it's for. One that went away under the pointer, as a pin moved into the favorites or
  // a row archived, sends no mouseleave, so the next move off it hides the card.
  const shownFor = useRef<HTMLElement>(undefined);
  useEffect(() => {
    if (!card) return;
    const check = () => {
      if (shownFor.current?.matches(":hover")) return;
      window.clearTimeout(timer.current);
      setCard(undefined);
    };
    document.addEventListener("pointermove", check);
    return () => document.removeEventListener("pointermove", check);
  }, [!card]);
  useImperativeHandle(ref, () => ({
    show(row, content) {
      window.clearTimeout(timer.current);
      shownFor.current = row;
      const place = () => {
        if (!row.isConnected) return;
        const rect = row.getBoundingClientRect();
        // A little clear of the sidebar, and kept on screen: it is at most about 15rem tall.
        const edge = (row.closest("#sidebar") ?? row).getBoundingClientRect().right;
        setCard({ ...content, top: Math.min(rect.top, window.innerHeight - 248), left: edge + 12 });
      };
      if (card) place();
      else timer.current = window.setTimeout(place, cardDelay);
    },
    hide() {
      window.clearTimeout(timer.current);
      setCard(undefined);
    },
  }));
  return card && <ThreadCard {...card} />;
}

/**
 * What a thread is, shown beside its row: its title, repository, computer, worktree branch or local
 * checkout, account, changes, and status, from its run as last listed (resting on the row lists it
 * again).
 */
function ThreadCard({
  title,
  run,
  repo,
  host,
  snoozedUntil,
  top,
  left,
}: {
  title: string;
  run?: AgentRun;
  repo: { name: string; icon: ReactNode };
  host: Host;
  snoozedUntil?: string;
  top: number;
  left: number;
}) {
  const Logo = run?.backend ? backendLogo(run.backend) : undefined;
  const look = run && (statusLooks[run.status] ?? statusLooks.completed!);
  return (
    <div
      role="tooltip"
      style={{ top, left }}
      className="card-in pointer-events-none fixed z-50 w-64 rounded-lg border border-border bg-surface p-3 text-foreground shadow-composer transition-[top] duration-150 ease-out motion-reduce:transition-none"
    >
      <p className="line-clamp-2 text-body font-medium">{title}</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-body text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-2">
        <li>
          {repo.icon}
          <span className="truncate">{repo.name}</span>
        </li>
        <li>
          {hostIcon(host)}
          <span className="truncate">{host.name}</span>
        </li>
        {run?.checkout ? (
          <li>
            <Folder />
            <span className="truncate">Local checkout</span>
          </li>
        ) : (
          run?.branch && (
            <li>
              <FolderGit2 />
              <span className="truncate">{run.branch}</span>
            </li>
          )
        )}
        {run?.accountId && (
          <li>
            {Logo ? <Logo /> : <Bot />}
            <span className="truncate">
              {instanceName(run.accountId) ?? accountLabel(run.accountId)}
            </span>
          </li>
        )}
        {run?.diff && (
          <li>
            <FileDiff />
            <span className="tabular-nums">
              {run.diff.files} {run.diff.files === 1 ? "file" : "files"}{" "}
              <span className="text-added">+{run.diff.insertions}</span>{" "}
              <span className="text-danger">−{run.diff.deletions}</span>
            </span>
          </li>
        )}
        {snoozedUntil && Date.parse(snoozedUntil) > Date.now() && (
          <li>
            <AlarmClock />
            <span className="truncate">Snoozed until {clock(snoozedUntil)}</span>
          </li>
        )}
        {run && look && (
          <li className={look.color}>
            <look.Icon />
            <span className="line-clamp-2">
              {runStatusLabel(run.status)}
              {run.status === "failed" && run.error && `: ${run.error}`}
              {run.status === "waiting" &&
                run.resumeAt &&
                `: resumes at ${resumeTime(run.resumeAt)}`}
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

/** Each Settings section's icon. */
const sectionIcons: Record<SettingsSection, LucideIcon> = {
  general: Settings,
  threads: MessageSquare,
  appearance: Palette,
  browser: Globe,
  keybinds: Keyboard,
  providers: Bot,
  schedules: CalendarClock,
  sourceControl: GitBranch,
  computerUse: MousePointerClick,
  scripts: SquareTerminal,
  connections: Server,
  storage: HardDrive,
};
export const settingsNames = Object.fromEntries(
  settingsSections.map((s) => [s.id, s.name]),
) as Record<SettingsSection, string>;

/**
 * Settings' nav (SettingsDialog): a search box and the sections. `/` anywhere outside a field
 * focuses the box. Typed words list the matching sections and settings in the sections' place
 * (search.ts); Up and Down choose one, Enter or a click opens it, and Escape clears.
 */
export function SettingsNav({
  section,
  onSection,
}: {
  section: SettingsSection;
  /** Opens a section, scrolled to the setting with `anchor` as its `data-setting`. */
  onSection: (section: SettingsSection, anchor?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const results = query.trim() ? searchSettings(query) : [];
  const chosen = results[Math.min(active, results.length - 1)];
  const list = useId();
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-3">
        <label className="sky-search flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-hover/50 pr-1.5 pl-2.5 transition-colors hover:bg-hover focus-within:border-transparent focus-within:bg-hover focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            ref={box}
            type="search"
            role="combobox"
            aria-label="Search settings"
            aria-expanded={results.length > 0}
            aria-controls={list}
            aria-activedescendant={chosen ? `${list}-${results.indexOf(chosen)}` : undefined}
            placeholder="Search"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Clearing the search leaves Settings open; Escape again closes it.
                if (query) {
                  e.preventDefault();
                  setQuery("");
                }
              } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((i) => (i + step + results.length) % results.length);
              } else if (e.key === "Enter" && chosen) onSection(chosen.section, chosen.anchor);
            }}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                box.current?.focus();
              }}
              className="grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          ) : (
            <kbd
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-background/60 font-sans text-meta text-faint-foreground"
            >
              /
            </kbd>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {query.trim() ? (
          <div
            id={list}
            role="listbox"
            aria-label="Settings found"
            className="flex flex-col gap-px"
          >
            {results.map((r, i) => {
              const Icon = sectionIcons[r.section];
              return (
                <button
                  key={`${r.section}/${r.anchor ?? ""}`}
                  id={`${list}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={r === chosen}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={() => onSection(r.section, r.anchor)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left aria-selected:bg-selected"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-background/60 text-muted-foreground">
                    <Icon aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-body text-foreground">
                      <Marked text={r.title} words={words} />
                    </span>
                    {r.place && (
                      <span className="block truncate text-meta text-faint-foreground">
                        {r.place}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {results.length === 0 && (
              <p className="px-2 py-6 text-center text-body text-faint-foreground">
                No settings match “{query.trim()}”
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-px">
            {settingsSections.map((s) => {
              const Icon = sectionIcons[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={s.id === section ? "page" : undefined}
                  onClick={() => onSection(s.id)}
                  className={`${row} ${s.id === section ? current : "text-foreground/80"}`}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  {s.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
