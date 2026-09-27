import { Bot, FileDiff, NotebookText } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { TopBar } from "./ui";

const tabs = [
  {
    id: "diffs",
    name: "Diffs",
    icon: FileDiff,
    empty: "No changes yet",
    hint: "Edits from this thread show up here for review.",
  },
  {
    id: "context",
    name: "Context",
    icon: NotebookText,
    empty: "No context yet",
    hint: "Notes your agents share show up here.",
  },
  {
    id: "agents",
    name: "Agents",
    icon: Bot,
    empty: "No agents running",
    hint: "Subagents this thread starts show up here.",
  },
] as const;

/** The collapsible right column: diffs, shared context, and agents, as tabs. */
export function SidePanel({ open }: { open: boolean }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move between tabs, per the ARIA tabs pattern.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = (active + step + tabs.length) % tabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside
      id="side-panel"
      aria-label="Side panel"
      hidden={!open}
      className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-sidebar"
    >
      <TopBar className="border-b border-border px-2">
        <div role="tablist" aria-label="Side panel" onKeyDown={onKeyDown} className="flex gap-0.5">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={i === active}
              aria-controls={`panel-${tab.id}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={`rounded-md px-2.5 py-1 text-[13px] ${i === active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
            >
              {tab.name}
            </button>
          ))}
        </div>
      </TopBar>
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={i !== active}
          className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center"
        >
          <tab.icon aria-hidden className="mb-1 size-5 text-faint-foreground" />
          <p className="text-[13px] font-medium text-foreground">{tab.empty}</p>
          <p className="text-[12.5px] text-muted-foreground">{tab.hint}</p>
        </div>
      ))}
    </aside>
  );
}
