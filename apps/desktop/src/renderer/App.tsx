import { Folder, House, PanelLeft, PanelRight, Workflow } from "lucide-react";
import { useEffect, useState } from "react";

import type { Thread } from "../protocol/generated/protocol";
import { AgentChat } from "./AgentChat";
import { useConnection } from "./ConnectionStatus";
import { NewThread } from "./NewThread";
import { localId, useHosts } from "./hosts";
import { AgentsPanel, useProjectAgents } from "./ProjectAgents";
import { ProjectChat } from "./ProjectChat";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { ProjectIcon, SettingsNav, settingsNames, Sidebar, ThreadList } from "./Sidebar";
import { useThemePreference } from "./theme";
import { groupOf, groupThreads, noRepo, titleOf, useThreads } from "./threads";
import { Breadcrumb, IconButton, TopBar, type Crumb } from "./ui";
import { UsagePage } from "./UsagePage";

/**
 * The main pane: a Project's coordinator chat, or with `agentId` one of its subagents' chats, a
 * thread (its id is its run's), a new thread in a sidebar group (`threads.ts`; with no group,
 * it's the first repository's), or Usage.
 */
export type Selection =
  | { kind: "project"; projectId: string; agentId?: string }
  | { kind: "thread"; threadId: string }
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
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // Set by the sidebar's "Add host", so Hosts opens on its form; any other way in clears it.
  const [addingHost, setAddingHost] = useState(false);
  const openSettings = (section: SettingsSection, addHost = false) => {
    setSettings(section);
    setAddingHost(addHost);
  };
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // A quiet note for the thread New Thread just started, such as the account it picked.
  const [notice, setNotice] = useState<{ threadId: string; text: string }>();

  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const threads = useThreads(host.id, connected);
  const { groups } = groupThreads(threads.state);
  // The open thread's group (No Repo's until wispd lists it), or the new thread's.
  let group = groups[0]!;
  if (selection.kind === "thread") {
    const open = threads.state.threads.find((t) => t.id === selection.threadId);
    // Deleted, maybe by another client: leave it rather than show a stale transcript. An open
    // thread is always listed, since a start and a click both come after the thread is.
    if (!open) setSelection({ kind: "new" });
    const id = open ? groupOf(threads.state, open) : noRepo;
    group = groups.find((g) => g.id === id)!;
  } else if (selection.kind === "new")
    group = groups.find((g) => g.id === selection.groupId) ?? group;

  // The open Project. Once its host is removed, the next host's list doesn't have it.
  const project =
    selection.kind === "project"
      ? threads.state.projects.find((p) => p.id === selection.projectId)
      : undefined;
  if (selection.kind === "project" && !project) setSelection({ kind: "new" });
  const agents = useProjectAgents(host.id, project?.id, connected);
  // The open subagent, whose chat takes the coordinator's place while the Project stays selected.
  const agentId = selection.kind === "project" ? selection.agentId : undefined;
  const agent = agents.runs.find((r) => r.id === agentId);
  // Shrinks an expanded side panel, which hides the main pane the chat opens in.
  const openAgent = (id?: string) => {
    if (!project) return;
    setSelection({ kind: "project", projectId: project.id, agentId: id });
    setPanelExpanded(false);
  };

  // The Project or repository crumb wears its sidebar icon. Under a subagent, the Project's goes
  // back to the coordinator.
  let crumbs: Crumb[];
  if (project) {
    crumbs = [
      { label: host.name },
      {
        label: project.name,
        icon: <ProjectIcon />,
        onClick: agentId ? () => openAgent() : undefined,
      },
    ];
    if (agentId) crumbs.push({ label: agent ? titleOf(agent) : "Subagent", icon: <Workflow /> });
  } else {
    const repo = { label: group.name, icon: group.id === noRepo ? <House /> : <Folder /> };
    const page =
      selection.kind === "thread"
        ? (threads.state.titles[selection.threadId] ?? "Thread")
        : "New thread";
    crumbs = [{ label: host.name }, repo, { label: page }];
  }

  const newThread = () => {
    setSettings(null);
    setSelection({ kind: "new", groupId: selection.kind === "project" ? undefined : group.id });
  };
  const deleteThread = async (thread: Thread) => {
    const error = await threads.remove(thread);
    if (!error && selection.kind === "thread" && selection.threadId === thread.id)
      setSelection({ kind: "new", groupId: groupOf(threads.state, thread) });
    return error;
  };

  const offline =
    connection?.status === "failed"
      ? "Disconnected from wispd"
      : connected
        ? undefined
        : "Connecting to wispd…";

  // Mod+B: sidebar. Mod+Alt+B: side panel. Mod+N: new thread. Mod+,: Settings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mac = window.wisp.platform === "darwin";
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
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNewThread={newThread}>
        {settings ? (
          <SettingsNav
            section={settings}
            onSection={(section) => openSettings(section)}
            onBack={() => setSettings(null)}
          />
        ) : (
          <ThreadList
            hosts={hosts}
            host={host}
            onHostChange={(id) => {
              setHostId(id);
              setSelection({ kind: "new" });
            }}
            selection={selection}
            onSelect={setSelection}
            onOpenSettings={openSettings}
            threads={threads}
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
            <Settings
              section={settings}
              addingHost={addingHost}
              theme={theme}
              onThemeChange={setTheme}
            />
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
                  setSelection({ kind: "thread", threadId });
                }}
                disabledReason={offline}
              />
            ) : agentId ? (
              <AgentChat
                key={`${host.id}/${agentId}`}
                hostId={host.id}
                runId={agentId}
                prompt={agent?.prompt}
              />
            ) : (
              project && (
                <ProjectChat
                  key={`${host.id}/${project.id}`}
                  hostId={host.id}
                  project={project}
                  prompt={project.coordinator && threads.state.runs[project.coordinator]?.prompt}
                  startCoordinator={threads.startCoordinator}
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
      />
    </div>
  );
}
