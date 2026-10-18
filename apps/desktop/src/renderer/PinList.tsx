// The sidebar's pinned threads (pins.ts, 0075): rows under the favorites, in folders that nest,
// in the order the user drags them into.
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleDot,
  Ellipsis,
  Eye,
  Folder,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  MessageCircleQuestion,
  Palette,
  PencilLine,
  PinOff,
  Plus,
  Star,
  Ungroup,
  X,
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
import { iconColors } from "./projectIcons";
import {
  addToFolder,
  containerOf,
  createFolder,
  folderWithin,
  draggedPin,
  entriesOf,
  forgetPin,
  makeFolder,
  moveOut,
  moveToEnd,
  pinDragType,
  pinIcons,
  pinLayout,
  pinHintHidden,
  pinNaming,
  pinOpen,
  placeAt,
  setDraggedPin,
  startIn,
  ungroup,
  updateFolder,
  wrapInFolder,
  type PinEntry,
} from "./pins";
import type { FavoriteAction } from "./Favorites";
import { MenuKey } from "./Sidebar";
import { shownRows, Tick } from "./SidebarParts";
import { dragThread, draggedThread, threadDragType } from "./threadDrag";
import { Menu, menuHeading, menuItem, openOnContextMenu } from "./ui";

/** One pinned thread. */
export interface Pin {
  /** `<host>/<id>`, as the sidebar keys its rows. */
  key: string;
  title: string;
  icon: ReactNode;
  /** The CSS color its icon's tinted with, as a folder's is. */
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

type Folder = Extract<PinEntry, { kind: "folder" }>;

const news = (a: Attention) => a === "done" || a === "failed" || a === "needsYou";
const busy = (a: Attention) => a === "working" || a === "monitoring" || a === "waiting";
const urgency: Attention[] = ["needsYou", "failed", "done", "working", "monitoring", "waiting"];
const topOf = (pins: Pin[]) => urgency.find((a) => pins.some((p) => p.attention === a));
const reduced = () => document.documentElement.classList.contains("reduce-motion");
const tinted = (tint: string) => ({ "--tint": tint }) as CSSProperties;
// A folder's colors: the icons' palette, with no color, faint, in place of the accent.
const folderColors = iconColors.map((c) =>
  c.key ? c : { ...c, label: "No color", fill: "bg-faint-foreground" },
);

/**
 * Grows an element in as it arrives, as when a thread is pinned or a folder opens, but not on the
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
 * on the user, its status in words. Dropping a row on another's top or bottom edge places it there,
 * on its middle makes a folder of the two, or files it in the folder; dropping a thread row here
 * pins it. Searching, matches show flat, outside their folders.
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
  onNewThread,
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
  /** Opens New thread, for a folder's New thread, which files what it starts there. */
  onNewThread: () => void;
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
  const folderTint = (color?: string) =>
    color ? `var(--project-${color})` : "var(--faint-foreground)";
  const byKey = new Map(pins.map((p) => [p.key, p]));
  const pinOf = (key: string) => byKey.get(key)!;
  const entries: PinEntry[] = searching
    ? pins.map((p) => ({ kind: "pin", key: p.key }))
    : entriesOf(
        layout,
        pins.map((p) => p.key),
      );
  // Open folders, several at once as in Finder, kept across launches.
  const openList = pinOpen.use();
  const isOpen = (id: string) => openList.includes(id);
  const setOpen = (id: string, open: boolean) =>
    pinOpen.set(
      open ? [...openList.filter((x) => x !== id), id] : openList.filter((x) => x !== id),
    );
  // Every folder shown, nested ones after the folder holding them, with how deep each sits.
  const allFolders = (list: PinEntry[], depth = 0): { entry: Folder; depth: number }[] =>
    list.flatMap((e) =>
      e.kind === "folder" ? [{ entry: e, depth }, ...allFolders(e.children, depth + 1)] : [],
    );
  const folderList = allFolders(entries);
  // The folders holding the open thread, at any depth, open, so its row shows.
  const holdingSelected = folderList
    .filter((f) => f.entry.keys.some((k) => byKey.get(k)?.selected))
    .map((f) => f.entry.id)
    .join(" ");
  useEffect(() => {
    if (!holdingSelected) return;
    const closed = holdingSelected.split(" ").filter((id) => !isOpen(id));
    if (closed.length) pinOpen.set([...openList.filter((x) => !closed.includes(x)), ...closed]);
  }, [holdingSelected]);
  // Among rows, where something dragged would land: before or after a row, or into it.
  const [dropAt, setDropAt] = useState<{ key: string; edge: "before" | "after" | "into" }>();
  // A folder the add palette just made opens to be named.
  const naming = pinNaming.use();
  useEffect(() => {
    if (!naming) return;
    setOpen(naming, true);
    setRenaming(`folder:${naming}`);
    pinNaming.set(null);
  }, [naming]);
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

  // The folder holding `key` directly, at any depth.
  const folderOf = (key: string) =>
    folderList.find((f) => f.entry.children.some((c) => c.kind === "pin" && c.key === key))?.entry;
  const endDrag = () => {
    setDraggedPin(undefined);
    setDragKey(undefined);
    setRowOver(false);
    setDropAt(undefined);
  };
  const isPinDrag = (e: DragEvent) => e.dataTransfer.types.includes(pinDragType);
  const isRowDrag = (e: DragEvent) =>
    !isPinDrag(e) && e.dataTransfer.types.includes(threadDragType);
  // A row dropped somewhere: pins it, then files it as `then` says.
  const pinRow = (e: DragEvent, then?: (key: string) => void) => {
    const row = draggedThread(e.dataTransfer);
    if (!row) return;
    onPinThread(row.hostId, row.runId);
    then?.(`${row.hostId}/${row.runId}`);
  };
  const newFolder = (target: string, key: string) => {
    const id = makeFolder(entries, target, key);
    setOpen(id, true);
    setRenaming(`folder:${id}`);
  };

  // Dropped on a row's top or bottom, a pin or folder goes before or after it, in whatever folder
  // holds that row; on its middle, into it: into a folder, or into a new folder with the row's pin,
  // nested where that pin is. A folder goes only into a folder outside itself.
  const dropRow = (target: string, folderId?: string) => {
    return {
      onDragOver: (e: DragEvent) => {
        const pin = draggedPin();
        if (isPinDrag(e) ? !pin || pin.key === target : !isRowDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const y = (e.clientY - box.top) / box.height;
        const nests =
          pin?.kind !== "folder" ||
          (!!folderId && !folderWithin(layout, folderId, pin.key.slice("folder:".length)));
        const into = nests && y > 0.28 && y < 0.72;
        const edge = into ? "into" : y < 0.5 ? "before" : "after";
        setDropAt((d) => (d?.key === target && d.edge === edge ? d : { key: target, edge }));
      },
      onDragLeave: (e: DragEvent) => {
        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
        setDropAt((d) => (d?.key === target ? undefined : d));
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const edge = dropAt?.key === target ? dropAt.edge : "after";
        const place = (key: string) => {
          // After an open folder's row is first in it, where the line draws.
          if (edge === "after" && folderId && isOpen(folderId))
            return addToFolder(entries, folderId, key, true);
          if (edge !== "into")
            return placeAt(
              entries,
              key,
              folderId ? `folder:${folderId}` : target,
              edge === "after",
            );
          if (folderId) addToFolder(entries, folderId, key);
          else newFolder(target, key);
        };
        const pin = draggedPin();
        if (isPinDrag(e) && pin) {
          place(pin.key);
          onPlaced?.(pin.key);
        } else pinRow(e, place);
        endDrag();
      },
    };
  };
  const item = (pin: Pin) => (
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
  const folderItem = (entry: Folder) => (
    <FolderItem
      key={entry.id}
      rowKey={`folder:${entry.id}`}
      renaming={renaming === `folder:${entry.id}`}
      onRename={(name) => {
        setRenaming(undefined);
        if (name !== undefined) updateFolder(entry.id, { name: name.trim() || "Folder" });
      }}
      onStartRename={() => setRenaming(`folder:${entry.id}`)}
      onKeyDown={(e) => {
        if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          return setRenaming(`folder:${entry.id}`);
        }
        if (e.key === "ArrowRight" && !isOpen(entry.id)) return setOpen(entry.id, true);
        if (e.key === "ArrowLeft" && isOpen(entry.id)) return setOpen(entry.id, false);
        rowNav(e);
      }}
      name={entry.folder.name}
      tint={folderTint(entry.folder.color)}
      pins={entry.keys.map(pinOf)}
      open={isOpen(entry.id)}
      drop={dropAt?.key === `folder:${entry.id}` ? dropAt.edge : undefined}
      dragging={dragKey === `folder:${entry.id}`}
      draggable={!searching}
      onDragStart={(e) => {
        setDraggedPin({ key: `folder:${entry.id}`, kind: "folder" });
        setDragKey(`folder:${entry.id}`);
        e.dataTransfer.setData(pinDragType, `folder:${entry.id}`);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      menuId={menuId}
      onMenu={() => setMenuFor(`folder:${entry.id}`)}
      onToggle={() => setOpen(entry.id, !isOpen(entry.id))}
      onNewThread={() => {
        startIn.set(entry.id);
        setOpen(entry.id, true);
        onNewThread();
      }}
      {...dropRow(`folder:${entry.id}`, entry.id)}
    />
  );
  const editing = menuFor ? byKey.get(menuFor) : undefined;
  const editingFolder = menuFor?.startsWith("folder:")
    ? folderList.find((f) => `folder:${f.entry.id}` === menuFor)?.entry
    : undefined;

  // A level of rows: each pin, and each folder with what's in it under it, a level in on a guide
  // line, always there so opening and closing can slide, and inert while closed.
  const tree = (list: PinEntry[]): ReactNode =>
    list.map((entry) =>
      entry.kind === "pin" ? (
        item(pinOf(entry.key))
      ) : (
        <Fragment key={entry.id}>
          {folderItem(entry)}
          <li
            key={`open-${entry.id}`}
            inert={!isOpen(entry.id)}
            className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${isOpen(entry.id) ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
          >
            <div className="min-h-0 overflow-hidden">
              <ul className="mt-px mb-1 ml-[15px] flex flex-col gap-px border-l border-border pl-1">
                {tree(entry.children)}
                {entry.children.length === 0 && (
                  <li className="px-2 py-1 text-[12px] text-faint-foreground">Drop threads here</li>
                )}
              </ul>
            </div>
          </li>
        </Fragment>
      ),
    );
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
          moveToEnd(entries, pin.key);
          onPlaced?.(pin.key);
        } else pinRow(e);
        endDrag();
      }}
      className="flex flex-col gap-px"
    >
      <ul className="flex flex-col gap-px">{tree(entries)}</ul>
      {rowOver && (
        <div className="grow-in grid h-8 place-items-center rounded-md border border-dashed border-accent/50 bg-accent/5 text-[12px] font-medium text-accent">
          Drop to pin
        </div>
      )}
      {pins.length === 0 && !rowOver && searching && (
        <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-center text-[12px] leading-snug text-faint-foreground">
          No pins match
        </p>
      )}
      {pins.length === 0 && !rowOver && !searching && !hintHidden && (
        <div className="relative rounded-[10px] border border-dashed border-border px-6 py-3 text-center text-[12px] leading-snug text-faint-foreground">
          Drag a thread here, or press P on it, to keep it here.
          <button
            type="button"
            aria-label="Hide this hint"
            title="Hide this hint"
            onClick={() => pinHintHidden.set(true)}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
          >
            <X aria-hidden />
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
            {folderList.some(({ entry: f }) => folderOf(editing.key)?.id !== f.id) && (
              <p role="presentation" className={menuHeading}>
                Move to folder
              </p>
            )}
            {folderList.map(
              ({ entry: f, depth }) =>
                folderOf(editing.key)?.id !== f.id && (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    onClick={close(() => addToFolder(entries, f.id, editing.key))}
                  >
                    <FolderClosed tint={folderTint(f.folder.color)} />
                    {f.folder.name}
                  </button>
                ),
            )}
            {folderOf(editing.key) ? (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => moveOut(entries, editing.key))}
              >
                <FolderOutput aria-hidden />
                Take out of folder
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => {
                  const id = wrapInFolder(entries, editing.key);
                  setOpen(id, true);
                  setRenaming(`folder:${id}`);
                })}
              >
                <FolderPlus aria-hidden />
                New folder
              </button>
            )}
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
        {editingFolder && (
          <>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => {
                setOpen(editingFolder.id, true);
                setRenaming(`folder:${editingFolder.id}`);
              })}
            >
              <PencilLine aria-hidden />
              Rename folder
              <MenuKey>R</MenuKey>
            </button>
            <div role="group" aria-label="Color" className="flex justify-between px-2.5 py-2">
              {folderColors.map((c) => {
                const checked = editingFolder.folder.color === c.key;
                return (
                  <button
                    key={c.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    aria-label={c.label}
                    title={c.label}
                    onClick={close(() => updateFolder(editingFolder.id, { color: c.key }))}
                    className={`grid size-3.5 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${c.fill}`}
                  >
                    {checked && (
                      <Check aria-hidden strokeWidth={3.5} className="size-2.5 text-background" />
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => {
                const id = createFolder(editingFolder.id);
                pinOpen.set([
                  ...pinOpen.get().filter((x) => x !== editingFolder.id),
                  editingFolder.id,
                  id,
                ]);
                setRenaming(`folder:${id}`);
              })}
            >
              <FolderPlus aria-hidden />
              New folder inside
            </button>
            {folderList.some(
              ({ entry: f }) =>
                f.id !== editingFolder.id &&
                !folderWithin(layout, f.id, editingFolder.id) &&
                containerOf(layout, `folder:${editingFolder.id}`) !== f.id,
            ) && (
              <p role="presentation" className={menuHeading}>
                Move to folder
              </p>
            )}
            {folderList.map(
              ({ entry: f, depth }) =>
                f.id !== editingFolder.id &&
                !folderWithin(layout, f.id, editingFolder.id) &&
                containerOf(layout, `folder:${editingFolder.id}`) !== f.id && (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    onClick={close(() => addToFolder(entries, f.id, `folder:${editingFolder.id}`))}
                  >
                    <FolderClosed tint={folderTint(f.folder.color)} />
                    {f.folder.name}
                  </button>
                ),
            )}
            {containerOf(layout, `folder:${editingFolder.id}`) && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={close(() => moveOut(entries, `folder:${editingFolder.id}`))}
              >
                <FolderOutput aria-hidden />
                Take out of folder
              </button>
            )}
            <hr className="my-1 border-border" />
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={close(() => ungroup(entries, editingFolder.id))}
            >
              <Ungroup aria-hidden />
              Ungroup
            </button>
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

/** Runs `then` after closing the menu it's in. */
const close = (then: () => void) => (e: { currentTarget: HTMLElement }) => {
  e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
  then();
};

// A row's surface: with something dragged into it, open, at rest, or its name being edited.
const plainSurface = {
  target:
    "bg-[color-mix(in_srgb,var(--tint)_14%,transparent)] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--tint)_55%,transparent)]",
  on: "bg-selected",
  rest: "hover:bg-hover",
  editing:
    "bg-[color-mix(in_srgb,var(--tint)_10%,var(--selected))] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--tint)_70%,transparent)]",
};
const rowLook =
  "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] transition-[background-color,transform] duration-100 outline-none";
const moreButton =
  "grid size-5.5 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/pin:opacity-100 group-has-[:focus-visible]/pin:opacity-100 hover:bg-[color-mix(in_srgb,var(--tint)_16%,transparent)] hover:text-foreground [&_svg]:size-3.5";
const hideOnHover = "group-hover/pin:hidden group-has-[:focus-visible]/pin:hidden";
// Room at a row's end for its hover buttons, so its name truncates before them: a pin's …, and a
// folder's + and ….
const roomForMore = "group-hover/pin:pr-8 group-has-[:focus-visible]/pin:pr-8";
const roomForTwo = "group-hover/pin:pr-14 group-has-[:focus-visible]/pin:pr-14";

/**
 * A pin's or folder's name, edited in place where it shows, on a row with the editing surface.
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
  drop?: "before" | "after" | "into";
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
  const state = drop === "into" ? "target" : pin.selected ? "on" : "rest";
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

/** A folder: its name, and what's in it finished, failed, or is working on, or how many. */
function FolderItem({
  name,
  tint,
  pins,
  open,
  menuId,
  onMenu,
  onToggle,
  onNewThread,
  onDragOver,
  onDragLeave,
  onDrop,
  drop,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
  renaming,
  onRename,
  onStartRename,
  onKeyDown,
  rowKey,
}: {
  /** `folder:<id>`, its place in the sidebar's keyboard order. */
  rowKey: string;
  /** Its name is being edited in place. */
  renaming: boolean;
  /** Ends a rename: saves `name`, or with undefined, keeps the old one. */
  onRename: (name: string | undefined) => void;
  /** Starts a rename, as double-clicking its name does. */
  onStartRename: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  /** Starts a thread that's filed in the folder once it starts. */
  onNewThread: () => void;
  /** Where something dragged over it would land. */
  drop?: "before" | "after" | "into";
  dragging: boolean;
  /** Whether it can be dragged to a new place. */
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  name: string;
  tint: string;
  pins: Pin[];
  open: boolean;
  menuId: string;
  onMenu: () => void;
  onToggle: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const top = topOf(pins);
  const bold = pins.some((p) => news(p.attention));
  const icon = (
    <span className="grid size-4 shrink-0 place-items-center text-[color-mix(in_srgb,var(--tint)_80%,var(--foreground))] [&_svg]:size-4">
      {open ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
    </span>
  );
  // While renaming, the row is the field's frame, not a button that drags or toggles.
  const body = renaming ? (
    <div className={`${rowLook} ${plainSurface.editing}`}>
      {icon}
      <NameField label="Folder name" value={name} onDone={onRename} />
    </div>
  ) : (
    <button
      type="button"
      data-row={rowKey}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-folder-name]")) return;
        e.preventDefault();
        onStartRename();
      }}
      onContextMenu={(e) => {
        onMenu();
        openOnContextMenu(e, more.current);
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`${rowLook} focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] ${roomForTwo} ${plainSurface[drop === "into" ? "target" : "rest"]}`}
    >
      {icon}
      <span
        data-folder-name
        className={`min-w-0 flex-1 truncate ${bold ? "font-medium text-foreground" : "text-foreground/80"}`}
      >
        {name}
      </span>
      <span
        className={`flex shrink-0 items-center gap-1 text-[11.5px] text-faint-foreground tabular-nums ${hideOnHover}`}
      >
        {top && news(top) ? (
          <Status attention={top} words />
        ) : top && busy(top) ? (
          <Status attention={top} />
        ) : (
          pins.length > 0 && <Tick value={pins.length} />
        )}
      </span>
    </button>
  );
  return (
    <li
      style={tinted(tint)}
      className={`group/pin relative list-none transition-[opacity,transform] duration-150 ${dragging ? "opacity-40" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {(drop === "before" || drop === "after") && <DropLine edge={drop} />}
      {body}
      {!renaming && (
        <>
          <button
            type="button"
            aria-label={`New thread in ${name}`}
            title={`New thread in ${name}`}
            onClick={onNewThread}
            className={`absolute top-1/2 right-7 -translate-y-1/2 ${moreButton}`}
          >
            <Plus />
          </button>
          <button
            ref={more}
            type="button"
            aria-label={`${name} actions`}
            title="Actions"
            popoverTarget={menuId}
            onClick={onMenu}
            className={`absolute top-1/2 right-1 -translate-y-1/2 ${moreButton}`}
          >
            <Ellipsis />
          </button>
        </>
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

/** A folder's glyph in its color, for a menu row. */
function FolderClosed({ tint }: { tint: string }) {
  return (
    <span
      style={tinted(tint)}
      className="flex text-[color-mix(in_srgb,var(--tint)_80%,var(--foreground))]"
    >
      <Folder aria-hidden />
    </span>
  );
}

/** A pin's or folder's status, as its mark, and with `words`, its word. */
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
  const look = `flex items-center gap-1 text-[11.5px] font-medium [&_svg]:size-3.5 ${changed ? "rise-in" : ""}`;
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
