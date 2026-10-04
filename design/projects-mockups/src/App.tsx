import { useState } from "react";
import { ChevronRight, Code2, Folder, X } from "lucide-react";
import { Composer } from "./Composer";
import { plainThreads } from "./data";
import { ProjectsIndex } from "./ProjectsIndex";
import { ProjectView } from "./ProjectView";
import { Sidebar } from "./Sidebar";
import { useStore } from "./store";

export function App() {
  const { route, toasts, dismissToast } = useStore();
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {route.name === "projects" && <ProjectsIndex />}
        {route.name === "project" && <ProjectView key={route.id} id={route.id} tab={route.tab} child={route.child} />}
        {route.name === "thread" && <PlainThread key={route.id} id={route.id} />}
      </main>
      <ol className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <li key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  t.action?.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-btn icon-btn--xs" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

// A plain thread, outside any project, to show the same composer and header there.
function PlainThread({ id }: { id: string }) {
  const t = plainThreads.find((x) => x.id === id) ?? plainThreads[0];
  const [messages, setMessages] = useState<{ role: "user" | "agent"; text: string }[]>([
    { role: "user", text: "Hi" },
    {
      role: "agent",
      text: "Hi Ryan. Nothing is in progress: there are no agent runs and develop has no uncommitted changes apart from .claude/worktrees/. What should we work on?",
    },
  ]);
  return (
    <div className="page">
      <header className="topbar titlebar">
        <div className="topbar__title crumbs">
          <span className="faint">macbook</span>
          <ChevronRight size={13} aria-hidden className="faint" />
          <Folder size={14} aria-hidden className="faint" />
          <span className="faint">parallax</span>
          <ChevronRight size={13} aria-hidden className="faint" />
          <h1>{t.title}</h1>
        </div>
        <div className="topbar__end">
          <button type="button" className="btn btn--ghost btn--sm">
            <Code2 size={14} aria-hidden />
            Open
          </button>
        </div>
      </header>
      <div className="thread-page">
        <div className="scroll">
          <div className="column">
            <ol className="chat chat--top">
              {messages.map((m, i) => (
                <li key={i} className={`msg msg--${m.role === "user" ? "user" : "coordinator"}`}>
                  {m.role === "user" ? <p className="bubble">{m.text}</p> : <p>{m.text}</p>}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="composer-dock">
          <Composer
            variant="thread"
            autoFocus
            onSubmit={(text) => {
              setMessages((m) => [...m, { role: "user", text }]);
              window.setTimeout(
                () => setMessages((m) => [...m, { role: "agent", text: "On it. I'll read the updater first and send a plan before changing anything." }]),
                900,
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}
