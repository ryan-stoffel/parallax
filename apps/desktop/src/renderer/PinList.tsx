// The sidebar's pinned threads (pins.ts, 0075): full thread rows atop Today, in the order the user
// drags them into, each marked by its pin (PLX-1043).
import { Pin } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";

import {
  draggedPin,
  moveToEnd,
  orderOf,
  pinDragType,
  pinHintHidden,
  pinLayout,
  placeAt,
  setDraggedPin,
} from "./pins";
import { draggedThread, threadDragType } from "./threadDrag";

/** What a pinned row needs to move among the pins: its drag, and where a drop on it would land. */
export interface PinDrag {
  dragging: boolean;
  /** Where something dragged over it would land. */
  drop?: "before" | "after";
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/**
 * The pinned threads, as the rows `row` draws, in the user's order. Dropping a pinned row on
 * another's top or bottom half places it there; dropping a thread row here pins it. Searching,
 * they keep their order but don't move.
 */
export function PinList({
  keys,
  searching,
  row,
  onPinThread,
  onPlaced,
}: {
  /** The pinned threads shown, by key. */
  keys: string[];
  searching: boolean;
  row: (key: string, drag?: PinDrag) => ReactNode;
  onPinThread: (hostId: string, threadId: string) => void;
  /** A pin dragged in from elsewhere landed here, as a favorite dragged back down. */
  onPlaced: (key: string) => void;
}) {
  const shown = orderOf(pinLayout.use(), keys);
  const [dropAt, setDropAt] = useState<{ key: string; edge: "before" | "after" }>();
  const [dragKey, setDragKey] = useState<string>();
  const [rowOver, setRowOver] = useState(false);
  const hintHidden = pinHintHidden.use();

  const endDrag = () => {
    setDraggedPin(undefined);
    setDragKey(undefined);
    setRowOver(false);
    setDropAt(undefined);
  };
  const isPinDrag = (e: DragEvent) => e.dataTransfer.types.includes(pinDragType);
  const isRowDrag = (e: DragEvent) =>
    !isPinDrag(e) && e.dataTransfer.types.includes(threadDragType);
  // A row dropped here: pins it, then places it as `then` says.
  const pinRow = (e: DragEvent, then?: (key: string) => void) => {
    const dragged = draggedThread(e.dataTransfer);
    if (!dragged) return;
    onPinThread(dragged.hostId, dragged.runId);
    then?.(`${dragged.hostId}/${dragged.runId}`);
  };
  const drag = (target: string): PinDrag => ({
    dragging: dragKey === target,
    drop: dropAt?.key === target ? dropAt.edge : undefined,
    onDragStart: (e) => {
      setDraggedPin({ key: target, kind: "thread" });
      setDragKey(target);
      e.dataTransfer.setData(pinDragType, target);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    onDragEnd: endDrag,
    // On a row's top or bottom half, a pin goes before or after it.
    onDragOver: (e) => {
      const pin = draggedPin();
      if (isPinDrag(e) ? !pin || pin.key === target : !isRowDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge = e.clientY - box.top < box.height / 2 ? "before" : "after";
      setDropAt((d) => (d?.key === target && d.edge === edge ? d : { key: target, edge }));
    },
    onDragLeave: (e) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
      setDropAt((d) => (d?.key === target ? undefined : d));
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = dropAt?.key === target ? dropAt.edge === "after" : true;
      const place = (key: string) => placeAt(shown, key, target, after);
      const pin = draggedPin();
      if (isPinDrag(e) && pin) {
        place(pin.key);
        onPlaced(pin.key);
      } else pinRow(e, place);
      endDrag();
    },
  });

  return (
    <div
      onDragOver={(e) => {
        if (isPinDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        } else if (isRowDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setRowOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRowOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const pin = draggedPin();
        if (isPinDrag(e) && pin) {
          moveToEnd(shown, pin.key);
          onPlaced(pin.key);
        } else pinRow(e);
        endDrag();
      }}
      // A strip to drop on, even with nothing pinned and the hint hidden.
      className="flex min-h-1 flex-col"
    >
      <ul aria-label="Pinned" className="flex flex-col gap-1 not-empty:mb-1">
        {shown.map((key) => row(key, searching ? undefined : drag(key)))}
      </ul>
      {rowOver && (
        <div className="grow-in mt-0.5 grid h-8 place-items-center rounded-md border border-dashed border-accent/50 bg-accent/5 text-meta font-medium text-accent">
          Drop to pin
        </div>
      )}
      {keys.length === 0 && !rowOver && !searching && !hintHidden && (
        <div className="mb-1 flex flex-col items-center rounded-xl border border-dashed border-border px-4 pt-4 pb-2.5 text-center">
          <span className="grid size-7 place-items-center rounded-lg bg-surface text-muted-foreground ring-1 ring-border [&_svg]:size-3.5">
            <Pin aria-hidden />
          </span>
          <p className="mt-2.5 text-body font-medium text-muted-foreground">Keep threads close</p>
          <p className="mt-0.5 text-meta leading-snug text-faint-foreground">
            Drag one here, or press{" "}
            <kbd className="rounded-sm border border-border bg-surface px-1 font-sans text-caption leading-4 text-muted-foreground">
              P
            </kbd>{" "}
            on it.
          </p>
          <button
            type="button"
            onClick={() => pinHintHidden.set(true)}
            className="mt-3 h-6 rounded-md px-2.5 text-meta font-medium text-faint-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Where a dragged row would land, before or after the row it's over: a line from a ring. */
export function DropLine({ edge }: { edge: "before" | "after" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute right-1 left-1 z-10 flex items-center ${edge === "before" ? "-top-[4.5px]" : "-bottom-[4.5px]"}`}
    >
      <span className="size-[8px] shrink-0 rounded-full border-2 border-accent bg-[var(--sidebar)]" />
      <span className="drop-line -ml-px h-[2px] flex-1 rounded-r-full bg-accent" />
    </span>
  );
}
