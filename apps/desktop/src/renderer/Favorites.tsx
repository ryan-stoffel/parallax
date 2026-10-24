// The sidebar's favorites (pins.ts, 0075): the Projects, and any pinned thread moved up, as squares
// that fill the row, above the pinned threads, as Arc's favorites sit above its tabs.
import { ArrowLeft, ArrowRight, ArrowUpRight, StarOff } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { Attention } from "./attention";
import { draggedPin, pinDragType, setDraggedPin } from "./pins";
import { MenuKey } from "./Sidebar";
import { shownRows } from "./SidebarParts";
import { dragThread, draggedThread, threadDragType } from "./threadDrag";
import { Menu, menuItem, openOnContextMenu } from "./ui";

/** One favorite: a Project, or a pinned thread moved up here. */
export interface Favorite {
  key: string;
  kind: "project" | "thread";
  title: string;
  icon: ReactNode;
  attention: Attention;
  /** A Project's status in place of a dot (0083): whether any of its runs works, and how many
   * wait on the user. */
  project?: { working: boolean; waiting: number };
  selected: boolean;
  /** Its Mod+number badge while Mod is held. */
  badge?: ReactNode;
  /** A thread's host and id, which its drag carries, so it drops on the composer like a row. */
  thread?: { hostId: string; id: string };
  /** What else its menu offers, as a Project's Rename and Delete, each run with its square. */
  actions?: FavoriteAction[];
  /** A thread's keys, as E and ⌫ on its row, for those the square doesn't take itself. */
  onKeys?: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

/** One item in a favorite's or pin's menu, after its own, run with its square or row. */
export interface FavoriteAction {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  /** The key that does it on a row, shown beside it. */
  shortcut?: string;
  run: (square: HTMLElement) => void;
}

/** What a favorite's drag carries, so only the favorites take it as a move. */
const favoriteDragType = "application/x-parallax-favorite";

// A thread's dot, and its words for a screen reader and the tooltip: only for what finished,
// failed, or waits on the user. Work in progress shows nothing, as the Working drawer keeps it out
// of sight. A Project shows its working ring and waiting count instead.
const dots: Partial<Record<Attention, { color: string; words: string }>> = {
  needsYou: { color: "bg-warning", words: "needs you" },
  failed: { color: "bg-danger", words: "failed" },
  done: { color: "bg-added", words: "done" },
};

/** What a favorite's mark says, for a screen reader and the tooltip. */
function wordsOf(f: Favorite): string | undefined {
  if (!f.project) return dots[f.attention]?.words;
  const { working, waiting } = f.project;
  const words = [working && "working", waiting > 0 && `${waiting} waiting on you`].filter(Boolean);
  return words.length ? words.join(", ") : undefined;
}

/**
 * The favorites: squares, as many to a row as fit and stretched to fill it, so two Projects take
 * half the width each. Dragging one between others moves it there. Dropping a
 * pinned thread, or a thread row, here makes it a favorite; dragging one back down to the pins, or
 * Remove from favorites, puts it back. Left and Right move between them, and with Alt, or Move left
 * and Move right in the menu, move one. A opens one's menu, and a thread's E, S, and ⌫ work as on
 * its row. None shows nothing.
 */
export function Favorites({
  items,
  onOpen,
  onAdd,
  onPinRow,
  onRemove,
  onReorder,
  onRest,
  onLeave,
}: {
  items: Favorite[];
  onOpen: (key: string) => void;
  /** A pinned thread dropped here. */
  onAdd: (key: string) => void;
  /** A thread row dropped here: pinned, then made a favorite. */
  onPinRow: (hostId: string, threadId: string) => void;
  onRemove: (key: string) => void;
  /** Every favorite's key, in the order a move left them; absent while they can't move, as while
   * searching, which shows only some. */
  onReorder?: (keys: string[]) => void;
  /** The pointer resting on a thread's square, for its card, and leaving it. */
  onRest?: (key: string, el: HTMLElement) => void;
  onLeave?: () => void;
}) {
  const menuId = useId();
  const [menuFor, setMenuFor] = useState<string>();
  const [over, setOver] = useState(false);
  const [dragging, setDragging] = useState<string>();
  // Where a dragged favorite would land: before or after a square.
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean }>();
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const tiles = useRef(new Map<string, HTMLElement>());
  // Each square's place before a move, so each slides from there to its new one, and the square a
  // key moved, which keeps focus.
  const moved = useRef<Map<string, DOMRect>>(undefined);
  const refocus = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (refocus.current) tiles.current.get(refocus.current)?.querySelector("button")?.focus();
    refocus.current = undefined;
    const was = moved.current;
    moved.current = undefined;
    if (!was || document.documentElement.classList.contains("reduce-motion")) return;
    for (const [key, el] of tiles.current) {
      const from = was.get(key);
      if (!from || typeof el.animate !== "function") continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx || dy)
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: 260,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        });
    }
  });
  const keys = new Set(items.map((f) => f.key));
  // What may land here: a pinned thread that isn't a favorite yet, or any thread row.
  const accepts = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(favoriteDragType)) return false;
    if (e.dataTransfer.types.includes(pinDragType)) {
      const pin = draggedPin();
      return pin?.kind === "thread" && !keys.has(pin.key);
    }
    return e.dataTransfer.types.includes(threadDragType);
  };
  // A favorite dragged among the others, to move it.
  const reordering = (e: DragEvent) =>
    !!dragging && e.dataTransfer.types.includes(favoriteDragType);
  const endDrag = () => {
    setDraggedPin(undefined);
    setDragging(undefined);
    setDropAt(undefined);
  };
  const move = (key: string, target: string, after: boolean) => {
    const order = items.map((f) => f.key).filter((k) => k !== key);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, key);
    if (!onReorder || order.join() === items.map((f) => f.key).join()) return;
    moved.current = new Map([...tiles.current].map(([k, el]) => [k, el.getBoundingClientRect()]));
    onReorder(order);
  };
  // One step left or right.
  const step = (key: string, by: -1 | 1) => {
    const next = items[items.findIndex((f) => f.key === key) + by];
    if (next) move(key, next.key, by === 1);
  };
  const alt = window.parallax.platform === "darwin" ? "⌥" : "Alt+";
  const editing = items.find((f) => f.key === menuFor);
  const at = editing ? items.indexOf(editing) : -1;
  if (!items.length) return null;
  const close = (run: () => void) => (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
    run();
  };
  return (
    <>
      <ul
        aria-label="Favorites"
        onDragOver={(e) => {
          if (reordering(e)) return e.preventDefault();
          if (!accepts(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setOver(false);
          setDropAt(undefined);
        }}
        onDrop={(e) => {
          setOver(false);
          if (reordering(e)) {
            e.preventDefault();
            if (dragging && dropAt) move(dragging, dropAt.key, dropAt.after);
            return endDrag();
          }
          if (!accepts(e)) return;
          e.preventDefault();
          const pin = draggedPin();
          if (e.dataTransfer.types.includes(pinDragType) && pin) return onAdd(pin.key);
          const row = draggedThread(e.dataTransfer);
          if (row) onPinRow(row.hostId, row.runId);
        }}
        className={`grid rounded-[12px] px-0.5 pt-1.5 transition-[background-color,box-shadow] duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none mb-2 grid-cols-[repeat(auto-fit,minmax(40px,1fr))] gap-1.5 ${over ? "bg-accent/6 shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--accent)_45%,transparent)]" : ""}`}
      >
        {items.map((f) => (
          <li
            key={f.key}
            ref={(el) => {
              if (el) tiles.current.set(f.key, el);
              else tiles.current.delete(f.key);
            }}
            className="grow-in relative"
            onMouseEnter={(e) => f.thread && onRest?.(f.key, e.currentTarget)}
            onMouseLeave={() => f.thread && onLeave?.()}
            onDragOver={(e) => {
              if (!reordering(e)) return;
              e.dataTransfer.dropEffect = "move";
              const box = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > box.left + box.width / 2;
              setDropAt((d) => (d?.key === f.key && d.after === after ? d : { key: f.key, after }));
            }}
          >
            {dropAt?.key === f.key && dragging !== f.key && (
              <span
                aria-hidden
                className={`drop-line absolute inset-y-1 z-10 w-0.5 rounded-full bg-accent ${dropAt.after ? "-right-[4px]" : "-left-[4px]"}`}
              />
            )}
            <button
              type="button"
              data-row={f.key}
              // A thread's card names it.
              title={
                f.thread && onRest ? undefined : `${f.title}${wordsOf(f) ? `, ${wordsOf(f)}` : ""}`
              }
              aria-label={f.title}
              aria-description={wordsOf(f)}
              aria-current={f.selected ? "page" : undefined}
              draggable={!!onReorder || !!f.thread}
              onDragStart={(e) => {
                onLeave?.();
                setDragging(f.key);
                if (onReorder) e.dataTransfer.setData(favoriteDragType, f.key);
                e.dataTransfer.effectAllowed = "copyMove";
                // A thread can also go back down to the pins, or onto the composer.
                if (!f.thread) return;
                setDraggedPin({ key: f.key, kind: "thread" });
                e.dataTransfer.setData(pinDragType, f.key);
                dragThread(e.dataTransfer, f.thread.hostId, f.thread.id);
              }}
              onDragEnd={endDrag}
              onClick={() => onOpen(f.key)}
              onKeyDown={(e) => {
                // A, as on a row, opens its menu.
                if (e.key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  setMenuFor(f.key);
                  return triggers.current.get(f.key)?.click();
                }
                f.onKeys?.(e);
                if (e.defaultPrevented) return;
                const by = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                if (by && e.altKey) {
                  e.preventDefault();
                  refocus.current = f.key;
                  return step(f.key, by);
                }
                const list = by
                  ? [...e.currentTarget.closest("ul")!.querySelectorAll<HTMLElement>("[data-row]")]
                  : e.key === "ArrowDown" || e.key === "ArrowUp"
                    ? shownRows()
                    : [];
                const next =
                  list[list.indexOf(e.currentTarget) + (by || (e.key === "ArrowDown" ? 1 : -1))];
                if (!next) return;
                e.preventDefault();
                next.focus();
              }}
              onContextMenu={(e) => {
                setMenuFor(f.key);
                openOnContextMenu(e, triggers.current.get(f.key) ?? null);
              }}
              className={`relative grid w-full place-items-center rounded-[10px] transition-[background-color,transform,opacity] duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none h-11 [&_svg]:size-5 ${dragging === f.key ? "opacity-40" : ""} ${f.selected ? "bg-selected shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent)]" : "bg-foreground/[0.045] hover:bg-foreground/[0.08]"}`}
            >
              {f.icon}
              {f.project ? (
                <>
                  {f.project.working && <span aria-hidden className="project-working" />}
                  {f.project.waiting > 0 && (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[10px] leading-none font-semibold text-background tabular-nums ring-2 ring-sidebar"
                    >
                      {f.project.waiting}
                    </span>
                  )}
                </>
              ) : (
                dots[f.attention] && (
                  <span
                    aria-hidden
                    className={`dot-in absolute size-[7px] rounded-full top-1.5 right-1.5 ${dots[f.attention]!.color}`}
                  />
                )
              )}
              {f.badge && <span className="absolute right-1 bottom-1">{f.badge}</span>}
            </button>
            {/* The context menu's anchor, so it opens beside this square. */}
            <button
              ref={(el) => {
                if (el) triggers.current.set(f.key, el);
                else triggers.current.delete(f.key);
              }}
              type="button"
              tabIndex={-1}
              aria-hidden
              popoverTarget={menuId}
              onClick={() => setMenuFor(f.key)}
              className="pointer-events-none absolute right-1 bottom-0 size-0 opacity-0"
            />
          </li>
        ))}
        {over && (
          <li className="grow-in grid h-11 place-items-center rounded-[10px] border border-dashed border-accent/50 text-[11.5px] font-medium text-accent">
            Favorite
          </li>
        )}
      </ul>
      <Menu
        id={menuId}
        label="Favorite"
        className="pop-in min-w-48 p-1"
        onClose={() => setMenuFor(undefined)}
      >
        {editing && (
          <>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => onOpen(editing.key))}
            >
              <ArrowUpRight aria-hidden />
              Open
              <MenuKey>↵</MenuKey>
            </button>
            {onReorder && items.length > 1 && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={at === 0}
                  className={`${menuItem} disabled:pointer-events-none disabled:opacity-40`}
                  onClick={close(() => step(editing.key, -1))}
                >
                  <ArrowLeft aria-hidden />
                  Move left
                  <MenuKey>{`${alt}←`}</MenuKey>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={at === items.length - 1}
                  className={`${menuItem} disabled:pointer-events-none disabled:opacity-40`}
                  onClick={close(() => step(editing.key, 1))}
                >
                  <ArrowRight aria-hidden />
                  Move right
                  <MenuKey>{`${alt}→`}</MenuKey>
                </button>
              </>
            )}
            {editing.kind === "thread" && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => onRemove(editing.key))}
              >
                <StarOff aria-hidden />
                Remove from favorites
              </button>
            )}
            {editing.actions && editing.actions.length > 0 && <hr className="my-1 border-border" />}
            {editing.actions?.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={`${menuItem} ${a.danger ? "text-danger" : ""}`}
                onClick={close(() => {
                  const square = tiles.current.get(editing.key);
                  if (square) a.run(square);
                })}
              >
                {a.icon}
                {a.label}
                {a.shortcut && <MenuKey>{a.shortcut}</MenuKey>}
              </button>
            ))}
          </>
        )}
      </Menu>
    </>
  );
}
