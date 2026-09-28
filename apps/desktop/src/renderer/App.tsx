import { PanelLeft, PanelRight, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentChat } from "./AgentChat";
import { Composer } from "./Composer";
import { composerOptions, hosts, type Host } from "./placeholder";
import { Settings } from "./Settings";
import { SidePanel } from "./SidePanel";
import { SettingsNav, Sidebar, ThreadList } from "./Sidebar";
import { useThemePreference } from "./theme";
import { Breadcrumb, IconButton, TopBar } from "./ui";

/**
 * The open chat: a Project's coordinator chat, or a repository's thread
 * (`threadId: null` is a new thread there).
 */
export type Selection =
  | { kind: "project"; projectId: string }
  | { kind: "thread"; repoId: string; threadId: string | null };

export type SettingsSection = "general" | "providers";

const firstHost = hosts[0]!;
// A host opens on a new thread in its first repository.
const newThreadIn = (host: Host, repoId = host.repositories[0]!.id): Selection => ({
  kind: "thread",
  repoId,
  threadId: null,
});

/**
 * The app frame: sidebar, then the chat or Settings, then the side panel.
 * Views are plain state, not routes: there is nothing to deep-link yet.
 */
export function App() {
  const [theme, setTheme] = useThemePreference();
  const [host, setHost] = useState(firstHost);
  const [selection, setSelection] = useState(() => newThreadIn(firstHost));
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);

  // The breadcrumb, and for a new thread the centered composer's heading. An
  // existing chat (a Project's, or a thread) docks the composer instead.
  let crumbs: string[];
  let heroHeading: string | null = null;
  let runId: string | undefined;
  if (selection.kind === "project") {
    crumbs = [host.name, host.projects.find((p) => p.id === selection.projectId)!.name];
  } else {
    const repo = host.repositories.find((r) => r.id === selection.repoId)!;
    const thread = repo.threads.find((t) => t.id === selection.threadId);
    crumbs = [host.name, repo.name, thread?.title ?? "New thread"];
    runId = thread?.runId;
    if (!thread)
      heroHeading = repo.scratch
        ? "What should we work on?"
        : `What should we build in ${repo.name}?`;
  }
  const newThread = () => {
    setSettings(null);
    setSelection(newThreadIn(host, selection.kind === "thread" ? selection.repoId : undefined));
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
              const next = hosts.find((h) => h.id === id)!;
              setHost(next);
              setSelection(newThreadIn(next));
            }}
            selection={selection}
            onSelect={setSelection}
            onOpenSettings={() => setSettings("general")}
            models={composerOptions.models}
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
            {runId ? (
              // Keyed, so another run starts from an empty transcript.
              <AgentChat key={`${host.id}/${runId}`} hostId={host.id} runId={runId} />
            ) : heroHeading === null ? (
              <>
                <div className="flex flex-1 items-center justify-center text-[13px] text-faint-foreground">
                  No messages yet
                </div>
                <div className="mx-auto w-full max-w-3xl px-6 pb-5">
                  <Composer newThread={{ localHost: host.local, options: composerOptions }} />
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[12vh]">
                <div className="w-full max-w-2xl">
                  <h1 className="mb-6 text-center text-[22px] font-medium tracking-tight">
                    {heroHeading}
                  </h1>
                  <Composer hero newThread={{ localHost: host.local, options: composerOptions }} />
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <SidePanel open={panelOpen && !settings} />
    </div>
  );
}
