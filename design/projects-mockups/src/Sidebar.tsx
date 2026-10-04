import { ChartColumn, LayoutGrid, Moon, PanelLeft, Plus, Search, Settings, SquarePen, Sun } from "lucide-react";
import { plainThreads } from "./data";
import { useStore } from "./store";
import { Kbd, Mark, ProjectIcon } from "./ui";

export function Sidebar() {
  const { route, go, projects, children, decisions, theme, setTheme } = useStore();
  const activeProject = route.name === "project" ? route.id : null;
  const activeThread = route.name === "thread" ? route.id : null;

  const live = (id: string) => {
    if (id !== "parallax") {
      const p = projects.find((x) => x.id === id);
      return { needs: p?.needs ?? 0, working: p?.working ?? 0 };
    }
    return {
      needs: decisions.filter((d) => !d.answer).length,
      working: children.filter((c) => c.status === "working" || c.status === "starting").length,
    };
  };

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__top titlebar">
        <span className="traffic" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Hide sidebar">
          <PanelLeft size={15} />
        </button>
      </div>

      <div className="sidebar__brand">
        <Mark size={18} />
        <span>Parallax</span>
      </div>

      <div className="sidebar__actions">
        <button type="button" className="side-row" onClick={() => go({ name: "thread", id: "t-updater" })}>
          <SquarePen size={15} aria-hidden />
          <span>New thread</span>
          <Kbd>{"⌘"}N</Kbd>
        </button>
        <button type="button" className="side-row">
          <Search size={15} aria-hidden />
          <span>Search</span>
          <Kbd>{"⌘"}K</Kbd>
        </button>
        <button
          type="button"
          className="side-row"
          aria-current={route.name === "projects" ? "page" : undefined}
          onClick={() => go({ name: "projects" })}
        >
          <LayoutGrid size={15} aria-hidden />
          <span>Projects</span>
        </button>
      </div>

      <div className="sidebar__scroll">
        <section aria-labelledby="side-projects">
          <header className="side-heading">
            <h2 id="side-projects">Projects</h2>
            <button type="button" className="icon-btn icon-btn--xs" aria-label="New project" onClick={() => go({ name: "projects" })}>
              <Plus size={14} />
            </button>
          </header>
          <ul>
            {projects.map((p) => {
              const s = live(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className="side-row side-row--project"
                    aria-current={activeProject === p.id ? "page" : undefined}
                    onClick={() => go({ name: "project", id: p.id, tab: "home" })}
                  >
                    <ProjectIcon color={p.color} name={p.name} size={18} />
                    <span className="truncate">{p.name}</span>
                    <span className="side-row__meta">
                      {s.working > 0 && <span className="pulse-dot" title={`${s.working} working`} />}
                      {s.needs > 0 && (
                        <span className="count-badge" title={`${s.needs} need you`}>
                          {s.needs}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="side-threads">
          <header className="side-heading">
            <h2 id="side-threads">Threads</h2>
          </header>
          <ul>
            {plainThreads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="side-row side-row--thread"
                  aria-current={activeThread === t.id ? "page" : undefined}
                  onClick={() => go({ name: "thread", id: t.id })}
                >
                  <span className="truncate">{t.title}</span>
                  <span className="side-row__meta faint">{t.working ? <span className="pulse-dot" title="Working" /> : t.age}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="sidebar__foot">
        <span className="avatar" aria-label="Ryan">
          R
        </span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Settings">
          <Settings size={15} />
        </button>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Usage">
          <ChartColumn size={15} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm push-end"
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </footer>
    </nav>
  );
}
