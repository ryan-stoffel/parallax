import { ChevronDown, Code2, PanelRight } from "lucide-react";
import { accounts, hosts } from "./data";
import { Home } from "./Home";
import { Knowledge } from "./Knowledge";
import { Ship } from "./Ship";
import { useStore, type Tab } from "./store";
import { Threads } from "./Threads";
import { Popover, ProjectIcon, ProviderLogo } from "./ui";

const tabs: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "threads", label: "Threads" },
  { id: "knowledge", label: "Knowledge" },
  { id: "ship", label: "Ship" },
];

export function ProjectView({ id, tab, child }: { id: string; tab: Tab; child?: string }) {
  const { projects, go, children, memory, railOpen, setRailOpen, landed } = useStore();
  const project = projects.find((p) => p.id === id) ?? projects[0];
  const rich = project.id === "parallax";
  const kids = rich ? children : [];
  const needs = kids.filter((c) => c.status === "needs").length;
  const proposed = rich ? memory.filter((m) => m.proposed || m.stale).length : 0;
  const ready = kids.filter((c) => c.status === "review").length;
  const running = kids.filter((c) => c.status === "working" || c.status === "starting").length;

  const counts: Partial<Record<Tab, { n: number; alert?: boolean }>> = {
    threads: { n: kids.filter((c) => c.status !== "landed").length, alert: needs > 0 },
    knowledge: { n: proposed, alert: proposed > 0 },
    ship: { n: ready, alert: ready > 0 },
  };

  return (
    <div className="project">
      <header className="topbar titlebar">
        <div className="topbar__title">
          <ProjectIcon color={project.color} name={project.name} size={20} />
          <h1>{project.name}</h1>
          <span className="faint small topbar__base">{project.base}</span>
        </div>

        <nav className="tabs" aria-label="Project">
          {tabs.map((t) => {
            const c = counts[t.id];
            return (
              <button
                key={t.id}
                type="button"
                className="tab"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => go({ name: "project", id: project.id, tab: t.id })}
              >
                {t.label}
                {c && c.n > 0 && <span className={`tab__count${c.alert ? " is-alert" : ""}`}>{c.n}</span>}
              </button>
            );
          })}
        </nav>

        <div className="topbar__end">
          <Popover
            label="Capacity"
            align="end"
            width={340}
            trigger={(open, toggle) => (
              <button type="button" className="chip chip--ghost" aria-expanded={open} onClick={toggle}>
                <span className="host-dots" aria-hidden>
                  {hosts.map((h) => (
                    <i key={h.id} className={h.online ? "is-on" : undefined} />
                  ))}
                </span>
                {running} running
                <ChevronDown size={12} aria-hidden className="faint" />
              </button>
            )}
          >
            {() => <Capacity />}
          </Popover>
          <button type="button" className="btn btn--ghost btn--sm">
            <Code2 size={14} aria-hidden />
            Open
          </button>
          {tab === "home" && (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={railOpen ? "Hide threads panel" : "Show threads panel"}
              aria-pressed={railOpen}
              onClick={() => setRailOpen(!railOpen)}
            >
              <PanelRight size={15} />
            </button>
          )}
        </div>
      </header>

      <div className="project__body">
        {tab === "home" && <Home project={project} />}
        {tab === "threads" && <Threads project={project} selected={child} />}
        {tab === "knowledge" && <Knowledge project={project} />}
        {tab === "ship" && <Ship project={project} landedCount={rich ? landed.length : 0} />}
      </div>
    </div>
  );
}

function Capacity() {
  const { children } = useStore();
  return (
    <div className="capacity">
      <div className="menu__label">Hosts</div>
      <ul className="capacity__list">
        {hosts.map((h) => {
          const here = children.filter((c) => c.host === h.id && (c.status === "working" || c.status === "starting"));
          return (
            <li key={h.id} className="capacity__host">
              <span className="online-dot" aria-label={h.online ? "Online" : "Offline"} />
              <span className="stack">
                <span>{h.name}</span>
                <span className="faint small truncate">{here.length ? here.map((c) => c.title).join(", ") : "Idle"}</span>
              </span>
              <span className="slots" aria-label={`${h.running} of ${h.slots} slots`}>
                {Array.from({ length: h.slots }, (_, i) => (
                  <i key={i} className={i < h.running ? "is-used" : undefined} />
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="menu__sep" />
      <div className="menu__label">Subscriptions</div>
      <ul className="capacity__list">
        {accounts.map((a) => (
          <li key={a.id} className="capacity__acct">
            <ProviderLogo provider={a.provider} size={14} />
            <span className="stack grow">
              <span className="row-between">
                <span>{a.name}</span>
                <span className="faint small">{a.resets}</span>
              </span>
              <span className="meter meter--wide" aria-label={`${a.used}% used, cap ${a.cap}%`}>
                <span style={{ width: `${a.used}%` }} className={a.used >= a.cap ? "is-over" : undefined} />
                <span className="meter__cap" style={{ left: `${a.cap}%` }} />
              </span>
              <span className="faint small">
                {a.used >= a.cap ? `Past your ${a.cap}% cap. New work goes elsewhere.` : `${a.used}% used, cap at ${a.cap}%`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
