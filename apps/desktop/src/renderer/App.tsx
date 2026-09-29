import { PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";

import type { Thread } from "../protocol/generated/protocol";
import { AgentChat } from "./AgentChat";
import { Composer } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { NewThread } from "./NewThread";
import { localId, useHosts } from "./hosts";
import { models, projects } from "./placeholder";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { SettingsNav, settingsNames, Sidebar, ThreadList } from "./Sidebar";
import { useThemePreference } from "./theme";
import { groupOf, groupThreads, noRepo, useThreads } from "./threads";
import { Breadcrumb, IconButton, TopBar } from "./ui";

/**
 * The open chat: a Project's coordinator chat, a thread (its id is its run's), or a new
 * thread in a sidebar group (`threads.ts`). With no group, it's the first repository's.
 */
export type Selection =
  | { kind: "project"; projectId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "new"; groupId?: string };

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

  let crumbs: string[];
  if (selection.kind === "project")
    crumbs = [host.name, projects.find((p) => p.id === selection.projectId)!.name];
  else if (selection.kind === "thread")
    crumbs = [host.name, group.name, threads.state.titles[selection.threadId] ?? "Thread"];
  else crumbs = [host.name, group.name, "New thread"];

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
  const sidePanelOpen = panelOpen && !settings;
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
            projects={host.id === localId ? projects : []}
            selection={selection}
            onSelect={setSelection}
            onOpenSettings={openSettings}
            models={models}
            threads={threads}
            onDelete={deleteThread}
          />
        )}
      </Sidebar>

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {settings ? (
          <>
            <TopBar className={topBarInset}>
              {showSidebar}
              <Breadcrumb items={["Settings", settingsNames[settings]]} />
            </TopBar>
            <Settings
              section={settings}
              addingHost={addingHost}
              theme={theme}
              onThemeChange={setTheme}
            />
          </>
        ) : (
          <>
            <TopBar className={`${topBarInset} border-b border-border`}>
              {showSidebar}
              <Breadcrumb items={crumbs} />
              <div className="ml-auto flex items-center gap-0.5">
                <IconButton label="New thread" keys="N" onClick={newThread}>
                  <SquarePen />
                </IconButton>
                <IconButton
                  label="Toggle side panel"
                  keys="Alt+B"
                  aria-expanded={panelOpen}
                  aria-controls="side-panel"
                  onClick={() => setPanelOpen((open) => !open)}
                >
                  <PanelRight />
                </IconButton>
              </div>
            </TopBar>
            {selection.kind === "thread" ? (
              // Keyed, so another run starts from an empty transcript.
              <AgentChat
                key={`${host.id}/${selection.threadId}`}
                hostId={host.id}
                runId={selection.threadId}
                notice={notice?.threadId === selection.threadId ? notice.text : undefined}
              />
            ) : selection.kind === "new" ? (
              <NewThread
                key={host.id}
                hostId={host.id}
                groups={groups}
                groupId={group.id}
                onGroupChange={(groupId) => setSelection({ kind: "new", groupId })}
                local={host.id === localId}
                addRepo={threads.addRepo}
                start={threads.start}
                onStarted={(threadId, text) => {
                  setNotice(text ? { threadId, text } : undefined);
                  setSelection({ kind: "thread", threadId });
                }}
                disabledReason={
                  connection?.status === "failed"
                    ? "Disconnected from wispd"
                    : connected
                      ? undefined
                      : "Connecting to wispd…"
                }
              />
            ) : (
              // A Project's coordinator chat is RYA-46's.
              <>
                <div className="flex flex-1 items-center justify-center text-[13px] text-faint-foreground">
                  No messages yet
                </div>
                <div className="mx-auto w-full max-w-3xl px-6 pb-5">
                  <Composer />
                </div>
              </>
            )}
          </>
        )}
      </main>

      <SidePanel open={sidePanelOpen} />
    </div>
  );
}
