import { useMemo, useRef, useState } from "react";
import { ArrowUp, FileText, FlaskConical, Link2, Pencil, Plus, Trash2, TriangleAlert, Upload, Wand2, X } from "lucide-react";
import { boardNotes, history, knowledgeFiles, type MemoryEntry, type MemoryKind, type Project, type Scope } from "./data";
import { useStore } from "./store";
import { Popover, MenuItem } from "./ui";

const kinds: { id: MemoryKind; label: string; hint: string }[] = [
  { id: "preference", label: "Preferences", hint: "How you like things done" },
  { id: "convention", label: "Conventions", hint: "How this codebase works" },
  { id: "decision", label: "Decisions", hint: "What was decided and why" },
  { id: "gotcha", label: "Gotchas", hint: "Traps worth remembering" },
];

const scopes: { id: Scope; label: string; note: string }[] = [
  { id: "project", label: "Project", note: "Only this project" },
  { id: "repo", label: "Repo", note: "Every project and thread in this repo" },
  { id: "you", label: "You", note: "Everywhere you use Parallax" },
];

const sections = [
  { id: "k-brief", label: "Brief" },
  { id: "k-memory", label: "Memory" },
  { id: "k-notes", label: "Notes" },
  { id: "k-files", label: "Files" },
  { id: "k-history", label: "History" },
];

export function Knowledge({ project }: { project: Project }) {
  const s = useStore();
  const rich = project.id === "parallax";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<Scope | "all">("all");
  const entries = rich ? s.memory : [];
  const review = entries.filter((e) => e.proposed || e.stale);
  const settled = entries.filter((e) => !e.proposed && (scope === "all" || e.scope === scope));

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="knowledge">
      <nav className="knowledge__nav" aria-label="Knowledge sections">
        {sections.map((x) => (
          <button key={x.id} type="button" className="side-row" onClick={() => jump(x.id)}>
            <span>{x.label}</span>
            {x.id === "k-memory" && review.length > 0 && <span className="count-badge">{review.length}</span>}
          </button>
        ))}
        <p className="knowledge__note faint small">
          Everything a new thread in this project starts with. Threads get the brief and a one-line index of memory, and read the rest when they need it.
        </p>
      </nav>

      <div className="scroll" ref={scrollRef}>
        <div className="column column--knowledge">
          <Teach entries={entries} disabled={!rich} />

          <section id="k-brief" className="k-section">
            <header className="k-head">
              <h2>Brief</h2>
              <p className="faint small">Goal, scope and constraints. Every thread reads this first.</p>
            </header>
            <Brief initial={rich ? s.brief : project.brief} onSave={rich ? s.setBrief : () => undefined} />
            <dl className="settings-grid">
              <div>
                <dt>Autonomy</dt>
                <dd>
                  <Autonomy />
                </dd>
              </div>
              <div>
                <dt>Checks</dt>
                <dd>
                  <code>pnpm check &amp;&amp; scripts/ci/check-rust</code>
                  <span className="faint small"> found in AGENTS.md</span>
                </dd>
              </div>
              <div>
                <dt>Base branch</dt>
                <dd>
                  <code>{project.base}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section id="k-memory" className="k-section">
            <header className="k-head k-head--row">
              <div>
                <h2>Memory</h2>
                <p className="faint small">Short facts that stay true. Threads propose them; you and the coordinator keep them tidy.</p>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Scope">
                {(["all", "project", "repo", "you"] as const).map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={scope === x} onClick={() => setScope(x)}>
                    {x === "all" ? "All" : scopes.find((y) => y.id === x)?.label}
                  </button>
                ))}
              </div>
            </header>

            {review.length > 0 && (
              <div className="review-box">
                <h3 className="review-box__title">To review</h3>
                <ul>
                  {review.map((e) => (
                    <li key={e.id} className="review-item">
                      {e.stale ? <TriangleAlert size={14} aria-hidden className="tone-warning" /> : <Plus size={14} aria-hidden className="tone-accent" />}
                      <div className="grow">
                        <p>{e.text}</p>
                        <p className="faint small">{e.stale ? e.stale : `Proposed by ${e.source} · ${e.date}`}</p>
                      </div>
                      <span className="row__actions">
                        <button type="button" className="btn btn--ghost btn--xs" onClick={() => s.memoryOps.remove(e.id)}>
                          {e.stale ? "Remove" : "Dismiss"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--soft btn--xs"
                          onClick={() => (e.stale ? s.memoryOps.edit(e.id, "Use Vitest (via vp test) for renderer unit tests.") : s.memoryOps.accept(e.id))}
                        >
                          {e.stale ? "Fix it" : "Keep"}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {kinds.map((k) => {
              const items = settled.filter((e) => e.kind === k.id && !e.stale);
              if (!items.length) return null;
              return (
                <div key={k.id} className="mem-group">
                  <h3 className="mem-group__title">
                    {k.label} <span className="faint">{k.hint}</span>
                  </h3>
                  <ul className="mem-list">
                    {items.map((e) => (
                      <Entry key={e.id} entry={e} />
                    ))}
                  </ul>
                </div>
              );
            })}
            {entries.length === 0 && <p className="empty-line">No memory yet. Threads propose lasting facts as they work, and you can add your own above.</p>}
          </section>

          <section id="k-notes" className="k-section">
            <header className="k-head">
              <h2>Notes</h2>
              <p className="faint small">The coordinator's running board. Updated 5 minutes ago.</p>
            </header>
            {rich ? (
              <div className="board">
                {boardNotes.map((b) => (
                  <div key={b.heading}>
                    <h3>{b.heading}</h3>
                    <ul>
                      {b.items.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-line">The coordinator starts a board here once work begins.</p>
            )}
          </section>

          <section id="k-files" className="k-section">
            <header className="k-head">
              <h2>Files</h2>
              <p className="faint small">Longer write-ups threads can read on request: research, plans, test instructions.</p>
            </header>
            <ul className="files">
              {(rich ? knowledgeFiles : []).map((f) => {
                const Icon = f.kind === "research" ? FlaskConical : f.kind === "link" ? Link2 : FileText;
                return (
                  <li key={f.id}>
                    <button type="button" className="file-card">
                      <Icon size={16} aria-hidden className="faint" />
                      <span className="stack grow">
                        <span>{f.name}</span>
                        <span className="faint small">{f.summary}</span>
                      </span>
                      <span className="faint small">{f.size}</span>
                    </button>
                  </li>
                );
              })}
              <li>
                <button type="button" className="file-card file-card--add" onClick={() => s.toast("Mockup: drop files here to add them.")}>
                  <Upload size={16} aria-hidden />
                  Add files or links
                </button>
              </li>
            </ul>
          </section>

          <section id="k-history" className="k-section">
            <header className="k-head">
              <h2>History</h2>
              <p className="faint small">One line per finished thread. The coordinator searches this before repeating work.</p>
            </header>
            <ul className="rows">
              {(rich ? history : []).map((h) => (
                <li key={h.title} className="row">
                  <div className="row__body">
                    <p>
                      {h.title} <span className={`pill pill--xs ${h.outcome === "Failed" ? "tone-danger" : "tone-muted"}`}>{h.outcome}</span>
                    </p>
                    <p className="faint small">{h.learned}</p>
                  </div>
                  <span className="faint small">{h.when}</span>
                </li>
              ))}
            </ul>
            {!rich && <p className="empty-line">Nothing finished yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function Teach({ entries, disabled }: { entries: MemoryEntry[]; disabled: boolean }) {
  const s = useStore();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ replace: MemoryEntry | null; entry: MemoryEntry } | null>(null);
  const [thinking, setThinking] = useState(false);

  const propose = () => {
    const t = text.trim();
    if (!t) return;
    setThinking(true);
    window.setTimeout(() => {
      const words = t.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const replace = entries.find((e) => words.some((w) => e.text.toLowerCase().includes(w))) ?? null;
      // "we moved off Jest, use Vitest" rewrites the matching entry rather than pasting the words in.
      const from = /\boff ([\w.-]+)/i.exec(t)?.[1];
      const to = /\buse ([\w.-]+)/i.exec(t)?.[1];
      const sentence =
        replace && from && to && replace.text.includes(from)
          ? replace.text.replace(from, to)
          : t.charAt(0).toUpperCase() + t.slice(1).replace(/[.]?$/, ".");
      setPreview({
        replace,
        entry: {
          id: `m-${Date.now()}`,
          kind: replace?.kind ?? "convention",
          text: sentence,
          source: "You",
          date: "Today",
          scope: replace?.scope ?? "repo",
          fresh: true,
        },
      });
      setThinking(false);
    }, 900);
  };

  const affected = useMemo(() => (preview ? s.children.filter((c) => c.status === "working").slice(0, 2) : []), [preview, s.children]);

  return (
    <div className="teach">
      <form
        className="teach__box"
        onSubmit={(e) => {
          e.preventDefault();
          propose();
        }}
      >
        <Wand2 size={15} aria-hidden className="faint" />
        <label className="sr-only" htmlFor="teach">
          Tell it what to remember or change
        </label>
        <input
          id="teach"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          placeholder='Tell it what to remember or change, like "we moved off Jest, use Vitest"'
        />
        <button type="submit" className="send send--sm" disabled={!text.trim() || thinking} aria-label="Preview change">
          <ArrowUp size={14} strokeWidth={2.4} />
        </button>
      </form>
      {thinking && <p className="thinking small teach__status">Checking memory for related entries</p>}
      {preview && (
        <div className="teach__preview" role="region" aria-label="Proposed change">
          <p className="small faint">{preview.replace ? "Replaces one entry" : "Adds one entry"}</p>
          {preview.replace && <p className="diff-line diff-line--del">{preview.replace.text}</p>}
          <p className="diff-line diff-line--add">{preview.entry.text}</p>
          {affected.length > 0 && (
            <p className="small faint">
              Also tells {affected.length} running thread{affected.length > 1 ? "s" : ""}: {affected.map((c) => c.title).join(", ")}.
            </p>
          )}
          <div className="teach__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setPreview(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                s.memoryOps.apply(preview.replace?.id ?? null, preview.entry);
                setPreview(null);
                setText("");
                s.toast("Memory updated");
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Brief({ initial, onSave }: { initial: string; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  if (editing)
    return (
      <div className="brief-edit">
        <textarea className="input input--area" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
        <div className="teach__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            Save brief
          </button>
        </div>
      </div>
    );
  return (
    <div className="brief">
      <p>{initial}</p>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Edit brief" onClick={() => setEditing(true)}>
        <Pencil size={14} />
      </button>
    </div>
  );
}

function Autonomy() {
  const [level, setLevel] = useState("Routine");
  const notes: Record<string, string> = {
    "Ask me": "Every question comes to you.",
    Routine: "Answers what memory or the code settles.",
    Full: "Answers anything it can justify.",
  };
  return (
    <span className="autonomy">
      <span className="segmented" role="radiogroup" aria-label="Autonomy">
        {Object.keys(notes).map((l) => (
          <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => setLevel(l)}>
            {l}
          </button>
        ))}
      </span>
      <span className="faint small">{notes[level]} Pushing, merging and deleting always ask.</span>
    </span>
  );
}

function Entry({ entry }: { entry: MemoryEntry }) {
  const s = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const scope = scopes.find((x) => x.id === entry.scope)!;

  return (
    <li className={`mem${entry.fresh ? " is-fresh" : ""}`}>
      {editing ? (
        <form
          className="mem__edit"
          onSubmit={(e) => {
            e.preventDefault();
            s.memoryOps.edit(entry.id, draft);
            setEditing(false);
          }}
        >
          <input className="input" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <button type="submit" className="btn btn--primary btn--xs">
            Save
          </button>
          <button type="button" className="icon-btn icon-btn--xs" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X size={13} />
          </button>
        </form>
      ) : (
        <>
          <div className="mem__body">
            <p>{entry.text}</p>
            <p className="mem__meta">
              {entry.source} · {entry.date}
            </p>
          </div>
          <Popover
            label="Scope"
            align="end"
            width={250}
            trigger={(open, toggle) => (
              <button type="button" className={`scope scope--${entry.scope}`} aria-expanded={open} onClick={toggle} title={scope.note}>
                {scope.label}
              </button>
            )}
          >
            {(close) => (
              <div className="menu">
                <div className="menu__label">Applies to</div>
                {scopes.map((x) => (
                  <MenuItem
                    key={x.id}
                    selected={x.id === entry.scope}
                    onSelect={() => {
                      s.memoryOps.scope(entry.id, x.id);
                      close();
                    }}
                  >
                    <span className="stack">
                      <span>{x.label}</span>
                      <span className="faint small">{x.note}</span>
                    </span>
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
          <span className="mem__actions">
            <button type="button" className="icon-btn icon-btn--xs" aria-label="Edit" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </button>
            <button type="button" className="icon-btn icon-btn--xs" aria-label="Delete" onClick={() => s.memoryOps.remove(entry.id)}>
              <Trash2 size={13} />
            </button>
          </span>
        </>
      )}
    </li>
  );
}
