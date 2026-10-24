import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Folder,
  GitFork,
  Globe,
  X,
  PanelBottom,
  PanelLeftOpen,
  PanelRight,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import type { InboxItem, PreviewTab, Repo, RepoId, Thread } from "../protocol/generated/protocol";
import { type RepoAction } from "./Actions";
import { AgentChat } from "./AgentChat";
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
import { OpenDocumentContext } from "./FileCards";
import { panelWidths, SIDEBAR_MIN } from "./PanelResize";
import { NewThreadPicker } from "./NewThreadPicker";
import { Notifications } from "./notifications";
import { Onboarding } from "./Onboarding";
import { useOnboarding } from "./firstRun";
import { localId, useHosts } from "./hosts";
import { iconImageBytes } from "./images";
import { ThreadDetails, ThreadDetailsButton, useThreadDetails } from "./ThreadDetails";
import { AgentsPanel, useProjectAgents } from "./ProjectAgents";
import { useProjectContext } from "./ContextPanel";
import { ProjectChat } from "./ProjectChat";
import { ProjectHome, waitingCount } from "./ProjectHome";
import {
  linkedPr,
  PullRequestChip,
  PullRequestList,
  PullRequestView,
  usePullRequests,
} from "./PullRequests";
import { PullRequestsPage, type PrEntry } from "./PullRequestsPage";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { Browser, BrowserTabBar } from "./Browser";
import { useBrowserTheme } from "./browserTheme";
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
  SettingsNav,
  settingsNames,
  SharedRepoIcons,
  Sidebar,
  ThreadList,
} from "./Sidebar";
import { newThreadPrefs } from "./prefs";
import { useThemePreference } from "./theme";
import type { ThreadLinks } from "./threadContext";
import { useAppearanceEffects } from "./appearance";
import { folderOf, runInDrawer, TerminalDrawer, TerminalPool, useDeleted } from "./ThreadTerminal";
import {
  asksOf,
  groupOf,
  groupThreads,
  idleThreads,
  lacksRepo,
  isRepository,
  lineageOf,
  noRepo,
  otherRepos,
  repoless,
  sharedRepoIcons,
  rootOf,
  threadProjects,
  titleOf,
  useThreads,
  type ForkChoice,
  type ThreadsView,
} from "./threads";
import { cloneOnto, type CloneAsk } from "./clone";
import { isRunning } from "./transcript";
import { fileStarted, folderPath, pinLayout, startIn } from "./pins";
import { appShortcut, Breadcrumb, IconButton, TopBar, type Crumb } from "./ui";
import { useUpdateAlarms } from "./Update";
import { useShortcutLabel } from "./keybindings";
import { draggedThread, threadDragType } from "./threadDrag";

/**
 * The main pane: a Project's coordinator chat, or with `agentId` one of its subagents' chats, a
 * thread (its id is its run's; `started` when New Thread just started it, until anything else is
 * selected; `subagent` when one of its agent's own subagents is open, by its call's id; `pr` when
 * its sidebar row's PR number opened it, which shows that pull request in the side panel), a new
 * thread in a sidebar group (`threads.ts`; with no group, it's the first repository's; `draft` when
 * it reopens one, by id, PLX-788).
 */
export type Selection =
  | { kind: "project"; projectId: string; agentId?: string }
  | { kind: "thread"; threadId: string; started?: boolean; subagent?: string; pr?: string }
  | { kind: "new"; groupId?: string; draft?: string };

/** Two threads on one host open side by side (PLX-587), left then right. */
export interface Split {
  hostId: string;
  threadIds: [string, string];
}

export type SettingsSection =
  | "usage"
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
  | "connections";

/**
 * The app frame: sidebar, then the chat or Settings, then the side panel.
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
  // A Project just created on another host, opened once that host is open and lists it: the
  // check below drops a Project selection the open host's list doesn't have.
  const [opening, setOpening] = useState<{ hostId: string; projectId: string }>();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // The host Set up GitHub opened Source control on (PLX-423).
  const [settingsHost, setSettingsHost] = useState<string>();
  // The setting Settings' search picked last, to scroll to; a new object each pick.
  const [settingsFocus, setSettingsFocus] = useState<{ anchor: string }>();
  // The page shown in place of the chat, if any: Pull requests, or the sidebar's permanent browser
  // (PLX-964). Opening a thread or Settings closes it.
  const [mainPage, setMainPage] = useState<"pullRequests" | "browser">();
  const browserStyle = useBrowserTheme();
  // The permanent browser mounts the first time it opens and stays, so its pages keep running.
  const [browserPage, setBrowserPage] = useState(false);
  if (mainPage === "browser" && !browserPage) setBrowserPage(true);

  useEffect(() => setMainPage(undefined), [selection]);
  // A folder's New thread files only what starts from the New thread screen it opens.
  useEffect(() => {
    if (selection.kind !== "new") startIn.set(null);
  }, [selection.kind]);
  const openSettings = (section: SettingsSection, hostId?: string) => {
    setMainPage(undefined);
    setSettings(section);
    setSettingsHost(hostId);
    setSettingsFocus(undefined);
  };
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // What each chat's right column shows, if anything: the side panel's views, or the browser,
  // which is apart from them (PLX-962). Each host's chats stay independent when switching.
  const [openPanes, setOpenPanes] = useState<Record<string, "views" | "browser" | undefined>>({});
  const panelKey = JSON.stringify([
    host.id,
    selection.kind,
    selection.kind === "thread"
      ? selection.threadId
      : selection.kind === "project"
        ? selection.projectId
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
  // Each new one shows the open Project's Project tab, when the sidebar opens a Project.
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

  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  // Runs started here forward their permission requests, only to a plxd that takes the flag.
  const approvals = connected && "approvals" in connection.capabilities;
  // Every host's threads and Projects, loaded side by side for the sidebar's one list (0033).
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
  const { groups } = groupThreads(threads.state);
  const pinFolders = pinLayout.use().folders;
  // The pinned folder New Thread starts in, from that folder's New thread (pins.ts).
  const startId = startIn.use();
  const startFolder = startId ? pinFolders[startId] : undefined;
  // The other computers' repositories, which New Thread and Mod+N's picker list too.
  const elsewhere = useMemo(() => otherRepos(hosts, views, host.id), [hosts, views, host.id]);
  // The computer New thread opens on: Settings > Threads' while it's listed and connected, else
  // the open one. Mod+N's picker lists its repositories first.
  const startPref = newThreadPrefs.use().host;
  const startConnected = useConnection(startPref)?.status === "connected";
  const start = (startConnected && hosts.find((h) => h.id === startPref)) || host;
  const startState = (views[start.id] ?? idleThreads).state;
  const startGroups = start.id === host.id ? groups : groupThreads(startState).groups;
  const startElsewhere = useMemo(
    () => otherRepos(hosts, views, start.id),
    [hosts, views, start.id],
  );
  // Each repository's icon by name, for its copies on other computers that have none.
  const repoIcons = useMemo(() => sharedRepoIcons(hosts, views), [hosts, views]);
  // Every thread and Project the open host has listed, so a selection is dropped only once what it
  // opened leaves the list: a just-started one reaches the list a render after it opens.
  const known = useRef(new Set<string>());
  for (const t of threads.state.threads) known.current.add(t.id);
  for (const p of threads.state.projects) known.current.add(p.id);
  // Closes one side of the split, leaving the other open alone if the split was showing.
  const closePane = (threadId: string) => {
    if (!split) return;
    const other = split.threadIds.find((id) => id !== threadId)!;
    setSplit(undefined);
    if (
      split.hostId === host.id &&
      selection.kind === "thread" &&
      split.threadIds.includes(selection.threadId)
    )
      setSelection({ kind: "thread", threadId: other });
  };
  // A split whose computer is removed goes with it.
  if (split && !hosts.some((h) => h.id === split.hostId)) setSplit(undefined);
  // A thread in the split that's deleted, maybe by another client, closes its side.
  const splitGone =
    split?.hostId === host.id
      ? split.threadIds.find(
          (id) => known.current.has(id) && !threads.state.threads.some((t) => t.id === id),
        )
      : undefined;
  if (splitGone) closePane(splitGone);
  // The threads the main pane shows: the split's while one of them is open.
  const paired =
    !settings &&
    selection.kind === "thread" &&
    split?.hostId === host.id &&
    split.threadIds.includes(selection.threadId);
  const panes = selection.kind !== "thread" ? [] : paired ? split.threadIds : [selection.threadId];
  // The open thread's group (No Repo's until plxd lists it), or the new thread's.
  let group = groups[0]!;
  if (selection.kind === "thread") {
    const open = threads.state.threads.find((t) => t.id === selection.threadId);
    // Deleted, maybe by another client: leave it rather than show a stale transcript.
    if (!open && known.current.has(selection.threadId) && !splitGone) setSelection({ kind: "new" });
    const id = open ? groupOf(threads.state, open) : noRepo;
    group = groups.find((g) => g.id === id)!;
  } else if (selection.kind === "new")
    group = groups.find((g) => g.id === selection.groupId) ?? group;

  if (
    opening?.hostId === host.id &&
    threads.state.projects.some((p) => p.id === opening.projectId)
  ) {
    setOpening(undefined);
    setSelection({ kind: "project", projectId: opening.projectId });
  }
  // The open Project. Once its host is removed, the next host's list doesn't have it.
  const project =
    selection.kind === "project"
      ? threads.state.projects.find((p) => p.id === selection.projectId)
      : undefined;
  if (selection.kind === "project" && !project && known.current.has(selection.projectId))
    setSelection({ kind: "new" });
  // With the threads in the Project, as its sidebar row counts them.
  const inProject = useMemo(() => threadProjects(threads.state), [threads.state]);
  const agents = useProjectAgents(host.id, project?.id, threads.state, inProject, approvals);
  // The open subagent, whose chat takes the coordinator's place while the Project stays selected.
  const agentId = selection.kind === "project" ? selection.agentId : undefined;
  // Entering a Project shows its inbox in the side panel.
  const projectPanelKey = project ? panelKey : undefined;
  const [panelProject, setPanelProject] = useState(projectPanelKey);
  if (projectPanelKey !== panelProject) {
    setPanelProject(projectPanelKey);
    if (project) setPanelOpen(true);
  }
  // The Project's inbox (0043), on a plxd with `inbox`, and the children whose questions wait in it.
  const answerable = connected && "questions" in connection.capabilities;
  const inbox = useInbox(
    host.id,
    project?.id ?? "",
    connected && !!project && "inbox" in connection.capabilities,
    answerable,
  );
  // The Project's context files, which its Project tab reads.
  const context = useProjectContext(host.id, project?.id ?? "", connected && !!project);
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
  // Project's, with its repository's, or the open thread's repository's.
  // ponytail: a repo entry's path is canonical and a Project's is as created, so a Project made
  // through a symlink finds no Repo scope; match canonical paths if that shows up.
  const memoryRepo = project
    ? threads.state.repos.find((r) => isRepository(r) && r.path === project.repoPath)?.id
    : selection.kind === "thread" && group.id !== noRepo
      ? group.id
      : undefined;
  const memory = connected && "memory" in connection.capabilities && (project || memoryRepo);
  // The run whose folder the side panel's Files view browses: the open thread or subagent.
  const filesRunId = selection.kind === "thread" ? selection.threadId : agentId;
  // The open thread's linked pull requests, on a plxd that links them (PLX-318).
  const threadRun =
    selection.kind === "thread" ? threads.state.runs[selection.threadId] : undefined;
  const linksPrs = connected && "pullRequests" in connection.capabilities;
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
    if (!project) return;
    setSelection({ kind: "project", projectId: project.id, agentId: id });
    setPanelExpanded(false);
  };
  // The permission requests the Project's other runs wait on, pinned in whichever of its chats is
  // open, each named and with a way to its own chat (PLX-196).
  const othersAsked = (open: string | undefined): Asked[] =>
    agents.runs.flatMap((run) => {
      if (run.id === open || !project) return [];
      const coordinator = run.id === project.coordinator;
      const from = {
        label: coordinator ? "Coordinator" : `Subagent: ${titleOf(run)}`,
        open: () => openAgent(coordinator ? undefined : run.id),
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
  // as on New Thread or a Project, Back goes to that thread itself.
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
  const needsYou = useNeedsYouAlarm(listed, (hostId, projectId) =>
    openOnHost(hostId, { kind: "project", projectId }),
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
  const subagents = (openThread && native[openThread.id]) || ([] as NativeSubagent[]);
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

  // The Project or repository crumb wears its sidebar icon. Under a subagent, the Project's goes
  // back to the coordinator. In a thread, the repository's opens New thread on that repository.
  let crumbs: Crumb[];
  if (project) {
    crumbs = [
      { label: host.name },
      {
        label: project.name,
        icon: <ProjectIcon icon={project.icon} />,
        onClick: agentId ? () => openAgent() : undefined,
      },
    ];
    if (agentTitle) crumbs.push({ label: agentTitle, icon: <Workflow /> });
  } else {
    const groupRepo = threads.state.repos.find((r) => r.id === group.id);
    // A chat in a pinned folder, or a folder's New thread, shows the folder in No Repo's place
    // (pins.ts). Nested folders read as a path: School / Math.
    const path =
      groupRepo && !groupRepo.scratch
        ? []
        : selection.kind === "thread"
          ? folderPath(pinFolders, `${host.id}/${selection.threadId}`)
          : startId && startFolder
            ? [...folderPath(pinFolders, `folder:${startId}`), startFolder]
            : [];
    const folder = path.at(-1);
    const repo = folder
      ? {
          label: path.map((f) => f.name).join(" / "),
          icon: (
            <Folder
              style={{ color: folder.color ? `var(--project-${folder.color})` : undefined }}
            />
          ),
        }
      : {
          label: group.name,
          icon: <RepoIcon repo={groupRepo} />,
          onClick:
            selection.kind === "thread"
              ? () => setSelection({ kind: "new", groupId: group.id })
              : undefined,
        };
    const page =
      selection.kind === "thread"
        ? (threads.state.titles[selection.threadId] ?? "Thread")
        : "New thread";
    crumbs = [{ label: host.name }, repo, { label: page }];

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

  // A Project created on the open host is in its list already. Another host's list loads once
  // that host is open.
  const openProject = (hostId: string, projectId: string) => {
    if (hostId === host.id) return setSelection({ kind: "project", projectId });
    setHostId(hostId);
    setSelection({ kind: "new" });
    setOpening({ hostId, projectId });
  };

  // New Thread's draft, which picking where it runs keeps (PLX-788).
  const draft = selection.kind === "new" ? selection.draft : undefined;
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
    let groupId = groupThreads(view.state).groups.find((g) => g.name === group.name)?.id;
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
    startIn.set(null);
    openOnHost(hostId, { kind: "new", groupId });
  };

  // A plain New thread, so not in the folder a folder's New thread put it in. It opens on the
  // computer new threads start on, in the repository of the same name there, or No Repo when it
  // has none.
  const newThread = (groupId = selection.kind === "project" ? undefined : group.id) => {
    startIn.set(null);
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
  const deleteThread = async (hostId: string, thread: Thread) => {
    const view = views[hostId] ?? idleThreads;
    const error = await view.remove(thread);
    if (error) return error;
    if (split?.hostId === hostId && split.threadIds.includes(thread.id)) closePane(thread.id);
    else if (selection.kind === "thread" && selection.threadId === thread.id)
      setSelection({ kind: "new", groupId: groupOf(view.state, thread) });
    return undefined;
  };
  // Opens `threadId` beside the open thread on `side`: by default the right, or in a split the side
  // that isn't focused, which it replaces.
  const openBeside = (threadId: string, side?: 0 | 1) => {
    if (selection.kind !== "thread" || selection.threadId === threadId) return;
    const ids: [string, string] = paired
      ? [...split.threadIds]
      : [selection.threadId, selection.threadId];
    const at = side ?? (paired ? (ids[0] === selection.threadId ? 1 : 0) : 1);
    ids[at] = threadId;
    // The other side's thread, dropped on this one.
    if (ids[0] === ids[1]) return;
    setSplit({ hostId: host.id, threadIds: ids });
    setSelection({ kind: "thread", threadId });
  };
  // The side a sidebar thread dragged over the open thread would open on: the right, or in a
  // split the side under the pointer. Not over a composer, which takes it to attach (PLX-378).
  const [dropSide, setDropSide] = useState<0 | 1>();
  const dropSideOf = (e: DragEvent<HTMLElement>): 0 | 1 | undefined => {
    if (e.defaultPrevented || !e.dataTransfer.types.includes(threadDragType)) return undefined;
    if (!paired) return 1;
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX < box.left + box.width / 2 ? 0 : 1;
  };
  // Focuses a side of the split, reopening it if another view is open, and its composer.
  const focusPane = (side: 0 | 1) => {
    if (!split) return;
    openOnHost(split.hostId, { kind: "thread", threadId: split.threadIds[side] });
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-pane="${side}"] .composer-input`)?.focus(),
    );
  };

  const offline = offlineReason(connection);

  // Where the open thread's or New thread's terminals open (folderOf).
  const folder =
    settings || selection.kind === "project"
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
      if (command === "panel") setPanelOpen(!panelOpen);
      else if (command === "browser" && !settings) toggleBrowser();
      else if (command === "sidebar") setSidebarOpen((open) => !open);
      else if (command === "terminal" && folder) toggleDrawer();
      else if (command === "newThread") {
        if (!dialog) picker.current?.showModal();
      } else if (command === "noRepoThread") {
        if (!dialog) newThread(noRepo);
      } else if (command === "leftThread" || command === "rightThread") {
        if (dialog || !split) return;
        focusPane(command === "leftThread" ? 0 : 1);
      } else if (command === "back" || command === "forward") {
        if (dialog || settings) return;
        step(command === "back" ? -1 : 1);
      } else if (command === "settings") openSettings("general");
      else if (command === "usage") openSettings("usage");
      else if (command === "openPr") {
        // The open thread's latest linked pull request.
        const latest = prs.urls.at(-1);
        if (!latest) return;
        window.open(latest, "_blank");
      } else if (
        !dialog &&
        (command === "parentThread" || command === "nextThread" || command === "previousThread")
      ) {
        // In a Project, Go to parent goes from a child back to the coordinator, and from an
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
  // The side panel is a chat's, so Settings has none.
  const chat = !settings;
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [requestedWidths, setRequestedWidths] = useState<[number, number]>([256, 416]);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sidePanelOpen = pane !== undefined && chat;
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

  const page = (
    <div className="flex h-full">
      {hosts.map((h) => (
        <HostLoader key={h.id} hostId={h.id} onView={report} onNeedsYou={needsYou} />
      ))}
      <Notifications />
      {onboarding && <Onboarding onStart={() => picker.current?.showModal()} />}
      <NewThreadPicker
        ref={picker}
        groups={startGroups.filter((g) => !g.space)}
        repos={startState.repos}
        hostName={start.name}
        elsewhere={startElsewhere}
        onPick={(groupId) =>
          start.id === host.id ? newThread(groupId) : pickRepoOn(start.id, groupId)
        }
        onPickElsewhere={pickRepoOn}
      />
      <Sidebar
        width={leftWidth}
        onResize={(width) => resizePanel(0, width)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewThread={() => newThread()}
      >
        {settings ? (
          <SettingsNav
            section={settings}
            onSection={(section, anchor) => {
              openSettings(section);
              setSettingsFocus(anchor ? { anchor } : undefined);
            }}
            onBack={() => {
              setSettings(null);
              setSettingsFocus(undefined);
            }}
          />
        ) : (
          <ThreadList
            hosts={listed}
            host={host}
            selection={selection}
            onSelect={(hostId, next) => {
              // The open row, picked again, leaves Pull requests or the browser too.
              setMainPage(undefined);
              // A draft opened from the list isn't in the folder either.
              if (next.kind === "new") startIn.set(null);
              openOnHost(hostId, next);
              // A Project opens on its coordinator's chat and the Project tab (0083).
              if (next.kind === "project") setShowHome({});
            }}
            onOpenProject={openProject}
            onOpenSettings={openSettings}
            onOpenPullRequests={() => {
              setSettings(null);
              setMainPage("pullRequests");
            }}
            browserOpen={!settings && mainPage === "browser"}
            onOpenBrowser={() => {
              setSettings(null);
              setMainPage("browser");
            }}
            onDelete={deleteThread}
            onNewThread={() => picker.current?.showModal()}
            onNewFolderThread={(id) => {
              newThread();
              startIn.set(id);
            }}
            split={split}
            onOpenBeside={openBeside}
            onClosePane={closePane}
          />
        )}
      </Sidebar>

      {/* An expanded side panel takes the main pane's place. */}
      <OpenDocumentContext value={openDoc}>
        <main hidden={expanded} className="flex min-w-0 flex-1 flex-col bg-pane">
          {settings ? (
            <>
              <TopBar className={topBarInset}>
                {showSidebar}
                <Breadcrumb items={[{ label: "Settings" }, { label: settingsNames[settings] }]} />
              </TopBar>
              <Settings
                section={settings}
                listed={listed}
                theme={theme}
                onThemeChange={setTheme}
                sourceControlHost={settingsHost}
                focus={settingsFocus}
              />
            </>
          ) : mainPage === "browser" ? (
            // The browser's theme paints its top bar and the browser, not the terminal drawer under
            // them (browserTheme.ts).
            <TopBar style={browserStyle} className={`bg-pane ${topBarInset}`}>
              {showSidebar}
              <BrowserTabBar scope="permanent" />
            </TopBar>
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
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-35 [&_svg]:size-4"
                  >
                    <ChevronLeft />
                  </IconButton>
                  <IconButton
                    label="Forward"
                    command="forward"
                    disabled={stepTo(1) === undefined}
                    onClick={() => step(1)}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-35 [&_svg]:size-4"
                  >
                    <ChevronRight />
                  </IconButton>
                </div>
                {agentId && (
                  <IconButton
                    label="Back to the coordinator"
                    command="parentThread"
                    onClick={() => openAgent()}
                  >
                    <ArrowLeft />
                  </IconButton>
                )}
                <Breadcrumb items={crumbs} />
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {!group.space && (
                    <ThreadDetailsButton
                      open={details.mode !== "hidden"}
                      onToggle={details.toggle}
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
                    <div
                      className="relative flex min-h-0 flex-1"
                      onDragOver={(e) => {
                        const side = dropSideOf(e);
                        setDropSide(side);
                        if (side === undefined) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                          setDropSide(undefined);
                      }}
                      onDrop={(e) => {
                        const side = dropSideOf(e);
                        setDropSide(undefined);
                        const thread = draggedThread(e.dataTransfer);
                        if (side === undefined || !thread) return;
                        e.preventDefault();
                        // A split's threads are one computer's.
                        if (thread.hostId === host.id) openBeside(thread.runId, side);
                      }}
                    >
                      {dropSide !== undefined && (
                        <div
                          aria-hidden
                          className={`pointer-events-none absolute inset-y-2 z-20 grid w-[calc(50%-1rem)] place-items-center rounded-xl border-2 border-dashed border-accent bg-background/85 backdrop-blur-sm ${dropSide === 0 ? "left-2" : "right-2"}`}
                        >
                          <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-foreground [&_svg]:size-4">
                            <Columns2 />
                            {paired ? "Open here" : "Open side by side"}
                          </span>
                        </div>
                      )}
                      {panes.map((threadId, side) => {
                        const focused = threadId === selection.threadId;
                        const paneThread = threads.state.threads.find((t) => t.id === threadId);
                        const paneParent =
                          "threadLineage" in threads.capabilities && paneThread
                            ? lineageOf(threads.state, paneThread)?.parent?.id
                            : undefined;
                        const title = threads.state.titles[threadId];
                        const inSpace = threads.state.repos.some(
                          (r) => r.id === paneThread?.repo && r.space,
                        );
                        // Keyed, so another run starts from an empty transcript.
                        return (
                          <section
                            key={`${host.id}/${threadId}`}
                            data-pane={paired ? side : undefined}
                            data-focused={paired && focused ? "" : undefined}
                            aria-label={paired ? (title ?? "Thread") : undefined}
                            // Clicking or tabbing into a side focuses it.
                            onPointerDownCapture={() => !focused && openThreadId(threadId)}
                            // A link to a pull request the thread links opens its view, not GitHub,
                            // unless a modifier key asks for the browser.
                            onClickCapture={(e) => {
                              const href = (e.target as Element)
                                .closest?.("a[href]")
                                ?.getAttribute("href");
                              const pr =
                                linksPrs &&
                                href &&
                                linkedPr(href, threads.state.runs[threadId]?.pullRequests ?? []);
                              if (!pr || e.metaKey || e.ctrlKey || e.shiftKey) return;
                              e.preventDefault();
                              openPr(pr);
                            }}
                            // Not focus the window or the app gives with nothing focused before, such as a
                            // notification's click or an approval card's.
                            onFocusCapture={(e) =>
                              !focused && e.relatedTarget && openThreadId(threadId)
                            }
                            className={`flex min-w-0 flex-1 flex-col ${side > 0 ? "border-l border-border" : ""}`}
                          >
                            {paired && (
                              <PaneHeader
                                side={side as 0 | 1}
                                title={title ?? "Thread"}
                                repo={threads.state.repos.find((r) => r.id === paneThread?.repo)}
                                focused={focused}
                                onClose={() => closePane(threadId)}
                              />
                            )}
                            <AgentChat
                              hostId={host.id}
                              host={host}
                              runId={threadId}
                              title={title}
                              prompt={threads.state.runs[threadId]?.prompt}
                              // The list's status goes stale once the run moves on, so only a start says so.
                              going={focused && selection.started}
                              listed={threads.state.runs[threadId]}
                              noRepo={repoless({
                                id: paneThread ? groupOf(threads.state, paneThread) : noRepo,
                                space: inSpace,
                              })}
                              space={inSpace}
                              pullRequests={
                                focused &&
                                prs.urls.length > 0 && <PullRequestChip prs={prs} onOpen={openPr} />
                              }
                              onPrOpened={linksPrs ? openPr : undefined}
                              onSetUpGithub={setUpGithub}
                              compose={focused ? compose : undefined}
                              onComposed={composed}
                              threadLinks={threadLinks}
                              subagent={focused ? selection.subagent : undefined}
                              onOpenSubagent={openSubagent}
                              onSubagents={reportNative}
                              onPreview={(runId, reveal) => void showPreviews(runId, reveal)}
                              onDevice={(runId, deviceId) => void showAgentDevice(runId, deviceId)}
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
                        );
                      })}
                    </div>
                  ) : selection.kind === "new" ? (
                    <NewThread
                      // Opening a draft opens a new screen, which leaves the one open as a draft.
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
                      runOptions={
                        connection?.status === "connected" &&
                        "runOptions" in connection.capabilities
                      }
                      onStarted={(threadId, background) => {
                        // Started from a pinned folder's New thread: pinned there (pins.ts).
                        if (fileStarted(`${host.id}/${threadId}`))
                          void threads.update(threadId, { pinned: true });
                        if (!background) setSelection({ kind: "thread", threadId, started: true });
                      }}
                      folder={startFolder}
                      disabledReason={offline}
                      threadLinks={threadLinks}
                    />
                  ) : agentId ? (
                    <AgentChat
                      key={`${host.id}/${agentId}`}
                      hostId={host.id}
                      runId={agentId}
                      title={agentTitle}
                      prompt={agent?.prompt}
                      // A Project's subagents are kept current.
                      going={isRunning(agent?.status)}
                      others={othersAsked(agentId)}
                      projectMode={project?.permission}
                      host={host}
                      threadLinks={threadLinks}
                      strip={
                        project && {
                          key: "parent",
                          node: (
                            <ChildStrip
                              name={project.name}
                              icon={
                                <ProjectIcon icon={project.icon} className="size-3.5 shrink-0" />
                              }
                              onOpenName={() =>
                                setSelection({ kind: "project", projectId: project.id })
                              }
                              onBack={() => openAgent()}
                            />
                          ),
                        }
                      }
                    />
                  ) : (
                    project && (
                      <ProjectChat
                        key={`${host.id}/${project.id}`}
                        hostId={host.id}
                        project={project}
                        prompt={
                          project.coordinator && threads.state.runs[project.coordinator]?.prompt
                        }
                        startCoordinator={threads.startCoordinator}
                        updateProject={threads.updateProject}
                        host={host}
                        repo={threads.state.repos.find((r) => r.path === project.repoPath)?.id}
                        others={othersAsked(project.coordinator)}
                        agents={agents}
                        titles={threads.state.titles}
                        needs={needs}
                        onOpenRun={(id) => openAgent(id === project.coordinator ? undefined : id)}
                        threadLinks={threadLinks}
                      />
                    )
                  )}
                </div>
                <ThreadDetails
                  key={panelKey}
                  mode={group.space ? "hidden" : details.mode}
                  host={host}
                  folder={folder?.path === "~" ? undefined : folder?.path}
                  worktree={
                    !!threadRun?.worktreePath &&
                    threadRun.worktreePath !==
                      threads.state.repos.find((repo) => repo.id === group.id)?.path
                  }
                  actions={
                    selection.kind !== "project" && !repoless(group)
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
                    (selection.kind === "new" && !repoless(group) && !group.space)
                      ? {
                          hostId: host.id,
                          run: threadRun,
                          repo: selection.kind === "new" ? (group.id as RepoId) : undefined,
                          title:
                            selection.kind === "thread"
                              ? threads.state.titles[selection.threadId]
                              : undefined,
                          onPrOpened: linksPrs ? openPr : undefined,
                          onSetUpGithub: setUpGithub,
                          onChanges: () => {
                            setPanelOpen(true);
                            setShowChanges({});
                          },
                        }
                      : undefined
                  }
                  prs={selection.kind === "thread" ? { prs, onOpen: openPr } : undefined}
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
              </div>
            </>
          )}
          {browserPage && (
            <div
              hidden={!!settings || mainPage !== "browser"}
              style={browserStyle}
              className="flex min-h-0 flex-1 flex-col bg-pane"
            >
              <Browser scope="permanent" remoteHost={host.id === localId ? undefined : host.name} />
            </div>
          )}
          {/* Outside the views, so the terminals live on behind Settings. */}
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
        showProject={showHome}
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
        project={
          project && {
            waiting: waitingCount(project, agents, inbox),
            home: (
              <ProjectHome
                key={`${host.id}/${project.id}`}
                hostId={host.id}
                context={context}
                project={project}
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
          project && (
            <AgentsPanel
              // Another Project's start box starts empty, with its own retry id.
              key={`${host.id}/${project.id}`}
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
            />
          )
        }
        knowledge={
          (project || memory) && (
            <KnowledgePanel
              key={`${host.id}/${project?.id ?? memoryRepo}`}
              hostId={host.id}
              project={project?.id}
              repo={memoryRepo}
              coordinator={
                project?.coordinator
                  ? agents.runs.find((r) => r.id === project.coordinator)
                  : undefined
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

/**
 * A side of the split's header, like a tab: its repository's icon, its title, its Focus left or
 * right thread key, and a close button. The focused side's is underlined in the accent.
 */
function PaneHeader({
  side,
  title,
  repo,
  focused,
  onClose,
}: {
  side: 0 | 1;
  title: string;
  repo?: Repo;
  focused: boolean;
  onClose: () => void;
}) {
  const keys = useShortcutLabel(side === 0 ? "leftThread" : "rightThread");
  return (
    <div
      className={`relative flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-4 text-[12.5px] transition-colors ${focused ? "text-foreground" : "text-faint-foreground"}`}
    >
      {focused && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />}
      <span className={`flex shrink-0 ${focused ? "" : "opacity-60"}`}>
        <RepoIcon repo={repo} />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {keys && (
        <kbd className="shrink-0 font-sans text-[11px] text-faint-foreground tabular-nums">
          {keys}
        </kbd>
      )}
      <button
        type="button"
        aria-label="Close this side"
        title="Close this side"
        onClick={onClose}
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
      >
        <X />
      </button>
    </div>
  );
}

/** Loads one host's threads and Projects and hands them up, whenever they change. */
function HostLoader({
  hostId,
  onView,
  onNeedsYou,
}: {
  hostId: string;
  onView: (hostId: string, view: ThreadsView) => void;
  onNeedsYou: (hostId: string, projectId: string, item: InboxItem) => void;
}) {
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const view = useThreads(hostId, capabilities, iconImageBytes(connection), (projectId, item) =>
    onNeedsYou(hostId, projectId, item),
  );
  useEffect(() => onView(hostId, view), [hostId, view, onView]);
  return null;
}
