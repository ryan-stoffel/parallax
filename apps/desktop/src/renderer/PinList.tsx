// The sidebar's pinned threads (pins.ts, 0075): rows under the favorites, in the order the user
// drags them into.
import {
  ArrowUpRight,
  CircleAlert,
  CircleDot,
  Ellipsis,
  Eye,
  MessageCircleQuestion,
  Palette,
  PencilLine,
  Pin,
  PinOff,
  Star,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { Attention } from "./attention";
import { DoneMark, WorkingMark } from "./AttentionMark";
import { IconPicker } from "./IconPicker";
import {
  draggedPin,
  forgetPin,
  moveToEnd,
  orderOf,
  pinDragType,
  pinHintHidden,
  pinIcons,
  pinLayout,
  placeAt,
  setDraggedPin,
} from "./pins";
import type { FavoriteAction } from "./Favorites";
import { MenuKey } from "./Sidebar";
import { close, shownRows } from "./SidebarParts";
import { dragThread, draggedThread, threadDragType } from "./threadDrag";
import { Menu, menuItem, openOnContextMenu } from "./ui";

/** One pinned thread. */
export interface Pin {
  /** `<host>/<id>`, as the sidebar keys its rows. */
  key: string;
  title: string;
  icon: ReactNode;
  /** The CSS color its icon's tinted with. */
  tint: string;
  attention: Attention;
  selected: boolean;
  /** Its host and id: what its drag carries, so it drops on the composer like a row. */
  thread: { hostId: string; id: string };
  renamable: boolean;
  /** Its thread's actions, as Archive and Delete, after the pin's own in its menu. */
  actions: FavoriteAction[];
  /** Its thread's keys, as E and ⌫, for those the pin doesn't take itself. */
  onKeys: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

const news = (a: Attention) => a === "done" || a === "failed" || a === "needsYou";
const reduced = () => document.documentElement.classList.contains("reduce-motion");
const tinted = (tint: string) => ({ "--tint": tint }) as CSSProperties;

/**
 * Grows an element in as it arrives, as when a thread is pinned, but not on the
 * sidebar's first load (data-settled, Sidebar.tsx).
 */
function useArrival<T extends HTMLElement>(from: string) {
  const self = useRef<T>(null);
  useLayoutEffect(() => {
    if (reduced() || !self.current?.closest("[data-settled]")) return;
    if (typeof self.current.animate !== "function") return;
    self.current.animate(
      [
        { opacity: 0, transform: from },
        { opacity: 1, transform: "none" },
      ],
      { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }, []);
  return self;
}

/**
 * The pinned threads, as rows: each with its icon, title, and, for what finished, failed, or waits
 * on the user, its status in words. Dropping a row on another's top or bottom half places it there;
 * dropping a thread row here pins it.
 */
export function PinList({
  pins,
  searching,
  onOpen,
  onPinThread,
  onUnpin,
  onRename,
  onRest,
  onLeave,
  onFavorite,
  onPlaced,
  onMarkUnread,
}: {
  /** Marks a finished pinned thread you've seen unread again. */
  onMarkUnread: (key: string) => void;
  /** Moves a pinned thread up into the favorites. */
  onFavorite: (key: string) => void;
  /** A pin dragged in from elsewhere landed here, as a favorite dragged back down. */
  onPlaced: (key: string) => void;
  pins: Pin[];
  searching: boolean;
  onOpen: (key: string) => void;
  onPinThread: (hostId: string, threadId: string) => void;
  onUnpin: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onRest: (key: string, el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const layout = pinLayout.use();
  const icons = pinIcons.use();
  const byKey = new Map(pins.map((p) => [p.key, p]));
  const keys = pins.map((p) => p.key);
  const shown = searching ? keys : orderOf(layout, keys);
  // Among rows, where something dragged would land: before or after a row.
  const [dropAt, setDropAt] = useState<{ key: string; edge: "before" | "after" }>();
  const [renaming, setRenaming] = useState<string>();
  const [dragKey, setDragKey] = useState<string>();
  const [rowOver, setRowOver] = useState(false);
  const hintHidden = pinHintHidden.use();
  const menuId = useId();
  const [menuFor, setMenuFor] = useState<string>();
  const pickerId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const [iconRequest, setIconRequest] = useState<{ key: string; source: HTMLElement }>();
  useEffect(() => {
    if (iconRequest) picker.current?.showPopover({ source: iconRequest.source });
  }, [iconRequest]);

  const endDrag = () => {
    setDraggedPin(undefined);
    setDragKey(undefined);
    setRowOver(false);
    setDropAt(undefined);
  };
  const isPinDrag = (e: DragEvent) => e.dataTransfer.types.includes(pinDragType);
  const isRowDrag = (e: DragEvent) =>
    !isPinDrag(e) && e.dataTransfer.types.includes(threadDragType);
  // A row dropped somewhere: pins it, then places it as `then` says.
  const pinRow = (e: DragEvent, then?: (key: string) => void) => {
    const row = draggedThread(e.dataTransfer);
    if (!row) return;
    onPinThread(row.hostId, row.runId);
    then?.(`${row.hostId}/${row.runId}`);
  };

  // Dropped on a row's top or bottom half, a pin goes before or after it.
  const dropRow = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      const pin = draggedPin();
      if (isPinDrag(e) ? !pin || pin.key === target : !isRowDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge = e.clientY - box.top < box.height / 2 ? "before" : "after";
      setDropAt((d) => (d?.key === target && d.edge === edge ? d : { key: target, edge }));
    },
    onDragLeave: (e: DragEvent) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
      setDropAt((d) => (d?.key === target ? undefined : d));
    },
    onDrop: (e: DragEvent) => {
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
  const editing = menuFor ? byKey.get(menuFor) : undefined;

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
      className="flex min-h-4 flex-col gap-px"
    >
      <ul className="flex flex-col gap-px">
        {shown.map((key) => {
          const pin = byKey.get(key)!;
          return (
            <PinItem
              key={pin.key}
              pin={pin}
              dragging={dragKey === pin.key}
              renaming={renaming === pin.key}
              draggable={!searching}
              menuId={menuId}
              onMenu={() => setMenuFor(pin.key)}
              onOpen={() => onOpen(pin.key)}
              onRename={(title) => {
                setRenaming(undefined);
                if (title !== undefined && title.trim() && title !== pin.title)
                  onRename(pin.key, title.trim());
              }}
              onStartRename={() => pin.renamable && setRenaming(pin.key)}
              onDragStart={(e) => {
                onLeave();
                setDraggedPin({ key: pin.key, kind: "thread" });
                setDragKey(pin.key);
                e.dataTransfer.setData(pinDragType, pin.key);
                dragThread(e.dataTransfer, pin.thread.hostId, pin.thread.id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={endDrag}
              onRest={(el) => onRest(pin.key, el)}
              onLeave={onLeave}
              onKeyDown={(e) => {
                if (e.key === "r" && pin.renamable && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  return setRenaming(pin.key);
                }
                if (e.key === "u" && pin.attention === "settled") {
                  e.preventDefault();
                  return onMarkUnread(pin.key);
                }
                pin.onKeys(e);
                if (!e.defaultPrevented) rowNav(e);
              }}
              drop={dropAt?.key === pin.key ? dropAt.edge : undefined}
              {...dropRow(pin.key)}
            />
          );
        })}
      </ul>
      {rowOver && (
        <div className="grow-in grid h-8 place-items-center rounded-md border border-dashed border-accent/50 bg-accent/5 text-meta font-medium text-accent">
          Drop to pin
        </div>
      )}
      {pins.length === 0 && !rowOver && searching && (
        <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-meta leading-snug text-faint-foreground">
          No pins match
        </p>
      )}
      {pins.length === 0 && !rowOver && !searching && !hintHidden && (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-4 pt-4 pb-2.5 text-center">
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

      <Menu
        id={menuId}
        label="Pin"
        className="pop-in min-w-52 p-1"
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
            {editing.renamable && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => setRenaming(editing.key))}
              >
                <PencilLine aria-hidden />
                Rename
                <MenuKey>R</MenuKey>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={(e) => {
                const source =
                  document.querySelector<HTMLElement>(`[data-pin="${CSS.escape(editing.key)}"]`) ??
                  e.currentTarget;
                close(() => setIconRequest({ key: editing.key, source }))(e);
              }}
            >
              <Palette aria-hidden />
              Change icon…
            </button>
            <hr className="my-1 border-border" />
            {editing.attention === "settled" && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => onMarkUnread(editing.key))}
              >
                <CircleDot aria-hidden />
                Mark as unread
                <MenuKey>U</MenuKey>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => {
                forgetPin(editing.key);
                onFavorite(editing.key);
              })}
            >
              <Star aria-hidden />
              Add to favorites
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => {
                forgetPin(editing.key);
                onUnpin(editing.key);
              })}
            >
              <PinOff aria-hidden />
              Unpin
            </button>
            {editing.actions.map((a) => (
              <Fragment key={a.label}>
                {a.danger && <hr className="my-1 border-border" />}
                <button
                  type="button"
                  role="menuitem"
                  className={`${menuItem} ${a.danger ? "text-danger" : ""}`}
                  onClick={close(() => {
                    const row = document.querySelector<HTMLElement>(
                      `[data-pin="${CSS.escape(editing.key)}"]`,
                    );
                    if (row) a.run(row);
                  })}
                >
                  {a.icon}
                  {a.label}
                  {a.shortcut && <MenuKey>{a.shortcut}</MenuKey>}
                </button>
              </Fragment>
            ))}
          </>
        )}
      </Menu>
      {iconRequest && (
        <IconPicker
          key={iconRequest.key}
          ref={picker}
          id={pickerId}
          value={icons[iconRequest.key]}
          onPick={(icon) => pinIcons.set({ ...pinIcons.get(), [iconRequest.key]: icon })}
        />
      )}
    </div>
  );
}

/**
 * Up and Down from a pin go to the row before or after it in the whole sidebar, favorites, pins,
 * and threads alike, as a thread row's keys do.
 */
function rowNav(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const rows = shownRows();
  const next = rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

// A row's surface: open, at rest, or its name being edited.
const plainSurface = {
  on: "bg-selected",
  rest: "hover:bg-hover",
  editing:
    "bg-[color-mix(in_srgb,var(--tint)_10%,var(--selected))] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--tint)_70%,transparent)]",
};
const rowLook =
  "flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left text-body transition-[background-color,transform] duration-100 outline-none";
const moreButton =
  "grid size-5.5 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/pin:opacity-100 group-has-[:focus-visible]/pin:opacity-100 hover:bg-[color-mix(in_srgb,var(--tint)_16%,transparent)] hover:text-foreground [&_svg]:size-3.5";
const hideOnHover = "group-hover/pin:hidden group-has-[:focus-visible]/pin:hidden";
// Room at a row's end for its … button, so its name truncates before it.
const roomForMore = "group-hover/pin:pr-8 group-has-[:focus-visible]/pin:pr-8";

/**
 * A pin's name, edited in place where it shows, on a row with the editing surface.
 * Enter or leaving it saves, Escape keeps the old name, and whichever comes first ends it, so the
 * blur that follows Enter or Escape saves nothing more.
 */
function NameField({
  label,
  value,
  onDone,
}: {
  label: string;
  value: string;
  onDone: (name: string | undefined) => void;
}) {
  const done = useRef(false);
  const finish = (name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      aria-label={label}
      defaultValue={value}
      autoFocus
      spellCheck={false}
      autoComplete="off"
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Enter and Escape belong to an input method while it composes.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(undefined);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="min-w-0 flex-1 bg-transparent p-0 text-foreground caret-(--tint) selection:bg-[color-mix(in_srgb,var(--tint)_35%,transparent)] focus-visible:outline-none"
    />
  );
}

function PinItem({
  pin,
  dragging,
  renaming,
  draggable,
  menuId,
  onMenu,
  onOpen,
  onRename,
  onStartRename,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onRest,
  onLeave,
  onKeyDown,
  drop,
}: {
  pin: Pin;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  /** Where something dragged over it would land. */
  drop?: "before" | "after";
  dragging: boolean;
  renaming: boolean;
  draggable: boolean;
  menuId: string;
  onMenu: () => void;
  onOpen: () => void;
  onRename: (title: string | undefined) => void;
  onStartRename: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onRest: (el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const self = useArrival<HTMLLIElement>("scale(.94)");
  const bold = news(pin.attention);
  const state = pin.selected ? "on" : "rest";
  const icon = (
    <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
      {pin.icon}
    </span>
  );
  // While renaming, the row is the field's frame, not a button that drags or opens.
  const body = renaming ? (
    <div className={`${rowLook} ${plainSurface.editing}`}>
      {icon}
      <NameField label="Title" value={pin.title} onDone={onRename} />
    </div>
  ) : (
    <button
      type="button"
      data-row={pin.key}
      aria-current={pin.selected ? "page" : undefined}
      onKeyDown={onKeyDown}
      draggable={draggable}
      onClick={onOpen}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-pin-title]")) return;
        e.preventDefault();
        onStartRename();
      }}
      onContextMenu={(e) => {
        onLeave();
        onMenu();
        openOnContextMenu(e, more.current);
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`${rowLook} focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] ${roomForMore} ${plainSurface[state]}`}
    >
      {icon}
      <span
        data-pin-title
        className={`min-w-0 flex-1 truncate ${bold ? "font-medium text-foreground" : pin.selected ? "text-foreground" : "text-foreground/80"}`}
      >
        {pin.title}
      </span>
      {/* What finished, failed, or waits says so; work in progress is only an icon. */}
      <span className={`flex shrink-0 items-center ${hideOnHover}`}>
        <Status attention={pin.attention} words={bold} />
      </span>
    </button>
  );
  return (
    <li
      ref={self}
      data-pin={pin.key}
      style={tinted(pin.tint)}
      className={`group/pin relative list-none transition-[opacity,transform] duration-150 ${dragging ? "opacity-40" : ""}`}
      onMouseEnter={(e) => onRest(e.currentTarget)}
      onMouseLeave={onLeave}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {(drop === "before" || drop === "after") && <DropLine edge={drop} />}
      {body}
      {!renaming && (
        <button
          ref={more}
          type="button"
          aria-label={`${pin.title} actions`}
          title="Actions"
          popoverTarget={menuId}
          onClick={onMenu}
          className={`absolute top-1/2 right-1 -translate-y-1/2 ${moreButton}`}
        >
          <Ellipsis />
        </button>
      )}
    </li>
  );
}

/** Where a dragged row would land, before or after the row it's over: a line from a ring. */
function DropLine({ edge }: { edge: "before" | "after" }) {
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

/** A pin's status, as its mark, and with `words`, its word. */
function Status({ attention, words }: { attention: Attention; words?: boolean }) {
  // Done animates only on a change from another state, and a change rises into place, as
  // AttentionBadge's do.
  const [shown, setShown] = useState(attention);
  const [animate, setAnimate] = useState(false);
  const [changed, setChanged] = useState(false);
  if (shown !== attention) {
    setShown(attention);
    setAnimate(attention === "done");
    setChanged(true);
  }
  const look = `flex items-center gap-1 text-meta font-medium [&_svg]:size-3.5 ${changed ? "rise-in" : ""}`;
  switch (attention) {
    case "needsYou":
      return (
        <span key={attention} className={`${look} text-warning`}>
          <MessageCircleQuestion aria-label="Needs you" />
          {words && "Needs you"}
        </span>
      );
    case "failed":
      return (
        <span key={attention} className={`${look} text-danger`}>
          <CircleAlert aria-label="Failed" />
          {words && "Failed"}
        </span>
      );
    case "done":
      return (
        <span key={attention} className={`${look} text-added`}>
          <DoneMark animate={animate} />
          {words && "Done"}
        </span>
      );
    case "working":
      return (
        <span key={attention} className={`${look} text-working`}>
          <WorkingMark />
          {words && "Working"}
        </span>
      );
    case "monitoring":
    case "waiting":
      return (
        <span key={attention} className={`${look} text-working`}>
          <Eye aria-label="Watching" />
          {words && (attention === "monitoring" ? "Monitoring" : "Waiting")}
        </span>
      );
    default:
      return null;
  }
}
