import { useState } from "react";
import { CircleCheck, GitBranch, GitMerge, GitPullRequest, Layers } from "lucide-react";
import { combinedFiles, type Project } from "./data";
import { useStore } from "./store";
import { Diffstat, StatusGlyph } from "./ui";

export function Ship({ project, landedCount }: { project: Project; landedCount: number }) {
  const s = useStore();
  const rich = project.id === "parallax";
  const [prOpen, setPrOpen] = useState(false);
  const [shape, setShape] = useState<"one" | "stack">("one");
  const queue = rich ? s.children.filter((c) => c.status === "review") : [];
  const finishing = rich ? s.children.filter((c) => c.status === "working" || c.status === "needs") : [];
  const landed = rich ? s.landed : [];
  const add = landed.reduce((n, l) => n + l.add, 0);
  const del = landed.reduce((n, l) => n + l.del, 0);
  const max = Math.max(...combinedFiles.map((f) => f.add + f.del));

  return (
    <div className="scroll">
      <div className="column column--wide">
        <header className="ship-head">
          <div className="ship-head__branch">
            <span className="ship-head__icon">
              <GitBranch size={18} aria-hidden />
            </span>
            <div>
              <h2>parallax/projects-m4</h2>
              <p className="ship-head__sub">
                <span className="faint">From {project.base}</span>
                <span className="faint">{landedCount} landed</span>
                <span className="ship-head__checks">
                  <CircleCheck size={13} aria-hidden className="tone-added" />
                  Checks passing
                </span>
                <Diffstat add={add} del={del} />
              </p>
            </div>
          </div>
          <div className="ship-head__actions">
            <button type="button" className="btn btn--ghost btn--sm">
              <Layers size={14} aria-hidden />
              Combined diff
            </button>
            <button type="button" className="btn btn--primary btn--sm" disabled={!landedCount} onClick={() => setPrOpen(!prOpen)}>
              <GitPullRequest size={14} aria-hidden />
              Open pull request
            </button>
          </div>
        </header>

        {prOpen && (
          <section className="pr-draft" aria-label="Pull request draft">
            <div className="segmented" role="radiogroup" aria-label="Shape">
              <button type="button" role="radio" aria-checked={shape === "one"} onClick={() => setShape("one")}>
                One pull request
              </button>
              <button type="button" role="radio" aria-checked={shape === "stack"} onClick={() => setShape("stack")}>
                A stack, one per task
              </button>
            </div>
            <label className="field">
              <span className="small faint">Title</span>
              <input className="input" defaultValue="feat: Projects inbox, instant dispatch and brief editor (PLX-78)" />
            </label>
            <label className="field">
              <span className="small faint">Description, written by the coordinator</span>
              <textarea
                className="input input--area input--tall"
                defaultValue={`Before: each child ended as its own branch, and you merged them by hand.\n\nAfter: finished children land on one project branch after review. This PR carries ${landed.length} tasks:\n${landed.map((l) => `- ${l.title}`).join("\n")}`}
              />
            </label>
            <div className="teach__actions">
              <span className="faint small grow">Targets {project.base}. Nothing is pushed until you confirm.</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPrOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  setPrOpen(false);
                  s.toast(shape === "one" ? "Mockup: draft PR opened against develop." : `Mockup: ${landed.length} stacked draft PRs opened.`);
                }}
              >
                Create draft
              </button>
            </div>
          </section>
        )}

        <section className="k-section">
          <header className="k-head">
            <h2>Ready to land</h2>
            <p className="faint small">Reviewed by the coordinator. Each lands as one commit, then checks run on the project branch.</p>
          </header>
          {queue.length === 0 && <p className="empty-line">Nothing waiting. Finished threads appear here after review.</p>}
          <ul className="rows rows--boxed">
            {queue.map((c) => (
              <li key={c.id} className="row">
                <StatusGlyph status={c.status} />
                <div className="row__body">
                  <p>{c.title}</p>
                  {s.landing === c.id ? (
                    <div className="progress" aria-label="Landing">
                      <span />
                    </div>
                  ) : (
                    <p className="faint small">{c.summary}</p>
                  )}
                </div>
                <Diffstat add={c.add} del={c.del} />
                <button type="button" className="btn btn--soft btn--sm" disabled={s.landing === c.id} onClick={() => s.land(c.id)}>
                  <GitMerge size={14} aria-hidden />
                  {s.landing === c.id ? "Running checks" : "Land"}
                </button>
              </li>
            ))}
          </ul>
          {finishing.length > 0 && (
            <p className="faint small after-list">
              Still working: {finishing.slice(0, 3).map((c) => c.title).join(", ")}
              {finishing.length > 3 ? `, and ${finishing.length - 3} more` : ""}.
            </p>
          )}
        </section>

        <section className="k-section">
          <header className="k-head">
            <h2>Landed</h2>
          </header>
          <ol className="commits">
            {[...landed].reverse().map((l) => (
              <li key={l.sha} className="commit">
                <span className="commit__dot" aria-hidden />
                <code className="faint">{l.sha}</code>
                <button type="button" className="link-plain grow truncate" onClick={() => s.openChild(l.childId)}>
                  {l.title}
                </button>
                <Diffstat add={l.add} del={l.del} />
                <span className="faint small">{l.when}</span>
              </li>
            ))}
            {landed.length === 0 && <li className="empty-line">Nothing has landed yet.</li>}
          </ol>
        </section>

        {rich && (
          <section className="k-section">
            <header className="k-head">
              <h2>Changed files</h2>
            </header>
            <ul className="filebars">
              {combinedFiles.map((f) => (
                <li key={f.path}>
                  <code className="truncate">{f.path}</code>
                  <span className="filebar" aria-hidden>
                    <span className="filebar__add" style={{ width: `${(f.add / max) * 100}%` }} />
                    <span className="filebar__del" style={{ width: `${(f.del / max) * 100}%` }} />
                  </span>
                  <Diffstat add={f.add} del={f.del} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
