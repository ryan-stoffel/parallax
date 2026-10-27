import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useBrowserTheme } from "./browserTheme";
import { stored } from "./stored";
import {
  ChevronRight,
  CloseSmall,
  CreateNewFolder,
  Delete,
  DoubleArrowRight,
  Edit,
  Folder,
  Public,
  Star,
  StarFilled,
  Tab,
} from "./symbols";
import { ConfirmDialog, Menu, menuItem, menuPanel, openOnContextMenu } from "./ui";

// The browser's bookmarks (PLX-968): one tree, shared by every browser, a thread's and a
// Project's, and kept on this computer. Its top level is the bookmarks bar, and a
// folder holds bookmarks and other folders, as Chrome's do.

/** A bookmarked page, with its title and icon as they were when it was added. */
export interface Bookmark {
  url: string;
  title?: string;
  icon?: string;
}

/** A folder of bookmarks and folders. */
export interface BookmarkFolder {
  id: string;
  title: string;
  children: BookmarkNode[];
}

export type BookmarkNode = Bookmark | BookmarkFolder;

export const isFolder = (node: BookmarkNode): node is BookmarkFolder => "children" in node;

// The longest icon kept, in characters of its data URL, as for saved tabs (Browser.tsx).
const MAX_ICON = 16_384;

/** The well-formed nodes of what's stored, dropping anything else. */
function parseNodes(raw: unknown): BookmarkNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n: unknown): BookmarkNode[] => {
    const node = n as Partial<BookmarkFolder & Bookmark> | null;
    if (typeof node?.url === "string") return [node as Bookmark];
    if (typeof node?.id === "string" && typeof node.title === "string")
      return [{ id: node.id, title: node.title, children: parseNodes(node.children) }];
    return [];
  });
}

export const bookmarks = stored<BookmarkNode[]>("parallax.bookmarks", [], parseNodes);

/** Whether the bookmarks bar shows, while there are bookmarks. */
export const bookmarksBar = stored<boolean>("parallax.bookmarksBar", true, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** The bookmark of `url` anywhere in `nodes`, and the id of the folder it's in, if any. */
export function findBookmark(
  nodes: readonly BookmarkNode[],
  url: string,
  folder?: string,
): { bookmark: Bookmark; folder?: string } | undefined {
  for (const node of nodes) {
    if (!isFolder(node)) {
      if (node.url === url) return { bookmark: node, ...(folder && { folder }) };
    } else {
      const found = findBookmark(node.children, url, node.id);
      if (found) return found;
    }
  }
  return undefined;
}

/** `nodes` without any node `drop` picks, at any depth. */
function without(
  nodes: readonly BookmarkNode[],
  drop: (node: BookmarkNode) => boolean,
): BookmarkNode[] {
  return nodes
    .filter((node) => !drop(node))
    .map((node) => (isFolder(node) ? { ...node, children: without(node.children, drop) } : node));
}

/** `nodes` with `node` added at the end of folder `folder`, or of the bar. */
function inserted(
  nodes: readonly BookmarkNode[],
  folder: string | undefined,
  node: BookmarkNode,
): BookmarkNode[] {
  if (!folder) return [...nodes, node];
  return nodes.map((n) =>
    isFolder(n)
      ? n.id === folder
        ? { ...n, children: [...n.children, node] }
        : { ...n, children: inserted(n.children, folder, node) }
      : n,
  );
}

/** `nodes` with each node `pick` picks changed by `change`, at any depth. */
function changed(
  nodes: readonly BookmarkNode[],
  pick: (node: BookmarkNode) => boolean,
  change: (node: BookmarkNode) => BookmarkNode,
): BookmarkNode[] {
  return nodes.map((node) => {
    const next = pick(node) ? change(node) : node;
    return isFolder(next) ? { ...next, children: changed(next.children, pick, change) } : next;
  });
}

const isUrl = (url: string) => (node: BookmarkNode) => !isFolder(node) && node.url === url;
const isId = (id: string) => (node: BookmarkNode) => isFolder(node) && node.id === id;

const removedBookmark = (nodes: readonly BookmarkNode[], url: string) => without(nodes, isUrl(url));

/** `nodes` without folder `id` and everything in it. */
export const removedFolder = (nodes: readonly BookmarkNode[], id: string) =>
  without(nodes, isId(id));

/**
 * `nodes` with `page` bookmarked at the bar's end, or with its bookmark removed wherever it is.
 * Its icon, a data URL (main.ts), is kept only when small, as a favicon is.
 */
export function toggled(nodes: readonly BookmarkNode[], page: Bookmark): BookmarkNode[] {
  if (findBookmark(nodes, page.url)) return removedBookmark(nodes, page.url);
  return [
    ...nodes,
    {
      url: page.url,
      ...(page.title && { title: page.title }),
      ...(page.icon && page.icon.length <= MAX_ICON && { icon: page.icon }),
    },
  ];
}

/** `nodes` with the bookmark of `url` moved to the end of folder `folder`, or of the bar. */
export function moved(nodes: readonly BookmarkNode[], url: string, folder: string | undefined) {
  const found = findBookmark(nodes, url);
  if (!found) return [...nodes];
  return inserted(removedBookmark(nodes, url), folder, found.bookmark);
}

/** `nodes` with a new folder `title` at the end of `parent`, or of the bar, and its id. */
export function withFolder(
  nodes: readonly BookmarkNode[],
  title: string,
  parent?: string,
): [BookmarkNode[], string] {
  const id = crypto.randomUUID();
  return [inserted(nodes, parent, { id, title, children: [] }), id];
}

const renamedBookmark = (nodes: readonly BookmarkNode[], url: string, title: string) =>
  changed(nodes, isUrl(url), (node) => ({ ...node, title }));

const renamedFolder = (nodes: readonly BookmarkNode[], id: string, title: string) =>
  changed(nodes, isId(id), (node) => ({ ...node, title }));

/**
 * `nodes` with the bookmark of `url` given `icon`, when it has none and the icon is small, or
 * `nodes` itself when that changes nothing, so setting it again doesn't loop.
 */
export function withIcon(
  nodes: readonly BookmarkNode[],
  url: string,
  icon: string | undefined,
): readonly BookmarkNode[] {
  const found = findBookmark(nodes, url);
  if (!icon || icon.length > MAX_ICON || !found || found.bookmark.icon) return nodes;
  return changed(
    nodes,
    (node) => isUrl(url)(node) && !(node as Bookmark).icon,
    (node) => ({ ...node, icon }),
  );
}

/** How many bookmarks folder `id` holds, its folders' included. */
export function countIn(nodes: readonly BookmarkNode[], id: string): number {
  const count = (list: readonly BookmarkNode[]): number =>
    list.reduce((n, node) => n + (isFolder(node) ? count(node.children) : 1), 0);
  for (const node of nodes) {
    if (!isFolder(node)) continue;
    if (node.id === id) return count(node.children);
    const inner = countIn(node.children, id);
    if (inner >= 0) return inner;
  }
  return -1;
}

/** Every folder, depth first, with how deep it is, for a folder picker. */
export function folderList(
  nodes: readonly BookmarkNode[],
  depth = 0,
): { id: string; title: string; depth: number }[] {
  return nodes.flatMap((node) =>
    isFolder(node)
      ? [{ id: node.id, title: node.title, depth }, ...folderList(node.children, depth + 1)]
      : [],
  );
}

const closePopover = (e: { currentTarget: HTMLElement }) =>
  e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();

// Closes a bookmark's menu and the folders' menus it was opened from, all the open popovers.
function closeAll() {
  for (const popover of document.querySelectorAll<HTMLElement>(":popover-open"))
    popover.hidePopover();
}

/**
 * The star at the end of the address bar, as Chrome's: a click bookmarks `page` at the bar's end
 * and opens its editor, where its name and folder change, or Remove takes it back; on a
 * bookmarked page it opens the editor. A page starred before its icon arrived gets it once it does.
 */
export function BookmarkStar({ page }: { page?: Bookmark }) {
  const tree = bookmarks.use();
  const found = page ? findBookmark(tree, page.url) : undefined;
  const editorId = useId();
  useEffect(() => {
    if (!found || !page?.icon) return;
    const next = withIcon(bookmarks.get(), found.bookmark.url, page.icon);
    if (next !== bookmarks.get()) bookmarks.set([...next]);
  }, [found, page?.icon]);
  return (
    <>
      <button
        type="button"
        aria-label={found ? "Edit bookmark" : "Bookmark this page"}
        title={found ? "Edit bookmark" : "Bookmark this page"}
        aria-pressed={!!found}
        disabled={!page}
        popoverTarget={editorId}
        onClick={() => page && !found && bookmarks.set(toggled(bookmarks.get(), page))}
        className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-0 aria-pressed:text-accent [&_svg]:size-3.5"
      >
        {found ? <StarFilled aria-hidden /> : <Star aria-hidden />}
      </button>
      {/* Outside the address bar's form, so Enter here doesn't open the address. */}
      {createPortal(
        <Themed>
          <BookmarkEditor id={editorId} url={page?.url} title="Bookmark" align="end" />
        </Themed>,
        document.body,
      )}
    </>
  );
}

/**
 * The bookmark of `url`'s editor, a popover with the id `id`: its name and folder, which change as
 * they're edited, a new folder, and Remove.
 */
function BookmarkEditor({
  id,
  url,
  title,
  align = "start",
}: {
  id: string;
  url?: string;
  title: string;
  align?: "start" | "end";
}) {
  const tree = bookmarks.use();
  const found = url ? findBookmark(tree, url) : undefined;
  const [adding, setAdding] = useState(false);
  const [folderName, setFolderName] = useState("");
  const addFolder = () => {
    if (!found || !folderName.trim()) return;
    const [next, folder] = withFolder(bookmarks.get(), folderName.trim(), found.folder);
    bookmarks.set(moved(next, found.bookmark.url, folder));
    setAdding(false);
    setFolderName("");
  };
  return (
    <div
      id={id}
      popover="auto"
      role="dialog"
      aria-label={title}
      onToggle={(e) => {
        if (e.newState === "open") e.currentTarget.querySelector("input")?.select();
        else setAdding(false);
      }}
      className={`${menuPanel(align)} w-72 p-3`}
    >
      {found && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (adding) addFolder();
            else closePopover(e);
          }}
          className="flex flex-col gap-2.5 text-body"
        >
          <p className="text-body font-medium">{title}</p>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Name</span>
            <input
              value={found.bookmark.title ?? ""}
              onChange={(e) =>
                bookmarks.set(renamedBookmark(bookmarks.get(), found.bookmark.url, e.target.value))
              }
              className="rounded-md bg-selected px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Folder</span>
            <select
              value={found.folder ?? ""}
              onChange={(e) =>
                bookmarks.set(
                  moved(bookmarks.get(), found.bookmark.url, e.target.value || undefined),
                )
              }
              className="rounded-md bg-selected px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Bookmarks bar</option>
              {folderList(tree).map((f) => (
                <option key={f.id} value={f.id}>
                  {" ".repeat(f.depth + 1)}
                  {f.title}
                </option>
              ))}
            </select>
          </label>
          {adding ? (
            <input
              autoFocus
              aria-label="New folder name"
              placeholder="New folder name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                setAdding(false);
              }}
              className="rounded-md bg-selected px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 self-start text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
            >
              <CreateNewFolder aria-hidden />
              New folder
            </button>
          )}
          <div className="flex justify-end gap-1.5 pt-1">
            <button
              type="button"
              onClick={(e) => {
                bookmarks.set(removedBookmark(bookmarks.get(), found.bookmark.url));
                closePopover(e);
              }}
              className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Remove
            </button>
            <button
              type="submit"
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-foreground"
            >
              {adding ? "Add folder" : "Done"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Folder `folderId`'s editor, a popover with the id `id`: its name, and Delete folder. */
function FolderEditor({
  id,
  folderId,
  onDelete,
}: {
  id: string;
  folderId?: string;
  onDelete: (id: string) => void;
}) {
  const tree = bookmarks.use();
  const folder = folderId ? folderList(tree).find((f) => f.id === folderId) : undefined;
  return (
    <div
      id={id}
      popover="auto"
      role="dialog"
      aria-label="Folder"
      onToggle={(e) => {
        if (e.newState === "open") e.currentTarget.querySelector("input")?.select();
      }}
      className={`${menuPanel()} w-64 p-3`}
    >
      {folder && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            closePopover(e);
          }}
          className="flex flex-col gap-2.5 text-body"
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Folder name</span>
            <input
              value={folder.title}
              onChange={(e) =>
                bookmarks.set(renamedFolder(bookmarks.get(), folder.id, e.target.value))
              }
              className="rounded-md bg-selected px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                closePopover(e);
                onDelete(folder.id);
              }}
              className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Delete folder
            </button>
            <button
              type="submit"
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-foreground"
            >
              Done
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** What a right-click on the bar was on: a bookmark by its url, a folder by its id, or neither. */
type Target = { url?: string; folder?: string };

/**
 * The bookmarks bar under a tab's toolbar, as Chrome and Helium draw it: the bar's bookmarks and
 * folders, as many as fit, and » for the rest. A bookmark's click opens it with `onOpen`, in the
 * tab, and a middle click or Mod-click in a new tab; a folder's opens its menu, where folders open
 * their own. Right-click offers Open in new tab, Edit, and Remove for a bookmark, Rename and
 * Delete for a folder, and Add folder anywhere on the bar. It shows only while turned on and not
 * empty.
 */
export function BookmarksBar({ onOpen }: { onOpen: (url: string, newTab: boolean) => void }) {
  const tree = bookmarks.use();
  const shown = bookmarksBar.use();
  const menuId = useId();
  const moreId = useId();
  const editorId = useId();
  const folderEditorId = useId();
  const [target, setTarget] = useState<Target>({});
  const [editing, setEditing] = useState<Target>({});
  // A folder with bookmarks in it asks before it goes, with them.
  const confirm = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState<{ id: string; count: number }>();
  const deleteFolder = (id: string) => {
    const count = countIn(bookmarks.get(), id);
    if (count <= 0) return bookmarks.set(removedFolder(bookmarks.get(), id));
    setDeleting({ id, count });
    confirm.current?.showModal();
  };
  const chips = useRef(new Map<string, HTMLElement>());
  // The context menu's anchor, moved under what was right-clicked.
  const anchor = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLElement>(null);
  // How many nodes fit before », measured after each layout and on every resize.
  const row = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(Infinity);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const end = el.getBoundingClientRect().right;
      const items = [...el.children] as HTMLElement[];
      const fit = items.findIndex((item) => item.getBoundingClientRect().right > end + 0.5);
      setFits(fit < 0 ? items.length : fit);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tree, shown]);
  if (!shown || !tree.length) return null;

  const keyOf = (t: Target) => (t.folder ? `f:${t.folder}` : `b:${t.url}`);
  const contextMenu = (e: MouseEvent<HTMLElement>, of: Target) => {
    e.stopPropagation();
    setTarget(of);
    const chip = of.url || of.folder ? chips.current.get(keyOf(of)) : undefined;
    const left = bar.current?.getBoundingClientRect().left ?? 0;
    if (anchor.current)
      anchor.current.style.left = `${(chip?.getBoundingClientRect().left ?? e.clientX) - left}px`;
    openOnContextMenu(e, anchor.current);
  };
  const edit = (of: Target) => {
    setEditing(of);
    const chip = chips.current.get(keyOf(of)) ?? anchor.current;
    // Beside the chip, which the app's popovers are positioned against.
    document
      .getElementById(of.url ? editorId : folderEditorId)
      ?.showPopover(chip ? { source: chip } : undefined);
  };
  const addFolder = () => {
    const [next, id] = withFolder(bookmarks.get(), "New folder");
    bookmarks.set(next);
    // Once the new folder's chip is drawn, its name editor opens beside it.
    requestAnimationFrame(() => edit({ folder: id }));
  };

  return (
    <nav
      ref={bar}
      aria-label="Bookmarks"
      onContextMenu={(e) => contextMenu(e, {})}
      className="relative flex h-7 shrink-0 items-center gap-0.5 px-2"
    >
      <div ref={row} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {tree.map((node, i) => {
          const of = isFolder(node) ? { folder: node.id } : { url: node.url };
          return (
            <span key={keyOf(of)} className={`shrink-0 ${i >= fits ? "invisible" : ""}`}>
              <NodeChip
                node={node}
                onOpen={onOpen}
                chipRef={(el) => {
                  if (el) chips.current.set(keyOf(of), el);
                  else chips.current.delete(keyOf(of));
                }}
                onContextMenu={(e) => contextMenu(e, of)}
              />
            </span>
          );
        })}
      </div>
      <button
        ref={anchor}
        type="button"
        tabIndex={-1}
        aria-hidden
        popoverTarget={menuId}
        className="pointer-events-none absolute bottom-0 size-0 opacity-0"
      />
      {fits < tree.length && (
        <>
          <button
            type="button"
            aria-label="More bookmarks"
            title="More bookmarks"
            aria-haspopup="menu"
            popoverTarget={moreId}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
          >
            <DoubleArrowRight aria-hidden />
          </button>
          <NodeMenu
            id={moreId}
            label="More bookmarks"
            align="end"
            nodes={tree.slice(fits)}
            onOpen={onOpen}
          />
        </>
      )}
      <Menu id={menuId} label="Bookmarks bar" className="w-48 p-1">
        {target.url && (
          <>
            <MenuButton icon={<Tab />} onClick={() => onOpen(target.url!, true)}>
              Open in new tab
            </MenuButton>
            <MenuButton icon={<Edit />} onClick={() => edit({ url: target.url })}>
              Edit…
            </MenuButton>
            <MenuButton
              icon={<Delete />}
              onClick={() => bookmarks.set(removedBookmark(bookmarks.get(), target.url!))}
            >
              Remove
            </MenuButton>
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        {target.folder && (
          <>
            <MenuButton icon={<Edit />} onClick={() => edit({ folder: target.folder })}>
              Rename…
            </MenuButton>
            <MenuButton icon={<Delete />} onClick={() => deleteFolder(target.folder!)}>
              Delete folder
            </MenuButton>
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        <MenuButton icon={<CreateNewFolder />} onClick={addFolder}>
          Add folder
        </MenuButton>
      </Menu>
      {createPortal(
        <Themed>
          <BookmarkEditor id={editorId} url={editing.url} title="Edit bookmark" />
          <FolderEditor id={folderEditorId} folderId={editing.folder} onDelete={deleteFolder} />
          <ConfirmDialog
            ref={confirm}
            title="Delete this folder?"
            action="Delete folder"
            onConfirm={() => {
              if (deleting) bookmarks.set(removedFolder(bookmarks.get(), deleting.id));
              confirm.current?.close();
            }}
          >
            Its {deleting?.count === 1 ? "bookmark goes" : `${deleting?.count} bookmarks go`} with
            it.
          </ConfirmDialog>
        </Themed>,
        document.body,
      )}
    </nav>
  );
}

/** A menu row that closes its menu once clicked. */
function MenuButton({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        closePopover(e);
        onClick();
      }}
      className={menuItem}
    >
      {icon}
      {children}
    </button>
  );
}

const chipClass =
  "flex h-6 max-w-44 items-center gap-1.5 rounded-md px-2 text-meta text-muted-foreground hover:bg-hover hover:text-foreground";

/** One of the bar's bookmarks or folders. A folder's opens its menu of what it holds. */
function NodeChip({
  node,
  onOpen,
  chipRef,
  onContextMenu,
}: {
  node: BookmarkNode;
  onOpen: (url: string, newTab: boolean) => void;
  chipRef: (el: HTMLElement | null) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}) {
  const menuId = useId();
  if (isFolder(node))
    return (
      <>
        <button
          ref={chipRef}
          type="button"
          aria-haspopup="menu"
          popoverTarget={menuId}
          onContextMenu={onContextMenu}
          className={chipClass}
        >
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{node.title || "Folder"}</span>
        </button>
        <NodeMenu id={menuId} label={node.title} nodes={node.children} onOpen={onOpen} />
      </>
    );
  return (
    <button
      ref={chipRef}
      type="button"
      title={node.url}
      onClick={(e) => onOpen(node.url, e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && onOpen(node.url, true)}
      onContextMenu={onContextMenu}
      className={chipClass}
    >
      <BookmarkIcon bookmark={node} />
      <span className="truncate">{node.title || node.url}</span>
    </button>
  );
}

/**
 * A menu of bookmarks and folders, a folder's or the bar's overflow: a bookmark opens as on the
 * bar, its × removes it, and a folder opens its own menu beside it.
 */
function NodeMenu({
  id,
  label,
  nodes,
  onOpen,
  align = "start",
}: {
  id: string;
  label: string;
  nodes: readonly BookmarkNode[];
  onOpen: (url: string, newTab: boolean) => void;
  align?: "start" | "end";
}) {
  return (
    <Menu
      id={id}
      label={label || "Folder"}
      align={align}
      className="max-h-96 w-64 overflow-y-auto p-1"
    >
      {nodes.length === 0 && <p className="px-2 py-1.5 text-body text-muted-foreground">Empty</p>}
      {nodes.map((node) =>
        isFolder(node) ? (
          <SubFolder key={node.id} folder={node} onOpen={onOpen} />
        ) : (
          <button
            key={node.url}
            type="button"
            role="menuitem"
            title={node.url}
            onClick={(e) => {
              onOpen(node.url, e.metaKey || e.ctrlKey);
              closeAll();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              onOpen(node.url, true);
              closeAll();
            }}
            className={`${menuItem} group`}
          >
            <BookmarkIcon bookmark={node} />
            <span className="min-w-0 flex-1 truncate">{node.title || node.url}</span>
            <span
              role="button"
              aria-label={`Remove ${node.title || node.url}`}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                bookmarks.set(removedBookmark(bookmarks.get(), node.url));
              }}
              className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground"
            >
              <CloseSmall aria-hidden className="size-4" />
            </span>
          </button>
        ),
      )}
    </Menu>
  );
}

/**
 * A folder inside a menu, which opens its own menu beside it. That menu is drawn outside this one,
 * so this one's arrow keys don't walk into it, and stays open over it, since its opener is here.
 */
function SubFolder({
  folder,
  onOpen,
}: {
  folder: BookmarkFolder;
  onOpen: (url: string, newTab: boolean) => void;
}) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        popoverTarget={id}
        className={menuItem}
      >
        <Folder aria-hidden />
        <span className="min-w-0 flex-1 truncate">{folder.title || "Folder"}</span>
        <ChevronRight aria-hidden />
      </button>
      {createPortal(
        <Themed>
          <NodeMenu id={id} label={folder.title} nodes={folder.children} onOpen={onOpen} />
        </Themed>,
        document.body,
      )}
    </>
  );
}

const BookmarkIcon = ({ bookmark }: { bookmark: Bookmark }) =>
  bookmark.icon ? (
    <img src={bookmark.icon} alt="" className="size-3.5 shrink-0" />
  ) : (
    <Public aria-hidden className="size-3.5 shrink-0" />
  );

/**
 * What's drawn outside the browser, such as an editor or a folder's menu over the page, in the
 * browser's theme, which the page's own elements take from the browser around them.
 */
function Themed({ children }: { children: ReactNode }) {
  return (
    <div className="contents" style={useBrowserTheme()}>
      {children}
    </div>
  );
}
