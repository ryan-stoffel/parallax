import {
  ChevronLeft,
  Cloud,
  ChevronRight,
  FileSearch,
  FolderGit2,
  FolderPlus,
  GitFork,
  GitPullRequest,
  Globe,
  ChartColumn,
  Palette,
  Settings as SettingsIcon,
  SquareDashed,
  SquarePen,
  SunMoon,
  TextSearch,
  PanelBottom,
  PanelLeftOpen,
  PanelRight,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";

import type { InboxItem, PreviewTab, Repo, RepoId, Thread } from "../protocol/generated/protocol";
import { type RepoAction } from "./Actions";
import type { AddDialogHandle } from "./AddDialog";
import { CommandMenu, type CommandMenuHandle, type MenuItem } from "./CommandMenu";
import { AgentChat } from "./AgentChat";
import { AccountPrompts } from "./AccountPrompts";
import { ChangesPanel, type ChangesRequest } from "./ChangesPanel";
import { ChildStrip } from "./ChildStrip";
import { ClaudeLogo } from "./logos";
import type { Asked } from "./Approval";
import { offlineReason, useConnection } from "./ConnectionStatus";
import { FilesPanel } from "./FilesPanel";
import { useInbox } from "./Inbox";
import { KnowledgePanel } from "./Knowledge";
import { NewThread } from "./NewThread";
import { DevicePanel } from "./DevicePanel";
import { DocumentView } from "./DocumentView";
import type { DocRef } from "./documents";
import { freshDraftId } from "./drafts";
import { OpenDocumentContext } from "./FileCards";
import { panelWidths, SIDEBAR_MIN } from "./PanelResize";
import { NewThreadPicker, type PickerOrchestrator } from "./NewThreadPicker";
import { Notifications } from "./notifications";
import { Onboarding } from "./Onboarding";
import { Splash } from "./Splash";
import { useOnboarding } from "./firstRun";
import { localId, useHosts } from "./hosts";
import { iconImageBytes } from "./images";
import { ThreadDetails, ThreadDetailsButton, useThreadDetails } from "./ThreadDetails";
import { AgentsPanel, useOrchestratorAgents } from "./OrchestratorAgents";
import { useOrchestratorContext } from "./ContextPanel";
import { OrchestratorChat } from "./OrchestratorChat";
import { OrchestratorHome, waitingCount } from "./OrchestratorHome";
import { linkedPr, PullRequestList, PullRequestView, usePullRequests } from "./PullRequests";
import { PullRequestsPage } from "./PullRequestsPage";
import { NewChatProject, ProjectsPage } from "./ProjectsPage";
import { projectEntries, type ProjectEntry } from "./projectList";
import { pinnedProjects, togglePinnedProject } from "./sidebarPrefs";
import { RunTargetMenu } from "./RunTargetMenu";
import { ProjectContext, ProjectHeader, ProjectThreads } from "./ProjectHome";
import { UsagePage } from "./UsagePage";
import type { PrEntry } from "./pullRequestSearch";
import { SettingsDialog } from "./Settings";
import { SidePanel } from "./SidePanel";
import { browserSettingsAsked } from "./browserSettings";
import { anchorOf } from "./settings/search";
import type { NativeSubagent } from "./Subagents";
import { attentionOf } from "./attention";
import {
  useAccountAlarms,
  useConnectionAlarms,
  useOutdatedAlarms,
  useHostUpdateAlarms,
  useNeedsYouAlarm,
  useSnoozeAlarms,
  useThreadAlarms,
} from "./alarms";
import {
  ProjectIcon,
  RepoIcon,
  SharedRepoIcons,
  Sidebar,
  ThreadList,
  type ProjectMenuHandle,
} from "./Sidebar";
import { behaviorPrefs, newThreadPrefs } from "./prefs";
import { useThemePreference } from "./theme";
import type { ThreadLinks } from "./threadContext";
import { useAppearanceEffects } from "./appearance";
import { folderOf, runInDrawer, TerminalDrawer, TerminalPool, useDeleted } from "./ThreadTerminal";
import {
  asksOf,
  groupOf,
  groupThreads,
  emptyThreads,
  idleThreads,
  lacksRepo,
  isRepository,
  lineageOf,
  noRepo,
  otherRepos,
  repoless,
  sharedRepoIcons,
  rootOf,
  threadOrchestrators,
  titleOf,
  useThreads,
  type ForkChoice,
  type ThreadsView,
} from "./threads";
import { cloneOnto, type CloneAsk } from "./clone";
import { isRunning, kindOf } from "./transcript";
import { isRemoteControl, useRemoteControl } from "./remoteControl";
import { keptRemoteControl, MoveRemoteControl } from "./MoveRemoteControl";
import { appShortcut, Breadcrumb, IconButton, TopBar, type Crumb } from "./ui";
import { useUpdateAlarms } from "./Update";
import { tileCommands } from "./keybindings";
import { evenRatio, maxTiles, ratiosWithout } from "./splitLayout";
import { SplitTiles } from "./SplitTiles";
import { draggedThread, threadDragType } from "./threadDrag";

/**
 * The main pane: an orchestrator chat, or with `agentId` one of its subagents' chats, a
 * thread (its id is its run's; `started` when New Thread just started it, until anything else is
 * selected; `subagent` when one of its agent's own subagents is open, by its call's id; `pr` when
 * its sidebar row's PR number opened it, which shows that pull request in the side panel), a new
 * thread in a sidebar group (`threads.ts`; with no group, it's the first repository's; `draft` when
 * it reopens one, by id, PLX-788).
 */
export type Selection =
  | { kind: "orchestrator"; orchestratorId: string; agentId?: string }
  | { kind: "thread"; threadId: string; started?: boolean; subagent?: string; pr?: string }
  | { kind: "new"; groupId?: string; draft?: string };

/**
 * Two to four threads on one host tiled side by side (PLX-587, PLX-1082), in their Fibonacci
 * layout's order, with each cut's share (splitLayout.ts): one fewer ratio than threads.
 * Opening another unmaximizes it.
 */
export interface Split {
  hostId: string;
  threadIds: string[];
  ratios: number[];
  /** All of them in one tile, the focused one shown, as tabs. */
  maximized?: boolean;
}

export type SettingsSection =
  | "general"
  | "threads"
  | "appearance"
  | "browser"
  | "keybinds"
  | "providers"
  | "sourceControl"
  | "computerUse"
  | "schedules"
  | "scripts"
  | "storage"
  | "connections"
  | "beta";

/**
 * The app frame: sidebar, then the chat or a page, then the side panel, with Settings floating
 * over them.
 * Views are plain state, not routes: there is nothing to deep-link yet.
 */
export function App() {
  const [theme, setTheme] = useThemePreference();
  const onboarding = useOnboarding();
  useAppearanceEffects(onboarding);
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  // The open host, or this computer once the open one is removed.
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const [selection, setSelection] = useState<Selection>({ kind: "new" });
  // The threads opened in this window, oldest first, and where Back and Forward stand (PLX-789).
  const [history, setHistory] = useState<{
    list: { hostId: string; threadId: string }[];
    at: number;
  }>({ list: [], at: -1 });
  // Shown while the selection is one of its threads, which is the focused one.
  const [split, setSplit] = useState<Split>();
  // An orchestrator just created on another host, opened once that host is open and lists it: the
  // check below drops an orchestrator selection the open host's list doesn't have.
  const [opening, setOpening] = useState<{ hostId: string; orchestratorId: string }>();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // The host Set up GitHub opened Source control on (PLX-423).
  const [settingsHost, setSettingsHost] = useState<string>();
  // The setting Settings' search picked last, to scroll to; a new object each pick.
  const [settingsFocus, setSettingsFocus] = useState<{ anchor: string }>();
  // How many times Settings has closed. New thread and an orchestrator's chat read the default
  // account again each time, since it may have changed there.
  const [settingsClosed, setSettingsClosed] = useState({ open: false, count: 0 });
  if (settingsClosed.open !== (settings !== null))
    setSettingsClosed(({ count }) => ({
      open: settings !== null,
      count: settings ? count : count + 1,
    }));
  // The page shown in place of the chat, if any: Projects, Pull requests, or Usage. Opening a
  // thread closes it.
  const [mainPage, setMainPage] = useState<"projects" | "pullRequests" | "usage">();
  // The sidebar's orchestrator menus, which the orchestrators page's cards open (0090).
  const orchestratorMenu = useRef<ProjectMenuHandle>(null);
  const newChatOrchestrator = useRef<HTMLDialogElement>(null);
  const pins = pinnedProjects.use();

  useEffect(() => setMainPage(undefined), [selection]);
  const openSettings = (section: SettingsSection, hostId?: string) => {
    setSettings(section);
    setSettingsHost(hostId);
    setSettingsFocus(undefined);
  };
  // Settings › Browser, from the browser's menus (Browser.tsx).
  const askedSettings = browserSettingsAsked.use();
  useEffect(() => {
    if (!askedSettings) return;
    openSettings("browser");
    if (askedSettings.title) setSettingsFocus({ anchor: anchorOf(askedSettings.title) });
  }, [askedSettings]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // An orchestrator's menu items, from the sidebar, which holds their dialogs and icon picker. Each
  // shows the sidebar first, since a modal in a hidden sidebar would leave the window inert.
  const orchestratorActions = (entry: ProjectEntry) =>
    (orchestratorMenu.current?.actionsFor(entry) ?? []).map((action) => ({
      ...action,
      run: (square: HTMLElement) => {
        if (!sidebarOpen) flushSync(() => setSidebarOpen(true));
        action.run(square);
      },
    }));
  // What each chat's right column shows, if anything: the side panel's views, or the browser,
  // which is apart from them (PLX-962). Each host's chats stay independent when switching.
  const [openPanes, setOpenPanes] = useState<Record<string, "views" | "browser" | undefined>>({});
  const panelKey = JSON.stringify([
    host.id,
    selection.kind,
    selection.kind === "thread"
      ? selection.threadId
      : selection.kind === "orchestrator"
        ? selection.orchestratorId
        : selection.groupId,
  ]);
  const pane = openPanes[panelKey];
  const setPane = (next: "views" | "browser" | undefined) =>
    setOpenPanes((panes) => ({ ...panes, [panelKey]: next }));
  const panelOpen = pane === "views";
  const setPanelOpen = (open: boolean) => setPane(open ? "views" : undefined);
  // Full screen is per panel too.
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});
  const panelExpanded = expandedPanels[panelKey] ?? false;
  const setPanelExpanded = (next: boolean) =>
    setExpandedPanels((panels) => ({ ...panels, [panelKey]: next }));
  // The folders whose terminal drawer is open, by key (ThreadTerminal.tsx).
  const [drawers, setDrawers] = useState<ReadonlySet<string>>(new Set());
  // A request to open the Changes view, perhaps on a thread's turn, scrolled to a file.
  const [showChanges, setShowChanges] = useState<ChangesRequest>();
  // The page a repository action last opened in the side panel's Browser view.
  const [browse, setBrowse] = useState<{ url?: string; agentTab?: string }>();
  // The open thread's agent browser tabs (PLX-639), which plxd lists after each browser tool call.
  const [agentTabs, setAgentTabs] = useState<{ runId: string; tabs: PreviewTab[] }>();
  const showPreviews = async (runId: string, reveal: boolean) => {
    const answer = await window.parallax.request(host.id, "preview/list", { runId });
    if ("error" in answer) return;
    const { tabs } = answer.result;
    setAgentTabs({ runId, tabs });
    const last = tabs.at(-1);
    // Only the focused thread's own preview opens its panel, not the other side of a split's.
    if (reveal && last && selection.kind === "thread" && selection.threadId === runId) {
      setPane("browser");
      setBrowse({ agentTab: last.tabId });
    }
  };
  // The top bar's Browser button shows or hides the browser, as the user left it (PLX-962).
  const toggleBrowser = () => setPane(pane === "browser" ? undefined : "browser");
  // The device the side panel's Device view last showed for an agent (PLX-886).
  const [showDevice, setShowDevice] = useState<{ deviceId?: string }>();
  const showAgentDevice = async (runId: string, named?: string) => {
    // Only the focused thread's own device opens its panel, not the other side of a split's.
    if (selection.kind !== "thread" || selection.threadId !== runId) return;
    let deviceId = named;
    if (!deviceId) {
      const answer = await window.parallax.request(host.id, "device/state", { runId });
      deviceId = "error" in answer ? undefined : answer.result.open.at(-1);
    }
    if (!deviceId) return;
    setPanelOpen(true);
    setShowDevice({ deviceId });
  };
  // Each new one shows the open orchestrator's Orchestrator tab, when the sidebar opens an
  // orchestrator.
  const [showHome, setShowHome] = useState<object>();
  // The pull request the side panel last opened, or with no URL its Pull requests view.
  const [showPr, setShowPr] = useState<{ url?: string }>();
  // A message the PR view handed the open thread's chat, until the chat takes it.
  const [compose, setCompose] = useState<{ text: string; send: boolean }>();
  const composed = useCallback(() => setCompose(undefined), []);
  // The presented file the side panel last opened (PLX-755), a new object each time.
  const [showDoc, setShowDoc] = useState<DocRef>();
  const openDoc = (doc: DocRef) => {
    setPanelOpen(true);
    setShowDoc({ ...doc });
  };
  // The file the command menu last picked (PLX-993), which a run's Files view opens, a new object
  // each time, and each new request to show that view.
  const [revealFile, setRevealFile] = useState<{ runId: string; path: string }>();
  const [showFiles, setShowFiles] = useState<object>();
  // Once the Files view has taken a pick, it's dropped, so the view doesn't open it again later.
  useEffect(() => {
    if (revealFile) setRevealFile(undefined);
  }, [revealFile]);

  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  // Runs started here forward their permission requests, only to a plxd that takes the flag.
  const approvals = connected && "approvals" in connection.capabilities;
  // Every host's threads and orchestrators, loaded side by side for the sidebar's one list (0033).
  const [views, setViews] = useState<Readonly<Record<string, ThreadsView>>>({});
  const report = useCallback(
    (id: string, view: ThreadsView) =>
      setViews((prev) => (prev[id] === view ? prev : { ...prev, [id]: view })),
    [],
  );
  const threads = views[host.id] ?? idleThreads;
  // The open host's threads, which a message attaches and its chips open (PLX-378).
  const threadLinks = useMemo<ThreadLinks>(
    () => ({
      hostId: host.id,
      state: threads.state,
      open: (threadId) => setSelection({ kind: "thread", threadId }),
    }),
    [host.id, threads.state],
  );
  const listed = useMemo(
    () => hosts.map((h) => ({ host: h, view: views[h.id] ?? idleThreads })),
    [hosts, views],
  );
  const groups = groupThreads(threads.state);
  // The other computers' repositories, which New Thread and Mod+N's picker list too.
  const elsewhere = useMemo(() => otherRepos(hosts, views, host.id), [hosts, views, host.id]);
  // The computer New thread opens on: Settings > Threads' while it's listed and connected, else
  // the open one. Mod+N's picker lists its repositories first.
  const startPref = newThreadPrefs.use().host;
  const startConnected = useConnection(startPref)?.status === "connected";
  const start = (startConnected && hosts.find((h) => h.id === startPref)) || host;
  const startState = (views[start.id] ?? idleThreads).state;
  const startGroups = start.id === host.id ? groups : groupThreads(startState);
  const startElsewhere = useMemo(
    () => otherRepos(hosts, views, start.id),
    [hosts, views, start.id],
  );
  // Each repository's icon by name, for its copies on other computers that have none.
  const repoIcons = useMemo(() => sharedRepoIcons(hosts, views), [hosts, views]);
  // Every thread and orchestrator the open host has listed, so a selection is dropped only once
  // what it opened leaves the list: a just-started one reaches the list a render after it opens.
  const known = useRef(new Set<string>());
  for (const t of threads.state.threads) known.current.add(t.id);
  for (const p of threads.state.orchestrators) known.current.add(p.id);
  // Closes a thread's tile. The rest stay tiled, or the last one stays open alone, and a closed
  // focused tile hands focus to the one before it.
  const closePane = (threadId: string) => {
    if (!split) return;
    const at = split.threadIds.indexOf(threadId);
    if (at === -1) return;
    const rest = split.threadIds.filter((id) => id !== threadId);
    setSplit(
      rest.length > 1
        ? { ...split, threadIds: rest, ratios: ratiosWithout(split.ratios, rest.length + 1, at) }
        : undefined,
    );
    if (split.hostId === host.id && selection.kind === "thread" && selection.threadId === threadId)
      setSelection({ kind: "thread", threadId: rest[Math.max(0, at - 1)]! });
  };
  // A split whose computer is removed goes with it.
  if (split && !hosts.some((h) => h.id === split.hostId)) setSplit(undefined);
  // A thread in the split that's deleted, maybe by another client, closes its tile.
  const splitGone =
    split?.hostId === host.id
      ? split.threadIds.find(
          (id) => known.current.has(id) && !threads.state.threads.some((t) => t.id === id),
        )
      : undefined;
  if (splitGone) closePane(splitGone);
  // The threads the main pane shows: the split's while one of them is open.
  const tiled =
    selection.kind === "thread" &&
    split?.hostId === host.id &&
    split.threadIds.includes(selection.threadId);
  const panes = selection.kind !== "thread" ? [] : tiled ? split.threadIds : [selection.threadId];
  // The open thread's group (Chat's until plxd lists it), or the new thread's.
  let group = groups[0]!;
  if (selection.kind === "thread") {
    const open = threads.state.threads.find((t) => t.id === selection.threadId);
    // Deleted, maybe by another client: leave it rather than show a stale transcript.
    if (!open && known.current.has(selection.threadId) && !splitGone) setSelection({ kind: "new" });
    const id = open ? groupOf(threads.state, open) : noRepo;
    group = groups.find((g) => g.id === id)!;
  } else if (selection.kind === "new")
    group = groups.find((g) => g.id === selection.groupId) ?? group;
  // A Project's entry, while New thread is open in it (0090).
  const projectRepo =
    selection.kind === "new" && group.project
      ? threads.state.repos.find((r) => r.id === group.id)
      : undefined;
  // The computers a Project's thread can run on: its own, and any other with a Project of its name.
  const projectHosts = projectRepo
    ? hosts.filter(
        (h) =>
          h.id === host.id ||
          views[h.id]?.state.repos.some((r) => r.project && r.name === projectRepo.name),
      )
    : [];
  const projectEntry = projectRepo
    ? projectEntries(listed).find((e) => e.key === `${host.id}/${projectRepo.id}`)
    : undefined;

  if (
    opening?.hostId === host.id &&
    threads.state.orchestrators.some((p) => p.id === opening.orchestratorId)
  ) {
    setOpening(undefined);
    setSelection({ kind: "orchestrator", orchestratorId: opening.orchestratorId });
  }
  // The open orchestrator. Once its host is removed, the next host's list doesn't have it.
  const orchestrator =
    selection.kind === "orchestrator"
      ? threads.state.orchestrators.find((p) => p.id === selection.orchestratorId)
      : undefined;
  if (
    selection.kind === "orchestrator" &&
    !orchestrator &&
    known.current.has(selection.orchestratorId)
  )
    setSelection({ kind: "new" });
  // With the threads in the orchestrator, as its sidebar row counts them.
  const inOrchestrator = useMemo(() => threadOrchestrators(threads.state), [threads.state]);
  const agents = useOrchestratorAgents(
    host.id,
    orchestrator?.id,
    threads.state,
    inOrchestrator,
    approvals,
  );
  // The open subagent, whose chat takes the orchestrator's place while the orchestrator stays
  // selected.
  const agentId = selection.kind === "orchestrator" ? selection.agentId : undefined;
  // Entering an orchestrator shows its inbox in the side panel.
  const orchestratorPanelKey = orchestrator ? panelKey : undefined;
  const [panelOrchestrator, setPanelOrchestrator] = useState(orchestratorPanelKey);
  if (orchestratorPanelKey !== panelOrchestrator) {
    setPanelOrchestrator(orchestratorPanelKey);
    if (orchestrator) setPanelOpen(true);
  }
  // The orchestrator's inbox (0043), on a plxd with `inbox`, and the children whose questions wait
  // in it.
  const answerable = connected && "questions" in connection.capabilities;
  const inbox = useInbox(
    host.id,
    orchestrator?.id ?? "",
    connected && !!orchestrator && "inbox" in connection.capabilities,
    answerable,
  );
  // The orchestrator's context files, which its orchestrator tab reads.
  const context = useOrchestratorContext(
    host.id,
    orchestrator?.id ?? "",
    connected && !!orchestrator,
  );
  const needs = useMemo(
    () => new Set(inbox.items.filter((i) => !i.seenAt && i.kind === "needsYou").map((i) => i.run)),
    [inbox.items],
  );
  const agent = agents.runs.find((r) => r.id === agentId);
  // Its thread's title from plxd (0041), else its prompt's.
  const agentTitle = agentId
    ? (threads.state.titles[agentId] ?? (agent ? titleOf(agent) : "Subagent"))
    : undefined;
  // Whose memory the side panel's Knowledge view shows, on a plxd with `memory` (0044): the open
  // orchestrator's, with its repository's, or the open thread's repository's. ponytail: a repo
  // entry's path is canonical and an orchestrator's is as created, so an orchestrator made through
  // a symlink finds no Repo scope; match canonical paths if that shows up.
  const memoryRepo = orchestrator
    ? threads.state.repos.find((r) => isRepository(r) && r.path === orchestrator.repoPath)?.id
    : selection.kind === "thread" && group.id !== noRepo
      ? group.id
      : undefined;
  const memory = connected && "memory" in connection.capabilities && (orchestrator || memoryRepo);
  // The run whose folder the side panel's Files view browses: the open thread or subagent.
  const filesRunId = selection.kind === "thread" ? selection.threadId : agentId;
  // The open thread's linked pull requests, on a plxd that links them (PLX-318).
  const threadRun =
    selection.kind === "thread" ? threads.state.runs[selection.threadId] : undefined;
  const linksPrs = connected && "pullRequests" in connection.capabilities;
  // A Claude Remote Control thread's session, for Thread details (PLX-1140).
  const remoteThread = isRemoteControl(threadRun);
  const remoteSession = useRemoteControl(
    host.id,
    remoteThread ? threadRun?.id : undefined,
    connected && "claudeRemoteControl" in connection.capabilities,
    threadRun?.status,
  );
  // Its choice between keeping it and moving it to its computer (PLX-1143): asked on its first
  // open, until kept, and from Thread details. Once open, the dialog stays until it's closed, as
  // setting up a computer changes the hosts under it.
  const canMove = remoteThread && connected && "claudeRemoteControlMove" in connection.capabilities;
  const kept = keptRemoteControl.use();
  const [moveDialog, setMoveDialog] = useState<{ hostId: string; runId: string; title: string }>();
  const [moveDismissed, setMoveDismissed] = useState<ReadonlySet<string>>(new Set());
  const moveKey = threadRun ? `${host.id}:${threadRun.id}` : "";
  const askMove = () =>
    threadRun &&
    setMoveDialog({
      hostId: host.id,
      runId: threadRun.id,
      title: threads.state.titles[threadRun.id] ?? titleOf(threadRun),
    });
  const firstOpen =
    canMove &&
    !threads.state.threads.find((t) => t.id === threadRun?.id)?.archived &&
    !kept.includes(moveKey) &&
    !moveDismissed.has(moveKey);
  useEffect(() => {
    if (firstOpen) askMove();
    // Asked once per thread opened; askMove reads the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOpen, moveKey]);
  const prs = usePullRequests(
    host.id,
    threadRun?.id,
    (linksPrs && threadRun?.pullRequests) || [],
    connected && "prDiff" in connection.capabilities,
  );
  // A PR action that fails for a missing or signed-out gh offers this, on a plxd that sets it up.
  const setUpGithub =
    connected && "githubSetup" in connection.capabilities
      ? () => openSettings("sourceControl", host.id)
      : undefined;
  // Every pull request linked to a thread on any host, for the Pull requests page.
  const prEntries: PrEntry[] = listed.flatMap(({ host: h, view }) =>
    view.state.threads.flatMap((t) =>
      (view.state.runs[t.id]?.pullRequests ?? []).map((url) => ({
        hostId: h.id,
        runId: t.id,
        threadTitle: view.state.titles[t.id] ?? "Thread",
        url,
      })),
    ),
  );
  const openPr = (url?: string) => {
    setPanelOpen(true);
    setShowPr({ url });
  };
  // Runs once the selection's own panel state is current, which `openPr` sets.
  const selectedPr = selection.kind === "thread" ? selection.pr : undefined;
  useEffect(() => {
    if (selectedPr) openPr(selectedPr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  // Shrinks an expanded side panel, which hides the main pane the chat opens in.
  const openAgent = (id?: string) => {
    if (!orchestrator) return;
    setSelection({ kind: "orchestrator", orchestratorId: orchestrator.id, agentId: id });
    setPanelExpanded(false);
  };
  // The permission requests the orchestrator's other runs wait on, pinned in whichever of its chats
  // is open, each named and with a way to its own chat (PLX-196).
  const othersAsked = (open: string | undefined): Asked[] =>
    agents.runs.flatMap((run) => {
      if (run.id === open || !orchestrator) return [];
      const orchestratorRun = run.id === orchestrator.run;
      const from = {
        label: orchestratorRun ? "Orchestrator" : `Subagent: ${titleOf(run)}`,
        open: () => openAgent(orchestratorRun ? undefined : run.id),
      };
      return (agents.waiting[run.id] ?? []).map((approval) => ({ runId: run.id, approval, from }));
    });

  const openThread =
    selection.kind === "thread"
      ? threads.state.threads.find((t) => t.id === selection.threadId)
      : undefined;
  // Each thread on screen that has news is seen now, including one that finishes while it's open.
  const news =
    "threadAttention" in threads.capabilities
      ? panes
          .filter((id) => {
            const t = threads.state.threads.find((t) => t.id === id);
            const attention =
              t && attentionOf(t, threads.state.runs[id], asksOf(threads.state, id));
            return attention === "done" || attention === "failed";
          })
          .join(" ")
      : "";
  useEffect(() => {
    for (const id of news.split(" ").filter(Boolean)) void threads.update(id, { seen: true });
  }, [news, threads]);

  const openOnHost = (hostId: string, next: Selection) => {
    setSettings(null);
    setHostId(hostId);
    setSelection(next);
    setOpening(undefined);
  };
  const openHostThread = (hostId: string, threadId: string) =>
    openOnHost(hostId, { kind: "thread", threadId });

  // Each thread opened is a step in this window's history. Back and Forward move `at` to the
  // thread they open first, so it isn't a new step.
  const openedThread = selection.kind === "thread" ? selection.threadId : undefined;
  useEffect(() => {
    if (!openedThread) return;
    setHistory(({ list, at }) => {
      const here = list[at];
      if (here?.hostId === host.id && here.threadId === openedThread) return { list, at };
      const next = [...list.slice(0, at + 1), { hostId: host.id, threadId: openedThread }];
      return { list: next, at: next.length - 1 };
    });
  }, [host.id, openedThread]);
  // Where Back (-1) or Forward (1) goes, skipping deleted threads. Away from the thread at `at`,
  // as on New Thread or an orchestrator, Back goes to that thread itself.
  const here = history.list[history.at];
  const onStep = here?.hostId === host.id && here.threadId === openedThread;
  const stepTo = (step: -1 | 1) => {
    const from = onStep ? history.at + step : step === -1 ? history.at : history.at + 1;
    for (let at = from; at >= 0 && at < history.list.length; at += step) {
      const { hostId, threadId } = history.list[at]!;
      const view = views[hostId];
      if (
        view?.state.threads.some((t) => t.id === threadId) ||
        (!view && hosts.some((h) => h.id === hostId))
      )
        return at;
    }
    return undefined;
  };
  const step = (direction: -1 | 1) => {
    const at = stepTo(direction);
    if (at === undefined) return;
    const { hostId, threadId } = history.list[at]!;
    setHistory({ list: history.list, at });
    openHostThread(hostId, threadId);
  };

  useSnoozeAlarms(listed, openHostThread);
  useThreadAlarms(listed, openHostThread, settings ? [] : panes.map((id) => `${host.id}/${id}`));
  useConnectionAlarms(hosts);
  useOutdatedAlarms(listed);
  useHostUpdateAlarms(hosts);
  useAccountAlarms();
  useUpdateAlarms();
  const needsYou = useNeedsYouAlarm(listed, (hostId, orchestratorId) =>
    openOnHost(hostId, { kind: "orchestrator", orchestratorId }),
  );

  // The open thread's parent and children or siblings, on a plxd that keeps them (0041).
  const lineage =
    "threadLineage" in threads.capabilities && openThread
      ? lineageOf(threads.state, openThread)
      : undefined;
  // Thread details, docked at the thread's right, or floating over it when the row is narrow.
  // Shown or hidden per thread, which its children and parent share, so opening one from
  // Lineage keeps it open.
  const details = useThreadDetails(
    openThread
      ? JSON.stringify([host.id, "thread", rootOf(threads.state, openThread).id])
      : panelKey,
  );
  // Each open thread's agent's own subagents, as its chat reports them (PLX-382).
  const [native, setNative] = useState<Readonly<Record<string, NativeSubagent[]>>>({});
  const reportNative = useCallback(
    (threadId: string, list: NativeSubagent[]) =>
      setNative((prev) => ({ ...prev, [threadId]: list })),
    [],
  );
  const subagents = (openThread && native[openThread.id]) || [];
  const openSubagent = useCallback(
    (threadId: string, callId?: string) =>
      setSelection({ kind: "thread", threadId, subagent: callId }),
    [],
  );
  const subagentOpen = selection.kind === "thread" ? selection.subagent : undefined;
  const openThreadId = (threadId: string) => openOnHost(host.id, { kind: "thread", threadId });
  // Where Go to parent, Next, and Previous sibling go. From a parent, Next and Previous open its
  // first and last child.
  const lineageStep = (command: "parentThread" | "nextThread" | "previousThread") => {
    if (!lineage || settings) return undefined;
    if (command === "parentThread") return lineage.parent?.id;
    const step = command === "nextThread" ? 1 : -1;
    const i = lineage.chips.findIndex((t) => t.id === lineage.active);
    const n = lineage.chips.length;
    const next = i === -1 ? (step === 1 ? 0 : n - 1) : (i + step + n) % n;
    return lineage.chips[next]?.id;
  };

  // The orchestrator or repository crumb wears its sidebar icon. Under a subagent, the
  // orchestrator's goes back to the orchestrator. In a thread, the repository's opens New thread on
  // that repository.
  let crumbs: Crumb[];
  if (orchestrator) {
    crumbs = [
      { label: host.name },
      {
        label: orchestrator.name,
        icon: <ProjectIcon icon={orchestrator.icon} />,
        onClick: agentId ? () => openAgent() : undefined,
      },
    ];
    if (agentTitle) crumbs.push({ label: agentTitle });
  } else {
    // A thread added to a Project names the Project, and opens its page (0090).
    const addedTo =
      selection.kind === "thread" && openThread?.project
        ? threads.state.repos.find((r) => r.id === openThread.project)
        : undefined;
    const groupRepo = addedTo ?? threads.state.repos.find((r) => r.id === group.id);
    const repo = {
      label: addedTo?.name ?? group.name,
      icon: <RepoIcon repo={groupRepo} />,
      onClick:
        selection.kind === "thread"
          ? () => setSelection({ kind: "new", groupId: addedTo?.id ?? group.id })
          : undefined,
    };
    const page =
      selection.kind === "thread"
        ? (threads.state.titles[selection.threadId] ?? "Thread")
        : "New thread";
    // A Claude Remote Control thread runs on another computer, not this host (PLX-1140).
    const where: Crumb =
      selection.kind === "thread" && remoteThread
        ? { label: "Remote Control", icon: <Cloud aria-hidden /> }
        : { label: host.name };
    // A Project's page is the Project itself (0090), so its crumbs end there.
    crumbs =
      selection.kind === "new" && group.project ? [where, repo] : [where, repo, { label: page }];

    // A child's parent crumb takes its title's place, the chips naming it; a thread with both a
    // parent and children has the parent's crumb before its own.
    const parent = lineage?.parent;
    if (parent) {
      const back = {
        label: threads.state.titles[parent.id] ?? "Thread",
        onClick: () => openThreadId(parent.id),
      };
      crumbs = lineage.active
        ? [crumbs[0]!, repo, back]
        : [crumbs[0]!, repo, back, { label: page }];
    }
    // A fork's original, while it's listed, goes before the fork's own crumb (0050).
    const original = threads.state.threads.find((t) => t.id === openThread?.forkedFrom?.run);
    if (original)
      crumbs.splice(-1, 0, {
        label: `Forked from ${threads.state.titles[original.id] ?? "Thread"}`,
        icon: <GitFork />,
        onClick: () => openThreadId(original.id),
      });
    // An open subagent's crumb comes last, and its thread's, when shown, goes back to the thread.
    if (selection.kind === "thread" && subagentOpen) {
      const threadId = selection.threadId;
      if (!lineage?.active)
        crumbs[crumbs.length - 1] = { label: page, onClick: () => openSubagent(threadId) };
      crumbs.push({
        label: subagents.find((s) => s.callId === subagentOpen)?.title ?? "Subagent",
        icon: <ClaudeLogo />,
      });
    }
  }
  // Forks a thread (0050) and opens the fork. Resolves to plxd's error, if it refused.
  const forkThread = async (runId: string, turnId: string | undefined, choice: ForkChoice) => {
    const forked = await threads.fork(runId, turnId, choice);
    if (typeof forked !== "string") return forked;
    openThreadId(forked);
    return undefined;
  };

  // An orchestrator created on the open host is in its list already. Another host's list loads once
  // that host is open.
  const openOrchestrator = (hostId: string, orchestratorId: string) => {
    if (hostId === host.id) return setSelection({ kind: "orchestrator", orchestratorId });
    setHostId(hostId);
    setSelection({ kind: "new" });
    setOpening({ hostId, orchestratorId });
  };

  // New Thread's draft, which picking where it runs keeps (PLX-788). A fresh New thread gets its
  // own, so opening another leaves this one as a draft (PLX-1150).
  const draft = selection.kind === "new" ? (selection.draft ?? freshDraftId(selection)) : undefined;
  // Runs New Thread on another computer: opens that host, keeping the repository if it lists one
  // of the same name (each host's entries have their own ids). A host whose list is in but lacks
  // it adds the repository at the same path first, or `at`, where New Thread's clone dialog put
  // it. A host without it at that path clones its origin there (PLX-905), sending git's progress
  // to `onProgress`, or, when no place there will do, resolves to where to ask to clone it. Once
  // it added or cloned the repository there, it resolves to its entry there. When that fails,
  // New Thread stays on this host and it resolves to plxd's error, for people. A host
  // whose list hasn't loaded yet gets New Thread's first repository. An add that finishes after
  // another pick, or once anything else is open, changes nothing.
  const picks = useRef(0);
  const shown = useRef({ hostId: host.id, selection });
  useEffect(() => {
    shown.current = { hostId: host.id, selection };
  });
  const pickHost = async (
    id: string,
    { at, onProgress }: { at?: string; onProgress?: (line: string) => void } = {},
  ): Promise<string | CloneAsk | Repo | undefined> => {
    // Picking this computer again is a pick too, so it drops an add still under way.
    const pick = ++picks.current;
    if (id === host.id) return undefined;
    const before = shown.current;
    const stale = () =>
      pick !== picks.current ||
      shown.current.hostId !== before.hostId ||
      shown.current.selection !== before.selection;
    const view = views[id] ?? idleThreads;
    let groupId = groupThreads(view.state).find((g) => g.name === group.name)?.id;
    const source = threads.state.repos.find((r) => r.id === group.id);
    let moved: Repo | undefined;
    if (!repoless(group) && source && (at || lacksRepo(view, group.name))) {
      let added = await view.addRepo(at ?? source.path);
      if (stale()) return undefined;
      if (
        typeof added === "string" &&
        !at &&
        "repoClone" in threads.capabilities &&
        "repoClone" in view.capabilities
      ) {
        const cloned = await cloneOnto(host.id, source, id, (line) => onProgress?.(line));
        if (stale()) return undefined;
        if (typeof cloned === "object" && "url" in cloned) return cloned;
        // Its own add, so the entry is in the host's list before New Thread opens there.
        added = typeof cloned === "string" ? cloned : await view.addRepo(cloned.path);
        if (stale()) return undefined;
      }
      if (typeof added === "string") return added;
      groupId = added.id;
      moved = added;
    }
    setHostId(id);
    setOpening(undefined);
    setSelection({ kind: "new", groupId, draft });
    return moved;
  };

  // Opens New Thread on another computer with one of its repositories.
  // Mod+N's pick of another computer's repository, a plain New thread as `newThread` is.
  const pickRepoOn = (hostId: string, groupId: string) => {
    openOnHost(hostId, { kind: "new", groupId });
  };

  // A New thread. It opens on the computer new threads start on, in the repository of the same
  // name there, or Chat when it has none.
  const newThread = (groupId = selection.kind === "orchestrator" ? undefined : group.id) => {
    if (start.id !== host.id) {
      const name = groups.find((g) => g.id === groupId)?.name;
      return openOnHost(start.id, {
        kind: "new",
        groupId: groupId && (startGroups.find((g) => g.name === name)?.id ?? noRepo),
      });
    }
    setSettings(null);
    setSelection({ kind: "new", groupId });
  };
  // Mod+N's picker of the repository a new thread goes in.
  const picker = useRef<HTMLDialogElement>(null);
  // Mod+K's command menu (PLX-993), and the sidebar's add palette, which its New orchestrator and
  // Add repository open. The palette shows with the thread list, so Settings closes first.
  const commandMenu = useRef<CommandMenuHandle>(null);
  const addDialog = useRef<AddDialogHandle>(null);
  const openAdd = (start?: "orchestrator") => {
    // Inside a hidden sidebar, the palette would open with no size.
    flushSync(() => {
      setSettings(null);
      setMainPage(undefined);
      setSidebarOpen(true);
    });
    addDialog.current?.open(start);
  };
  // Create Project (0090), from the orchestrators page or the add palette, where the open host makes
  // them.
  const newProject =
    connected && "projects" in connection.capabilities
      ? () => newChatOrchestrator.current?.showModal()
      : undefined;
  const openMainPage = (next: NonNullable<typeof mainPage>) => {
    setSettings(null);
    setMainPage(next);
  };
  // The orchestrator threads New thread's picker offers to continue, on every computer listed, most
  // recently active first (0093): orchestrators start and continue from New thread.
  const pickerOrchestrators: PickerOrchestrator[] = listed
    .flatMap(({ host, view }) => view.state.orchestrators.map((o) => ({ host, o })))
    .sort((a, b) => Date.parse(b.o.updatedAt) - Date.parse(a.o.updatedAt))
    .map(({ host, o }) => ({
      key: `${host.id}/${o.id}`,
      name: o.name,
      icon: <ProjectIcon icon={o.icon} className="size-4 shrink-0" />,
      hint: [listed.length > 1 ? host.name : undefined, o.integrationBranch ?? o.branch]
        .filter(Boolean)
        .join(" · "),
      open: () => openOrchestrator(host.id, o.id),
    }));
  // The repositories a new thread can start in, the computer new threads start on's first.
  const menuRepos: MenuItem[] = [
    ...startGroups
      .filter((g) => !g.project && g.id !== noRepo)
      .map((g): MenuItem => {
        const repo = startState.repos.find((r) => r.id === g.id);
        return {
          id: `repo:${start.id}/${g.id}`,
          label: g.name,
          text: g.name,
          keywords: repo?.path,
          hint: repo && `${start.name} · ${repo.path}`,
          icon: <RepoIcon repo={repo} />,
          run: () => (start.id === host.id ? newThread(g.id) : pickRepoOn(start.id, g.id)),
        };
      }),
    ...startElsewhere.map((o): MenuItem => ({
      id: `repo:${o.host.id}/${o.repo.id}`,
      label: o.repo.name,
      text: o.repo.name,
      keywords: o.repo.path,
      hint: `${o.host.name} · ${o.repo.path}`,
      icon: <RepoIcon repo={o.repo} />,
      run: () => pickRepoOn(o.host.id, o.repo.id),
    })),
  ];
  // The open thread's or New thread's repository, which the first action starts a thread in.
  const hereRepo =
    selection.kind !== "orchestrator" && !repoless(group) && !settings ? group : undefined;
  const menuActions: MenuItem[] = [
    ...(hereRepo
      ? [
          {
            id: "newThreadHere",
            label: (
              <>
                New thread in <strong className="font-semibold">{hereRepo.name}</strong>
              </>
            ),
            text: `New thread in ${hereRepo.name}`,
            icon: <SquarePen />,
            run: () => newThread(hereRepo.id),
          },
        ]
      : []),
    {
      id: "newThreadIn",
      label: "New thread in…",
      text: "New thread in",
      icon: <SquarePen />,
      command: "newThread",
      page: "repos",
    },
    {
      id: "noRepoThread",
      label: "New thread without a repo",
      text: "New thread without a repo",
      icon: <SquareDashed />,
      command: "noRepoThread",
      run: () => newThread(noRepo),
    },
    {
      id: "goToFile",
      label: "Go to file",
      text: "Go to file",
      keywords: "open find",
      icon: <FileSearch />,
      command: "goToFile",
      page: "files",
    },
    {
      id: "searchContents",
      label: "Search project contents",
      text: "Search project contents",
      keywords: "grep find text code",
      icon: <TextSearch />,
      command: "searchContents",
      page: "contents",
    },
    {
      id: "newOrchestrator",
      label: "New orchestrator thread",
      text: "New orchestrator thread",
      keywords: "create orchestrator",
      icon: <FolderPlus />,
      run: () => openAdd("orchestrator"),
    },
    {
      id: "addRepo",
      label: "Add repository",
      text: "Add repository",
      keywords: "folder clone github new",
      icon: <FolderGit2 />,
      run: () => openAdd(),
    },
    {
      id: "theme",
      label: "Change theme",
      text: "Change theme",
      keywords: "color",
      icon: <Palette />,
      page: "theme",
    },
    {
      id: "appearance",
      label: "Change appearance",
      text: "Change appearance",
      keywords: "light dark system mode",
      icon: <SunMoon />,
      page: "appearance",
    },
    {
      id: "pullRequests",
      label: "Pull requests",
      text: "Pull requests",
      keywords: "pr github",
      icon: <GitPullRequest />,
      run: () => openMainPage("pullRequests"),
    },
    {
      id: "usage",
      label: "Usage",
      text: "Usage",
      keywords: "limits tokens cost",
      icon: <ChartColumn />,
      command: "usage",
      run: () => openMainPage("usage"),
    },
    {
      id: "settings",
      label: "Settings",
      text: "Settings",
      keywords: "preferences",
      icon: <SettingsIcon />,
      command: "settings",
      run: () => openSettings("general"),
    },
  ];
  const deleteThread = async (hostId: string, thread: Thread) => {
    const view = views[hostId] ?? idleThreads;
    const error = await view.remove(thread);
    if (error) return error;
    if (split?.hostId === hostId && split.threadIds.includes(thread.id)) closePane(thread.id);
    else if (selection.kind === "thread" && selection.threadId === thread.id)
      setSelection({ kind: "new", groupId: groupOf(view.state, thread) });
    return undefined;
  };
  // Opens `threadId` in the split beside the open thread, at tile `at`: by default a new last tile
  // while there's room, else the last tile that isn't focused, which it replaces. A thread already
  // tiled is focused instead.
  const openBeside = (threadId: string, at?: number) => {
    if (selection.kind !== "thread" || selection.threadId === threadId) return;
    const ids = tiled ? [...split.threadIds] : [selection.threadId];
    const ratios = tiled ? [...split.ratios] : [];
    if (!ids.includes(threadId)) {
      const tile =
        at ??
        (ids.length < maxTiles ? ids.length : ids.findLastIndex((id) => id !== selection.threadId));
      if (tile === ids.length) ratios.push(evenRatio);
      ids[tile] = threadId;
      setSplit({ hostId: host.id, threadIds: ids, ratios });
    }
    setSelection({ kind: "thread", threadId });
  };
  // Focuses a tile of the split, reopening it if another view is open, and its composer.
  const focusPane = (tile: number) => {
    const threadId = split?.threadIds[tile];
    if (!threadId) return;
    openOnHost(split.hostId, { kind: "thread", threadId });
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-pane="${tile}"] .composer-input`)?.focus(),
    );
  };

  const offline = offlineReason(connection);

  // Where the open thread's or New thread's terminals open (folderOf).
  const folder =
    selection.kind === "orchestrator"
      ? undefined
      : folderOf(
          host.id,
          threads.state,
          selection.kind === "thread" ? { threadId: selection.threadId } : { repoId: group.id },
        );
  const deleted = useDeleted(views);
  const drawerOpen = !!folder && drawers.has(folder.key);
  const toggleDrawer = () => {
    if (!folder) return;
    const next = new Set(drawers);
    if (!next.delete(folder.key)) next.add(folder.key);
    setDrawers(next);
  };
  // Runs a repository action in the folder's drawer, opened for it, and opens its preview.
  const runAction = (action: RepoAction) => {
    if (!folder) return;
    if (!drawers.has(folder.key)) setDrawers(new Set(drawers).add(folder.key));
    runInDrawer(folder, action.command);
    if (action.openPreview && action.previewUrl) {
      setPane("browser");
      setBrowse({ url: action.previewUrl });
    }
  };

  // The app's shortcuts (ui.tsx), but Open, which Thread details takes, and Mod+1 to Mod+9, which
  // ThreadList takes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const command = appShortcut(e);
      // A new thread waits for an open dialog, the picker included, to close.
      const dialog = !!document.querySelector("dialog[open]");
      // The command menu's shortcuts work in it too: its own toggles it, the others go to a page.
      const menuOpen = !!document.querySelector('dialog[aria-label="Command menu"][open]');
      if (command === "commandMenu") {
        if (menuOpen || !dialog) commandMenu.current?.toggle();
      } else if (command === "goToFile" || command === "searchContents") {
        if (menuOpen || !dialog)
          commandMenu.current?.open(command === "goToFile" ? "files" : "contents");
      } else if (command === "panel") setPanelOpen(!panelOpen);
      else if (command === "browser" && !settings) toggleBrowser();
      else if (command === "sidebar") setSidebarOpen((open) => !open);
      else if (command === "terminal" && folder) toggleDrawer();
      else if (command === "newThread") {
        if (!dialog) picker.current?.showModal();
      } else if (command === "noRepoThread") {
        if (!dialog) newThread(noRepo);
      } else if (command && (tileCommands as readonly string[]).includes(command)) {
        if (dialog || !split) return;
        focusPane((tileCommands as readonly string[]).indexOf(command));
      } else if (command === "back" || command === "forward") {
        if (dialog || settings) return;
        step(command === "back" ? -1 : 1);
      } else if (command === "settings") openSettings("general");
      else if (command === "usage") openMainPage("usage");
      else if (command === "openPr") {
        // The open thread's latest linked pull request.
        const latest = prs.urls.at(-1);
        if (!latest) return;
        window.open(latest, "_blank");
      } else if (
        !dialog &&
        (command === "parentThread" || command === "nextThread" || command === "previousThread")
      ) {
        // In an orchestrator, Go to parent goes from a child back to the orchestrator, and from an
        // agent's own subagent, back to its thread.
        if (command === "parentThread" && agentId && !settings) openAgent();
        else if (
          command === "parentThread" &&
          selection.kind === "thread" &&
          selection.subagent &&
          !settings
        )
          openSubagent(selection.threadId);
        else {
          const next = lineageStep(command);
          if (!next) return;
          openThreadId(next);
        }
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  // The mouse's back and forward buttons, as Back and Forward.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (document.querySelector("dialog[open]") || settings) return;
      step(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  });

  // Shown in the main pane's top row only while the sidebar is hidden.
  const showSidebar = !sidebarOpen && (
    <IconButton
      label="Show sidebar"
      command="sidebar"
      aria-expanded={false}
      aria-controls="sidebar"
      onClick={() => setSidebarOpen(true)}
    >
      <PanelLeftOpen />
    </IconButton>
  );
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [requestedWidths, setRequestedWidths] = useState<[number, number]>([288, 416]);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sidePanelOpen = pane !== undefined;
  const expanded = sidePanelOpen && panelExpanded;
  const [leftWidth, rightWidth] = panelWidths(
    viewportWidth,
    sidebarOpen ? requestedWidths[0] : 0,
    sidePanelOpen && !expanded ? requestedWidths[1] : 0,
  );
  const resizePanel = (side: 0 | 1, value: number) => {
    const other =
      side === 0 ? (sidePanelOpen && !expanded ? rightWidth : 0) : sidebarOpen ? leftWidth : 0;
    const maximum = Math.max(0, viewportWidth - Math.min(400, viewportWidth / 2) - other);
    setRequestedWidths((widths) => {
      const next: [number, number] = [...widths];
      next[side] = Math.max(
        Math.min(side === 0 ? SIDEBAR_MIN : 200, maximum),
        Math.min(side === 0 ? 400 : 640, maximum, value),
      );
      if (other) next[side === 0 ? 1 : 0] = other;
      return next;
    });
  };
  // The main pane's top row meets the traffic lights without the sidebar, and
  // Windows' window buttons without the side panel.
  const topBarInset = [
    sidebarOpen ? "" : "traffic-light-inset",
    sidePanelOpen ? "" : "window-controls-inset",
  ].join(" ");

  // Thread details for the open thread: beside the chat, or in a split floating in its tile.
  const threadDetails = (mode: ComponentProps<typeof ThreadDetails>["mode"]) => (
    <ThreadDetails
      key={panelKey}
      mode={mode}
      host={host}
      folder={folder?.path === "~" ? undefined : folder?.path}
      worktree={
        !!threadRun?.worktreePath &&
        threadRun.worktreePath !== threads.state.repos.find((repo) => repo.id === group.id)?.path
      }
      actions={
        selection.kind !== "orchestrator" && !repoless(group)
          ? {
              hostId: host.id,
              repoId: group.id,
              canRun: !!folder,
              onRun: runAction,
            }
          : undefined
      }
      git={
        selection.kind === "thread" ||
        agent ||
        (selection.kind === "new" && !repoless(group) && !group.project)
          ? {
              hostId: host.id,
              // An orchestrator's child thread has one too, as its composer's tab had.
              run: threadRun ?? agent,
              repo: selection.kind === "new" ? (group.id as RepoId) : undefined,
              title:
                selection.kind === "thread" ? threads.state.titles[selection.threadId] : agentTitle,
              // The PR view shows a thread's own; a child's opens in the browser.
              onPrOpened: linksPrs && threadRun ? openPr : undefined,
              onSetUpGithub: setUpGithub,
              onChanges: () => {
                setPanelOpen(true);
                setShowChanges({});
              },
            }
          : undefined
      }
      prs={selection.kind === "thread" ? { prs, onOpen: openPr } : undefined}
      remoteControl={
        remoteThread
          ? {
              session: remoteSession,
              ...(canMove && { onMove: askMove }),
            }
          : undefined
      }
      project={
        selection.kind === "thread" && openThread && !openThread.parent
          ? { thread: openThread, view: threads }
          : undefined
      }
      lineage={
        openThread
          ? {
              state: threads.state,
              includeThreads: "threadLineage" in threads.capabilities,
              root: lineage ? rootOf(threads.state, openThread) : openThread,
              openId: openThread.id,
              onOpen: openThreadId,
              subagents: subagents.filter((sub) => !sub.parent),
              activeSubagent: subagentOpen,
              onOpenSubagent: (callId) => openSubagent(openThread.id, callId),
            }
          : undefined
      }
    />
  );
  // Its key for thread `threadId`, which its children and parent share (useThreadDetails).
  const detailsKeyOf = (threadId: string) => {
    const thread = threads.state.threads.find((t) => t.id === threadId);
    return JSON.stringify([
      host.id,
      "thread",
      thread ? rootOf(threads.state, thread).id : threadId,
    ]);
  };
  // Tile `index`'s Thread details button: shows or hides its thread's, focusing it to show it.
  const toggleTileDetails = (index: number) => {
    const threadId = panes[index]!;
    const key = detailsKeyOf(threadId);
    if (selection.kind === "thread" && selection.threadId !== threadId) {
      openThreadId(threadId);
      if (details.isOpen(key)) return;
    }
    details.toggle(key);
  };

  const page = (
    <div className="flex h-full">
      {hosts.map((h) => (
        <HostLoader key={h.id} hostId={h.id} onView={report} onNeedsYou={needsYou} />
      ))}
      <Notifications />
      {!onboarding && <AccountPrompts />}
      {onboarding && <Onboarding onStart={() => picker.current?.showModal()} />}
      {moveDialog && (
        <MoveRemoteControl
          key={`${moveDialog.hostId}:${moveDialog.runId}`}
          {...moveDialog}
          onKeep={() =>
            keptRemoteControl.set([...kept, `${moveDialog.hostId}:${moveDialog.runId}`])
          }
          onClose={() => {
            setMoveDismissed((now) => new Set(now).add(`${moveDialog.hostId}:${moveDialog.runId}`));
            setMoveDialog(undefined);
          }}
          onOpen={openHostThread}
        />
      )}
      <Splash
        ready={
          onboarding ||
          threads.state !== emptyThreads ||
          !!threads.error ||
          !!threads.outdated ||
          connection?.status === "failed"
        }
      />
      <CommandMenu
        ref={commandMenu}
        hosts={listed}
        actions={menuActions}
        repos={menuRepos}
        files={
          filesRunId && !settings && connected && "composerMenus" in connection.capabilities
            ? { hostId: host.id, runId: filesRunId }
            : undefined
        }
        grep={connected && "repoGrep" in connection.capabilities}
        theme={theme}
        onThemeChange={setTheme}
        onOpenThread={(hostId, threadId) => {
          setMainPage(undefined);
          openHostThread(hostId, threadId);
        }}
        onOpenOrchestrator={(hostId, orchestratorId) => {
          setSettings(null);
          openOrchestrator(hostId, orchestratorId);
          setShowHome({});
        }}
        // A document or media file opens as presented files do; any other, such as code, in the
        // Files view, which shows text.
        onOpenFile={(runId, path) => {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const kind = kindOf(name);
          if (kind !== "file") return openDoc({ runId, path, name, kind });
          setPanelOpen(true);
          setShowFiles({});
          setRevealFile({ runId, path });
        }}
      />
      <NewChatProject
        ref={newChatOrchestrator}
        create={threads.createProject}
        maxImageBytes={threads.iconImageBytes}
        onCreated={(project) => {
          setMainPage(undefined);
          setSelection({ kind: "new", groupId: project.id });
        }}
      />
      <NewThreadPicker
        ref={picker}
        groups={startGroups.filter((g) => !g.project)}
        repos={startState.repos}
        hostName={start.name}
        elsewhere={startElsewhere}
        onPick={(groupId) =>
          start.id === host.id ? newThread(groupId) : pickRepoOn(start.id, groupId)
        }
        onPickElsewhere={pickRepoOn}
        orchestrators={pickerOrchestrators}
        onNewOrchestrator={() => openAdd("orchestrator")}
      />
      {settings && (
        <SettingsDialog
          section={settings}
          listed={listed}
          theme={theme}
          onThemeChange={setTheme}
          sourceControlHost={settingsHost}
          focus={settingsFocus}
          onSection={(section, anchor) => {
            openSettings(section);
            setSettingsFocus(anchor ? { anchor } : undefined);
          }}
          onClose={() => {
            setSettings(null);
            setSettingsFocus(undefined);
          }}
        />
      )}
      <Sidebar
        width={leftWidth}
        onResize={(width) => resizePanel(0, width)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewThread={() => newThread()}
      >
        <ThreadList
          hosts={listed}
          host={host}
          selection={selection}
          onSelect={(hostId, next) => {
            // The open row, picked again, leaves Pull requests or the browser too.
            setMainPage(undefined);
            openOnHost(hostId, next);
            // An orchestrator opens on its orchestrator's chat and the orchestrator tab (0083).
            if (next.kind === "orchestrator") setShowHome({});
          }}
          onOpenOrchestrator={openOrchestrator}
          onOpenSettings={openSettings}
          page={mainPage}
          onOpenPage={openMainPage}
          openProject={
            selection.kind === "new" && group.project && !mainPage
              ? `${host.id}/${group.id}`
              : undefined
          }
          orchestratorMenu={orchestratorMenu}
          onNewProject={newProject}
          onDelete={deleteThread}
          addDialog={addDialog}
          onNewThread={() => picker.current?.showModal()}
          split={split}
          onOpenBeside={openBeside}
          onClosePane={closePane}
        />
      </Sidebar>

      {/* An expanded side panel takes the main pane's place. */}
      <OpenDocumentContext value={openDoc}>
        <main hidden={expanded} className="flex min-w-0 flex-1 flex-col bg-pane">
          {mainPage === "projects" ? (
            <>
              <TopBar className={topBarInset}>
                {showSidebar}
                <Breadcrumb items={[{ label: "Projects" }]} />
              </TopBar>
              <ProjectsPage
                entries={projectEntries(listed)}
                pins={pins}
                onOpen={(entry) => {
                  setMainPage(undefined);
                  openOnHost(entry.host.id, { kind: "new", groupId: entry.id });
                }}
                onTogglePin={togglePinnedProject}
                actionsFor={orchestratorActions}
                onNewProject={newProject}
              />
            </>
          ) : mainPage === "usage" ? (
            <>
              <TopBar className={topBarInset}>
                {showSidebar}
                <Breadcrumb items={[{ label: "Usage" }]} />
              </TopBar>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-5xl px-8 pt-6 pb-16">
                  <UsagePage hosts={hosts} />
                </div>
              </div>
            </>
          ) : mainPage === "pullRequests" ? (
            <>
              <TopBar className={topBarInset}>
                {showSidebar}
                <Breadcrumb items={[{ label: "Pull Requests" }]} />
              </TopBar>
              <PullRequestsPage
                entries={prEntries}
                onOpenThread={(e) => {
                  setMainPage(undefined);
                  openOnHost(e.hostId, { kind: "thread", threadId: e.runId });
                }}
              />
            </>
          ) : (
            <>
              <TopBar className={`@container ${topBarInset}`}>
                {showSidebar}
                <div className="-ml-1 flex shrink-0 items-center">
                  <IconButton
                    label="Back"
                    command="back"
                    disabled={stepTo(-1) === undefined}
                    onClick={() => step(-1)}
                    className={stepButton}
                  >
                    <ChevronLeft />
                  </IconButton>
                  <IconButton
                    label="Forward"
                    command="forward"
                    disabled={stepTo(1) === undefined}
                    onClick={() => step(1)}
                    className={stepButton}
                  >
                    <ChevronRight />
                  </IconButton>
                </div>
                <Breadcrumb items={crumbs} />
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {!group.project && !tiled && (
                    <ThreadDetailsButton
                      open={details.mode !== "hidden"}
                      onToggle={() => details.toggle()}
                    />
                  )}
                  <IconButton
                    label={pane === "browser" ? "Hide browser" : "Browser"}
                    command="browser"
                    aria-pressed={pane === "browser"}
                    onClick={toggleBrowser}
                  >
                    <Globe />
                  </IconButton>
                  {folder && (
                    <IconButton
                      label={drawerOpen ? "Hide terminal" : "Show terminal"}
                      command="terminal"
                      aria-pressed={drawerOpen}
                      aria-controls="terminal-drawer"
                      onClick={toggleDrawer}
                    >
                      <PanelBottom />
                    </IconButton>
                  )}
                  {/* Shown only while the panel's views are hidden; their top bar has it otherwise. */}
                  {!panelOpen && (
                    <IconButton
                      label="Show side panel"
                      command="panel"
                      aria-expanded={false}
                      aria-controls="side-panel"
                      onClick={() => setPanelOpen(true)}
                    >
                      <PanelRight />
                    </IconButton>
                  )}
                </div>
              </TopBar>
              <div ref={details.ref} className="relative flex min-h-0 flex-1">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {selection.kind === "thread" ? (
                    <div className="relative flex min-h-0 flex-1">
                      <SplitTiles
                        tiled={tiled}
                        focused={panes.indexOf(selection.threadId)}
                        ratios={tiled ? split.ratios : []}
                        onResize={(ratios) => split && setSplit({ ...split, ratios })}
                        maximized={tiled && !!split.maximized}
                        onMaximize={(maximized) => split && setSplit({ ...split, maximized })}
                        onFocus={(index) => openThreadId(panes[index]!)}
                        onClose={(index) => closePane(panes[index]!)}
                        details={
                          tiled && !group.project
                            ? {
                                node: threadDetails(
                                  details.mode === "hidden" ? "hidden" : "floating",
                                ),
                                open: (index) => details.isOpen(detailsKeyOf(panes[index]!)),
                                onToggle: toggleTileDetails,
                              }
                            : undefined
                        }
                        // A sidebar thread dragged over the open thread, not over a composer,
                        // which takes it to attach (PLX-378).
                        drop={{
                          accepts: (e) =>
                            !e.defaultPrevented && e.dataTransfer.types.includes(threadDragType),
                          onDrop: (at, e) => {
                            const thread = draggedThread(e.dataTransfer);
                            // A split's threads are one computer's.
                            if (thread?.hostId === host.id) openBeside(thread.runId, at);
                          },
                        }}
                        items={panes.map((threadId, side) => {
                          const focused = threadId === selection.threadId;
                          const paneThread = threads.state.threads.find((t) => t.id === threadId);
                          const paneParent =
                            "threadLineage" in threads.capabilities && paneThread
                              ? lineageOf(threads.state, paneThread)?.parent?.id
                              : undefined;
                          const title = threads.state.titles[threadId];
                          // Keyed, so another run starts from an empty transcript.
                          return {
                            key: `${host.id}/${threadId}`,
                            title: title ?? "Thread",
                            icon: (
                              <RepoIcon
                                repo={threads.state.repos.find((r) => r.id === paneThread?.repo)}
                              />
                            ),
                            node: (
                              <section
                                data-pane={tiled ? side : undefined}
                                data-focused={tiled && focused ? "" : undefined}
                                aria-label={tiled ? (title ?? "Thread") : undefined}
                                // Clicking or tabbing into a tile focuses it.
                                onPointerDownCapture={() => !focused && openThreadId(threadId)}
                                // A link to a pull request the thread links opens its view, not GitHub,
                                // unless a modifier key asks for the browser; the setting swaps the two.
                                onClickCapture={(e) => {
                                  const href = (e.target as Element)
                                    .closest?.("a[href]")
                                    ?.getAttribute("href");
                                  const pr =
                                    linksPrs &&
                                    href &&
                                    linkedPr(
                                      href,
                                      threads.state.runs[threadId]?.pullRequests ?? [],
                                    );
                                  const modified = e.metaKey || e.ctrlKey || e.shiftKey;
                                  const inApp = behaviorPrefs.get().prLinkClick === "parallax";
                                  if (!pr || modified === inApp) return;
                                  // Never reaching the link's own handler, which opens the browser.
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openPr(pr);
                                }}
                                // Not focus the window or the app gives with nothing focused before, such as a
                                // notification's click or an approval card's.
                                onFocusCapture={(e) =>
                                  !focused && e.relatedTarget && openThreadId(threadId)
                                }
                                className="flex min-h-0 min-w-0 flex-1 flex-col"
                              >
                                <AgentChat
                                  hostId={host.id}
                                  runId={threadId}
                                  prompt={threads.state.runs[threadId]?.prompt}
                                  // The list's status goes stale once the run moves on, so only a start says so.
                                  going={focused && selection.started}
                                  quiet={tiled && !focused}
                                  listed={threads.state.runs[threadId]}
                                  compose={focused ? compose : undefined}
                                  onComposed={composed}
                                  threadLinks={threadLinks}
                                  subagent={focused ? selection.subagent : undefined}
                                  onOpenSubagent={openSubagent}
                                  onSubagents={reportNative}
                                  onPreview={(runId, reveal) => void showPreviews(runId, reveal)}
                                  onDevice={(runId, deviceId) =>
                                    void showAgentDevice(runId, deviceId)
                                  }
                                  strip={
                                    paneParent
                                      ? {
                                          key: "parent",
                                          node: (
                                            <ChildStrip
                                              name={threads.state.titles[paneParent] ?? "Thread"}
                                              onOpenName={() => openThreadId(paneParent)}
                                              onBack={() => openThreadId(paneParent)}
                                            />
                                          ),
                                        }
                                      : undefined
                                  }
                                  forked={!!paneThread?.forkedFrom}
                                  // The open thread's, the one App reads; another pane's chips stay neutral.
                                  pullRequests={threadRun?.id === threadId ? prs : undefined}
                                  onOpenChanges={(turn, path) => {
                                    setPanelOpen(true);
                                    setShowChanges({ runId: threadId, turn, path });
                                  }}
                                  onFork={
                                    "threadFork" in threads.capabilities
                                      ? (turnId, choice) => forkThread(threadId, turnId, choice)
                                      : undefined
                                  }
                                />
                              </section>
                            ),
                          };
                        })}
                      />
                    </div>
                  ) : selection.kind === "new" ? (
                    <NewThread
                      // Each draft is its own screen, so opening another leaves this one as a draft.
                      key={draft}
                      draftId={draft}
                      hostId={host.id}
                      hosts={hosts}
                      onHostChange={pickHost}
                      groups={groups}
                      groupId={group.id}
                      onGroupChange={(groupId) => setSelection({ kind: "new", groupId, draft })}
                      elsewhere={elsewhere}
                      onPickElsewhere={(hostId, groupId) =>
                        openOnHost(hostId, { kind: "new", groupId, draft })
                      }
                      missing={
                        new Set(
                          hosts.filter((h) => lacksRepo(views[h.id], group.name)).map((h) => h.id),
                        )
                      }
                      shared={hosts.some(
                        (h) =>
                          h.id !== host.id &&
                          views[h.id]?.state.repos.some(
                            (r) => isRepository(r) && r.name === group.name,
                          ),
                      )}
                      local={host.id === localId}
                      addRepo={threads.addRepo}
                      start={threads.start}
                      runOptions={connected && "runOptions" in connection.capabilities}
                      onStarted={(threadId, background) => {
                        if (!background) setSelection({ kind: "thread", threadId, started: true });
                      }}
                      disabledReason={offline}
                      threadLinks={threadLinks}
                      settingsClosed={settingsClosed.count}
                      header={
                        projectEntry && (
                          <ProjectHeader
                            entry={projectEntry}
                            onBack={() => openMainPage("projects")}
                            pinned={pins.includes(projectEntry.key)}
                            onTogglePin={() => togglePinnedProject(projectEntry.key)}
                            actionsFor={() => orchestratorActions(projectEntry)}
                          />
                        )
                      }
                      tray={
                        projectRepo && (
                          <RunTargetMenu
                            hosts={projectHosts}
                            hostId={host.id}
                            onHostChange={(id) => {
                              const there = views[id]?.state.repos.find(
                                (r) => r.project && r.name === projectRepo.name,
                              );
                              if (id !== host.id && there)
                                openOnHost(id, { kind: "new", groupId: there.id, draft });
                            }}
                          />
                        )
                      }
                      aside={
                        projectRepo &&
                        "projectContext" in threads.capabilities && (
                          <ProjectContext hostId={host.id} project={projectRepo} view={threads} />
                        )
                      }
                      below={
                        projectRepo && (
                          <ProjectThreads
                            host={host}
                            project={projectRepo}
                            view={threads}
                            onOpenThread={(threadId) => setSelection({ kind: "thread", threadId })}
                          />
                        )
                      }
                    />
                  ) : agentId ? (
                    <AgentChat
                      key={`${host.id}/${agentId}`}
                      hostId={host.id}
                      runId={agentId}
                      prompt={agent?.prompt}
                      // An orchestrator's subagents are kept current.
                      going={isRunning(agent?.status)}
                      others={othersAsked(agentId)}
                      orchestratorMode={orchestrator?.permission}
                      threadLinks={threadLinks}
                      strip={
                        orchestrator && {
                          key: "parent",
                          node: (
                            <ChildStrip
                              name={orchestrator.name}
                              icon={
                                <ProjectIcon
                                  icon={orchestrator.icon}
                                  className="size-3.5 shrink-0"
                                />
                              }
                              onOpenName={() =>
                                setSelection({
                                  kind: "orchestrator",
                                  orchestratorId: orchestrator.id,
                                })
                              }
                              onBack={() => openAgent()}
                            />
                          ),
                        }
                      }
                    />
                  ) : (
                    orchestrator && (
                      <OrchestratorChat
                        key={`${host.id}/${orchestrator.id}`}
                        hostId={host.id}
                        orchestrator={orchestrator}
                        prompt={orchestrator.run && threads.state.runs[orchestrator.run]?.prompt}
                        startOrchestrator={threads.startOrchestrator}
                        updateOrchestrator={threads.updateOrchestrator}
                        host={host}
                        repo={threads.state.repos.find((r) => r.path === orchestrator.repoPath)?.id}
                        others={othersAsked(orchestrator.run)}
                        agents={agents}
                        titles={threads.state.titles}
                        needs={needs}
                        onOpenRun={(id) => openAgent(id === orchestrator.run ? undefined : id)}
                        threadLinks={threadLinks}
                        settingsClosed={settingsClosed.count}
                      />
                    )
                  )}
                </div>
                {!tiled && threadDetails(group.project ? "hidden" : details.mode)}
              </div>
            </>
          )}
          {/* Outside the views, so the terminals live on behind the other pages. */}
          <TerminalDrawer
            open={drawerOpen}
            folder={folder}
            deleted={deleted}
            onClose={toggleDrawer}
          />
        </main>
      </OpenDocumentContext>

      <SidePanel
        scope={panelKey}
        width={rightWidth}
        onResize={(width) => resizePanel(1, width)}
        open={sidePanelOpen}
        onClose={() => setPanelOpen(false)}
        expanded={expanded}
        onExpandedChange={setPanelExpanded}
        leading={expanded && showSidebar}
        topBarClassName={expanded && !sidebarOpen ? "traffic-light-inset" : ""}
        remoteHost={host.id === localId ? undefined : host.name}
        browse={browse}
        browsing={pane === "browser"}
        changes={showChanges}
        agentTabs={
          threadRun && agentTabs?.runId === threadRun.id
            ? { hostId: host.id, backend: threadRun.backend, ...agentTabs }
            : undefined
        }
        pullRequest={showPr}
        showDevice={showDevice}
        showOrchestrator={showHome}
        showFiles={showFiles}
        device={(shown) => (
          <DevicePanel hostId={host.id} runId={threadRun?.id} shown={shown} request={showDevice} />
        )}
        documents={{
          runId: filesRunId,
          open: showDoc,
          view: (doc) => (
            <DocumentView key={`${host.id}/${doc.runId}/${doc.path}`} hostId={host.id} doc={doc} />
          ),
        }}
        orchestrator={
          orchestrator && {
            waiting: waitingCount(orchestrator, agents, inbox),
            home: (
              <OrchestratorHome
                key={`${host.id}/${orchestrator.id}`}
                hostId={host.id}
                context={context}
                orchestrator={orchestrator}
                agents={agents}
                titles={threads.state.titles}
                inbox={inbox}
                answerable={answerable}
                onOpen={openAgent}
              />
            ),
          }
        }
        pullRequests={
          linksPrs && threadRun
            ? {
                urls: prs.urls,
                get: prs.get,
                list: <PullRequestList prs={prs} onOpen={openPr} />,
                view: (url) => (
                  <PullRequestView
                    key={`${host.id}/${threadRun.id}`}
                    url={url}
                    prs={prs}
                    onSetUpGithub={setUpGithub}
                    onBrowse={(page) => {
                      setPane("browser");
                      setBrowse({ url: page });
                    }}
                    onCompose={(text, send) => {
                      // The chat is under an expanded panel.
                      setPanelExpanded(false);
                      setCompose({ text, send });
                    }}
                  />
                ),
              }
            : undefined
        }
        agents={
          orchestrator && (
            <AgentsPanel
              // Another orchestrator's start box starts empty, with its own retry id.
              key={`${host.id}/${orchestrator.id}`}
              agents={agents}
              titles={threads.state.titles}
              openId={agentId}
              onOpen={openAgent}
              disabledReason={offline}
            />
          )
        }
        changesView={
          threadRun && (
            <ChangesPanel
              key={`${host.id}/${threadRun.id}`}
              hostId={host.id}
              runId={threadRun.id}
              prompt={threadRun.prompt}
              backend={threadRun.backend}
              sessionId={threadRun.sessionId}
              running={isRunning(threadRun.status)}
              version={threads.state.checkpoints[threadRun.id]}
              request={showChanges}
              onRequestShown={() => setShowChanges(undefined)}
              unavailable={
                offline ??
                (connected && "checkpoints" in connection.capabilities
                  ? undefined
                  : "Update Parallax on this host to see a thread's changes.")
              }
              onCompose={(text) => {
                // The chat is under an expanded panel.
                setPanelExpanded(false);
                setCompose({ text, send: false });
              }}
            />
          )
        }
        files={
          filesRunId && (
            <FilesPanel
              key={`${host.id}/${filesRunId}`}
              hostId={host.id}
              runId={filesRunId}
              unavailable={
                offline ??
                (connected && "files" in connection.capabilities
                  ? undefined
                  : "Update Parallax on this host to browse a thread's files.")
              }
              editable={connected && "fileEdit" in connection.capabilities}
              reveal={revealFile?.runId === filesRunId ? revealFile : undefined}
            />
          )
        }
        knowledge={
          (orchestrator || memory) && (
            <KnowledgePanel
              key={`${host.id}/${orchestrator?.id ?? memoryRepo}`}
              hostId={host.id}
              orchestrator={orchestrator?.id}
              repo={memoryRepo}
              orchestratorRun={
                orchestrator?.run ? agents.runs.find((r) => r.id === orchestrator.run) : undefined
              }
              titles={threads.state.titles}
              memory={!!memory}
              expanded={panelExpanded}
            />
          )
        }
        terminal={(shown, empty) => (
          <TerminalPool
            prefix="panel"
            label="Side panel terminal"
            active={shown ? folder : undefined}
            deleted={deleted}
            empty={empty}
          />
        )}
      />
    </div>
  );
  return <SharedRepoIcons value={repoIcons}>{page}</SharedRepoIcons>;
}

const stepButton =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-35 [&_svg]:size-4";

/** Loads one host's threads and orchestrators and hands them up, whenever they change. */
function HostLoader({
  hostId,
  onView,
  onNeedsYou,
}: {
  hostId: string;
  onView: (hostId: string, view: ThreadsView) => void;
  onNeedsYou: (hostId: string, orchestratorId: string, item: InboxItem) => void;
}) {
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const view = useThreads(
    hostId,
    capabilities,
    iconImageBytes(connection),
    (orchestratorId, item) => onNeedsYou(hostId, orchestratorId, item),
  );
  useEffect(() => onView(hostId, view), [hostId, view, onView]);
  return null;
}
