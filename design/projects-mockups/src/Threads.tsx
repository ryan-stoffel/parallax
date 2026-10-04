import { useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  FileCode2,
  FilePlus2,
  GitBranch,
  GitMerge,
  Lightbulb,
  RotateCcw,
  Search,
  SquareTerminal,
  Eye,
} from "lucide-react";
import { accountName, accountProvider, type Child, type Project, type TranscriptItem } from "./data";
import { Composer } from "./Composer";
import { useStore } from "./store";
import { Diffstat, ProviderLogo, StatusGlyph, StatusPill } from "./ui";

type Filter = "all" | "attention" | "running" | "done";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
];

const match = (f: Filter, c: Child) =>
  f === "all" ||
  (f === "attention" && (c.status === "needs" || c.status === "failed")) ||
  (f === "running" && (c.status === "working" || c.status === "starting" || c.status === "queued")) ||
  (f === "done" && (c.status === "review" || c.status === "landed"));

export function Threads({ project, selected }: { project: Project; selected?: string }) {
  const s = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const kids = project.id === "parallax" ? s.children : [];
  const shown = kids.filter((c) => match(filter, c) && c.title.toLowerCase().includes(query.toLowerCase()));
  const current = kids.find((c) => c.id === selected) ?? null;

  if (kids.length === 0)
    return (
      <div className="empty-page">
        <h2>No threads yet</h2>
        <p className="faint">Start one from Home. Each task gets its own worktree and runs on whichever host has room.</p>
        <button type="button" className="btn btn--soft btn--sm" onClick={() => s.go({ name: "project", id: project.id, tab: "home" })}>
          Go to Home
        </button>
      </div>
    );

  return (
    <div className="threads">
      <div className="threads__list">
        <div className="threads__tools">
          <label className="search">
            <Search size={14} aria-hidden />
            <span className="sr-only">Filter threads</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter threads" />
          </label>
          <div className="segmented" role="radiogroup" aria-label="Show">
            {filters.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="thread-list">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="thread-row"
                aria-current={current?.id === c.id ? "true" : undefined}
                onClick={() => s.openChild(c.id)}
              >
                <StatusGlyph status={c.status} />
                <span className="thread-row__body">
                  <span className="thread-row__title truncate">{c.title}</span>
                  <span className="thread-row__meta truncate">
                    {c.status === "working" || c.status === "starting" ? <span className="shimmer">{c.steps[c.step]}</span> : c.queueReason ?? c.summary}
                  </span>
                </span>
                <span className="thread-row__side">
                  <span className="faint small">{c.age}</span>
                  <Diffstat add={c.add} del={c.del} />
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="empty-line">No threads match.</li>}
        </ul>
      </div>
      <div className="threads__detail">
        {current ? <ChildThread child={current} /> : <Overview kids={kids} />}
      </div>
    </div>
  );
}

function Overview({ kids }: { kids: Child[] }) {
  const s = useStore();
  const byHost = ["macbook", "studio", "devbox"].map((h) => ({
    host: h,
    items: kids.filter((c) => c.host === h && c.status !== "landed"),
  }));
  return (
    <div className="scroll">
      <div className="column column--wide">
        <header className="page-head">
          <h2>Where the work is running</h2>
          <p className="faint">Pick a thread on the left to open it. Each one is a full thread with its own worktree.</p>
        </header>
        <div className="lanes">
          {byHost.map((l) => (
            <section key={l.host} className="lane" aria-label={l.host}>
              <h3 className="lane__head">
                <span className="online-dot" aria-hidden />
                {l.host}
                <span className="faint">{l.items.length}</span>
              </h3>
              <ul>
                {l.items.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="lane-card" onClick={() => s.openChild(c.id)}>
                      <span className="lane-card__top">
                        <StatusGlyph status={c.status} size={13} />
                        <span className="truncate">{c.title}</span>
                      </span>
                      <span className="faint small truncate">
                        {c.status === "working" ? <span className="shimmer">{c.steps[c.step]}</span> : c.queueReason ?? c.summary}
                      </span>
                      <span className="lane-card__foot">
                        <span className="host-tag">
                          <ProviderLogo provider={accountProvider(c.account)} size={11} />
                          {c.model}
                        </span>
                        <Diffstat add={c.add} del={c.del} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChildThread({ child }: { child: Child }) {
  const s = useStore();
  const [briefOpen, setBriefOpen] = useState(false);
  const brief = child.transcript.find((t) => t.kind === "brief");
  const rest = child.transcript.filter((t) => t.kind !== "brief");
  const decision = s.decisions.find((d) => d.childId === child.id && !d.answer);
  const running = child.status === "working" || child.status === "starting";

  return (
    <div className="child">
      <header className="child__head">
        <button type="button" className="link small back" onClick={() => s.go({ name: "project", id: "parallax", tab: "home" })}>
          <ArrowLeft size={13} aria-hidden />
          Coordinator
        </button>
        <div className="child__titlerow">
          <h2>{child.title}</h2>
          <StatusPill status={child.status} />
        </div>
        <div className="child__meta">
          <span className="host-tag">
            <ProviderLogo provider={accountProvider(child.account)} size={12} />
            {child.model}
          </span>
          <span className="meta-item">
            {child.host} <span className="faint">via {accountName(child.account)}</span>
          </span>
          <span className="meta-item">
            <GitBranch size={12} aria-hidden />
            {child.branch}
          </span>
          <Diffstat add={child.add} del={child.del} />
          <span className="grow" />
          {running && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => s.stopChild(child.id)}>
              <CircleStop size={14} aria-hidden />
              Stop
            </button>
          )}
          {child.status === "failed" && (
            <button type="button" className="btn btn--soft btn--sm" onClick={() => s.retryChild(child.id)}>
              <RotateCcw size={14} aria-hidden />
              Retry
            </button>
          )}
          {(child.status === "review" || child.status === "landed") && (
            <button type="button" className="btn btn--ghost btn--sm">
              <Eye size={14} aria-hidden />
              Diff
            </button>
          )}
          {child.status === "review" && (
            <button type="button" className="btn btn--primary btn--sm" disabled={s.landing === child.id} onClick={() => s.land(child.id)}>
              <GitMerge size={14} aria-hidden />
              {s.landing === child.id ? "Landing" : "Land"}
            </button>
          )}
        </div>
      </header>

      <div className="scroll">
        <div className="column">
          {brief && brief.kind === "brief" && (
            <button type="button" className={`brief-card${briefOpen ? " is-open" : ""}`} aria-expanded={briefOpen} onClick={() => setBriefOpen(!briefOpen)}>
              <span className="brief-card__head">
                <ChevronRight size={14} aria-hidden className="chev" />
                Task from the coordinator
                <span className="faint small push-end">with brief and 9 memories</span>
              </span>
              <span className="brief-card__text">{brief.text}</span>
            </button>
          )}
          <ol className="transcript">
            {rest.map((t, i) => (
              <Item key={i} item={t} />
            ))}
            {running && (
              <li className="tool-row is-live">
                <span className="shimmer">{child.status === "starting" ? "Starting" : child.steps[child.step]}</span>
              </li>
            )}
            {child.status === "queued" && <li className="notice">{child.queueReason}. It starts on its own when there is room.</li>}
          </ol>
          {decision && (
            <div className="inline-ask">
              <p className="small faint">Waiting on you</p>
              <p>{decision.question}</p>
              <div className="inline-ask__opts">
                {decision.options.map((o) => (
                  <button key={o.label} type="button" className={`btn btn--sm ${o.recommended ? "btn--primary" : "btn--ghost"}`} onClick={() => s.answer(decision.id, o.label)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="composer-dock">
        <Composer variant="child" onSubmit={(text) => s.messageChild(child.id, text)} />
      </div>
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  const [changed, setChanged] = useState(false);
  switch (item.kind) {
    case "user":
      return (
        <li className="msg msg--user">
          <p className="bubble">{item.text}</p>
        </li>
      );
    case "agent":
      return (
        <li className="msg msg--coordinator">
          <p>{item.text}</p>
        </li>
      );
    case "tool": {
      const Icon = item.verb === "Ran" ? SquareTerminal : item.verb === "Searched" ? Search : item.verb === "Created" ? FilePlus2 : FileCode2;
      return (
        <li className="tool-row">
          <Icon size={13} aria-hidden className="faint" />
          <span className="faint">{item.verb}</span>
          <code>{item.target}</code>
          {item.detail && <span className="faint">{item.detail}</span>}
          {(item.add || item.del) && <Diffstat add={item.add ?? 0} del={item.del ?? 0} />}
        </li>
      );
    }
    case "assumption":
      return (
        <li className="assumption">
          <Lightbulb size={14} aria-hidden />
          <span className="grow">
            {changed ? (
              <>
                Changed to <strong>{item.alternative}</strong>. The thread will redo that part.
              </>
            ) : (
              item.text
            )}
          </span>
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => setChanged(!changed)}>
            {changed ? "Undo" : "Change"}
          </button>
        </li>
      );
    default:
      return null;
  }
}
