import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { draggedThread, tabDragType, threadDragType } from "./threadDrag";
import { IconButton } from "./ui";

/** One tab, as its pane lists it. */
export interface TabItem {
  id: string;
  title: string;
  icon: ReactNode;
}

/** What a drop on a pane's tabs carries. */
export type TabDrop =
  | { kind: "tab"; id: string }
  | { kind: "thread"; hostId: string; runId: string };

/** What `e` carries, by its data, which only a drop can read. */
function dropOf(e: DragEvent): TabDrop | undefined {
  const id = e.dataTransfer.getData(tabDragType);
  if (id) return { kind: "tab", id };
  const thread = draggedThread(e.dataTransfer);
  return thread && { kind: "thread", ...thread };
}

const accepted = [tabDragType, threadDragType];

/**
 * A pane's tabs (PLX-1289), in a row above its card, then a button that opens a new one. The shown
 * tab is part of the card: one outline, joined by curves at its foot (.tab-shown). With `marked`, for
 * the focused pane among several, that outline is brighter. A tab drags along the tabs or to another pane's
 * to move there, and into a pane to open beside it. A sidebar thread dropped here gets a tab where it
 * lands, which a bar shows. A middle click closes a tab.
 */
export function ThreadTabs({
  tabs,
  active,
  focused,
  marked,
  onSelect,
  onClose,
  onNew,
  onDrop,
  closable,
}: {
  tabs: TabItem[];
  active: string;
  focused: boolean;
  marked: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDrop: (drop: TabDrop, before?: string) => void;
  /** False for the window's only tab on New thread, with nothing to close to. */
  closable: boolean;
}) {
  // Where a drop would land: before this tab, or last for null.
  const [landing, setLanding] = useState<string | null>();
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  // The tab whose left half the pointer is left of, or null past the last.
  const landingAt = (x: number) => {
    const shown = [...list.current!.querySelectorAll<HTMLElement>("[data-tab]")];
    const at = shown.find((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return at?.dataset["tab"] ?? null;
  };

  const over = (e: DragEvent) => {
    if (!accepted.some((type) => e.dataTransfer.types.includes(type))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setLanding(landingAt(e.clientX));
  };

  return (
    <div
      className="tab-strip flex h-full min-w-0 items-center"
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLanding(undefined);
      }}
      onDrop={(e) => {
        const drop = dropOf(e);
        const before = landingAt(e.clientX) ?? undefined;
        setLanding(undefined);
        if (!drop) return;
        e.preventDefault();
        onDrop(drop, before);
      }}
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Open tabs"
        className="flex h-full min-w-0 items-end gap-0.5 overflow-x-auto px-2.5"
      >
        {tabs.map((tab, i) => {
          const selected = tab.id === active;
          const last = i === tabs.length - 1;
          return (
            <div
              key={tab.id}
              data-tab={tab.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(tabDragType, tab.id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={() => setLanding(undefined)}
              onAuxClick={(e) => {
                if (e.button !== 1 || !closable) return;
                e.preventDefault();
                onClose(tab.id);
              }}
              className={`group/tab relative flex max-w-56 min-w-16 shrink items-center ${selected ? "pane-edge tab-shown self-stretch rounded-t-[10px] bg-pane pb-0.5" : "mb-[7px] h-7 rounded-md hover:bg-hover"}`}
              data-marked={selected && marked ? "" : undefined}
            >
              {(landing === tab.id || (landing === null && last)) && (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-0.5 z-[1] w-0.5 rounded-full bg-accent ${last && landing === null ? "-right-0.5" : "-left-0.5"}`}
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={tab.title}
                onClick={() => onSelect(tab.id)}
                className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-body outline-none focus-visible:ring-1 focus-visible:ring-ring ${selected ? `font-medium ${focused ? "text-foreground" : "text-muted-foreground"}` : "text-faint-foreground"}`}
              >
                <span className="flex shrink-0 [&_svg]:size-4">{tab.icon}</span>
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </button>
              {closable && (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  title="Close tab"
                  onClick={() => onClose(tab.id)}
                  className={`absolute right-0.5 grid size-6 place-items-center rounded-md text-faint-foreground opacity-0 group-hover/tab:opacity-100 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5 ${selected ? "bg-pane" : "bg-sidebar"}`}
                >
                  <X />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <IconButton
        label="New tab"
        command="newTab"
        size="sm"
        className="-ml-1 mb-[9px] self-end"
        onClick={onNew}
      >
        <Plus />
      </IconButton>
    </div>
  );
}
