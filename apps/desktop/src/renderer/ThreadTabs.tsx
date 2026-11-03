import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { bindingOf, formatKeybinding, tileCommands, useKeybindings } from "./keybindings";
import { draggedThread, dragThread, tabDragType, threadDragType, tileDragType } from "./threadDrag";
import { IconButton } from "./ui";

/** A thread a tab shows, by its host's id for it. */
export interface TabThread {
  hostId: string;
  runId: string;
}

/** One part of a tab: its one view, or one of the threads tiled in it. */
export interface TabPart {
  title: string;
  icon: ReactNode;
  thread?: TabThread;
  /** The tab's focused thread, or its only view. */
  focused: boolean;
}

/** One tab in the strip. */
export interface TabItem {
  id: string;
  parts: TabPart[];
}

/** What a drop on the strip carries. */
export type StripDrop =
  | { kind: "tab"; id: string }
  | { kind: "tile"; threadId: string }
  | { kind: "thread"; hostId: string; runId: string };

/** What the strip is dragging, which a drag over the pane can't read from its data. */
export type StripDrag = { tab: string; threadId?: string };

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
 * The top bar's tabs (PLX-1289), then a button that opens a new one. It's the app's only row of
 * thread titles: threads tiled together show as one tab of joined parts, in the order they tile,
 * and choosing a part focuses that tile.
 *
 * A tab drags along the strip to reorder and, holding one thread, into the pane to tile it. A part
 * of the open tab drags onto another tile to swap them. Any part dragged to the strip gets a tab of
 * its own, as a sidebar thread does, where a bar shows it would land. A middle click closes a part.
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
  onSelect: (id: string, threadId?: string) => void;
  onClose: (id: string, thread?: TabThread) => void;
  onNew: () => void;
  onDrop: (drop: StripDrop, before?: string) => void;
  /** False for the only tab on New thread, with nothing to close to. */
  closable: boolean;
  dragging: { current: StripDrag | undefined };
}) {
  useKeybindings();
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
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab, i) => {
          const open = tab.id === active;
          const last = i === tabs.length - 1;
          const tiled = tab.parts.length > 1;
          return (
            <div
              key={tab.id}
              data-tab={tab.id}
              className={`relative flex h-8 min-w-0 items-stretch rounded-lg ${tiled ? `shrink divide-x divide-border border border-border ${open ? "bg-hover" : ""}` : "w-52 min-w-24 shrink"}`}
            >
              {(landing === tab.id || (landing === null && last)) && (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-1 z-[1] w-0.5 rounded-full bg-accent ${last && landing === null ? "-right-0.5" : "-left-0.5"}`}
                />
              )}
              {tab.parts.map((part, side) => {
                const selected = open && part.focused;
                const keys = open && tiled && bindingOf(tileCommands[side]!);
                return (
                  <div
                    key={part.thread?.runId ?? side}
                    draggable
                    onDragStart={(e) => {
                      const { dataTransfer: data } = e;
                      data.effectAllowed = "copyMove";
                      // A part of the open tab is a tile, which a composer doesn't take.
                      if (tiled && open) data.setData(tileDragType, part.thread!.runId);
                      else {
                        if (!tiled) data.setData(tabDragType, tab.id);
                        if (part.thread) dragThread(data, part.thread.hostId, part.thread.runId);
                      }
                      dragging.current = { tab: tab.id, threadId: part.thread?.runId };
                    }}
                    onDragEnd={() => {
                      dragging.current = undefined;
                      setLanding(undefined);
                    }}
                    onAuxClick={(e) => {
                      if (e.button !== 1 || !closable) return;
                      e.preventDefault();
                      onClose(tab.id, part.thread);
                    }}
                    className={`group/tab relative flex min-w-0 items-center transition-colors first:rounded-l-lg last:rounded-r-lg ${tiled ? "w-44 min-w-20 shrink" : "flex-1"} ${selected ? "bg-selected" : "hover:bg-hover"}`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      title={part.title}
                      data-keys={keys ? formatKeybinding(keys) : undefined}
                      onClick={() => onSelect(tab.id, part.thread?.runId)}
                      className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 text-left text-body outline-none focus-visible:ring-1 focus-visible:ring-ring ${closable && selected ? "pr-1" : "pr-2.5"} ${selected ? "font-medium text-foreground" : "text-muted-foreground"}`}
                    >
                      <span className="flex shrink-0 [&_svg]:size-4">{part.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{part.title}</span>
                    </button>
                    {closable && (
                      <button
                        type="button"
                        aria-label={`Close ${part.title}`}
                        title="Close tab"
                        onClick={() => onClose(tab.id, part.thread)}
                        className={`grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:text-foreground [&_svg]:size-3.5 ${selected ? "mr-1 hover:bg-hover" : "absolute right-1 bg-pane opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"}`}
                      >
                        <X />
                      </button>
                    )}
                  </div>
                );
              })}
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
