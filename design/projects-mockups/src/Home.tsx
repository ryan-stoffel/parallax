import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, ChevronRight, CornerDownRight, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { accountName, accountProvider, type Child, type Decision, type Project } from "./data";
import { Composer } from "./Composer";
import { useStore } from "./store";
import { Diffstat, ProviderLogo, StatusGlyph } from "./ui";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home({ project }: { project: Project }) {
  const s = useStore();
  const rich = project.id === "parallax";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && s.chat.length > 2) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [s.chat]);

  const onSubmit = (text: string, mode: "task" | "ask") => (mode === "task" ? s.startChild(text) : s.ask(text));

  return (
    <div className={`home${s.railOpen ? " has-rail" : ""}`}>
      <div className="home__main">
        <div className="scroll" ref={scrollRef}>
          <div className="column">{rich ? <Digest /> : <EmptyHome project={project} />}</div>
          {rich && (
            <div className="column">
              <div className="divider">
                <span>Coordinator</span>
              </div>
              <ol className="chat">
                {s.chat.map((m) => (
                  <li key={m.id} className={`msg msg--${m.role}`}>
                    {m.role === "user" ? (
                      <p className="bubble">{m.text}</p>
                    ) : m.thinking ? (
                      <p className="thinking">Thinking</p>
                    ) : (
                      <p>{m.text}</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <div className="composer-dock">
          <Composer variant="project" onSubmit={onSubmit} />
        </div>
      </div>
      {s.railOpen && <Rail rich={rich} project={project} />}
    </div>
  );
}

function Digest() {
  const s = useStore();
  const kids = s.children;
  const open = s.decisions.filter((d) => !d.answer);
  const answered = s.decisions.filter((d) => d.answer);
  const working = kids.filter((c) => c.status === "working" || c.status === "starting").length;
  const landedToday = kids.filter((c) => c.status === "landed").length;
  const ready = kids.filter((c) => c.status === "review").length;
  const failed = kids.filter((c) => c.status === "failed");
  const learned = s.memory.filter((m) => m.fresh || m.proposed);
  const goTab = (tab: "threads" | "knowledge" | "ship") => s.go({ name: "project", id: "parallax", tab });

  const summary =
    open.length > 0
      ? `While you were away, ${landedToday} threads landed and ${working} are still working. ${open.length === 1 ? "One question needs" : `${open.length} questions need`} you.`
      : `You're caught up. ${working} threads are working and nothing needs you.`;

  return (
    <>
      <header className="hero">
        <p className="eyebrow">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
        <h2 className="hero__title">{greeting()}, Ryan.</h2>
        <p className="hero__summary">{summary}</p>
        <div className="stat-row">
          <button type="button" className="stat" onClick={() => goTab("threads")}>
            <strong>{working}</strong> working
          </button>
          <button type="button" className="stat" onClick={() => goTab("ship")}>
            <strong>{ready}</strong> ready to land
          </button>
          <button type="button" className="stat" onClick={() => goTab("ship")}>
            <strong>{landedToday}</strong> landed today
          </button>
          {failed.length > 0 && (
            <button type="button" className="stat stat--danger" onClick={() => s.openChild(failed[0].id)}>
              <strong>{failed.length}</strong> failed
            </button>
          )}
        </div>
      </header>

      {!s.digestOpen ? (
        <button type="button" className="digest-collapsed" onClick={() => s.setDigestOpen(true)}>
          <Check size={14} aria-hidden />
          Inbox read. {s.autoDecisions.length} decided for you, {learned.length} learned.
          <span className="link">Show</span>
        </button>
      ) : (
        <>
          <section className="inbox-section" aria-labelledby="needs-you">
            <header className="section-head">
              <h3 id="needs-you">Needs you</h3>
              <span className="count">{open.length}</span>
            </header>
            {open.length === 0 && <p className="empty-line">Nothing is waiting on you.</p>}
            <ul className="stack-list">
              {open.map((d) => (
                <li key={d.id}>
                  <DecisionCard decision={d} />
                </li>
              ))}
              {answered.map((d) => (
                <li key={d.id} className="answered">
                  <Check size={14} aria-hidden className="tone-added" />
                  <span className="grow truncate">
                    <span className="faint">{d.question}</span> <strong>{d.answer}</strong>
                  </span>
                  {s.landing !== d.childId && (
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => s.undoAnswer(d.id)}>
                      <Undo2 size={12} aria-hidden />
                      Undo
                    </button>
                  )}
                  {s.landing === d.childId && <span className="faint small thinking">Landing</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="inbox-section" aria-labelledby="decided">
            <header className="section-head">
              <h3 id="decided">Decided for you</h3>
              <span className="count">{s.autoDecisions.length}</span>
              <span className="section-head__note">Autonomy: Routine</span>
            </header>
            <ul className="rows">
              {s.autoDecisions.map((a) => {
                const c = kids.find((k) => k.id === a.childId);
                return (
                  <li key={a.id} className="row">
                    <CornerDownRight size={14} aria-hidden className="faint row__icon" />
                    <div className="row__body">
                      <p className={a.changed ? "struck" : undefined}>{a.chose}</p>
                      {a.changed ? (
                        <p className="small tone-accent">Changed to: {a.alternative}. The thread has been told.</p>
                      ) : (
                        <p className="faint small">{a.because}</p>
                      )}
                    </div>
                    <button type="button" className="row__thread" onClick={() => c && s.openChild(c.id)}>
                      {c?.title}
                    </button>
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => s.changeAuto(a.id)}>
                      {a.changed ? <RotateCcw size={12} aria-hidden /> : null}
                      {a.changed ? "Revert" : "Change"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="inbox-section" aria-labelledby="learned">
            <header className="section-head">
              <h3 id="learned">Learned</h3>
              <span className="count">{learned.length}</span>
              <button type="button" className="link section-head__note" onClick={() => goTab("knowledge")}>
                Open Knowledge
                <ArrowRight size={12} aria-hidden />
              </button>
            </header>
            <ul className="rows">
              {learned.map((m) => (
                <li key={m.id} className="row">
                  <BookOpen size={14} aria-hidden className="faint row__icon" />
                  <div className="row__body">
                    <p>{m.text}</p>
                    <p className="faint small">
                      {m.proposed ? "Proposed by" : "Added from"} {m.source}
                    </p>
                  </div>
                  {m.proposed ? (
                    <span className="row__actions">
                      <button type="button" className="btn btn--ghost btn--xs" onClick={() => s.memoryOps.remove(m.id)}>
                        Dismiss
                      </button>
                      <button type="button" className="btn btn--soft btn--xs" onClick={() => s.memoryOps.accept(m.id)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <span className="pill tone-added">Saved</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="digest-foot">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.setDigestOpen(false)}>
              <Check size={14} aria-hidden />
              Mark inbox as read
            </button>
          </div>
        </>
      )}
    </>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  const s = useStore();
  const child = s.children.find((c) => c.id === decision.childId);
  const [choice, setChoice] = useState(decision.options.find((o) => o.recommended)?.label ?? decision.options[0].label);
  const [custom, setCustom] = useState<string | null>(null);

  return (
    <article className="decision">
      <header className="decision__head">
        {child && (
          <button type="button" className="thread-chip" onClick={() => s.openChild(child.id)}>
            <StatusGlyph status={child.status} size={12} />
            {child.title}
          </button>
        )}
        <span className="faint small">{decision.asked}</span>
      </header>
      <h4 className="decision__q">{decision.question}</h4>
      <p className="decision__ctx">{decision.context}</p>
      <fieldset className="options">
        <legend className="sr-only">{decision.question}</legend>
        {decision.options.map((o) => (
          <label key={o.label} className={`option${choice === o.label && custom === null ? " is-picked" : ""}`}>
            <input
              type="radio"
              name={decision.id}
              checked={choice === o.label && custom === null}
              onChange={() => {
                setChoice(o.label);
                setCustom(null);
              }}
            />
            <span className="option__body">
              <span className="option__label">
                {o.label}
                {o.recommended && <span className="pill pill--xs tone-accent">Recommended</span>}
              </span>
              <span className="faint small">{o.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {custom !== null && (
        <textarea
          className="input input--area"
          placeholder="Answer in your own words"
          value={custom}
          autoFocus
          onChange={(e) => setCustom(e.target.value)}
        />
      )}
      <footer className="decision__foot">
        <button type="button" className="link small" onClick={() => setCustom(custom === null ? "" : null)}>
          {custom === null ? "Answer in your own words" : "Pick an option instead"}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={custom !== null && !custom.trim()}
          onClick={() => s.answer(decision.id, custom?.trim() || choice)}
        >
          {decision.id === "d-pr" && custom === null && choice === "Land it" ? "Land" : "Send answer"}
        </button>
      </footer>
    </article>
  );
}

function Rail({ rich, project }: { rich: boolean; project: Project }) {
  const s = useStore();
  const kids = rich ? s.children : [];
  const groups: { label: string; items: Child[] }[] = [
    { label: "Needs you", items: kids.filter((c) => c.status === "needs" || c.status === "failed") },
    { label: "Working", items: kids.filter((c) => c.status === "working" || c.status === "starting" || c.status === "queued") },
    { label: "Ready to land", items: kids.filter((c) => c.status === "review") },
    { label: "Landed", items: kids.filter((c) => c.status === "landed") },
  ];
  const memoryCount = rich ? s.memory.filter((m) => !m.proposed).length : 0;
  const pending = rich ? s.memory.filter((m) => m.proposed).length : 0;

  return (
    <aside className="rail" aria-label="Threads in this project">
      <div className="rail__scroll">
        {kids.length === 0 && (
          <div className="rail-empty">
            <Sparkles size={16} aria-hidden className="faint" />
            <p>Threads you start here show up in this panel, grouped by what they need.</p>
          </div>
        )}
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <section key={g.label} className="rail__group">
                <h3 className="rail__label">
                  {g.label} <span className="faint">{g.items.length}</span>
                </h3>
                <ul>
                  {g.items.map((c) => (
                    <li key={c.id}>
                      <button type="button" className={`rail-item${c.status === "starting" ? " is-new" : ""}`} onClick={() => s.openChild(c.id)}>
                        <StatusGlyph status={c.status} />
                        <span className="rail-item__body">
                          <span className="rail-item__title truncate">{c.title}</span>
                          <span className="rail-item__meta truncate">
                            {c.status === "working" || c.status === "starting" ? (
                              <span className="shimmer">{c.status === "starting" ? "Starting" : c.steps[c.step]}</span>
                            ) : c.status === "queued" ? (
                              c.queueReason
                            ) : (
                              c.summary
                            )}
                          </span>
                        </span>
                        <span className="rail-item__side">
                          <span className="host-tag" title={`${c.host}, ${accountName(c.account)}`}>
                            <ProviderLogo provider={accountProvider(c.account)} size={11} />
                            {c.host}
                          </span>
                          <Diffstat add={c.add} del={c.del} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ),
        )}
      </div>
      <button type="button" className="rail-card" onClick={() => s.go({ name: "project", id: project.id, tab: "knowledge" })}>
        <span className="rail-card__head">
          <BookOpen size={14} aria-hidden />
          Knowledge
          <ChevronRight size={14} aria-hidden className="faint push-end" />
        </span>
        <span className="rail-card__text">{rich ? s.brief : project.brief}</span>
        <span className="faint small">
          {memoryCount} memories{pending > 0 ? `, ${pending} to review` : ""}
        </span>
      </button>
    </aside>
  );
}

function EmptyHome({ project }: { project: Project }) {
  const s = useStore();
  const ideas =
    project.id === "docs-site"
      ? ["Write the hosts page from docs/decisions/0009", "Add screenshots of the new composer", "Check every link in the getting started guide"]
      : ["Run the 20-child dispatch benchmark on all three hosts", "Graph memory use per child over an hour", "Compare dispatch latency with and without the coordinator"];
  return (
    <>
      <header className="hero">
        <p className="eyebrow">{project.repo}</p>
        <h2 className="hero__title">{project.name}</h2>
        <p className="hero__summary">{project.brief}</p>
      </header>
      <section className="inbox-section">
        <header className="section-head">
          <h3>Needs you</h3>
          <span className="count">0</span>
        </header>
        <p className="empty-line">Nothing is waiting on you. Start a few threads and walk away; questions and results collect here.</p>
      </section>
      <section className="inbox-section">
        <header className="section-head">
          <h3>Try</h3>
        </header>
        <ul className="ideas">
          {ideas.map((i) => (
            <li key={i}>
              <button type="button" className="idea" onClick={() => s.toast("Mockup: this would start a thread with that prompt.")}>
                <Sparkles size={14} aria-hidden className="faint" />
                {i}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
