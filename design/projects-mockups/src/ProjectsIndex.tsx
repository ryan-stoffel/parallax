import { useEffect, useRef, useState } from "react";
import { FolderGit2, Layers, Plus, Search } from "lucide-react";
import { plainThreads } from "./data";
import { useStore } from "./store";
import { ProjectIcon } from "./ui";

export function ProjectsIndex() {
  const s = useStore();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | "new" | "threads">(null);
  const shown = s.projects.filter((p) => p.name.includes(query.toLowerCase()) || p.brief.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page">
      <header className="topbar titlebar">
        <div className="topbar__title">
          <h1>Projects</h1>
        </div>
      </header>
      <div className="scroll">
        <div className="column column--wide">
          <header className="index-head">
            <div>
              <h2 className="hero__title">Projects</h2>
              <p className="hero__summary">A coordinator, its threads, and what they know, kept together for one body of work.</p>
            </div>
            <div className="index-head__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog("threads")}>
                <Layers size={14} aria-hidden />
                From threads
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setDialog("new")}>
                <Plus size={14} aria-hidden />
                New project
              </button>
            </div>
          </header>
          <label className="search search--wide">
            <Search size={14} aria-hidden />
            <span className="sr-only">Search projects</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" />
          </label>
          <ul className="project-grid">
            {shown.map((p) => {
              const needs = p.id === "parallax" ? s.decisions.filter((d) => !d.answer).length : p.needs;
              const working = p.id === "parallax" ? s.children.filter((c) => c.status === "working" || c.status === "starting").length : p.working;
              return (
                <li key={p.id}>
                  <button type="button" className="project-card" onClick={() => s.go({ name: "project", id: p.id, tab: "home" })}>
                    <span className="project-card__top">
                      <ProjectIcon color={p.color} name={p.name} size={28} />
                      <span className="stack grow">
                        <span className="project-card__name">{p.name}</span>
                        <span className="faint small truncate">{p.repo}</span>
                      </span>
                      <span className="faint small">{p.updated}</span>
                    </span>
                    <span className="project-card__brief">{p.brief}</span>
                    <span className="project-card__foot">
                      {needs > 0 && <span className="pill tone-accent">{needs} need you</span>}
                      {working > 0 && (
                        <span className="pill tone-working">
                          <span className="pulse-dot" aria-hidden />
                          {working} working
                        </span>
                      )}
                      {needs === 0 && working === 0 && <span className="pill tone-muted">Idle</span>}
                      <span className="faint small push-end">{p.done} done</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {dialog && <NewProject fromThreads={dialog === "threads"} onClose={() => setDialog(null)} />}
    </div>
  );
}

function NewProject({ fromThreads, onClose }: { fromThreads: boolean; onClose: () => void }) {
  const s = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(fromThreads ? "updater-polish" : "");
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<string[]>(fromThreads ? ["t-updater", "t-onboard"] : []);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const create = () => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "untitled";
    s.addProject({
      id,
      name: id,
      color: "orange",
      repo: "~/Developer/personal/parallax",
      base: "develop",
      brief: brief.trim() || (picked.length ? "The coordinator is reading the selected threads and will draft a brief." : "No brief yet."),
      updated: "now",
      needs: 0,
      working: picked.length,
      done: 0,
    });
    onClose();
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="np-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <h2 id="np-title">{fromThreads ? "Make a project from threads" : "New project"}</h2>
        <p className="faint small">
          {fromThreads
            ? "The threads move in with their history. The coordinator reads them and drafts the brief."
            : "Pick a repository and say what the project is for. You can change all of this later."}
        </p>
        <label className="field">
          <span className="small faint">Name</span>
          <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="projects-m4" />
        </label>
        <label className="field">
          <span className="small faint">Repository</span>
          <span className="input input--static">
            <FolderGit2 size={14} aria-hidden className="faint" />
            ~/Developer/personal/parallax
          </span>
        </label>
        {fromThreads ? (
          <fieldset className="field">
            <legend className="small faint">Threads to bring in</legend>
            <ul className="checklist">
              {plainThreads.map((t) => (
                <li key={t.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.includes(t.id)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))}
                    />
                    {t.title}
                    <span className="faint small push-end">{t.age}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : (
          <label className="field">
            <span className="small faint">Brief</span>
            <textarea
              className="input input--area"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Goal, scope and anything every thread should know"
            />
          </label>
        )}
        <div className="teach__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim() || (fromThreads && picked.length === 0)}>
            Create project
          </button>
        </div>
      </form>
    </dialog>
  );
}
