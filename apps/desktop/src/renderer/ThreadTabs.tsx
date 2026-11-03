import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { draggedThread, dragThread, tabDragType, threadDragType, tileDragType } from "./threadDrag";
import { IconButton } from "./ui";

/** One tab in the strip. `thread` is its thread while it holds just one, so it can drag out. */
export interface TabItem {
  id: string;
  title: string;
  icon: ReactNode;
  thread?: { hostId: string; runId: string };
}

/** What a drop on the strip carries. */
export type StripDrop =
  | { kind: "tab"; id: string }
  | { kind: "tile"; threadId: string }
  | { kind: "thread"; hostId: string; runId: string };

/** What `e` carries, by its data, which only a drop can read. */
function dropOf(e: DragEvent): StripDrop | undefined {
  const data = e.dataTransfer;
  const id = data.getData(tabDragType);
  if (id) return { kind: "tab", id };
  const threadId = data.getData(tileDragType);
  if (threadId) return { kind: "tile", threadId };
  const thread = draggedThread(data);
  return thread && { kind: "thread", ...thread };
}

const accepted = [tabDragType, tileDragType, threadDragType];

/**
 * The top bar's tabs (PLX-1289), then a button that opens a new one. A tab drags along the strip to
 * reorder and, holding one thread, into the pane to tile it. A thread or a tile's header dropped
 * here gets a tab where it lands, which a bar shows while it's over the strip. A middle click
 * closes a tab.
 */
export function ThreadTabs({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
  onDrop,
  closable,
  dragging,
}: {
  tabs: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDrop: (drop: StripDrop, before?: string) => void;
  /** False for the only tab on New thread, with nothing to close to. */
  closable: boolean;
  /** Holds the tab being dragged, for the pane to tell whether it's its own. */
  dragging: { current: string | undefined };
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
      className="tab-strip flex min-w-0 items-center gap-1"
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
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
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
                if (tab.thread) dragThread(e.dataTransfer, tab.thread.hostId, tab.thread.runId);
                dragging.current = tab.id;
              }}
              onDragEnd={() => {
                dragging.current = undefined;
                setLanding(undefined);
              }}
              onAuxClick={(e) => {
                if (e.button !== 1 || !closable) return;
                e.preventDefault();
                onClose(tab.id);
              }}
              className={`group/tab relative flex h-8 w-52 min-w-24 shrink items-center rounded-lg transition-colors ${selected ? "bg-selected" : "hover:bg-hover"}`}
            >
              {(landing === tab.id || (landing === null && last)) && (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-1 z-[1] w-0.5 rounded-full bg-accent ${last && landing === null ? "-right-0.5" : "-left-0.5"}`}
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={tab.title}
                onClick={() => onSelect(tab.id)}
                className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 text-left text-body outline-none focus-visible:ring-1 focus-visible:ring-ring ${closable ? "pr-1" : "pr-2.5"} ${selected ? "font-medium text-foreground" : "text-muted-foreground"}`}
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
                  className={`mr-1 grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground group-hover/tab:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5 ${selected ? "" : "opacity-0"}`}
                >
                  <X />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <IconButton label="New tab" command="newTab" onClick={onNew}>
        <Plus />
      </IconButton>
    </div>
  );
}
