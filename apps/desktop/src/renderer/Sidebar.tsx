import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  Columns2,
  ChevronRight,
  CornerDownRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleSlash,
  Ellipsis,
  FileDiff,
  Folder,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  HardDrive,
  Keyboard,
  Layers,
  ListFilter,
  LoaderCircle,
  MessageCircleQuestion,
  Minus,
  Palette,
  PanelLeftClose,
  Pencil,
  PencilLine,
  Pin,
  Plus,
  Search,
  Server,
  Settings,
  SquareDashed,
  SquarePen,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
  type ToggleEvent,
} from "react";

import type {
  AgentRun,
  AgentStatus,
  Area,
  Project,
  ProjectAutonomy,
  ProjectIcon as ProjectIconValue,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import type { RpcError } from "../preload/bridge";
import type { Selection, SettingsSection, Split } from "./App";
import { clock } from "./Approval";
import { drafts, type Draft } from "./drafts";
import { AddDialog, type AddDialogHandle } from "./AddDialog";
import { AreaEditor, AreaSwatch, type AreaFields, type Candidate } from "./AreaEditor";
import {
  areaColor,
  highlight,
  inArea,
  jumpTarget,
  parseScope,
  rootIds,
  scopeStore,
  searchMatch,
  searchWords,
  withMember,
  type Member,
  type Scope,
} from "./areas";
import {
  attentionOf,
  initials,
  lastPrompt,
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
import { iconColors, iconLook } from "./projectIcons";
import { ForkMenu } from "./Fork";
import { archivePageSize, sidebarPrefs } from "./sidebarPrefs";
import { stored } from "./stored";
import { describeError } from "./errors";
import { useFlip } from "./flip";
import { dragThread } from "./threadDrag";
import {
  asksOf,
  groupOf,
  waitingOf,
  projectRuns,
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
  menuHeading,
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
import { lookOf, numberOf, usePullRequests, type PullRequests } from "./PullRequests";
import { instanceLogo, instanceName } from "./providers";
import { UpdateButton } from "./Update";
import { clockOptions } from "./prefs";
import { useShortcutLabel } from "./keybindings";
import { flushToasts, toast, undo, useToasts } from "./undo";
import { uuidv7 } from "./uuidv7";

const row =
  "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover";
const current = "bg-selected text-foreground";
const sectionHeading =
  "flex h-7 items-center gap-1 px-2 text-[12px] font-medium text-faint-foreground";
const emptyNote = "px-2 py-1 text-[12.5px] text-faint-foreground";

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
 * open a new thread. A nightly build paints a sky behind that row and the Search row under it,
 * as the column's own background (index.css), with stars and clouds (NightSky.tsx).
 */
export function Sidebar({
  open,
  onClose,
  onNewThread,
  children,
  width = 256,
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
          className="mr-auto flex items-center gap-1.5 rounded-md px-1 py-0.5 font-brand text-[14px] font-semibold tracking-tight text-foreground hover:bg-hover"
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
  /** Opens the Pull requests page, in place of the main pane. */
  onOpenPullRequests: () => void;
  /** Deletes a thread. Resolves to an error message, or undefined. */
  onDelete: (hostId: string, thread: Thread) => Promise<string | undefined>;
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

/** A repo's color: its icon's, or else one picked from its name, as its initials' tile shows. */
function repoColor(repo: Repo) {
  const palette = iconColors.slice(1);
  if (repo.icon?.color) return `var(--project-${repo.icon.color})`;
  if (repo.icon) return "var(--accent)";
  let hash = 0;
  for (let i = 0; i < repo.name.length; i++) hash = (hash * 31 + repo.name.charCodeAt(i)) | 0;
  return `var(--project-${palette[Math.abs(hash) % palette.length]!.key})`;
}

/**
 * A repo's icon: the one the user chose, in a Project's shape (0033), or else its initials on a
 * tile in a color picked from its name. No Repo is a dashed square. `big` draws it at 18px, as a
 * thread row's.
 */
export function RepoIcon({ repo, big }: { repo?: Repo; big?: boolean }) {
  const size = big ? "size-[18px]" : "size-4";
  if (!repo || repo.scratch)
    return <SquareDashed aria-hidden className={`${size} shrink-0 text-faint-foreground`} />;
  if (repo.icon) return <ProjectIcon icon={repo.icon} className={`${size} shrink-0`} />;
  return (
    <span
      aria-hidden
      style={{ color: repoColor(repo) }}
      className={`grid ${size} shrink-0 place-items-center rounded-[4px] bg-current/15 ${big ? "text-[9.5px]" : "text-[8.5px]"} leading-none font-bold`}
    >
      {/* Drawn from the attribute, so the tile adds nothing to the text around it. */}
      <span data-initials={initials(repo.name)} className="before:content-[attr(data-initials)]" />
    </span>
  );
}

// How long a pointer rests on a thread before its card shows. Moving to another thread while
// one shows switches at once.
const cardDelay = 450;

/** A scope's sections and drawers, by whether each is open. */
type Sections = Record<
  "pinned" | "projects" | "threads" | "working" | "snoozed" | "archived",
  boolean
>;
const sectionDefaults: Sections = {
  pinned: true,
  projects: true,
  threads: true,
  working: true,
  snoozed: false,
  archived: false,
};
const record = <T,>(raw: unknown, fallback: Record<string, T>) =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, T>) : fallback;
/** Which sections and drawers each scope has open (PLX-789), kept on this computer. */
export const sectionsStore = stored<Record<string, Partial<Sections>>>(
  "parallax:sections",
  {},
  record,
);
/** Each scope's last open row, by key, so switching back reopens it. */
const lastOpenStore = stored<Record<string, string>>("parallax:lastOpen", {}, record);

/** One row of the list: a thread, or a Project, with its host and what it asks of the user. */
type Item = (
  | { kind: "thread"; thread: Thread }
  | { kind: "project"; project: Project; runs: AgentRun[] }
) & {
  key: string;
  host: Host;
  view: ThreadsView;
  repo?: Repo;
  attention: Attention;
  /** When it was last prompted, for the order. */
  at: string;
  title: string;
  /** What makes it an area member, and the areas it's in. */
  member: Member;
  areas: Area[];
  /** What search reads besides its messages: its title, repo, branch, and pull request numbers. */
  text: string;
};

/** A thread's one waiting request, when it is a single command the row can allow or deny. */
type Ask = { approvalId: string; command: string };

/** The request `item` waits on, if it's exactly one, and a command (PLX-789). */
function askOf(item: Item): Ask | undefined {
  if (item.kind !== "thread") return undefined;
  const pending = item.view.state.approvals[item.thread.id]?.items ?? [];
  const [only] = pending;
  if (pending.length !== 1 || only?.kind !== "approval" || only.resolved) return undefined;
  const { request } = only;
  const input = request.input as Record<string, unknown> | null;
  const command = request.toolName === "Bash" ? input?.["command"] : undefined;
  return typeof command === "string" && command.trim()
    ? { approvalId: request.approvalId, command }
    : undefined;
}

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
/** Text cut to fit a toast. */
const short = (text: string) => (text.length > 30 ? `${text.slice(0, 28).trimEnd()}…` : text);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const working = (a: Attention) => a === "working" || a === "monitoring" || a === "waiting";

/**
 * Search, the scope menu (areas, Spaces, and repos), a menu to create a Project or add a
 * repository, and New thread, then every host's pinned threads, Projects, and threads, each in a
 * collapsible section, most recently active first (0033, PLX-789). A thread row shows its repo,
 * how long ago it was prompted or what it asks of the user, its title, branch, and provider. A
 * thread's children (0041) and the strip under it read as one block, collapsed behind their count
 * and most urgent status, but a Project's children show only inside it, its row showing their
 * combined status (0042). While a top-level thread is working, it and its children sit in a
 * Working drawer above Snoozed and Archived, until it finishes. Each scope keeps which sections
 * and drawers are open. Rows that move slide to their place. Changes the user makes show a toast
 * with Undo, which ⌘Z also runs. Resting on a thread shows a card.
 */
export function ThreadList({
  hosts,
  host,
  selection,
  onSelect,
  onOpenProject,
  onOpenSettings,
  onOpenPullRequests,
  onDelete,
  onNewThread,
  split,
  onOpenBeside,
  onClosePane,
}: ThreadListProps) {
  const addDialog = useRef<AddDialogHandle>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const projectsId = useId();
  const threadsId = useId();
  const pinnedId = useId();
  // The thread or Project the delete dialog asks about.
  const [toDelete, setToDelete] = useState<Item>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  // Threads deleted with Undo still offered: hidden until the toast goes, then deleted.
  const [doomed, setDoomed] = useState<ReadonlySet<string>>(new Set());
  // Bumped when the last open thread is archived, to pop confetti beside the empty list's note.
  const [confetti, setConfetti] = useState(0);
  // It ends here rather than in Confetti, so a pop that never showed, say behind a draft row,
  // can't play later.
  useEffect(() => {
    if (!confetti) return;
    const timer = setTimeout(() => setConfetti(0), 1000);
    return () => clearTimeout(timer);
  }, [confetti]);
  const [query, setQuery] = useState("");
  const { workingSection, pageArchived } = sidebarPrefs.use();
  // The threads whose children show, by key, and the open thread whose groups were last opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<string>();
  // The rows picked with ⌘-click, ⇧-click, or X, by key, and where a ⇧-click range starts.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string>(undefined);
  const [renaming, setRenaming] = useState<string>();
  // The area editor, while it's open: a host's area to edit, or a new one.
  const [editor, setEditor] = useState<{
    hostId: string;
    area?: Area;
    initial?: { name?: string; threads?: string[]; projects?: string[] };
  }>();
  // Threads that just finished, flashing once.
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  // The row to focus after the next render: by key, or by place, as the one that takes an
  // archived row's place.
  const focusNext = useRef<{ key?: string; index?: number }>(undefined);
  const card = useRef<CardHandle>(null);
  // Snoozes end on time even with nothing else changing.
  const now = useMinute();
  // The hosts as they are now, for an Undo that runs after later changes.
  const latest = useRef(hosts);
  useEffect(() => {
    latest.current = hosts;
  });
  const viewOf = (hostId: string) => latest.current.find((h) => h.host.id === hostId)?.view;
  // Changes that aren't moves, such as switching areas or typing a search, don't slide rows.
  const quiet = useFlip("#sidebar");

  const open = hosts.find((h) => h.host.id === host.id)?.view;
  const many = hosts.length > 1;

  // Every host's areas, in order, where its plxd keeps them.
  const listedAreas: ListedArea[] = hosts
    .flatMap(({ host: h, view }) =>
      "areas" in view.capabilities ? view.state.areas.map((area) => ({ host: h, view, area })) : [],
    )
    .map((a, index) => ({ ...a, index }));
  const areaScope = (a: { host: Host; area: Area }): Scope => `area:${a.host.id}/${a.area.id}`;
  // A chosen area or repo that's gone, deleted or not loaded yet, shows everything, keeping the
  // choice for its return.
  const chosen = scopeStore.use();
  const parsed = parseScope(chosen);
  const scopeArea =
    parsed.kind === "area"
      ? listedAreas.find((a) => a.host.id === parsed.hostId && a.area.id === parsed.id)
      : undefined;
  const scopeRepo =
    parsed.kind === "repo"
      ? hosts
          .find((h) => h.host.id === parsed.hostId)
          ?.view.state.repos.find((r) => !r.scratch && r.id === parsed.id)
      : undefined;
  const scope: Scope =
    (parsed.kind === "area" && !scopeArea) || (parsed.kind === "repo" && !scopeRepo)
      ? "all"
      : chosen;
  const scopeLabel = scopeArea
    ? { name: scopeArea.area.name, color: areaColor(scopeArea.area.color) }
    : scopeRepo
      ? { name: scopeRepo.name, color: repoColor(scopeRepo) }
      : scope === "none"
        ? { name: "No repo", color: "var(--faint-foreground)" }
        : undefined;
  const sections = { ...sectionDefaults, ...sectionsStore.use()[scope] };
  const toggleSection = (name: keyof Sections, value = !sections[name]) => {
    quiet();
    const all = sectionsStore.get();
    sectionsStore.set({ ...all, [scope]: { ...all[scope], [name]: value } });
  };

  const items: Item[] = hosts.flatMap(({ host: h, view }) => {
    const { state } = view;
    const repoOf = (id: string) => state.repos.find((r) => r.id === id);
    const areas = "areas" in view.capabilities ? state.areas : [];
    // A Project's children show only inside it, and count toward its row's status (0042).
    const inProject = threadProjects(state);
    const roots = rootIds(state.threads);
    const threads = state.threads
      .filter((t) => !inProject.get(t.id))
      .map((t): Item => {
        const run = state.runs[t.id];
        const repo = repoOf(t.repo);
        const title = state.titles[t.id] ?? "Thread";
        const member: Member = { kind: "thread", root: roots.get(t.id) ?? t.id };
        return {
          kind: "thread",
          thread: t,
          key: `${h.id}/${t.id}`,
          host: h,
          view,
          repo,
          attention: attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)),
          at: lastPrompt(t),
          title,
          member,
          areas: areas.filter((a) => inArea(a, member)),
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
      const member: Member = { kind: "project", id: p.id };
      return {
        kind: "project",
        project: p,
        runs,
        key: `${h.id}/${p.id}`,
        host: h,
        view,
        repo: state.repos.find((r) => r.path === p.repoPath),
        attention: projectAttention(runs, (id) => asksOf(state, id)),
        at: p.updatedAt,
        title: p.name,
        member,
        areas: areas.filter((a) => inArea(a, member)),
        text: p.name,
      };
    });
    return [...threads, ...projects];
  });
  const byKey = new Map(items.map((i) => [i.key, i]));

  const inScope = (item: Item, s: Scope) => {
    const p = parseScope(s);
    if (p.kind === "all") return true;
    if (p.kind === "none") return !item.repo || item.repo.scratch;
    if (item.host.id !== p.hostId) return false;
    return p.kind === "repo" ? item.repo?.id === p.id : item.areas.some((a) => a.id === p.id);
  };
  const isArchived = (i: Item) => i.kind === "thread" && !!i.thread.archived;
  const isSnoozed = (i: Item) => i.kind === "thread" && snoozed(i.thread, i.attention, now);
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
  const snippetOf = (i: Item) =>
    matched.get(i.key)?.length ? hits?.snippets.get(i.key) : undefined;

  const shown = items
    .filter((i) => inScope(i, scope) && matched.has(i.key) && !doomed.has(i.key))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const projects = shown.filter((i) => i.kind === "project");
  const pool = shown.filter((i) => i.kind === "thread" && !isArchived(i) && !isSnoozed(i));
  const snoozedItems = shown.filter((i) => !isArchived(i) && isSnoozed(i));
  const archived = shown.filter(isArchived);
  // The Projects section shows once any host has a Project, even while search or the filter hides
  // them all.
  const hasProjects = items.some((i) => i.kind === "project" && inScope(i, scope));
  // Unsent New Thread prompts (PLX-788), above the threads, on hosts still listed. An area lists
  // only what it holds.
  const draftRows = drafts.use().flatMap((d) => {
    const view = hosts.find((h) => h.host.id === d.hostId)?.view;
    if (!view || scopeArea) return [];
    const repo = view.state.repos.find((r) => r.id === d.groupId);
    const inRepo =
      scope === "all" ||
      (scope === "none" ? !repo || repo.scratch : scope === `repo:${d.hostId}/${repo?.id}`);
    return inRepo && words.every((w) => d.text.toLowerCase().includes(w))
      ? [{ draft: d, repo }]
      : [];
  });

  // A thread whose parent is in the list nests under it (0041), oldest first, collapsed until
  // opened or until one of them is the open thread.
  const parentKey = (i: Item) =>
    i.kind === "thread" && "threadLineage" in i.view.capabilities && i.thread.parent
      ? `${i.host.id}/${i.thread.parent}`
      : undefined;
  const inList = new Set(pool.map((i) => i.key));
  const children = new Map<string, Item[]>();
  const created = (i: Item) => (i.kind === "thread" ? i.thread.createdAt : "");
  for (const i of [...pool].sort((a, b) => created(a).localeCompare(created(b)))) {
    const key = parentKey(i);
    if (key && inList.has(key)) children.set(key, [...(children.get(key) ?? []), i]);
  }
  const tops = pool.filter((i) => !inList.has(parentKey(i) ?? ""));
  // Pinned threads stay put; the rest of a working family sits in Working (PLX-777: a thread
  // waiting on background work or a watched pull request stays with them).
  const pinned = tops.filter((i) => i.kind === "thread" && i.thread.pinned);
  const unpinned = tops.filter((i) => !pinned.includes(i));
  const workingTops = workingSection ? unpinned.filter((i) => working(i.attention)) : [];
  const topThreads = unpinned.filter((i) => !workingTops.includes(i));
  const selectedKey =
    selection.kind === "thread"
      ? `${host.id}/${selection.threadId}`
      : selection.kind === "project"
        ? `${host.id}/${selection.projectId}`
        : undefined;
  if (selectedKey !== revealed) {
    setRevealed(selectedKey);
    // Opens the groups the open thread is in, so its row shows. A loop of parents stops.
    const byPool = new Map(pool.map((i) => [i.key, i]));
    const opened = new Set(expanded);
    const chosenItem = selectedKey === undefined ? undefined : byPool.get(selectedKey);
    let up = chosenItem && parentKey(chosenItem);
    while (up && byPool.has(up) && !opened.has(up)) {
      opened.add(up);
      up = parentKey(byPool.get(up)!);
    }
    if (opened.size !== expanded.size) setExpanded(opened);
  }
  // The rows shown, in order, a group's children after their parent while it's open.
  const flat = (i: Item): Item[] => [
    i,
    ...(expanded.has(i.key) ? (children.get(i.key) ?? []).flatMap(flat) : []),
  ];
  const pinnedRows = sections.pinned ? pinned.flatMap(flat) : [];
  const threadRows = sections.threads ? topThreads.flatMap(flat) : [];
  const workingRows = sections.working ? workingTops.flatMap(flat) : [];

  // Mod+1 to Mod+9 open the first nine rows shown, which show their badges while Mod is held:
  // Pinned's, then the Projects section's, then the threads', then Working's, each only while
  // it's open.
  const listed = [
    ...pinnedRows,
    ...(sections.projects ? projects : []),
    ...threadRows,
    ...workingRows,
  ];
  const modHeld = useModHeld();
  const openItem = (item: Item) =>
    onSelect(
      item.host.id,
      item.kind === "thread"
        ? { kind: "thread", threadId: item.thread.id }
        : { kind: "project", projectId: item.project.id },
    );

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

  // ⌥↓ and ⌥↑: the next or previous row that needs the user, switching to an area that holds it,
  // or to every thread, when it's outside this scope.
  const jump = (step: 1 | -1) => {
    const key = jumpTarget(jumpList, selectedKey, step);
    const item = key ? byKey.get(key) : undefined;
    if (!item) return toast("Nothing needs you right now");
    if (!inScope(item, scope)) {
      const home = listedAreas.find(
        (a) => a.host.id === item.host.id && item.areas.some((x) => x.id === a.area.id),
      );
      setScope(home ? areaScope(home) : "all", false);
      toast(`Switched to ${home ? home.area.name : "All threads"} for “${short(item.title)}”`);
    }
    if (!matched.has(item.key)) setQuery("");
    focusNext.current = { key: item.key };
    openItem(item);
  };

  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = undefined;
    const rows = [...document.querySelectorAll<HTMLElement>("#sidebar [data-row]")];
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

  // Held-back deletes go through when the window closes.
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
      // ⌥1 to ⌥9 open areas in order and ⌥0 shows every thread. By key position, since ⌥ and a
      // digit type a symbol on macOS.
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
      if (digit !== undefined && plainAlt && listedAreas.length) {
        const d = Number(digit);
        const area = listedAreas[d - 1];
        if (d !== 0 && !area) return;
        e.preventDefault();
        return setScope(area ? areaScope(area) : "all");
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

  const hideCard = () => card.current?.hide();

  const askDelete = (item: Item) => {
    setToDelete(item);
    setDeleteError(undefined);
    deleteDialog.current?.showModal();
  };

  // What the user changes shows a toast with Undo, which puts back only what they changed.
  const archive = async (item: Item) => {
    if (item.kind !== "thread") return;
    const { thread: t, host: h } = item;
    const was = !!t.archived;
    const error = await item.view.archive(t.id, !was);
    setActionError(error);
    if (error) return;
    const lastOpen = items.every(
      (i) => i.kind !== "thread" || i.thread.archived || i.key === item.key,
    );
    if (!was && lastOpen) setConfetti((n) => n + 1);
    toast(was ? "Unarchived" : `Archived “${short(item.title)}”`, () => {
      void viewOf(h.id)?.archive(t.id, was);
    });
  };
  const snoozeUntil = async (item: Item, until: Date) => {
    if (item.kind !== "thread") return;
    const { thread: t, host: h } = item;
    const was = t.snoozedUntil;
    const error = await item.view.update(t.id, { snoozedUntil: until.toISOString() });
    setActionError(error);
    if (error) return;
    const ending = until.getTime() <= Date.now();
    toast(ending ? "Unsnoozed" : `Snoozed until ${when(until)}`, () => {
      // A snooze that ended meanwhile ends now.
      void viewOf(h.id)?.update(t.id, { snoozedUntil: was ?? new Date().toISOString() });
    });
  };
  const pin = async (item: Item) => {
    if (item.kind !== "thread" || item.thread.parent) return;
    const { thread: t, host: h } = item;
    const was = !!t.pinned;
    const error = await item.view.update(t.id, { pinned: !was });
    setActionError(error);
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
    setActionError(error);
    if (!error)
      toast("Renamed", () => {
        void viewOf(h.id)?.update(t.id, { title: was });
      });
  };
  const setMember = (hostId: string, areaId: string, item: Item, on: boolean) => {
    const view = viewOf(hostId);
    const area = view?.state.areas.find((a) => a.id === areaId);
    if (!view || !area) return Promise.resolve(undefined);
    const id = item.member.kind === "thread" ? item.member.root : item.member.id;
    return view.updateArea(areaId, withMember(area, item.member.kind, id, on));
  };
  const toggleArea = async (item: Item, area: Area, on: boolean) => {
    const error = await setMember(item.host.id, area.id, item, on);
    setActionError(error);
    if (!error)
      toast(on ? `Added to ${area.name}` : `Removed from ${area.name}`, () => {
        void setMember(item.host.id, area.id, item, !on);
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
      const keys = [
        ...document.querySelectorAll<HTMLElement>('#sidebar [data-row][data-kind="thread"]'),
      ].map((r) => r.dataset["row"]!);
      const [a, b] = [keys.indexOf(from), keys.indexOf(item.key)];
      if (a >= 0 && b >= 0)
        for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k);
    } else if (!next.delete(item.key)) next.add(item.key);
    anchor.current = item.key;
    setPicked(next);
  };
  const bulk = async (action: "archive" | "snooze" | "pin") => {
    const list = pickedItems.flatMap((i) =>
      i.kind === "thread" ? [{ item: i, t: i.thread }] : [],
    );
    if (!list.length) return;
    const n = plural(list.length, "thread");
    const errors: (string | undefined)[] = [];
    if (action === "archive") {
      errors.push(...(await Promise.all(list.map(({ item, t }) => item.view.archive(t.id, true)))));
      setPicked(new Set());
      toast(`Archived ${n}`, () => {
        for (const { item, t } of list)
          if (!t.archived) void viewOf(item.host.id)?.archive(t.id, false);
      });
    } else if (action === "snooze") {
      const until = new Date(Date.now() + 3_600_000).toISOString();
      errors.push(
        ...(await Promise.all(
          list.map(({ item, t }) => item.view.update(t.id, { snoozedUntil: until })),
        )),
      );
      setPicked(new Set());
      toast(`Snoozed ${n} for an hour`, () => {
        for (const { item, t } of list)
          void viewOf(item.host.id)?.update(t.id, {
            snoozedUntil: t.snoozedUntil ?? new Date().toISOString(),
          });
      });
    } else {
      const tops = list.filter(({ t }) => !t.parent);
      const on = !tops.every(({ t }) => t.pinned);
      errors.push(
        ...(await Promise.all(tops.map(({ item, t }) => item.view.update(t.id, { pinned: on })))),
      );
      toast(`${on ? "Pinned" : "Unpinned"} ${plural(tops.length, "thread")}`, () => {
        for (const { item, t } of tops)
          void viewOf(item.host.id)?.update(t.id, { pinned: !!t.pinned });
      });
    }
    setActionError(errors.find(Boolean));
  };
  // The picked threads' area checkboxes: on, off, or mixed, for each area on their hosts.
  const bulkAreas = listedAreas.flatMap((listed) => {
    const ids = [
      ...new Set(
        pickedItems.flatMap((i) =>
          i.host.id === listed.host.id && i.member.kind === "thread" ? [i.member.root] : [],
        ),
      ),
    ];
    if (!ids.length) return [];
    const n = ids.filter((id) => listed.area.threads.includes(id)).length;
    return [{ listed, ids, state: n === 0 ? false : n === ids.length ? true : ("mixed" as const) }];
  });
  const bulkArea = async ({ listed, ids, state }: (typeof bulkAreas)[number]) => {
    const { area } = listed;
    const add = state !== true;
    // Only the ones that change, so Undo takes back exactly those.
    const changed = ids.filter((id) => area.threads.includes(id) !== add);
    const apply = (on: boolean) => {
      const view = viewOf(listed.host.id);
      const now = view?.state.areas.find((a) => a.id === area.id);
      if (!view || !now) return Promise.resolve(undefined);
      const threads = on
        ? [...now.threads, ...changed.filter((id) => !now.threads.includes(id))]
        : now.threads.filter((id) => !changed.includes(id));
      return view.updateArea(area.id, { threads });
    };
    const error = await apply(add);
    setActionError(error);
    if (!error)
      toast(
        `${add ? "Added" : "Removed"} ${plural(changed.length, "thread")} ${add ? "to" : "from"} ${area.name}`,
        () => void apply(!add),
      );
  };

  const rowKeys = (e: ReactKeyboardEvent<HTMLElement>, item: Item) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
    const rows = [...document.querySelectorAll<HTMLElement>("#sidebar [data-row]")];
    const at = rows.indexOf(e.currentTarget);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const thread = item.kind === "thread";
    const act = (run: () => void, after?: { index?: number; key?: string }) => {
      e.preventDefault();
      focusNext.current = after;
      run();
    };
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      const next = rows[at + (key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (key === "e" && thread) act(() => void archive(item), { index: at });
    else if (key === "s" && thread && !e.shiftKey)
      act(() => void snoozeUntil(item, new Date(Date.now() + 3_600_000)), { index: at });
    else if (key === "p" && thread && !item.thread.parent)
      act(() => void pin(item), { key: item.key });
    else if (key === "r" && thread) act(() => setRenaming(item.key));
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

  // A row's Areas menu: each of its host's areas as a checkbox, and New area…, which opens the
  // editor with it picked. A child follows its root into its areas.
  const areaMenuOf = (item: Item): AreaMenu | undefined => {
    if (!("areas" in item.view.capabilities)) return undefined;
    const parent =
      item.kind === "thread" && item.member.kind === "thread" && item.member.root !== item.thread.id
        ? (item.view.state.titles[item.member.root] ?? "its parent")
        : undefined;
    return {
      parent,
      areas: listedAreas
        .filter((a) => a.host.id === item.host.id)
        .map(({ area }) => ({
          area,
          on: item.areas.some((x) => x.id === area.id),
        })),
      onToggle: (area, on) => void toggleArea(item, area, on),
      onNew: () =>
        setEditor({
          hostId: item.host.id,
          initial:
            item.kind === "thread"
              ? { threads: [item.thread.id] }
              : { projects: [item.project.id] },
        }),
    };
  };

  const row = (item: Item, inFamily = false) => itemRow(item, false, inFamily);
  const itemRow = (item: Item, nested: boolean, inFamily = false) => {
    const n = modHeld ? listed.indexOf(item) : -1;
    const badge = n >= 0 && n < 9 ? <RowBadge index={n} /> : undefined;
    const selected = item.key === selectedKey;
    const dots = item.areas.filter((a) => a.id !== scopeArea?.area.id);
    if (item.kind === "project")
      return (
        <ProjectRow
          key={item.key}
          rowKey={item.key}
          flip={!nested && !inFamily}
          project={item.project}
          runs={item.runs}
          attention={item.attention}
          host={many ? item.host : undefined}
          selected={selected}
          badge={badge}
          words={words}
          dots={dots}
          editable={"projectEdit" in item.view.capabilities}
          moded={"projectPermission" in item.view.capabilities}
          autonomous={"projectAutonomy" in item.view.capabilities}
          iconImageBytes={item.view.iconImageBytes}
          areaMenu={areaMenuOf(item)}
          onOpen={() => openItem(item)}
          onKeys={(e) => rowKeys(e, item)}
          onUpdate={async (change) =>
            setActionError(await item.view.updateProject(item.project.id, change))
          }
          onDelete={"projectDelete" in item.view.capabilities ? () => askDelete(item) : undefined}
        />
      );
    const { thread: t, view } = item;
    const pinnable = "areas" in view.capabilities && !t.parent;
    const ask = nested ? undefined : askOf(item);
    return (
      <ThreadRow
        key={item.key}
        rowKey={item.key}
        flip={!nested && !inFamily}
        thread={t}
        hostId={item.host.id}
        device={many && item.host.icon ? item.host : undefined}
        title={item.title}
        run={view.state.runs[t.id]}
        repo={item.repo}
        attention={item.attention}
        selected={selected}
        picked={picked.has(item.key)}
        flash={flashing.has(item.key)}
        inFamily={inFamily}
        badge={badge}
        nested={nested}
        words={words}
        snippet={snippetOf(item)}
        dots={dots}
        ask={ask}
        renaming={renaming === item.key}
        snoozable={"threadAttention" in view.capabilities}
        renamable={"threadLineage" in view.capabilities}
        autoResumable={"autoResume" in view.capabilities}
        areaMenu={areaMenuOf(item)}
        onOpen={(e) => {
          const mod = mac() ? e.metaKey : e.ctrlKey;
          if (mod || e.shiftKey) return pick(item, e.shiftKey);
          setPicked(new Set());
          anchor.current = item.key;
          openItem(item);
        }}
        onKeys={(e) => rowKeys(e, item)}
        onArchive={() => void archive(item)}
        onSnooze={(until) => void snoozeUntil(item, until)}
        onPin={pinnable ? () => void pin(item) : undefined}
        onRename={(title) => void rename(item, title)}
        onStartRename={() => setRenaming(item.key)}
        onAnswer={async (approvalId, decision) => {
          const answer = await window.parallax.request(item.host.id, "agent/approve", {
            runId: t.id,
            approvalId,
            decision,
          });
          setActionError("error" in answer ? describeError(answer.error) : undefined);
        }}
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
          setActionError("error" in answer ? answer.error.message : undefined);
        }}
        onRest={(el) =>
          card.current?.show(el, {
            title: item.title,
            run: view.state.runs[t.id],
            repo: {
              name: item.repo && !item.repo.scratch ? item.repo.name : "No Repo",
              icon: <RepoIcon repo={item.repo} />,
            },
            host: item.host,
            snoozedUntil: t.snoozedUntil,
          })
        }
        onLeave={hideCard}
      />
    );
  };

  // Every thread under `key`, at any depth, for its group's most urgent status.
  const descendants = (key: string): Item[] =>
    (children.get(key) ?? []).flatMap((c) => [c, ...descendants(c.key)]);
  // A thread's row, then with children, a strip under it with their count and, while they're
  // hidden, the most urgent one's status; the two read as one block, with one hover and tint.
  // Open, the children list under it on a guide line.
  const tree = (item: Item, nested: boolean): ReactNode => {
    const kids = children.get(item.key);
    if (!kids) return itemRow(item, nested);
    const isOpen = expanded.has(item.key);
    const toggle = () => {
      quiet();
      const next = new Set(expanded);
      if (!next.delete(item.key)) next.add(item.key);
      setExpanded(next);
    };
    const urgent = mostUrgent(descendants(item.key).map((c) => c.attention));
    const block = (
      <li
        key={item.key}
        data-flip={nested ? undefined : item.key}
        data-family
        className={`group/fam rounded-lg transition-colors duration-100 hover:bg-hover has-[[aria-current=page]]:hover:bg-hover ${isOpen ? "bg-hover/60" : ""}`}
      >
        <ul>{itemRow(item, nested, true)}</ul>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Hide" : "Show"} ${plural(kids.length, "child thread")}`}
          onClick={toggle}
          className={`-mt-1 flex w-full items-center gap-1.25 rounded-b-lg px-2 pt-0.5 text-left text-[11.5px] text-faint-foreground hover:text-foreground ${isOpen ? "pb-0.75" : "pb-1.5"}`}
        >
          <span className="flex w-4.5 justify-center">
            <ChevronRight
              aria-hidden
              className={`size-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          </span>
          <CornerDownRight aria-hidden className="size-3 shrink-0" />
          {plural(kids.length, "thread")}
          {urgent !== "settled" && !isOpen && (
            <span className="ml-auto">
              <AttentionBadge attention={urgent} />
            </span>
          )}
        </button>
        {isOpen && (
          <ul
            aria-label={`Threads ${item.title} started`}
            className="mb-1.25 ml-4.25 flex flex-col gap-px border-l border-foreground/14 pr-1 pl-1.75"
          >
            {kids.map((k) => tree(k, true))}
          </ul>
        )}
      </li>
    );
    return block;
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
          setActionError(error);
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

  // Saves the editor's area: New area makes it and opens it, with Undo deleting it again.
  const saveArea = async (hostId: string, fields: AreaFields, area?: Area) => {
    const view = viewOf(hostId);
    if (!view) return "Not connected";
    if (area) {
      const error = await view.updateArea(area.id, fields);
      if (error) return error;
      setEditor(undefined);
      const { id: _, ...was } = area;
      toast(`Saved ${fields.name}`, () => void viewOf(hostId)?.updateArea(area.id, was));
      return undefined;
    }
    const created = { id: uuidv7(), ...fields };
    const error = await view.createArea(created);
    if (error) return error;
    setEditor(undefined);
    setQuery("");
    setScope(`area:${hostId}/${created.id}`, false);
    const index = listedAreas.length;
    toast(
      `Created ${fields.name}${index < 9 ? ` · ${areaKey(index + 1)}` : ""}`,
      () => void viewOf(hostId)?.deleteArea(created.id),
    );
    return undefined;
  };
  const deleteArea = async (hostId: string, area: Area) => {
    const error = await viewOf(hostId)?.deleteArea(area.id);
    if (error) return setActionError(error);
    setEditor(undefined);
    const was = scope;
    toast(`Deleted ${area.name}`, () => {
      // The same id brings it back, with the members that are still there.
      void viewOf(hostId)
        ?.createArea(area)
        .then((e) => {
          if (!e && was === `area:${hostId}/${area.id}`) scopeStore.set(was);
        });
    });
  };
  const editorView = editor && viewOf(editor.hostId);
  const candidates: Candidate[] = editor
    ? items.flatMap((i) => {
        if (i.host.id !== editor.hostId || isArchived(i)) return [];
        if (i.kind === "thread" && i.member.kind === "thread" && i.member.root !== i.thread.id)
          return [];
        const repo = i.repo && !i.repo.scratch ? i.repo : undefined;
        return [
          {
            kind: i.kind,
            id: i.kind === "thread" ? i.thread.id : i.project.id,
            title: i.title,
            group: repo?.id ?? "",
            groupName: repo?.name ?? "No repo",
            groupIcon: <RepoIcon repo={repo} />,
            attention: i.attention,
            at: i.at,
          },
        ];
      })
    : [];
  const newAreaHost = listedAreas.length
    ? (
        hosts.find((h) => h.host.id === host.id && "areas" in h.view.capabilities) ??
        hosts.find((h) => "areas" in h.view.capabilities)
      )?.host.id
    : hosts.find((h) => "areas" in h.view.capabilities)?.host.id;

  const errors = [...new Set([actionError, ...hosts.map((h) => h.view.error)].filter(Boolean))];
  const nothingShown =
    !projects.length &&
    !pool.length &&
    !snoozedItems.length &&
    !archived.length &&
    !draftRows.length;
  // An area with nothing in it that's still around asks for some.
  const emptyArea =
    scopeArea && !items.some((i) => inScope(i, scope) && !isArchived(i) && !doomed.has(i.key));

  return (
    <>
      <div className="flex items-center gap-1 px-2">
        <label className="sky-search flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-hover/50 px-2.5 transition-colors hover:bg-hover focus-within:border-transparent focus-within:bg-hover focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
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
                const first = document.querySelector<HTMLElement>("#sidebar [data-row]");
                if (!first) return;
                e.preventDefault();
                if (e.key === "Enter") first.click();
                else first.focus();
              }
            }}
            className="min-w-0 flex-1 truncate bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <ScopeMenu
          hosts={hosts}
          areas={listedAreas}
          scope={scope}
          current={scopeLabel}
          onScope={(next) => setScope(next)}
          many={many}
          needs={needsIn}
          outside={outside}
          newAreaHost={newAreaHost}
          onEditArea={({ host: h, area }) => setEditor({ hostId: h.id, area })}
          onNewArea={(hostId, name) => setEditor({ hostId, initial: { name } })}
        />
        <IconButton label="New project or repository" onClick={() => addDialog.current?.open()}>
          <FolderPlus />
        </IconButton>
        <IconButton label="New thread" command="newThread" onClick={onNewThread}>
          <SquarePen />
        </IconButton>
      </div>
      <div
        onScroll={hideCard}
        data-flip-scroll
        className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {errors.map((e) => (
          <p key={e} role="alert" className="px-2 pb-1 text-[12px] text-danger">
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
        {words.length > 0 && nothingShown ? (
          <EmptyCard title={`No matches${scopeLabel ? ` in ${scopeLabel.name}` : ""}`}>
            Nothing matches “{query.trim()}”.
            {scope !== "all" && (
              <button type="button" onClick={() => setScope("all", false)} className={cardButton}>
                Search all threads
              </button>
            )}
          </EmptyCard>
        ) : emptyArea ? (
          <EmptyCard
            title={`Nothing in ${scopeArea.area.name} yet`}
            mark={<AreaSwatch color={scopeArea.area.color} className="size-3 rounded-[4px]" />}
          >
            Add a thread from its ⋯ menu, or pick a few now.
            <button
              type="button"
              onClick={() => setEditor({ hostId: scopeArea.host.id, area: scopeArea.area })}
              className={cardButton}
            >
              Pick threads
            </button>
          </EmptyCard>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <div className={sectionHeading}>
                  <SectionToggle
                    label="Pinned"
                    collapsed={!sections.pinned}
                    controls={pinnedId}
                    onToggle={() => toggleSection("pinned")}
                  />
                </div>
                <div id={pinnedId} hidden={!sections.pinned} className="mb-2">
                  <ul aria-label="Pinned" className="flex flex-col gap-px">
                    {pinned.map((i) => tree(i, false))}
                  </ul>
                </div>
              </>
            )}
            {hasProjects && (
              <>
                {/* The heading holds only its toggle, so its name is just "Projects". */}
                <div className={sectionHeading}>
                  <SectionToggle
                    label="Projects"
                    collapsed={!sections.projects}
                    controls={projectsId}
                    onToggle={() => toggleSection("projects")}
                  />
                </div>
                <div id={projectsId} hidden={!sections.projects} className="mb-2">
                  <ul aria-label="Projects" className="flex flex-col gap-px">
                    {projects.map((i) => row(i))}
                  </ul>
                  {projects.length === 0 && <p className={emptyNote}>Nothing matches</p>}
                </div>
              </>
            )}
            <div className={sectionHeading}>
              <SectionToggle
                label="Threads"
                collapsed={!sections.threads}
                controls={threadsId}
                onToggle={() => toggleSection("threads")}
              />
            </div>
            <div id={threadsId} hidden={!sections.threads}>
              <ul aria-label="Threads" className="flex flex-col gap-px">
                {draftRows.map(({ draft, repo }) => (
                  <DraftRow
                    key={draft.id}
                    draft={draft}
                    repo={repo}
                    onOpen={() =>
                      onSelect(draft.hostId, {
                        kind: "new",
                        groupId: draft.groupId,
                        draft: draft.id,
                      })
                    }
                  />
                ))}
                {topThreads.map((i) => tree(i, false))}
              </ul>
              {draftRows.length === 0 && topThreads.length === 0 && (
                <p className={emptyNote}>
                  <span className="relative">
                    {workingTops.length
                      ? "Everything else here is working."
                      : pinned.length
                        ? "Nothing else here."
                        : words.length || scope !== "all"
                          ? "Nothing matches"
                          : "No threads yet"}
                    {confetti > 0 && <Confetti key={confetti} />}
                  </span>
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <Drawer
        label="Working"
        items={workingTops}
        row={(item) => tree(item, false)}
        open={sections.working}
        onOpenChange={(o) => toggleSection("working", o)}
      />
      <Drawer
        label="Snoozed"
        items={snoozedItems}
        row={(i) => row(i)}
        open={sections.snoozed}
        onOpenChange={(o) => toggleSection("snoozed", o)}
      />
      <Drawer
        label="Archived"
        items={archived}
        row={(i) => row(i)}
        open={sections.archived}
        onOpenChange={(o) => toggleSection("archived", o)}
        pageSize={pageArchived ? archivePageSize : undefined}
      />
      {pickedItems.length > 0 && (
        <BulkBar
          count={pickedItems.length}
          areas={bulkAreas.map((b) => ({
            key: `${b.listed.host.id}/${b.listed.area.id}`,
            area: b.listed.area,
            state: b.state,
            onToggle: () => void bulkArea(b),
          }))}
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
        createSpace={open && "spaces" in open.capabilities ? open.createSpace : undefined}
        iconImageBytes={open?.iconImageBytes}
        onCreated={(hostId, project) => onOpenProject(hostId, project.id)}
      />
      {editor && editorView && (
        <AreaEditor
          area={editor.area}
          areas={editorView.state.areas}
          candidates={candidates}
          initial={editor.initial}
          onSave={(fields) => saveArea(editor.hostId, fields, editor.area)}
          onDelete={editor.area ? () => void deleteArea(editor.hostId, editor.area!) : undefined}
          onClose={() => setEditor(undefined)}
        />
      )}
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
      <div className="border-t border-border p-2">
        <ConnectionStatus hostId={host.id} />
        <Footer
          listed={hosts}
          onOpenSettings={onOpenSettings}
          onOpenPullRequests={onOpenPullRequests}
          needs={jumpList.length}
          onJump={() => jump(1)}
        />
      </div>
    </>
  );
}

const cardButton =
  "mx-auto mt-3 flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1 text-[12.5px] font-medium text-foreground hover:bg-hover";

/** A dashed card in place of the list, for an empty area or a search with no matches. */
function EmptyCard({
  title,
  mark,
  children,
}: {
  title: string;
  mark?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-1 my-3.5 flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-5 text-center text-[12.5px] leading-normal text-faint-foreground">
      {mark}
      <p className={`text-[13px] font-semibold text-foreground ${mark ? "mt-2" : ""}`}>{title}</p>
      <div className="mt-0.75">{children}</div>
    </div>
  );
}

/**
 * The bar over the footer while threads are picked (PLX-789): how many, then Archive, Snooze for
 * an hour, Pin, Area, whose menu adds them to or takes them out of each area (mixed while only
 * some are in it), and Clear, as Escape does.
 */
function BulkBar({
  count,
  areas,
  onAction,
  onClear,
}: {
  count: number;
  areas: { key: string; area: Area; state: boolean | "mixed"; onToggle: () => void }[];
  onAction: (action: "archive" | "snooze" | "pin") => void;
  onClear: () => void;
}) {
  const menuId = useId();
  const button =
    "grid h-6 min-w-6 place-items-center rounded-md px-1 text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5";
  return (
    <div
      role="toolbar"
      aria-label="Selected threads"
      className="mx-2 mt-1 mb-1.5 flex shrink-0 items-center gap-0.5 rounded-xl bg-surface py-1 pr-1 pl-3 shadow-composer ring-1 ring-border motion-safe:animate-[sidebar-rise_140ms_ease-out]"
    >
      <span className="flex-1 text-[12px] font-semibold tabular-nums">{count} selected</span>
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
        onClick={() => onAction("snooze")}
        className={button}
      >
        <AlarmClock />
      </button>
      <button
        type="button"
        aria-label="Pin"
        title="Pin (P)"
        onClick={() => onAction("pin")}
        className={button}
      >
        <Pin />
      </button>
      <button
        type="button"
        popoverTarget={menuId}
        aria-haspopup="menu"
        disabled={areas.length === 0}
        className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
      >
        <Layers aria-hidden />
        Area
      </button>
      <Menu
        id={menuId}
        label="Add selected to an area"
        align="end"
        focus='[role="menuitemcheckbox"]'
        className="min-w-48 p-1"
      >
        {areas.map((a) => (
          <button
            key={a.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={a.state}
            onClick={a.onToggle}
            className={menuItem}
          >
            <CheckBox state={a.state} />
            <AreaSwatch color={a.area.color} />
            <span className="min-w-0 truncate">{a.area.name}</span>
          </button>
        ))}
      </Menu>
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

/** A menu checkbox's box: checked, mixed, or empty. */
function CheckBox({ state }: { state: boolean | "mixed" }) {
  return (
    <span
      aria-hidden
      className={`grid size-3.75 shrink-0 place-items-center rounded-[4.5px] border-[1.5px] text-accent-foreground [&_svg]:size-2.5! ${state ? "border-accent bg-accent" : "border-border"}`}
    >
      {state === "mixed" ? <Minus strokeWidth={3.5} /> : state ? <Check strokeWidth={3.5} /> : null}
    </span>
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
          className="pointer-events-auto flex max-w-85 items-center gap-2.5 rounded-xl bg-foreground py-1.5 pr-1.5 pl-3 text-[12.5px] text-background shadow-composer motion-safe:animate-[sidebar-rise_160ms_ease-out]"
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

// Twelve rays, evenly spaced, alternating near and far, cycling the Project colors.
const confettiRays = Array.from({ length: 12 }, (_, i) => ({
  "--angle": `${i * 30}deg`,
  "--distance": i % 2 ? "16px" : "24px",
  background: ["var(--project-pink)", "var(--project-yellow)", "var(--project-sky)"][i % 3],
})) as CSSProperties[];

/** One pop of confetti rays just right of its parent, for archiving the last open thread. */
function Confetti() {
  return (
    <span aria-hidden className="confetti">
      {confettiRays.map((style, i) => (
        <span key={i} style={style} />
      ))}
    </span>
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

/** A section's heading: its name and a chevron, which collapse the section `controls` names. */
function SectionToggle({
  label,
  collapsed,
  controls,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <h2 className="flex flex-1 self-stretch">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={controls}
        onClick={onToggle}
        className="flex flex-1 items-center gap-1 text-left hover:text-foreground"
      >
        {label}
        <ChevronRight
          aria-hidden
          className={`size-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
      </button>
    </h2>
  );
}

/**
 * A drawer pinned under the list, such as Working, Snoozed, or Archived, shown while it holds any
 * rows, which render only while it's open. It scrolls under a cap, and its summary sticks to the
 * top, so collapsing stays reachable. With `pageSize`, the first page shows and each click reveals
 * that many more. Whether it's open is the scope's (PLX-789).
 */
function Drawer<T>({
  label,
  items,
  row,
  pageSize,
  open,
  onOpenChange,
}: {
  label: string;
  items: T[];
  row: (item: T) => ReactNode;
  pageSize?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pages, setPages] = useState(1);
  if (items.length === 0) return null;
  const visible = pageSize ? items.slice(0, pageSize * pages) : items;
  const remaining = items.length - visible.length;
  const more = pageSize && remaining > 0 ? Math.min(pageSize, remaining) : 0;
  return (
    <details
      open={open}
      onToggle={(e) => e.currentTarget.open !== open && onOpenChange(e.currentTarget.open)}
      data-flip-scroll
      className="group/drawer max-h-[40%] min-h-0 shrink-0 overflow-y-auto px-2 pb-1"
    >
      <summary
        onClick={(e) => {
          e.preventDefault();
          onOpenChange(!open);
        }}
        className="sticky top-0 z-10 flex cursor-default list-none items-center gap-3 rounded-md bg-sidebar px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <span>
          {label} <span className="text-faint-foreground tabular-nums">({items.length})</span>
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open/drawer:rotate-180"
        />
      </summary>
      {open && <ul className="flex flex-col gap-px">{visible.map(row)}</ul>}
      {open && more > 0 && (
        <button
          type="button"
          onClick={() => setPages((n) => n + 1)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <Plus aria-hidden className="size-3.5 shrink-0" />
          Show {more} more
        </button>
      )}
    </details>
  );
}

/** One area as the scope menu lists it, with its host and its ⌥ number. */
export interface ListedArea {
  host: Host;
  view: ThreadsView;
  area: Area;
  /** Its place among every host's areas, for ⌥1 to ⌥9. */
  index: number;
}

/** ⌥ (Alt) and a digit, which opens an area, as this OS writes it. */
export const areaKey = (digit: number | string) =>
  window.parallax.platform === "darwin" ? `⌥${digit}` : `Alt+${digit}`;

/**
 * The scope menu (PLX-789, 0033): a searchable menu of All threads, then Areas, Spaces, and
 * Repos, each row with how many of its threads need the user. Typing filters it, and with no
 * match it offers New area "<text>". An area's pencil, or → on its row, opens its editor. Where
 * the repo's plxd keeps icons, its gear opens the icon picker, and a Space's row renames or deletes
 * it. Spaces are made only from the add palette (AddDialog.tsx). Its button stays pressed while
 * an area or repo is chosen, with a dot in its color, and counts what needs the user elsewhere.
 */
function ScopeMenu({
  hosts,
  areas,
  scope,
  current,
  onScope,
  many,
  needs,
  outside,
  newAreaHost,
  onEditArea,
  onNewArea,
}: {
  hosts: HostThreads[];
  areas: ListedArea[];
  scope: Scope;
  /** What's chosen, unless every thread is. */
  current?: { name: string; color: string };
  onScope: (scope: Scope) => void;
  many: boolean;
  /** How many threads in `scope` need the user. */
  needs: (scope: Scope) => number;
  /** How many threads outside the chosen scope need the user. */
  outside: number;
  /** The host a new area goes on, where its plxd keeps areas. */
  newAreaHost?: string;
  onEditArea: (listed: ListedArea) => void;
  onNewArea: (hostId: string, name?: string) => void;
}) {
  const menuId = useId();
  const pickerId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ view: ThreadsView; repo: Repo }>();
  // The Space dialog's subject: a Space to rename or delete (0069).
  const [spaceDialog, setSpaceDialog] = useState<
    { kind: "rename" | "delete"; view: ThreadsView; repo: Repo } | undefined
  >();
  const [spaceName, setSpaceName] = useState("");
  const [spaceError, setSpaceError] = useState<string>();
  const spaceRef = useRef<HTMLDialogElement>(null);
  const openSpaceDialog = (next: NonNullable<typeof spaceDialog>) => {
    setSpaceName(next.repo.name);
    setSpaceError(undefined);
    setSpaceDialog(next);
    menu.current?.hidePopover();
    // After this render, which mounts the dialog.
    queueMicrotask(() => spaceRef.current?.showModal());
  };
  const saveSpace = async () => {
    if (!spaceDialog) return;
    const { kind, view, repo } = spaceDialog;
    const name = spaceName.trim();
    const error =
      kind === "rename" ? await view.renameSpace(repo.id, name) : await view.deleteSpace(repo.id);
    setSpaceError(error);
    if (error) spaceRef.current?.showModal();
    else setSpaceDialog(undefined);
  };
  const q = query.trim().toLowerCase();
  const all = hosts.flatMap(({ host, view }) =>
    view.state.repos.filter((r) => !r.scratch).map((repo) => ({ host, view, repo })),
  );
  const repos = all.filter((r) => !q || r.repo.name.toLowerCase().includes(q));
  const spaces = repos.filter((r) => r.repo.space);
  const plain = repos.filter((r) => !r.repo.space);
  const shownAreas = areas.filter((a) => !q || a.area.name.toLowerCase().includes(q));
  const choose = (next: Scope) => {
    onScope(next);
    menu.current?.hidePopover();
  };
  const hide = () => menu.current?.hidePopover();
  const check = (on: boolean) => (
    <Check aria-hidden className={`text-accent ${on ? "" : "hidden"}`} />
  );
  const count = (n: number) =>
    n > 0 && (
      <span
        title={`${n} ${n === 1 ? "needs" : "need"} you`}
        className="grid h-4.25 min-w-4.25 place-items-center rounded-full bg-warning/15 px-1.25 text-[10.5px] font-semibold text-warning tabular-nums"
      >
        {n}
      </span>
    );
  const heading = (text: string, extra?: ReactNode) => (
    <p
      role="presentation"
      className="flex items-center px-2 pt-2.5 pb-1 text-[11px] font-medium text-faint-foreground"
    >
      {text}
      {extra}
    </p>
  );
  const trailing =
    "ml-auto flex shrink-0 items-center gap-2 pl-1.5 text-[11.5px] text-faint-foreground";
  const actionButton =
    "grid size-6 place-items-center rounded-md text-faint-foreground hover:bg-background hover:text-foreground [&_svg]:size-3.5";

  const areaRow = (listed: ListedArea) => {
    const { host, area, index } = listed;
    const key = `area:${host.id}/${area.id}` as const;
    return (
      <div key={key} className="group/area relative">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={scope === key}
          data-area={area.id}
          onClick={() => choose(key)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight") return;
            e.preventDefault();
            hide();
            onEditArea(listed);
          }}
          className={`${menuItem} group-focus-within/area:pr-9 group-hover/area:pr-9`}
        >
          <AreaSwatch color={area.color} />
          <span className="min-w-0 truncate">{area.name}</span>
          <span className={trailing}>
            {many && <span className="truncate">{host.name}</span>}
            {count(needs(key))}
            {check(scope === key)}
            {index < 9 && (
              <kbd className="font-sans group-focus-within/area:invisible group-hover/area:invisible">
                {areaKey(index + 1)}
              </kbd>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Edit ${area.name}`}
          title={`Edit ${area.name} (→)`}
          tabIndex={-1}
          onClick={() => {
            hide();
            onEditArea(listed);
          }}
          className={`${actionButton} absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/area:opacity-100 group-hover/area:opacity-100`}
        >
          <Pencil />
        </button>
      </div>
    );
  };

  const row = ({ host, view, repo }: (typeof repos)[number]) => {
    const key = `repo:${host.id}/${repo.id}` as const;
    const canEdit = repo.space && "spaces" in view.capabilities;
    const canIcon = "threadAttention" in view.capabilities;
    // Room for the hover actions, which the row makes by pushing its content left.
    const actions = (canEdit ? 2 : 0) + (canIcon ? 1 : 0);
    return (
      <div
        key={key}
        style={{ "--actions": `${actions * 1.5 + 0.5}rem` } as CSSProperties}
        className="group/repo relative"
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={scope === key}
          className={`${menuItem} group-focus-within/repo:pr-(--actions) group-hover/repo:pr-(--actions)`}
          onClick={() => choose(key)}
        >
          <RepoIcon repo={repo} />
          <span className="min-w-0 truncate">{repo.name}</span>
          <span
            className={`${trailing} ${actions ? "group-focus-within/repo:hidden group-hover/repo:hidden" : ""}`}
          >
            {many && <span className="truncate">{host.name}</span>}
            {count(needs(key))}
            {check(scope === key)}
          </span>
        </button>
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5 opacity-0 group-hover/repo:opacity-100 focus-within:opacity-100">
          {canEdit && (
            <>
              <button
                type="button"
                aria-label={`Rename ${repo.name}`}
                title="Rename"
                onClick={() => openSpaceDialog({ kind: "rename", view, repo })}
                className={actionButton}
              >
                <Pencil />
              </button>
              <button
                type="button"
                aria-label={`Delete ${repo.name}`}
                title="Delete"
                onClick={() => openSpaceDialog({ kind: "delete", view, repo })}
                className={actionButton}
              >
                <Trash2 />
              </button>
            </>
          )}
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

  const offerAreas = newAreaHost !== undefined;
  const label = current?.name ?? "All threads";
  const title = current
    ? `Showing ${current.name}${outside ? `. ${outside} waiting elsewhere` : ""} (${areaKey(0)} shows all)`
    : offerAreas
      ? "Areas, Spaces, and repos"
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
        className="relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-4"
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
            className="absolute -right-1 -bottom-0.75 grid h-3.25 min-w-3.25 place-items-center rounded-full bg-warning px-0.75 text-[8.5px] font-bold text-white ring-2 ring-sidebar tabular-nums"
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
        aria-label={offerAreas ? "Areas, Spaces, and repos" : "Repos"}
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
            aria-label={offerAreas ? "Find an area, Space, or repo" : "Search repos"}
            placeholder={offerAreas ? "Find an area, Space, or repo" : "Search repos…"}
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
            className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="min-h-0 overflow-y-auto p-1.5">
          {!q && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope === "all"}
              className={menuItem}
              onClick={() => choose("all")}
            >
              <Layers aria-hidden />
              All threads
              <span className={trailing}>
                {count(needs("all"))}
                {check(scope === "all")}
                {offerAreas && <kbd className="font-sans">{areaKey(0)}</kbd>}
              </span>
            </button>
          )}
          {offerAreas && (!q || shownAreas.length > 0) && (
            <>
              {heading(
                "Areas",
                <button
                  type="button"
                  aria-label="New area"
                  title="New area"
                  tabIndex={-1}
                  onClick={() => {
                    hide();
                    onNewArea(newAreaHost);
                  }}
                  className={`${actionButton} -my-1 ml-auto size-5`}
                >
                  <Plus />
                </button>,
              )}
              {areas.length === 0 && (
                <div className="px-2 pt-0.5 pb-2 text-[12px] leading-normal text-faint-foreground">
                  Group threads from any repo, Project, or Space, then switch between them here.
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      hide();
                      onNewArea(newAreaHost);
                    }}
                    className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-hover [&_svg]:size-3.5"
                  >
                    <Plus aria-hidden />
                    New area
                  </button>
                </div>
              )}
              {shownAreas.map(areaRow)}
            </>
          )}
          {spaces.length > 0 && heading("Spaces")}
          {spaces.map(row)}
          {(plain.length > 0 || !q) && heading("Repos")}
          {plain.map(row)}
          {!q && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope === "none"}
              className={menuItem}
              onClick={() => choose("none")}
            >
              <SquareDashed aria-hidden />
              No repo
              <span className={trailing}>
                {count(needs("none"))}
                {check(scope === "none")}
              </span>
            </button>
          )}
          {q && offerAreas && shownAreas.length === 0 && (
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                hide();
                onNewArea(newAreaHost, query.trim());
              }}
            >
              <Plus aria-hidden />
              <span className="min-w-0 truncate">New area “{query.trim()}”</span>
            </button>
          )}
          {q && !offerAreas && repos.length === 0 && (
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">No repos match</p>
          )}
        </div>
        <div className="flex shrink-0 gap-3 border-t border-border px-3.5 py-1.5 text-[11px] text-faint-foreground">
          <span>↑↓ move</span>
          <span>↵ open</span>
          {areas.length > 0 && <span>→ edit area</span>}
        </div>
      </div>
      {spaceDialog && (
        <SettingDialog
          ref={spaceRef}
          label={`${spaceDialog.kind === "rename" ? "Rename" : "Delete"} ${spaceDialog.repo.name}`}
          action={spaceDialog.kind === "rename" ? "Rename" : "Delete"}
          onSave={() => void saveSpace()}
        >
          {spaceDialog.kind === "delete" ? (
            <p className="text-[13px] text-muted-foreground">
              Delete {spaceDialog.repo.name} and every chat in it? This can't be undone.
            </p>
          ) : (
            <label className="block text-[13px]">
              Name
              <input
                autoFocus
                value={spaceName}
                onChange={(e) => setSpaceName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 focus-visible:outline-none"
              />
            </label>
          )}
          {spaceError && <p className="mt-2 text-[12.5px] text-danger">{spaceError}</p>}
        </SettingDialog>
      )}
      {/* Each pick saves at once; the picker stays open for the next. */}
      <IconPicker
        ref={picker}
        id={pickerId}
        value={editing?.repo.icon}
        onPick={(icon) => editing && void editing.view.updateRepo(editing.repo.id, icon)}
        maxImageBytes={editing?.view.iconImageBytes}
      />
    </>
  );
}

/**
 * The footer's buttons: Profile, which shows the account's picture or initials and opens its menu
 * (ProfileMenu.tsx), Settings, Pull requests, Usage, and Update when `updatable` (Update.tsx), then
 * how many threads need the user, which goes to the next (⌥↓), and the keyboard shortcuts.
 */
function Footer({
  listed,
  onOpenSettings,
  onOpenPullRequests,
  needs,
  onJump,
}: Pick<ThreadListProps, "onOpenSettings" | "onOpenPullRequests"> & {
  listed: HostThreads[];
  needs: number;
  onJump: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ProfileButton listed={listed} />
      <IconButton label="Settings" command="settings" onClick={() => onOpenSettings("general")}>
        <Settings />
      </IconButton>
      <IconButton label="Pull requests" onClick={onOpenPullRequests}>
        <GitPullRequest />
      </IconButton>
      <IconButton label="Usage" onClick={() => onOpenSettings("usage")}>
        <ChartNoAxesColumn />
      </IconButton>
      {window.parallax.updatable && <UpdateButton />}
      <span className="flex-1" />
      {needs > 0 && (
        <button
          type="button"
          onClick={onJump}
          aria-label={`${needs} ${needs === 1 ? "needs" : "need"} you. Go to the next`}
          title={`Go to the next thread that needs you (${altArrow("↓")})`}
          className="flex h-6 items-center gap-1.25 rounded-md bg-warning/13 px-1.75 text-[11.5px] font-semibold text-warning tabular-nums hover:bg-warning/20 [&_svg]:size-3.5"
        >
          <MessageCircleQuestion aria-hidden />
          {needs}
          <kbd className="font-sans font-semibold opacity-75">{altArrow("↓")}</kbd>
        </button>
      )}
      <ShortcutsButton />
    </div>
  );
}

/** ⌥ and an arrow, as this OS writes it. */
const altArrow = (arrow: string) => (mac() ? `⌥${arrow}` : `Alt+${arrow}`);

/** The keyboard button and its list of the sidebar's shortcuts (PLX-789). */
function ShortcutsButton() {
  const id = useId();
  const back = useShortcutLabel("back");
  const forward = useShortcutLabel("forward");
  const mod = mac() ? "⌘" : "Ctrl+";
  // Each: what it does, its keys, and how else.
  const keys: [string, string[], string?][] = [
    ["Next or previous that needs you", [altArrow("↓"), altArrow("↑")]],
    ["Move between threads", ["↑", "↓"]],
    ["Open", ["↵"]],
    ["Archive, snooze, pin", ["E", "S", "P"]],
    ["Add to an area", ["A"]],
    ["Rename", ["R"], "or double-click"],
    ["Select", ["X"], `⇧-click, ${mod}click`],
    ["Delete", ["⌫"]],
    ...(back && forward ? [["Back, forward", [back, forward]] as [string, string[]]] : []),
    ["Areas, all threads", [`${areaKey(1)}–9`, areaKey(0)]],
    ["Search", ["/"]],
    ["Undo", [shortcut("Z")]],
  ];
  return (
    <>
      <IconButton label="Keyboard shortcuts" popoverTarget={id}>
        <Keyboard />
      </IconButton>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Keyboard shortcuts"
        className={`${menuPanel("end")} w-76 p-3`}
      >
        <table className="w-full border-collapse text-[12.5px]">
          <tbody>
            {keys.map(([what, how, also]) => (
              <tr key={what} className="[&+&>td]:border-t [&+&>td]:border-border">
                <td className="py-1 pr-2">{what}</td>
                <td className="py-1 text-right whitespace-nowrap text-muted-foreground">
                  {how.map((k) => (
                    <kbd
                      key={k}
                      className="ml-1 rounded bg-hover px-1 py-px font-sans text-[10.5px]"
                    >
                      {k}
                    </kbd>
                  ))}
                  {also && <span className="ml-1 text-[11.5px]">{also}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A row's Areas menu section (PLX-789). */
interface AreaMenu {
  /** For a child thread: its root's title, which it follows into areas. */
  parent?: string;
  areas: { area: Area; on: boolean }[];
  onToggle: (area: Area, on: boolean) => void;
  /** Opens New area with the row picked. */
  onNew: () => void;
}

/**
 * A row menu's Areas: each of its host's areas as a checkbox, which leaves the menu open, then New
 * area…, or for a child thread, a note that it follows its parent instead.
 */
function AreaMenuItems({ menu, onClose }: { menu: AreaMenu; onClose: () => void }) {
  return (
    <>
      <p role="presentation" className={menuHeading}>
        Areas
      </p>
      {menu.parent !== undefined ? (
        <p className="px-2 pb-1.5 text-[12px] leading-normal text-faint-foreground">
          Follows <b className="font-medium text-muted-foreground">{menu.parent}</b> into its areas.
        </p>
      ) : (
        <>
          {menu.areas.map(({ area, on }) => (
            <button
              key={area.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              onClick={() => menu.onToggle(area, !on)}
              className={menuItem}
            >
              <CheckBox state={on} />
              <AreaSwatch color={area.color} />
              <span className="min-w-0 truncate">{area.name}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              menu.onNew();
            }}
            className={menuItem}
          >
            <Plus aria-hidden />
            New area…
          </button>
        </>
      )}
    </>
  );
}

/** Dots in the colors of the areas a row is in. */
function AreaDots({ areas }: { areas: Area[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.75">
      {areas.map((a) => (
        <span key={a.id} title={`In ${a.name}`} className="flex">
          <AreaSwatch color={a.color} className="size-1.75 rounded-[2px]" />
        </span>
      ))}
    </span>
  );
}

/** `text` with a search's words marked. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlight(text, words).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-[3px] bg-warning/30 px-px text-inherit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * A Project's row, one line for its whole coordinator and subagents: its icon and name, then what
 * its runs ask of the user or its age. Its tooltip counts its agents, and names its host when there
 * are several. Where its host's plxd can edit or delete Projects, hovering or focusing it swaps the
 * status for its actions, which also open by right-clicking the row: Rename, which edits the name
 * in place, Change icon, which opens the icon picker under the row's icon, Full access…, which
 * moves a Project not yet in Bypass there for good (0042), as Create Project now starts every
 * one, Autonomy…, which sets who answers its children's questions (0043), and Delete….
 */
function ProjectRow({
  rowKey,
  flip,
  project,
  runs,
  attention,
  host,
  selected,
  badge,
  words,
  dots,
  areaMenu,
  onKeys,
  editable,
  moded,
  autonomous,
  iconImageBytes,
  onOpen,
  onUpdate,
  onDelete,
}: {
  project: Project;
  runs: AgentRun[];
  attention: Attention;
  /** Its host, named when there is more than one. */
  host?: Host;
  selected: boolean;
  /** Its Mod+number badge, shown in place of its status while Mod is held. */
  badge?: ReactNode;
  /** Its key in the list, for keyboard moves, and whether it slides when the list moves. */
  rowKey: string;
  flip: boolean;
  /** A search's words, marked in its name. */
  words: readonly string[];
  /** The areas it's in, besides the one shown, as dots. */
  dots: Area[];
  areaMenu?: AreaMenu;
  /** Keyboard triage on the focused row (PLX-789). */
  onKeys: (e: ReactKeyboardEvent<HTMLElement>) => void;
  editable: boolean;
  /** Whether its host's plxd keeps its permission mode (`projectPermission`). */
  moded: boolean;
  /** Whether its host's plxd keeps its autonomy (`projectAutonomy`, 0043). */
  autonomous: boolean;
  /** Its host's cap on an icon image, where its plxd keeps them. */
  iconImageBytes?: number;
  onOpen: () => void;
  /** Sends `project/update`, and settles once plxd has answered. */
  onUpdate: (change: ProjectChange) => Promise<void>;
  /** Asks to delete it, where its host's plxd can (`projectDelete`). */
  onDelete?: () => void;
}) {
  const menuId = useId();
  const pickerId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const iconSpot = useRef<HTMLSpanElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const autonomyDialog = useRef<HTMLDialogElement>(null);
  const accessDialog = useRef<HTMLDialogElement>(null);
  // A Project made before full access was the only mode, such as one on Auto, can move to it.
  const upgradable = moded && project.permission !== "bypass";
  // The level picked in Autonomy…, which opens on the Project's own.
  const [autonomy, setAutonomy] = useState<ProjectAutonomy>("routine");
  // The name the field opened with, while Rename is open.
  const [renaming, setRenaming] = useState<string>();
  // The new name, shown until plxd answers.
  const [saving, setSaving] = useState<string>();
  // Set while the name box is open, so Enter and the blur that follows save once.
  const editing = useRef(false);
  // After Enter or Escape, the row takes focus back from the name box.
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming !== undefined || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [renaming]);

  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    action();
  };
  const startRename = () => {
    editing.current = true;
    setRenaming(project.name);
  };
  // An empty name, or the one the field opened with, saves nothing, even if another client has
  // renamed the Project since.
  const endRename = async (name: string | undefined, focusRow: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    refocus.current = focusRow;
    setRenaming(undefined);
    const next = name?.trim();
    if (!next || next === renaming) return;
    setSaving(next);
    await onUpdate({ name: next });
    setSaving(undefined);
  };

  const icon = <ProjectIcon icon={project.icon} className="size-4" />;
  const actionable = editable || upgradable || autonomous || !!onDelete || !!areaMenu;
  const tooltip =
    [runs.length > 0 && `${runs.length} ${runs.length === 1 ? "agent" : "agents"}`, host?.name]
      .filter(Boolean)
      .join(" · ") || undefined;
  return (
    <li data-kind="project" data-flip={flip ? rowKey : undefined} className="group/row relative">
      {renaming !== undefined ? (
        <div
          className={`${row} ${selected ? current : ""} outline-2 -outline-offset-2 outline-ring`}
        >
          <span className="grid shrink-0 place-items-center">{icon}</span>
          <input
            aria-label="Project name"
            defaultValue={renaming}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              // Enter and Escape belong to an input method while it composes.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") void endRename(e.currentTarget.value, true);
              else if (e.key === "Escape") void endRename(undefined, true);
            }}
            onBlur={(e) => void endRename(e.currentTarget.value, false)}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground focus-visible:outline-none"
          />
        </div>
      ) : (
        <button
          ref={button}
          type="button"
          aria-current={selected ? "page" : undefined}
          title={tooltip}
          data-row={rowKey}
          data-kind="project"
          onClick={onOpen}
          onKeyDown={onKeys}
          onContextMenu={actionable ? (e) => openOnContextMenu(e, actions.current) : undefined}
          className={`${row} ${selected ? current : ""} ${actionable ? "group-has-[:focus-visible]/row:pr-8 group-hover/row:pr-8" : ""}`}
        >
          <span ref={iconSpot} data-project-icon className="grid shrink-0 place-items-center">
            {icon}
          </span>
          <span
            data-title
            className={`min-w-0 flex-1 truncate ${selected ? "text-foreground" : "text-foreground/80"}`}
          >
            {saving ?? <Marked text={project.name} words={words} />}
          </span>
          {dots.length > 0 && <AreaDots areas={dots} />}
          <span
            data-status
            className={`shrink-0 text-[11.5px] text-faint-foreground ${actionable ? "group-has-[:focus-visible]/row:hidden group-hover/row:hidden" : ""}`}
          >
            {badge ??
              (attention === "settled" ? (
                age(project.updatedAt)
              ) : (
                <AttentionBadge
                  attention={attention}
                  count={runs.filter((r) => isRunning(r.status)).length}
                />
              ))}
          </span>
        </button>
      )}
      {actionable && renaming === undefined && (
        <>
          <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100">
            <button
              ref={actions}
              type="button"
              aria-label="Project actions"
              title="Project actions"
              popoverTarget={menuId}
              className="grid size-5.5 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
            >
              <Ellipsis />
            </button>
          </div>
          <Menu ref={menu} id={menuId} label="Project actions" align="end" className="min-w-52 p-1">
            {areaMenu && (
              <AreaMenuItems menu={areaMenu} onClose={() => menu.current?.hidePopover()} />
            )}
            {areaMenu && (editable || upgradable || autonomous || onDelete) && (
              <div role="separator" className="my-1 h-px bg-border" />
            )}
            {editable && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(startRename)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() =>
                    picker.current?.showPopover({ source: iconSpot.current ?? undefined }),
                  )}
                >
                  Change icon
                </button>
              </>
            )}
            {upgradable && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={choose(() => accessDialog.current?.showModal())}
              >
                Full access…
              </button>
            )}
            {autonomous && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={choose(() => {
                  setAutonomy(project.autonomy ?? "routine");
                  autonomyDialog.current?.showModal();
                })}
              >
                Autonomy…
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                role="menuitem"
                className={`${menuItem} text-danger`}
                onClick={choose(onDelete)}
              >
                Delete…
              </button>
            )}
          </Menu>
        </>
      )}
      {/* Each pick saves at once; the picker stays open for the next. */}
      {editable && (
        <IconPicker
          ref={picker}
          id={pickerId}
          value={project.icon}
          onPick={(next) => void onUpdate({ icon: next })}
          maxImageBytes={iconImageBytes}
        />
      )}
      {upgradable && (
        <SettingDialog
          ref={accessDialog}
          label={`${project.name} full access`}
          action="Give full access"
          onSave={() => void onUpdate({ permission: "bypass" })}
        >
          <p className="text-[13px] font-medium">Full access</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            New agents in this Project run commands and edit files without asking, as in new
            Projects. Agents running now keep asking until they next start. Agents on Cursor, Grok
            Build, Hermes Agent, Ollama Cloud, OpenRouter, and local models need it. You can't
            switch back.
          </p>
        </SettingDialog>
      )}
      {autonomous && (
        <SettingDialog
          ref={autonomyDialog}
          label={`${project.name} autonomy`}
          onSave={() => void onUpdate({ autonomy })}
        >
          <AutonomyChoice value={autonomy} onChange={setAutonomy} />
        </SettingDialog>
      )}
    </li>
  );
}

/** A Project setting's dialog: its choice, then Cancel and `action`, which closes it and saves. */
function SettingDialog({
  ref,
  label,
  action = "Save",
  onSave,
  children,
}: {
  ref: RefObject<HTMLDialogElement | null>;
  label: string;
  action?: string;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <dialog
      ref={ref}
      aria-label={label}
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
            className="rounded-md px-3 py-1.5 text-[13px] hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90"
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

/**
 * A thread row's first line: its repo's icon and name, then `status`: what it asks of the user, or
 * how long ago it was prompted. Hovering or focusing the row hides the status and keeps the repo
 * name clear of the row's actions.
 */
function RowHead({
  repo,
  status,
  words = [],
}: {
  repo?: Repo;
  status: ReactNode;
  words?: readonly string[];
}) {
  return (
    <span className="flex w-full items-center gap-2 text-[12px] text-faint-foreground group-has-[:focus-visible]/row:pr-34 group-hover/row:pr-34">
      <RepoIcon repo={repo} big />
      <span className="min-w-0 truncate">
        <Marked text={repo && !repo.scratch ? repo.name : "No repo"} words={words} />
      </span>
      <span
        data-status
        className="ml-auto shrink-0 text-[11.5px] group-has-[:focus-visible]/row:hidden group-hover/row:hidden"
      >
        {status}
      </span>
    </span>
  );
}

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

/**
 * An unsent New Thread prompt's row (PLX-788): its repo and a Draft status, then its first line,
 * outlined in the warning color. Opening it reopens New Thread with it, which takes it off the list.
 */
function DraftRow({ draft, repo, onOpen }: { draft: Draft; repo?: Repo; onOpen: () => void }) {
  const attached = draft.images.length + draft.files.length + draft.threads.length;
  const title =
    draft.text.trim().split("\n")[0] ||
    `${attached} ${attached === 1 ? "attachment" : "attachments"}`;
  return (
    <li data-kind="draft">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-0.5 rounded-lg border border-warning px-2 py-1.5 text-left hover:bg-hover"
      >
        <RowHead
          repo={repo}
          status={
            <span className="flex items-center gap-1 text-[11.5px] font-medium text-warning [&_svg]:size-3.5">
              <PencilLine aria-hidden />
              Draft
            </span>
          }
        />
        <span data-title className="w-full truncate text-[13px] text-foreground">
          {title}
        </span>
      </button>
    </li>
  );
}

/**
 * A thread's row (0033): its repo and status (what it asks of the user, or how long ago it was
 * prompted), its title, then its worktree or local checkout icon and branch, a pin, linked pull
 * requests (the number of one, or +N for more), the other areas it's in, and provider. Under a
 * search, the words found are marked, and a match only in its messages shows a line of them.
 * Resting on it shows its card; hovering or focusing it swaps the status for Snooze, Archive, and
 * more actions, which also open by right-clicking the row: native popovers, so Escape and clicking
 * away close them. A row waiting on one command shows it, with Deny and Allow, on hover or focus.
 * Double-clicking the title renames it in place.
 */
function ThreadRow({
  rowKey,
  flip,
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
  inFamily,
  badge,
  nested,
  words,
  snippet,
  dots,
  ask,
  renaming,
  snoozable,
  renamable,
  autoResumable,
  areaMenu,
  onOpen,
  onKeys,
  onArchive,
  onSnooze,
  onPin,
  onRename,
  onStartRename,
  onAnswer,
  onDelete,
  onOpenBeside,
  onFork,
  onAutoResume,
  onRest,
  onLeave,
}: {
  /** Its key in the list, for keyboard moves, and whether it slides when the list moves. */
  rowKey: string;
  flip: boolean;
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
  /** Atop its children's strip, whose block has the hover. */
  inFamily: boolean;
  /** Its Mod+number badge, shown in place of its status while Mod is held. */
  badge?: ReactNode;
  /** Under its parent's row, which names the repo: its status goes beside its title instead. */
  nested?: boolean;
  /** A search's words, marked where they're found. */
  words: readonly string[];
  /** A line of its messages where the search found what its title and branch don't have. */
  snippet?: string;
  /** The areas it's in, besides the one shown, as dots. */
  dots: Area[];
  /** The one command it waits on, which the row can allow or deny. */
  ask?: Ask;
  /** Whether its title is being edited in place. */
  renaming: boolean;
  /** Whether its plxd keeps seen and snooze state (`threadAttention`). */
  snoozable: boolean;
  /** Whether its plxd keeps its title (`threadLineage`). */
  renamable: boolean;
  /** Whether its plxd resumes runs after usage limits (`autoResume`, 0049). */
  autoResumable: boolean;
  areaMenu?: AreaMenu;
  /** A click: opens it, or with Mod or Shift, picks it. */
  onOpen: (e: MouseEvent<HTMLElement>) => void;
  /** Keyboard triage on the focused row (PLX-789). */
  onKeys: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onArchive: () => void;
  onSnooze: (until: Date) => void;
  /** Pins or unpins it, for a top-level thread where its plxd keeps pins. */
  onPin?: () => void;
  /** Ends a rename: saves `title`, or with undefined, keeps the old one. */
  onRename: (title: string | undefined) => void;
  onStartRename: () => void;
  onAnswer: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
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
  // The request being answered from the row, until its answer is in.
  const [answering, setAnswering] = useState<string>();
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
  const Logo = run?.backend ? (backendLogos[run.backend] ?? instanceLogo(run.backend)) : undefined;
  // Read once, not polled: a row's state is as of when the sidebar loaded it.
  const prs = usePullRequests(hostId, run?.id, run?.pullRequests ?? [], false, false);
  const prLook = majorityLook(prs);
  // A checkout thread has no branch of its own: show the one its repository has out, read again
  // as its run's status changes. A detached HEAD, or a plxd without `git`, leaves it unnamed.
  const [checkoutBranch, setCheckoutBranch] = useState<string | null>(null);
  const checkoutRun = run?.checkout ? run.id : undefined;
  const runStatus = run?.status;
  useEffect(() => {
    if (!checkoutRun) return;
    let live = true;
    void window.parallax
      .request(hostId, "agent/gitStatus", { runId: checkoutRun })
      .then(
        (answer) => live && setCheckoutBranch("result" in answer ? answer.result.branch : null),
      );
    return () => {
      live = false;
    };
  }, [hostId, checkoutRun, runStatus]);
  const branch = run?.checkout ? (checkoutBranch ?? "Local checkout") : run?.branch;
  const hasDetails = !!(
    branch ||
    prs.urls.length ||
    Logo ||
    device ||
    thread.pinned ||
    dots.length
  );
  const snoozedNow = !!thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now();
  const mainLabel = (
    <>
      {thread.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
      {thread.archived ? "Unarchive" : "Archive"}
    </>
  );
  const status =
    badge ??
    (run?.status === "waiting" && attention === "settled" && !thread.archived ? (
      <span className="flex items-center gap-1 text-[11.5px] font-medium text-warning [&_svg]:size-3.5">
        <AlarmClock aria-hidden />
        {run.resumeAt ? `Resumes ${resumeTime(run.resumeAt)}` : "Waiting"}
      </span>
    ) : attention === "settled" ? (
      age(lastPrompt(thread))
    ) : (
      <AttentionBadge attention={attention} since={lastPrompt(thread)} />
    ));
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
      className="-mx-1 w-[calc(100%+0.5rem)] min-w-0 rounded-[5px] bg-background px-1 text-[13px] font-medium text-foreground ring-[1.5px] ring-ring focus-visible:outline-none"
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
  const rowLook = picked
    ? "bg-accent/14 ring-1 ring-accent/38 ring-inset"
    : selected
      ? current
      : inFamily
        ? ""
        : "group-hover/row:bg-hover";
  return (
    <li
      data-kind="thread"
      data-flip={flip ? rowKey : undefined}
      className={`group/row relative rounded-lg transition-colors duration-100 ${rowLook} ${flash ? "row-flash" : ""}`}
      onMouseEnter={(e) => onRest(e.currentTarget)}
      onMouseLeave={onLeave}
    >
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
        }}
        className="flex w-full cursor-pointer flex-col gap-1 rounded-lg px-2 py-[7px] text-left -outline-offset-2"
      >
        {nested ? (
          <span className="flex w-full items-center gap-2 group-has-[:focus-visible]/row:pr-34 group-hover/row:pr-34">
            <span
              data-title
              className={`min-w-0 flex-1 truncate text-[13px] font-[450] transition-colors ${titleColor}`}
            >
              {titleText}
            </span>
            <span
              data-status
              className="shrink-0 text-[11.5px] text-faint-foreground group-has-[:focus-visible]/row:hidden group-hover/row:hidden"
            >
              {status}
            </span>
          </span>
        ) : (
          <>
            <RowHead repo={repo} status={status} words={words} />
            <span
              data-title
              className={`w-full truncate text-[13px] font-[450] transition-colors ${titleColor}`}
            >
              {titleText}
            </span>
          </>
        )}
        {hasDetails && (
          <span className="flex w-full items-center gap-2 text-[11.5px] text-faint-foreground">
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {run?.checkout ? (
                // Without a branch, the text beside it already says "Local checkout".
                <span
                  title="Local checkout"
                  role="img"
                  aria-label="Local checkout"
                  aria-hidden={!checkoutBranch}
                  className="flex shrink-0"
                >
                  <Folder className="size-3.5" />
                </span>
              ) : (
                branch && (
                  <span title="Worktree" role="img" aria-label="Worktree" className="flex shrink-0">
                    <FolderGit2 className="size-3.5" />
                  </span>
                )
              )}
              <span className="min-w-0 truncate">
                {branch && <Marked text={branch} words={words} />}
              </span>
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
                  // Inside the row's button, so a span: clicking it opens the PR on GitHub
                  // (PLX-809), not the thread.
                  <span
                    className="hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.open(prs.urls[0], "_blank");
                    }}
                  >
                    <Marked text={`#${numberOf(prs.urls[0]!)}`} words={words} />
                  </span>
                )}
              </span>
            )}
            {dots.length > 0 && <AreaDots areas={dots} />}
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
            {Logo && <Logo className="size-3.5 shrink-0" />}
          </span>
        )}
        {snippet && (
          <span className="flex w-full min-w-0 items-center gap-1.5 text-[11.5px] text-faint-foreground">
            <Search aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              <Marked text={snippet} words={words} />
            </span>
          </span>
        )}
      </Main>
      {ask && !thread.archived && (
        <div className="-mt-1 hidden items-center gap-1.25 px-2 pb-2 group-hover/row:flex group-has-[:focus-visible]/row:flex">
          <code
            title={ask.command}
            className="min-w-0 flex-1 truncate rounded-md bg-code px-1.5 py-0.75 font-mono text-[10.5px] text-foreground"
          >
            {ask.command}
          </code>
          {(["deny", "allow"] as const).map((decision) => (
            <button
              key={decision}
              type="button"
              disabled={answering === ask.approvalId}
              onClick={async () => {
                setAnswering(ask.approvalId);
                await onAnswer(ask.approvalId, decision);
                setAnswering(undefined);
              }}
              className={`h-5.5 shrink-0 rounded-md px-2 text-[11.5px] font-medium disabled:opacity-50 ${decision === "allow" ? "bg-primary text-primary-foreground enabled:hover:opacity-90" : "border border-border bg-background enabled:hover:bg-hover"}`}
            >
              {decision === "allow" ? "Allow" : "Deny"}
            </button>
          ))}
        </div>
      )}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100 [&_button]:cursor-pointer">
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
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
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
                  <span className="ml-auto text-[12px] text-faint-foreground tabular-nums">
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
                  className="min-w-0 flex-1 rounded-md bg-hover px-1.5 py-1 text-[12px] [color-scheme:inherit]"
                />
                <button
                  type="submit"
                  disabled={!custom}
                  className="rounded-md px-2 py-1 text-[12px] hover:bg-hover disabled:opacity-50"
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
            {areaMenu && (
              <>
                {onOpenBeside && <div role="separator" className="my-1 h-px bg-border" />}
                <AreaMenuItems menu={areaMenu} onClose={() => menu.current?.hidePopover()} />
              </>
            )}
            {(onOpenBeside || areaMenu) && <div role="separator" className="my-1 h-px bg-border" />}
            {onPin && (
              <button type="button" role="menuitem" className={menuItem} onClick={choose(onPin)}>
                <Pin aria-hidden />
                {thread.pinned ? "Unpin" : "Pin to top"}
                <MenuKey>P</MenuKey>
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
              {thread.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              {thread.archived ? "Unarchive" : "Archive"}
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

/** A menu item's key, at its end. */
function MenuKey({ children }: { children: string }) {
  // Drawn from the attribute, so the item's name stays its whole text.
  return (
    <kbd
      aria-hidden
      data-key={children}
      className="ml-auto pl-3 font-sans text-[11px] text-faint-foreground before:content-[attr(data-key)]"
    />
  );
}

/**
 * The two threads open side by side (PLX-587), joined in one box above the list: each with its
 * Focus left or right thread key and a button that closes its side. Choosing one focuses it.
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
  const left = useShortcutLabel("leftThread");
  const right = useShortcutLabel("rightThread");
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
                <kbd className="shrink-0 rounded border border-border bg-surface px-1 font-sans text-[11px] leading-4 text-muted-foreground">
                  {side === 0 ? left : right}
                </kbd>
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                title="Close this side"
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
  useImperativeHandle(ref, () => ({
    show(row, content) {
      window.clearTimeout(timer.current);
      const place = () => {
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
 * What a thread is, shown beside its row: its title, repository, computer, branch, account,
 * changes, and status, from its run as last listed (resting on the row lists it again).
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
  const Logo = run?.backend ? (backendLogos[run.backend] ?? instanceLogo(run.backend)) : undefined;
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
          {hostIcon(host)}
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

/** Each Settings section's name and icon, in the nav's order. */
const sections: { id: SettingsSection; name: string; Icon: LucideIcon }[] = [
  { id: "usage", name: "Usage", Icon: ChartNoAxesColumn },
  { id: "general", name: "General", Icon: Settings },
  { id: "appearance", name: "Appearance", Icon: Palette },
  { id: "keybinds", name: "Keybinds", Icon: Keyboard },
  { id: "providers", name: "Providers", Icon: Bot },
  { id: "sourceControl", name: "Source control", Icon: GitBranch },
  { id: "schedules", name: "Schedules", Icon: CalendarClock },
  { id: "scripts", name: "Scripts", Icon: SquareTerminal },
  { id: "storage", name: "Storage", Icon: HardDrive },
  { id: "connections", name: "Connections", Icon: Server },
];
export const settingsNames = Object.fromEntries(sections.map((s) => [s.id, s.name])) as Record<
  SettingsSection,
  string
>;

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
          <s.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {s.name}
        </button>
      ))}
    </div>
  );
}
