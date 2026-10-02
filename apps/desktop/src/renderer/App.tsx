import { PanelLeft, PanelRight, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Thread } from "../protocol/generated/protocol";
import { AgentChat } from "./AgentChat";
import type { Asked } from "./Approval";
import { useConnection } from "./ConnectionStatus";
import { ContextPanel } from "./ContextPanel";
import { NewThread } from "./NewThread";
import { localId, useHosts } from "./hosts";
import { AgentsPanel, useProjectAgents } from "./ProjectAgents";
import { ProjectChat } from "./ProjectChat";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { attentionOf } from "./attention";
import { useSnoozeAlarms } from "./alarms";
import { ProjectIcon, RepoIcon, SettingsNav, settingsNames, Sidebar, ThreadList } from "./Sidebar";
import { useThemePreference } from "./theme";
import {
  asksOf,
  groupOf,
  groupThreads,
  idleThreads,
  noRepo,
  titleOf,
  useThreads,
  type ThreadsView,
} from "./threads";
import { isRunning } from "./transcript";
import { Breadcrumb, IconButton, TopBar, type Crumb } from "./ui";
import { UsagePage } from "./UsagePage";

/**
 * The main pane: a Project's coordinator chat, or with `agentId` one of its subagents' chats, a
 * thread (its id is its run's; `started` when New Thread just started it, until anything else is
 * selected), a new thread in a sidebar group (`threads.ts`; with no group, it's the first
 * repository's), or Usage.
 */
export type Selection =
  | { kind: "project"; projectId: string; agentId?: string }
  | { kind: "thread"; threadId: string; started?: boolean }
  | { kind: "new"; groupId?: string }
  | { kind: "usage" };

export type SettingsSection = "general" | "hosts" | "providers";

/**
 * The app frame: sidebar, then the chat or Settings, then the side panel.
 * Views are plain state, not routes: there is nothing to deep-link yet.
 */
export function App() {
  const [theme, setTheme] = useThemePreference();
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  // The open host, or this computer once the open one is removed.
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const [selection, setSelection] = useState<Selection>({ kind: "new" });
  // A Project just created on another host, opened once that host is open and lists it: the
  // check below drops a Project selection the open host's list doesn't have.
  const [opening, setOpening] = useState<{ hostId: string; projectId: string }>();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const openSettings = (section: SettingsSection) => setSettings(section);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // A quiet note for the thread New Thread just started, such as the account it picked.
  const [notice, setNotice] = useState<{ threadId: string; text: string }>();

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
  const listed = useMemo(
    () => hosts.map((h) => ({ host: h, view: views[h.id] ?? idleThreads })),
    [hosts, views],
  );
  const { groups } = groupThreads(threads.state);
  // Every thread and Project the open host has listed, so a selection is dropped only once what it
  // opened leaves the list: a just-started one reaches the list a render after it opens.
  const known = useRef(new Set<string>());
  for (const t of threads.state.threads) known.current.add(t.id);
  for (const p of threads.state.projects) known.current.add(p.id);
  // The open thread's group (No Repo's until plxd lists it), or the new thread's.
  let group = groups[0]!;
  if (selection.kind === "thread") {
    const open = threads.state.threads.find((t) => t.id === selection.threadId);
    // Deleted, maybe by another client: leave it rather than show a stale transcript.
    if (!open && known.current.has(selection.threadId)) setSelection({ kind: "new" });
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
  const agents = useProjectAgents(host.id, project?.id, connected, approvals);
  // The open subagent, whose chat takes the coordinator's place while the Project stays selected.
  const agentId = selection.kind === "project" ? selection.agentId : undefined;
  const agent = agents.runs.find((r) => r.id === agentId);
  // Shrinks an expanded side panel, which hides the main pane the chat opens in.
  const openAgent = (id?: string) => {
    if (!project) return;
    setSelection({ kind: "project", projectId: project.id, agentId: id });
    setPanelExpanded(false);
  };
  // The permission requests the Project's other runs wait on, pinned in whichever of its chats is
  // open, each named and with a way to its own chat (RYA-196).
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

  // An open thread that has news is seen now, including one that finishes while it is open.
  const openThread =
    selection.kind === "thread"
      ? threads.state.threads.find((t) => t.id === selection.threadId)
      : undefined;
  const openNews =
    openThread &&
    threads.attention &&
    ["done", "failed"].includes(
      attentionOf(
        openThread,
        threads.state.runs[openThread.id],
        asksOf(threads.state, openThread.id),
      ),
    );
  useEffect(() => {
    if (openNews && openThread) void threads.update(openThread.id, { seen: true });
  }, [openNews, openThread, threads]);

  const openOnHost = (hostId: string, next: Selection) => {
    setSettings(null);
    setHostId(hostId);
    setSelection(next);
    setOpening(undefined);
  };
  useSnoozeAlarms(listed, (hostId, threadId) => openOnHost(hostId, { kind: "thread", threadId }));

  // The Project or repository crumb wears its sidebar icon. Under a subagent, the Project's goes
  // back to the coordinator.
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
    if (agentId) crumbs.push({ label: agent ? titleOf(agent) : "Subagent", icon: <Workflow /> });
  } else {
    const repo = {
      label: group.name,
      icon: <RepoIcon repo={threads.state.repos.find((r) => r.id === group.id)} />,
    };
    const page =
      selection.kind === "thread"
        ? (threads.state.titles[selection.threadId] ?? "Thread")
        : "New thread";
    crumbs = [{ label: host.name }, repo, { label: page }];
  }

  // A Project created on the open host is in its list already. Another host's list loads once
  // that host is open.
  const openProject = (hostId: string, projectId: string) => {
    if (hostId === host.id) return setSelection({ kind: "project", projectId });
    setHostId(hostId);
    setSelection({ kind: "new" });
    setOpening({ hostId, projectId });
  };

  const newThread = () => {
    setSettings(null);
    setSelection({ kind: "new", groupId: selection.kind === "project" ? undefined : group.id });
  };
  const deleteThread = async (hostId: string, thread: Thread) => {
    const view = views[hostId] ?? idleThreads;
    const error = await view.remove(thread);
    if (!error && selection.kind === "thread" && selection.threadId === thread.id)
      setSelection({ kind: "new", groupId: groupOf(view.state, thread) });
    return error;
  };

  const offline =
    connection?.status === "failed"
      ? "Disconnected from plxd"
      : connected
        ? undefined
        : "Connecting to plxd…";

  // Mod+B: sidebar. Mod+Alt+B: side panel. Mod+N: new thread. Mod+,: Settings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mac = window.parallax.platform === "darwin";
      if (!(mac ? e.metaKey : e.ctrlKey)) return;
      // Off macOS, AltGr arrives as Ctrl+Alt and types characters we must not
      // eat. (macOS may report Option as AltGraph, and uses Cmd anyway.)
      if (!mac && e.getModifierState("AltGraph")) return;
      if (e.code === "KeyB" && e.altKey) setPanelOpen((open) => !open);
      else if (e.code === "KeyB") setSidebarOpen((open) => !open);
      else if (e.code === "KeyN" && !e.altKey) newThread();
      else if (e.key === "," && !e.altKey) openSettings("general");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Shown in the main pane's top row only while the sidebar is hidden.
  const showSidebar = !sidebarOpen && (
    <IconButton
      label="Show sidebar"
      keys="B"
      aria-expanded={false}
      aria-controls="sidebar"
      onClick={() => setSidebarOpen(true)}
    >
      <PanelLeft />
    </IconButton>
  );
  // The side panel is a chat's, so Settings and Usage have none.
  const chat = !settings && selection.kind !== "usage";
  const sidePanelOpen = panelOpen && chat;
  const expanded = sidePanelOpen && panelExpanded;
  // The main pane's top row meets the traffic lights without the sidebar, and
  // Windows' window buttons without the side panel.
  const topBarInset = [
    sidebarOpen ? "" : "traffic-light-inset",
    sidePanelOpen ? "" : "window-controls-inset",
  ].join(" ");

  return (
    <div className="flex h-full">
      {hosts.map((h) => (
        <HostLoader key={h.id} hostId={h.id} onView={report} />
      ))}
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNewThread={newThread}>
        {settings ? (
          <SettingsNav
            section={settings}
            onSection={(section) => openSettings(section)}
            onBack={() => setSettings(null)}
          />
        ) : (
          <ThreadList
            hosts={listed}
            host={host}
            selection={selection}
            onSelect={openOnHost}
            onOpenProject={openProject}
            onOpenSettings={openSettings}
            onDelete={deleteThread}
          />
        )}
      </Sidebar>

      {/* An expanded side panel takes the main pane's place. */}
      <main hidden={expanded} className="flex min-w-0 flex-1 flex-col bg-background">
        {settings ? (
          <>
            <TopBar className={topBarInset}>
              {showSidebar}
              <Breadcrumb items={[{ label: "Settings" }, { label: settingsNames[settings] }]} />
            </TopBar>
            <Settings section={settings} theme={theme} onThemeChange={setTheme} />
          </>
        ) : selection.kind === "usage" ? (
          <UsagePage hosts={hosts} leading={showSidebar} topBarClassName={topBarInset} />
        ) : (
          <>
            <TopBar className={topBarInset}>
              {showSidebar}
              <Breadcrumb items={crumbs} />
              {/* Shown only while the panel is closed; the panel's top bar has it otherwise. */}
              {!panelOpen && (
                <div className="ml-auto">
                  <IconButton
                    label="Show side panel"
                    keys="Alt+B"
                    aria-expanded={false}
                    aria-controls="side-panel"
                    onClick={() => setPanelOpen(true)}
                  >
                    <PanelRight />
                  </IconButton>
                </div>
              )}
            </TopBar>
            {selection.kind === "thread" ? (
              // Keyed, so another run starts from an empty transcript.
              <AgentChat
                key={`${host.id}/${selection.threadId}`}
                hostId={host.id}
                runId={selection.threadId}
                notice={notice?.threadId === selection.threadId ? notice.text : undefined}
                prompt={threads.state.runs[selection.threadId]?.prompt}
                // The list's status goes stale once the run moves on, so only a start says so.
                going={selection.started}
                noRepo={group.id === noRepo}
              />
            ) : selection.kind === "new" ? (
              <NewThread
                key={host.id}
                hostId={host.id}
                hosts={hosts}
                groups={groups}
                groupId={group.id}
                onGroupChange={(groupId) => setSelection({ kind: "new", groupId })}
                local={host.id === localId}
                addRepo={threads.addRepo}
                start={threads.start}
                runOptions={
                  connection?.status === "connected" && "runOptions" in connection.capabilities
                }
                onStarted={(threadId, text) => {
                  setNotice(text ? { threadId, text } : undefined);
                  setSelection({ kind: "thread", threadId, started: true });
                }}
                disabledReason={offline}
              />
            ) : agentId ? (
              <AgentChat
                key={`${host.id}/${agentId}`}
                hostId={host.id}
                runId={agentId}
                prompt={agent?.prompt}
                // A Project's subagents are kept current.
                going={isRunning(agent?.status)}
                others={othersAsked(agentId)}
              />
            ) : (
              project && (
                <ProjectChat
                  key={`${host.id}/${project.id}`}
                  hostId={host.id}
                  project={project}
                  prompt={project.coordinator && threads.state.runs[project.coordinator]?.prompt}
                  startCoordinator={threads.startCoordinator}
                  others={othersAsked(project.coordinator)}
                />
              )
            )}
          </>
        )}
      </main>

      <SidePanel
        open={sidePanelOpen}
        onClose={() => setPanelOpen(false)}
        expanded={expanded}
        onExpandedChange={setPanelExpanded}
        leading={expanded && showSidebar}
        topBarClassName={expanded && !sidebarOpen ? "traffic-light-inset" : ""}
        agents={
          project && (
            <AgentsPanel
              // Another Project's start box starts empty, with its own retry id.
              key={`${host.id}/${project.id}`}
              agents={agents}
              openId={agentId}
              onOpen={openAgent}
              disabledReason={offline}
            />
          )
        }
        context={
          project && (
            <ContextPanel
              key={`${host.id}/${project.id}`}
              hostId={host.id}
              project={project.id}
              name={project.name}
              connected={connected}
            />
          )
        }
      />
    </div>
  );
}

/** Loads one host's threads and Projects and hands them up, whenever they change. */
function HostLoader({
  hostId,
  onView,
}: {
  hostId: string;
  onView: (hostId: string, view: ThreadsView) => void;
}) {
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const view = useThreads(hostId, !!capabilities, {
    approvals: !!capabilities && "approvals" in capabilities,
    attention: !!capabilities && "threadAttention" in capabilities,
    editable: !!capabilities && "projectEdit" in capabilities,
  });
  useEffect(() => onView(hostId, view), [hostId, view, onView]);
  return null;
}
