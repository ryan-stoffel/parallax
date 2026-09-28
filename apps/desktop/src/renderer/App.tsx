import { PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";

import type { Thread } from "../protocol/generated/protocol";
import { AgentChat } from "./AgentChat";
import { Composer } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { NewThread } from "./NewThread";
import { hosts, models } from "./placeholder";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { SettingsNav, Sidebar, ThreadList } from "./Sidebar";
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

export type SettingsSection = "general" | "providers";

const firstHost = hosts[0]!;

/**
 * The app frame: sidebar, then the chat or Settings, then the side panel.
 * Views are plain state, not routes: there is nothing to deep-link yet.
 */
export function App() {
  const [theme, setTheme] = useThemePreference();
  const [host, setHost] = useState(firstHost);
  const [selection, setSelection] = useState<Selection>({ kind: "new" });
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);

  // Threads are live for this Mac only; other hosts arrive with RYA-26.
  const connection = useConnection("local");
  const connected = connection?.status === "connected";
  const threads = useThreads("local", connected);
  const { groups } = groupThreads(threads.state);
  // The open thread's group (No Repo's until wispd lists it), or the new thread's.
  let group = groups[0]!;
  if (selection.kind === "thread") {
    const open = threads.state.threads.find((t) => t.id === selection.threadId);
    const id = open ? groupOf(threads.state, open) : noRepo;
    group = groups.find((g) => g.id === id)!;
  } else if (selection.kind === "new")
    group = groups.find((g) => g.id === selection.groupId) ?? group;

  let crumbs: string[];
  if (selection.kind === "project")
    crumbs = [host.name, host.projects.find((p) => p.id === selection.projectId)!.name];
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
      else if (e.key === "," && !e.altKey) setSettings("general");
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
  const topBarInset = sidebarOpen ? "" : "traffic-light-inset";

  return (
    <div className="flex h-full">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNewThread={newThread}>
        {settings ? (
          <SettingsNav
            section={settings}
            onSection={setSettings}
            onBack={() => setSettings(null)}
          />
        ) : (
          <ThreadList
            hosts={hosts}
            host={host}
            onHostChange={(id) => {
              setHost(hosts.find((h) => h.id === id)!);
              setSelection({ kind: "new" });
            }}
            selection={selection}
            onSelect={setSelection}
            onOpenSettings={() => setSettings("general")}
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
              <Breadcrumb items={["Settings", settings === "general" ? "General" : "Providers"]} />
            </TopBar>
            <Settings section={settings} theme={theme} onThemeChange={setTheme} />
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
              />
            ) : selection.kind === "new" ? (
              <NewThread
                groups={groups}
                groupId={group.id}
                onGroupChange={(groupId) => setSelection({ kind: "new", groupId })}
                local={host.local}
                addRepo={threads.addRepo}
                start={threads.start}
                onStarted={(threadId) => setSelection({ kind: "thread", threadId })}
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

      <SidePanel open={panelOpen && !settings} />
    </div>
  );
}
