import { t } from "i18next";
import {
  ChevronRight,
  ListCollapse,
  Ellipsis,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderPlus,
  PanelLeft,
  Search,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentEntry, GrepMatch } from "../protocol/generated/protocol";
import { Marked } from "./CommandMenu";
import { rank } from "./commandSearch";
import { useConnectedNow } from "./ConnectionStatus";
import { describeError } from "./errors";
import { FileEditor } from "./FileEditor";
import { useShortcutLabel } from "./keybindings";
import { CHECK_EVERY_MS, openFilesOf } from "./openFiles";
import { FileIcon } from "./TurnChanges";
import { ConfirmDialog, IconButton, Menu, menuItem, openOnContextMenu, searchField } from "./ui";

/** From this wide, the tree sits beside the file, and a split Markdown view has room. */
const TREE_BESIDE_WIDTH = 720;
const TREE_WIDTH = 256;
const TREE_MIN_WIDTH = 170;
/** What the file keeps however wide the tree is dragged. */
const FILE_MIN_WIDTH = 360;
const TREE_WIDTH_KEY = "parallax.files.treeWidth";
/** How often the open folders are listed again, for what the agent changes. */
const RELIST_EVERY_MS = 5000;
/** How far a tree's level indents. */
const INDENT = 12;
/** How long a search waits after typing before it asks plxd about file contents. */
const GREP_AFTER_MS = 250;

/** A folder's entries once listed, or why they couldn't be. */
type Listing = { entries: AgentEntry[]; truncated: boolean; folder?: string } | { error: string };

/** A name being typed in the tree: a new entry in `folder`, or a new name for `path`. */
type Draft = { folder: string; isFolder: boolean } | { path: string };

/** An entry the menu or Delete acts on. */
type Target = { path: string; isFolder: boolean };

/** Folders first, then by name, as a file browser lists them. */
const byKind = (a: AgentEntry, b: AgentEntry) =>
  Number(b.kind === "dir") - Number(a.kind === "dir") || (a.name < b.name ? -1 : 1);

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** `path` after `from` moved to `to`, so what's inside a renamed folder follows it. */
const moved = (path: string, from: string, to: string) =>
  inside(path, from) ? to + path.slice(from.length) : path;

/** plxd's reason a change failed, without JSON-RPC's prefix. */
const reason = (error: RpcError) => describeError(error).replace(/^Invalid params: /, "");

/** `folder` of the run's folder, "" for the folder itself. */
async function listFolder(hostId: string, runId: string, folder: string): Promise<Listing> {
  const listed = await window.parallax.request(hostId, "agent/files", {
    runId,
    ...(folder && { path: folder }),
  });
  return "error" in listed ? { error: describeError(listed.error) } : listed.result;
}

/**
 * The side panel's Files view (PLX-296, PLX-1428): a run's folder on its host, its worktree or a
 * Current checkout thread's checkout, as a tree beside an editor, or taking turns with it when
 * narrow. A folder lists from `agent/files`, and open folders list again every few seconds, so the
 * agent's new files show. Files open in tabs, which `openFiles` keeps and saves: on a plxd with
 * `fileWrite`, `writable` edits them. A single click opens a file in a preview tab, which the next
 * one replaces, and a double-click or an edit keeps it, as in VS Code and Zed. `unavailable` says why
 * it can't load, such as a plxd without the `files` capability.
 *
 * `editable`, on a plxd with `fileEdit` (PLX-590), adds New file and New folder above the tree
 * and a menu on each entry, on right-click or its `…`: New file, New folder, Rename, and Delete.
 * Names are typed in the tree, where Enter or leaving the field saves and Escape cancels; F2
 * renames the focused entry and Delete deletes it, after asking.
 *
 * Each new `reveal` opens its file in the view, as the command menu's file picks do (PLX-993).
 * `folder` is the run's folder on the host, which the open file's path starts from.
 */
export function FilesPanel({
  hostId,
  runId,
  folder,
  unavailable,
  editable,
  writable,
  grep,
  reveal,
}: {
  hostId: string;
  runId: string;
  folder?: string;
  unavailable?: string;
  editable?: boolean;
  writable?: boolean;
  /** Whether this plxd searches file contents (`repoGrep`). */
  grep?: boolean;
  reveal?: { path: string };
}) {
  // Each listed folder by path, the root's as "".
  const connectedNow = useConnectedNow(hostId);
  const store = openFilesOf(hostId, runId);
  store.writable = !!writable;
  const {
    tabs,
    active: activeId,
    home,
    closing,
  } = useSyncExternalStore(store.subscribe, store.get);
  const file = tabs.find((f) => f.id === activeId);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpandedNow] = useState(store.expanded);
  const setExpanded = (next: (prev: ReadonlySet<string>) => ReadonlySet<string>) =>
    setExpandedNow((prev) => (store.expanded = next(prev)));
  // How wide the view is, which decides whether the tree sits beside the file.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [!unavailable]);
  const beside = width >= TREE_BESIDE_WIDTH;
  const [treeBeside, setTreeBeside] = useState(true);
  const [treeWidth, setTreeWidth] = useState(
    () => Number(localStorage.getItem(TREE_WIDTH_KEY)) || TREE_WIDTH,
  );
  const treeMax = Math.max(TREE_MIN_WIDTH, width - FILE_MIN_WIDTH);
  const shownTreeWidth = Math.min(treeWidth, treeMax);
  const setWidthOfTree = (next: number) => {
    const clamped = Math.min(Math.max(next, TREE_MIN_WIDTH), treeMax);
    setTreeWidth(clamped);
    localStorage.setItem(TREE_WIDTH_KEY, String(clamped));
  };
  const dragSash = (e: PointerEvent<HTMLElement>) => {
    const start = e.clientX - shownTreeWidth;
    const sash = e.currentTarget;
    sash.setPointerCapture(e.pointerId);
    const move = (event: globalThis.PointerEvent) => setWidthOfTree(event.clientX - start);
    sash.addEventListener("pointermove", move);
    sash.addEventListener(
      "lostpointercapture",
      () => sash.removeEventListener("pointermove", move),
      {
        once: true,
      },
    );
  };
  // A tab whose edits can't land asks before it closes (OpenFiles.askClose).
  const closeDialog = useRef<HTMLDialogElement>(null);
  const closingFile = tabs.find((f) => f.id === closing);
  useEffect(() => {
    const dialog = closeDialog.current;
    if (!dialog || !closingFile) return;
    dialog.showModal();
    const cancel = () => store.settleClose(false);
    dialog.addEventListener("close", cancel);
    return () => dialog.removeEventListener("close", cancel);
  }, [store, closingFile]);

  /** Opens `path` from the tree or a search, which shows it in place of the tree when narrow. */
  const openFile = (path: string, options?: Parameters<typeof store.open>[1]) =>
    store.open(path, options);
  const treeRef = useRef<HTMLDivElement>(null);
  /** Opens the folders above `path` and scrolls its row into view. */
  const revealInTree = (path: string) => {
    const folders = path
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    setExpanded((prev) => new Set([...prev, ...folders]));
    void relist(...folders).then(() =>
      requestAnimationFrame(() =>
        treeRef.current
          ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
          ?.scrollIntoView?.({ block: "nearest" }),
      ),
    );
  };
  const showInFiles = (path: string) => {
    if (beside) setTreeBeside(true);
    else store.showHome(true);
    revealInTree(path);
  };

  const [draft, setDraft] = useState<Draft>();
  const [draftError, setDraftError] = useState<string>();
  // The draft on screen, and the one being saved, so Enter and the blur after it save once and a
  // save that ends after another draft opened leaves that one alone.
  const active = useRef<Draft>(undefined);
  const saving = useRef<Draft>(undefined);
  const [target, setTarget] = useState<Target>();
  const [toDelete, setToDelete] = useState<Target>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);

  const show = (folder: string) => (listing: Listing) =>
    setListings((prev) => ({ ...prev, [folder]: listing }));
  const relist = (...folders: string[]) =>
    Promise.all([...new Set(folders)].map((f) => listFolder(hostId, runId, f).then(show(f))));
  const shownFolders = useRef<string[]>([]);
  shownFolders.current = ["", ...expanded];
  useEffect(() => {
    if (unavailable || !connectedNow) return;
    void relist(...shownFolders.current);
    const timer = setInterval(() => {
      if (!document.hidden) void relist(...shownFolders.current);
    }, RELIST_EVERY_MS);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `relist` reads only these
  }, [hostId, runId, unavailable, connectedNow]);

  // The file on screen is checked for changes on disk, and saves that failed try again.
  useEffect(() => {
    if (unavailable || !connectedNow || activeId === undefined) return;
    const timer = setInterval(() => {
      if (!document.hidden) void store.check(activeId);
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [store, activeId, unavailable, connectedNow]);

  // A new `reveal` opens its file, kept, with the folders above it open in the tree.
  useEffect(() => {
    if (!reveal || store.revealed === reveal) return;
    store.revealed = reveal;
    openFile(reveal.path);
    revealInTree(reveal.path);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on a new reveal only
  }, [reveal, store]);

  // The tree follows the tab on screen when it sits beside it, as VS Code's Explorer does.
  const activePath = file?.path;
  useEffect(() => {
    if (activePath && beside && treeBeside) revealInTree(activePath);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on another file only
  }, [activePath, beside, treeBeside]);

  const toggle = (folder: string) => {
    if (expanded.has(folder))
      return setExpanded((prev) => new Set([...prev].filter((f) => f !== folder)));
    setExpanded((prev) => new Set(prev).add(folder));
    void listFolder(hostId, runId, folder).then(show(folder));
  };

  const startDraft = (next: Draft) => {
    if ("folder" in next && next.folder && !expanded.has(next.folder)) toggle(next.folder);
    active.current = next;
    setDraft(next);
    setDraftError(undefined);
  };
  const cancelDraft = () => {
    active.current = undefined;
    setDraft(undefined);
  };
  /** Creates or renames `d`'s entry as `value`; a blank or unchanged name just closes it. */
  const save = async (d: Draft, value: string) => {
    if (active.current !== d || saving.current === d) return;
    const name = value.trim();
    const from = "path" in d ? d.path : undefined;
    const folder = "path" in d ? parentOf(d.path) : d.folder;
    if (!name || (from !== undefined && name === nameOf(from))) return cancelDraft();
    const path = join(folder, name);
    saving.current = d;
    // An open file's edits land under its old name.
    if (from !== undefined) await store.flush(from);
    const answer =
      from === undefined
        ? await window.parallax.request(hostId, "agent/fileCreate", {
            runId,
            path,
            folder: "isFolder" in d && d.isFolder,
          })
        : await window.parallax.request(hostId, "agent/fileRename", { runId, from, to: path });
    saving.current = undefined;
    if ("error" in answer) {
      if (active.current === d) setDraftError(reason(answer.error));
      return;
    }
    if (active.current === d) cancelDraft();
    if (from !== undefined) {
      store.moved(from, path);
      setExpanded((prev) => new Set([...prev].map((p) => moved(p, from, path))));
      setListings((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [moved(k, from, path), v])),
      );
    }
    await relist(folder, parentOf(path));
  };

  const askDelete = (entry: Target) => {
    setToDelete(entry);
    setDeleteError(undefined);
    deleteDialog.current?.showModal();
  };
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    const { path } = toDelete;
    const answer = await window.parallax.request(hostId, "agent/fileDelete", { runId, path });
    setDeleting(false);
    if ("error" in answer) return setDeleteError(reason(answer.error));
    deleteDialog.current?.close();
    store.removed(path);
    setExpanded((prev) => new Set([...prev].filter((p) => !inside(p, path))));
    await relist(parentOf(path));
  };

  /** F2 renames the focused entry and Delete deletes it, as in an IDE. */
  const onRowKey = (e: KeyboardEvent, entry: Target) => {
    if (!editable) return;
    if (e.key === "F2") startDraft({ path: entry.path });
    else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) askDelete(entry);
    else return;
    e.preventDefault();
  };

  if (unavailable) return <Empty title={t("Files aren't available")} hint={unavailable} />;
  const top = listings[""];
  const empty = top && "entries" in top && top.entries.length === 0 && !draft;

  /** The field a name is typed in, in place of a row, with why the last save failed under it. */
  const nameField = (d: Draft, depth: number, isFolder: boolean, initial = "") => {
    const indent = { paddingLeft: `${4 + depth * INDENT}px` };
    const Icon = isFolder ? Folder : File;
    return (
      <div>
        <div style={indent} className="flex items-center gap-1.5 py-0.5 pr-2">
          <ChevronRight aria-hidden className="invisible size-3.5 shrink-0" />
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label={
              "path" in d
                ? t("Rename {{name}}", { name: initial })
                : isFolder
                  ? t("Folder name")
                  : t("File name")
            }
            aria-invalid={draftError ? true : undefined}
            defaultValue={initial}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => {
              // A file's name is chosen up to its extension, as an IDE does.
              const dot = isFolder ? -1 : initial.lastIndexOf(".");
              e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
            }}
            onChange={() => setDraftError(undefined)}
            onKeyDown={(e) => {
              // Enter and Escape belong to an input method while it composes.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") void save(d, e.currentTarget.value);
              else if (e.key === "Escape") cancelDraft();
            }}
            onBlur={(e) => void save(d, e.currentTarget.value)}
            className={`min-w-0 flex-1 rounded-md border bg-background px-1.5 py-0.5 text-body text-foreground focus-visible:outline-none ${draftError ? "border-danger" : "border-ring"}`}
          />
        </div>
        {draftError && (
          <p role="alert" style={indent} className="pr-2 pb-1 text-meta text-danger">
            <span className="pl-10">{draftError}</span>
          </p>
        )}
      </div>
    );
  };

  /** `folder`'s entries, each folder's own below it while it's open. */
  const tree = (folder: string, depth: number) => {
    const listing = listings[folder];
    if (!listing) return null;
    const indent = { paddingLeft: `${4 + depth * INDENT}px` };
    if ("error" in listing)
      return (
        <p role="alert" style={indent} className="py-1 pr-2 text-body text-danger">
          {listing.error}
        </p>
      );
    return (
      // A guide runs down each open folder's entries, under its chevron.
      <ul
        role="group"
        style={{ "--guide": `${depth * INDENT - 6}px` } as CSSProperties}
        className={
          depth
            ? "relative before:absolute before:inset-y-0 before:left-[var(--guide)] before:w-px before:bg-border/50"
            : ""
        }
      >
        {draft && "folder" in draft && draft.folder === folder && (
          <li>{nameField(draft, depth, draft.isFolder)}</li>
        )}
        {listing.entries.toSorted(byKind).map((entry) => {
          const path = join(folder, entry.name);
          const isFolder = entry.kind === "dir";
          const open = expanded.has(path);
          const link = entry.kind === "symlink";
          const renaming = draft && "path" in draft && draft.path === path;
          return (
            <li
              key={entry.name}
              role="treeitem"
              aria-expanded={isFolder ? open : undefined}
              data-path={path}
            >
              {renaming ? (
                nameField(draft, depth, isFolder, entry.name)
              ) : (
                // The row and its actions, apart from the folder's entries below it, so hovering
                // a nested row shows only its own actions.
                <div className="group/row relative">
                  <button
                    type="button"
                    style={indent}
                    data-row
                    onClick={() =>
                      isFolder ? toggle(path) : openFile(path, { link, transient: true })
                    }
                    onDoubleClick={() => {
                      if (!isFolder) openFile(path, { link });
                    }}
                    onKeyDown={(e) => {
                      onRowKey(e, { path, isFolder });
                      // Right opens a folder, then Left closes it or goes up, as in any tree.
                      if (e.key === "ArrowRight" && isFolder && !open) toggle(path);
                      if (e.key === "ArrowLeft" && isFolder && open) {
                        e.stopPropagation();
                        toggle(path);
                      }
                    }}
                    onContextMenu={
                      editable
                        ? (e) =>
                            openOnContextMenu(
                              e,
                              e.currentTarget.parentElement!.querySelector("[data-actions]"),
                            )
                        : undefined
                    }
                    aria-current={file?.path === path ? "true" : undefined}
                    className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-body text-foreground/90 transition-colors hover:bg-hover aria-[current]:bg-selected aria-[current]:text-foreground ${target?.path === path ? "bg-hover" : ""} ${editable ? "group-has-[:focus-visible]/row:pr-8 group-hover/row:pr-8" : ""}`}
                  >
                    {/* As Pierre's and T3 Code's trees: a folder is its chevron and name, and a file its icon. */}
                    {isFolder ? (
                      <ChevronRight
                        aria-hidden
                        className={`size-4 shrink-0 text-faint-foreground transition-transform duration-fast ${open ? "rotate-90" : ""}`}
                      />
                    ) : link ? (
                      <FileSymlink aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : entry.kind === "file" ? (
                      <FileIcon path={path} />
                    ) : (
                      <File aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                  {editable && (
                    <span className="absolute top-0.5 right-1 opacity-0 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100">
                      <button
                        data-actions
                        type="button"
                        aria-label={t("Actions for {{name}}", { name: entry.name })}
                        title={t("Actions")}
                        onClick={(e) => {
                          setTarget({ path, isFolder });
                          menu.current?.showPopover({ source: e.currentTarget });
                        }}
                        className="grid size-5.5 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
                      >
                        <Ellipsis />
                      </button>
                    </span>
                  )}
                </div>
              )}
              {open && tree(path, depth + 1)}
            </li>
          );
        })}
        {listing.truncated && (
          <li style={indent} className="py-1 pr-2 text-body text-faint-foreground">
            {t("More files not shown.")}
          </li>
        )}
      </ul>
    );
  };

  // New entries from the menu go in the folder it was opened on, or beside the file.
  const targetFolder = target && (target.isFolder ? target.path : parentOf(target.path));
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    action();
  };
  // Narrow, the Files tab shows the tree and a file's tab the file. Wide, the tree sits beside.
  const fileOnScreen = !!file && !home;
  const treeOnScreen = beside ? treeBeside || !fileOnScreen : !fileOnScreen;
  /** Down and Up move through the tree's visible rows, and Left from a closed row goes to its folder. */
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("button[data-row]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") rows[at + 1]?.focus();
    else if (e.key === "ArrowUp") rows[Math.max(at - 1, 0)]?.focus();
    else if (e.key === "ArrowLeft") {
      const parent = (document.activeElement as HTMLElement | null)
        ?.closest('[role="group"]')
        ?.closest('[role="treeitem"]')
        ?.querySelector<HTMLElement>("button[data-row]");
      parent?.focus();
    } else return;
    e.preventDefault();
  };
  const explorer = (
    <section
      aria-label={t("Explorer")}
      style={beside ? { width: shownTreeWidth } : undefined}
      className={`flex min-h-0 flex-col ${beside ? "relative shrink-0 border-r border-border/60" : "min-w-0 flex-1"}`}
    >
      <FileSearch
        hostId={hostId}
        runId={runId}
        enabled={connectedNow}
        grep={!!grep}
        onOpen={(path, line) => openFile(path, { transient: true, ...(line && { line }) })}
        actions={
          <>
            {editable && (
              <>
                <IconButton
                  size="sm"
                  label={t("New file")}
                  onClick={() => startDraft({ folder: "", isFolder: false })}
                >
                  <FilePlus aria-hidden />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t("New folder")}
                  onClick={() => startDraft({ folder: "", isFolder: true })}
                >
                  <FolderPlus aria-hidden />
                </IconButton>
              </>
            )}
            <IconButton
              size="sm"
              label={t("Collapse folders")}
              disabled={expanded.size === 0}
              onClick={() => setExpanded(() => new Set())}
            >
              <ListCollapse aria-hidden />
            </IconButton>
          </>
        }
      >
        {empty ? (
          <Empty title={t("No files")} hint={t("This thread's folder is empty.")} />
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label={t("Files")}
            onKeyDown={onTreeKey}
            className="min-h-0 flex-1 overflow-y-auto px-2 pt-1.5 pb-3"
          >
            {tree("", 0)}
          </div>
        )}
      </FileSearch>
      {beside && (
        <div
          role="separator"
          aria-label={t("Resize files")}
          aria-orientation="vertical"
          aria-valuenow={shownTreeWidth}
          aria-valuemin={TREE_MIN_WIDTH}
          aria-valuemax={treeMax}
          tabIndex={0}
          onPointerDown={dragSash}
          onDoubleClick={() => setWidthOfTree(TREE_WIDTH)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWidthOfTree(shownTreeWidth - 16);
            else if (e.key === "ArrowRight") setWidthOfTree(shownTreeWidth + 16);
          }}
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-border focus-visible:bg-border focus-visible:outline-none active:bg-border"
        />
      )}
    </section>
  );
  return (
    <div ref={root} className="relative flex min-h-0 flex-1 overflow-hidden">
      {treeOnScreen && explorer}
      {fileOnScreen ? (
        <FileEditor
          store={store}
          file={file}
          folder={folder}
          wide={beside}
          treeOpen={treeOnScreen}
          onToggleTree={() => setTreeBeside(!treeBeside)}
          onReveal={showInFiles}
          onClose={(tab) => void store.askClose(tab.id)}
          hostId={hostId}
          runId={runId}
        />
      ) : (
        beside && (
          <NoFile
            treeButton={
              !treeBeside && (
                <IconButton size="sm" label={t("Show files")} onClick={() => setTreeBeside(true)}>
                  <PanelLeft aria-hidden />
                </IconButton>
              )
            }
          />
        )
      )}
      <ConfirmDialog
        ref={closeDialog}
        title={t("Close “{{name}}” without saving?", {
          name: closingFile ? nameOf(closingFile.path) : "",
        })}
        titleClass="break-all"
        action={t("Close without saving")}
        onConfirm={() => {
          store.settleClose(true);
          closeDialog.current?.close();
        }}
      >
        {t("Your edits to this file aren't on disk, and closing drops them.")}
      </ConfirmDialog>
      {editable && (
        <>
          <Menu
            ref={menu}
            label={
              target ? t("Actions for {{name}}", { name: nameOf(target.path) }) : t("File actions")
            }
            align="end"
            className="min-w-36 p-1"
            onClose={() => setTarget(undefined)}
          >
            {target && targetFolder !== undefined && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => startDraft({ folder: targetFolder, isFolder: false }))}
                >
                  <FilePlus aria-hidden />
                  {t("New file")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => startDraft({ folder: targetFolder, isFolder: true }))}
                >
                  <FolderPlus aria-hidden />
                  {t("New folder")}
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => startDraft({ path: target.path }))}
                >
                  {t("Rename")}
                  <span className="ml-auto text-meta text-faint-foreground">F2</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${menuItem} text-danger`}
                  onClick={choose(() => askDelete(target))}
                >
                  {t("Delete…")}
                </button>
              </>
            )}
          </Menu>
          <ConfirmDialog
            ref={deleteDialog}
            title={t("Delete “{{name}}”?", { name: toDelete ? nameOf(toDelete.path) : "" })}
            titleClass="break-all"
            action={t("Delete")}
            busy={deleting ? t("Deleting…") : undefined}
            error={deleteError}
            onConfirm={() => void confirmDelete()}
          >
            {toDelete?.isFolder
              ? t("This folder and everything in it are deleted from disk. This can't be undone.")
              : t("This is deleted from disk. This can't be undone.")}
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

/**
 * A search over the thread's folder above `children`, the tree, which its results stand in for while
 * there's a query: files by name from `repo/files`, then lines from `repo/grep`, as VS Code's Quick
 * Open and Search are, in one box. Enter opens the first result.
 */
function FileSearch({
  hostId,
  runId,
  onOpen,
  enabled,
  grep,
  actions,
  children,
}: {
  hostId: string;
  runId: string;
  onOpen: (path: string, line?: number) => void;
  enabled: boolean;
  grep: boolean;
  /** Buttons beside the box, such as New file. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[] | { error: string }>();
  const [lines, setLines] = useState<{ query: string; matches: GrepMatch[]; error?: string }>();
  const load = async () => {
    const answer = await window.parallax.request(hostId, "repo/files", { runId });
    setPaths("error" in answer ? { error: describeError(answer.error) } : answer.result.files);
  };
  const trimmed = query.trim();
  useEffect(() => {
    if (!grep || trimmed.length < 2) return setLines(undefined);
    let stopped = false;
    const timer = setTimeout(() => {
      void window.parallax
        .request(hostId, "repo/grep", { runId, query: trimmed })
        .then((answer) => {
          if (stopped) return;
          setLines(
            "error" in answer
              ? { query: trimmed, matches: [], error: describeError(answer.error) }
              : { query: trimmed, matches: answer.result.matches },
          );
        });
    }, GREP_AFTER_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, runId, grep, trimmed]);
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const found =
    Array.isArray(paths) && words.length
      ? rank(paths, words, (path) => [
          [nameOf(path), 1],
          [path, 0.7],
        ]).slice(0, 50)
      : [];
  const clear = () => setQuery("");
  const open = (path: string, line?: number) => {
    onOpen(path, line);
    clear();
  };
  // Only the query in the box: an older one's lines aren't what Enter should open.
  const current = lines?.query === trimmed ? lines : undefined;
  const matches = current?.matches ?? [];
  const byFile = Map.groupBy(matches, (m) => m.path);
  const heading = "px-2 pt-2 pb-1 text-meta font-medium text-faint-foreground";
  const row =
    "flex h-6.5 w-full items-center gap-1.5 rounded-md px-2 text-left text-body hover:bg-hover";
  return (
    <>
      {/* As tall as the file's path row beside it, so their lines meet. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5">
        <label className={`${searchField} h-7! min-w-0 flex-1`}>
          <Search aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label={t("Search files")}
            placeholder={t("Search files")}
            value={query}
            disabled={!enabled}
            onFocus={() => void load()}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") clear();
              if (e.key !== "Enter") return;
              const first = found[0]?.item ?? matches[0]?.path;
              if (first) open(first, found[0] ? undefined : matches[0]?.line);
            }}
            className="min-w-0 flex-1 bg-transparent text-meta outline-none placeholder:text-faint-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label={t("Clear search")}
              onClick={clear}
              className="text-faint-foreground hover:text-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </label>
        {actions}
      </div>
      {words.length === 0 ? (
        children
      ) : (
        <div
          role="group"
          aria-label={t("Search results")}
          className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
        >
          {paths && "error" in paths && (
            <p role="alert" className="px-2 py-1 text-body text-danger">
              {paths.error}
            </p>
          )}
          {current?.error && (
            <p role="alert" className="px-2 py-1 text-body text-danger">
              {current.error}
            </p>
          )}
          {found.length > 0 && <h3 className={heading}>{t("Files")}</h3>}
          {found.map(({ item: path }) => (
            <button
              key={path}
              type="button"
              title={path}
              onClick={() => open(path)}
              className={row}
            >
              <FileIcon path={path} />
              <span className="shrink-0">{nameOf(path)}</span>
              <span className="min-w-0 truncate text-meta text-faint-foreground">
                {parentOf(path)}
              </span>
            </button>
          ))}
          {byFile.size > 0 && <h3 className={heading}>{t("In files")}</h3>}
          {[...byFile].map(([path, inFile]) => (
            <div key={path}>
              <div title={path} className="flex h-6.5 items-center gap-1.5 px-2 text-body">
                <FileIcon path={path} />
                <span className="shrink-0">{nameOf(path)}</span>
                <span className="min-w-0 flex-1 truncate text-meta text-faint-foreground">
                  {parentOf(path)}
                </span>
                <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
                  {inFile.length}
                </span>
              </div>
              {inFile.map((match) => (
                <button
                  key={match.line}
                  type="button"
                  onClick={() => open(path, match.line)}
                  className="flex h-6 w-full items-center gap-2 rounded-md pr-2 pl-7 text-left text-meta hover:bg-hover"
                >
                  <span className="shrink-0 text-faint-foreground tabular-nums">{match.line}</span>
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    <Marked text={match.text.trim()} words={[trimmed.toLowerCase()]} />
                  </span>
                </button>
              ))}
            </div>
          ))}
          {Array.isArray(paths) && found.length === 0 && byFile.size === 0 && (
            <p className="px-2 py-2 text-body text-muted-foreground">{t("No results.")}</p>
          )}
        </div>
      )}
    </>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <Folder aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-body font-medium text-foreground">{title}</p>
      <p className="text-body text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The full view with no file open: what you can do from here, with its keys, as VS Code shows. */
function NoFile({ treeButton }: { treeButton: React.ReactNode }) {
  const goToFile = useShortcutLabel("goToFile");
  const contents = useShortcutLabel("searchContents");
  const menu = useShortcutLabel("commandMenu");
  return (
    <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center pb-16">
      {treeButton && <div className="absolute top-1.5 left-2">{treeButton}</div>}
      <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-2.5 text-body">
        {(
          [
            [t("Go to file"), goToFile],
            [t("Search contents"), contents],
            [t("Command menu"), menu],
          ] as const
        ).map(([name, keys]) => (
          <div key={name} className="contents">
            <dt className="text-right text-muted-foreground">{name}</dt>
            <dd className="text-faint-foreground">{keys}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
