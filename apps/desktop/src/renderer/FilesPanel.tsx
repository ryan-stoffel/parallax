import {
  ChevronRight,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Search,
  WrapText,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentEntry } from "../protocol/generated/protocol";
import { setAppearance, useAppearance } from "./appearance";
import type { Cursor } from "./CodeEditor";
import { rank } from "./commandSearch";
import { useConnectedNow } from "./ConnectionStatus";
import { readWorking } from "./documents";
import { describeError } from "./errors";
import { DownloadButton } from "./FileCards";
import { CHECK_EVERY_MS, type OpenFile, type OpenFiles, openFilesOf } from "./openFiles";
import { GithubMarkdown } from "./pr/GithubMarkdown";
import { FileIcon } from "./TurnChanges";
import {
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  menuItem,
  openOnContextMenu,
  searchField,
} from "./ui";

// The editor and its languages load when a file first opens.
const CodeEditor = lazy(() => import("./CodeEditor"));

/** From this wide, the tree sits beside the file instead of taking turns with it. */
const TREE_BESIDE_WIDTH = 720;
const TREE_WIDTH = 256;
/** How often the open folders are listed again, for what the agent changes. */
const RELIST_EVERY_MS = 5000;

/** A folder's entries once listed, or why they couldn't be. */
type Listing = { entries: AgentEntry[]; truncated: boolean } | { error: string };

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

/** Whether `path` shows as rendered Markdown when asked. */
const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);

/**
 * The side panel's Files view (PLX-296, PLX-1428): a run's folder on its host, its worktree or a
 * Current checkout thread's checkout, as a tree beside an editor, or taking turns with it when
 * narrow. A folder lists from `agent/files`, and open folders list again every few seconds, so the
 * agent's new files show. Files open in tabs, which `openFiles` keeps and saves: on a plxd with
 * `fileWrite`, `writable` edits them. `unavailable` says why it can't load, such as a plxd without
 * the `files` capability.
 *
 * `editable`, on a plxd with `fileEdit` (PLX-590), adds New file and New folder above the tree
 * and a menu on each entry, on right-click or its `…`: New file, New folder, Rename, and Delete.
 * Names are typed in the tree, where Enter or leaving the field saves and Escape cancels; F2
 * renames the focused entry and Delete deletes it, after asking.
 *
 * Each new `reveal` opens its file in the view, as the command menu's file picks do (PLX-993).
 */
export function FilesPanel({
  hostId,
  runId,
  unavailable,
  editable,
  writable,
  reveal,
}: {
  hostId: string;
  runId: string;
  unavailable?: string;
  editable?: boolean;
  writable?: boolean;
  reveal?: { path: string };
}) {
  // Each listed folder by path, the root's as "".
  const connectedNow = useConnectedNow(hostId);
  const store = openFilesOf(hostId, runId);
  store.writable = !!writable;
  const { tabs, active: activeId } = useSyncExternalStore(store.subscribe, store.get);
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
  // When narrow, whether the tree is on screen rather than the file.
  const [treeTurn, setTreeTurn] = useState(false);
  const [closing, setClosing] = useState<OpenFile>();
  const closeDialog = useRef<HTMLDialogElement>(null);

  /** Opens `path` from the tree, and when narrow, goes to it. */
  const openFile = (path: string, link = false) => {
    store.open(path, link);
    setTreeTurn(false);
  };
  const closeTab = async (tab: OpenFile) => {
    if (await store.close(tab.id)) return;
    setClosing(tab);
    closeDialog.current?.showModal();
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

  // A new `reveal` opens its file, with the folders above it open in the tree.
  useEffect(() => {
    if (!reveal || store.revealed === reveal) return;
    store.revealed = reveal;
    openFile(reveal.path);
    const folders = reveal.path
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    setExpanded((prev) => new Set([...prev, ...folders]));
    void relist(...folders);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on a new reveal only
  }, [reveal, store]);

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

  if (unavailable) return <Empty title="Files aren't available" hint={unavailable} />;
  const top = listings[""];
  const empty = top && "entries" in top && top.entries.length === 0 && !draft;

  /** The field a name is typed in, in place of a row, with why the last save failed under it. */
  const nameField = (d: Draft, depth: number, isFolder: boolean, initial = "") => {
    const indent = { paddingLeft: `${10 + depth * 14}px` };
    const Icon = isFolder ? Folder : File;
    return (
      <div>
        <div style={indent} className="flex items-center gap-1.5 py-0.5 pr-2">
          <ChevronRight aria-hidden className="invisible size-3.5 shrink-0" />
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label={"path" in d ? `Rename ${initial}` : isFolder ? "Folder name" : "File name"}
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
    const indent = { paddingLeft: `${10 + depth * 14}px` };
    if ("error" in listing)
      return (
        <p role="alert" style={indent} className="py-1 pr-2 text-body text-danger">
          {listing.error}
        </p>
      );
    return (
      <ul role="group">
        {draft && "folder" in draft && draft.folder === folder && (
          <li>{nameField(draft, depth, draft.isFolder)}</li>
        )}
        {listing.entries.toSorted(byKind).map((entry) => {
          const path = join(folder, entry.name);
          const isFolder = entry.kind === "dir";
          const open = expanded.has(path);
          const link = entry.kind === "symlink";
          const FolderIcon = open ? FolderOpen : Folder;
          const renaming = draft && "path" in draft && draft.path === path;
          return (
            <li key={entry.name} role="treeitem" aria-expanded={isFolder ? open : undefined}>
              {renaming ? (
                nameField(draft, depth, isFolder, entry.name)
              ) : (
                // The row and its actions, apart from the folder's entries below it, so hovering
                // a nested row shows only its own actions.
                <div className="group/row relative">
                  <button
                    type="button"
                    style={indent}
                    onClick={() => (isFolder ? toggle(path) : openFile(path, link))}
                    onKeyDown={(e) => onRowKey(e, { path, isFolder })}
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
                    className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-body hover:bg-hover aria-[current]:bg-selected ${target?.path === path ? "bg-hover" : ""} ${editable ? "group-has-[:focus-visible]/row:pr-8 group-hover/row:pr-8" : ""}`}
                  >
                    <ChevronRight
                      aria-hidden
                      className={`size-3.5 shrink-0 text-faint-foreground ${isFolder ? "" : "invisible"} ${open ? "rotate-90" : ""}`}
                    />
                    {isFolder ? (
                      <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
                        aria-label={`Actions for ${entry.name}`}
                        title="Actions"
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
            More files not shown.
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
  const treeOnScreen = beside ? treeBeside : treeTurn || !file;
  const treeButton = (
    <IconButton
      size="sm"
      label={treeOnScreen ? "Hide files" : "Show files"}
      aria-pressed={treeOnScreen}
      onClick={() => (beside ? setTreeBeside(!treeBeside) : setTreeTurn(!treeTurn))}
    >
      <FolderTree aria-hidden />
    </IconButton>
  );
  return (
    <div ref={root} className="flex min-h-0 flex-1">
      {treeOnScreen && (
        <section
          aria-label="Files"
          style={beside && file ? { width: TREE_WIDTH } : undefined}
          className={`flex min-h-0 flex-col ${beside && file ? "shrink-0 border-r border-border/60" : "min-w-0 flex-1"}`}
        >
          <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1.5">
            {tabs.length > 0 && !beside && treeButton}
            <FileSearch hostId={hostId} runId={runId} onOpen={openFile} enabled={connectedNow} />
            {editable && (
              <>
                <IconButton
                  label="New file"
                  onClick={() => startDraft({ folder: "", isFolder: false })}
                >
                  <FilePlus />
                </IconButton>
                <IconButton
                  label="New folder"
                  onClick={() => startDraft({ folder: "", isFolder: true })}
                >
                  <FolderPlus />
                </IconButton>
              </>
            )}
          </div>
          {empty ? (
            <Empty title="No files" hint="This thread's folder is empty." />
          ) : (
            <div
              role="tree"
              aria-label="Files"
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            >
              {tree("", 0)}
            </div>
          )}
        </section>
      )}
      {file && (beside || !treeOnScreen) && (
        <FileColumn
          store={store}
          file={file}
          tabs={tabs}
          treeButton={treeButton}
          onClose={(tab) => void closeTab(tab)}
          hostId={hostId}
          runId={runId}
        />
      )}
      {!file && beside && width > 0 && !treeBeside && (
        <div className="flex flex-1 flex-col px-2">
          <div>{treeButton}</div>
          <Empty title="No file open" hint="Open a file from the tree." />
        </div>
      )}
      <ConfirmDialog
        ref={closeDialog}
        title={<>Close “{closing && nameOf(closing.path)}” without saving?</>}
        titleClass="break-all"
        action="Close without saving"
        onConfirm={() => {
          if (closing) store.discard(closing.id);
          closeDialog.current?.close();
        }}
      >
        Your edits to this file aren't on disk, and closing drops them.
      </ConfirmDialog>
      {editable && (
        <>
          <Menu
            ref={menu}
            label={target ? `Actions for ${nameOf(target.path)}` : "File actions"}
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
                  New file
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => startDraft({ folder: targetFolder, isFolder: true }))}
                >
                  <FolderPlus aria-hidden />
                  New folder
                </button>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={choose(() => startDraft({ path: target.path }))}
                >
                  Rename
                  <span className="ml-auto text-meta text-faint-foreground">F2</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${menuItem} text-danger`}
                  onClick={choose(() => askDelete(target))}
                >
                  Delete…
                </button>
              </>
            )}
          </Menu>
          <ConfirmDialog
            ref={deleteDialog}
            title={<>Delete “{toDelete && nameOf(toDelete.path)}”?</>}
            titleClass="break-all"
            action="Delete"
            busy={deleting ? "Deleting…" : undefined}
            error={deleteError}
            onConfirm={() => void confirmDelete()}
          >
            {toDelete?.isFolder
              ? "This folder and everything in it are deleted from disk."
              : "This is deleted from disk."}{" "}
            This can't be undone.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

/** One line's search over every file in the thread's folder, from `repo/files`. */
function FileSearch({
  hostId,
  runId,
  onOpen,
  enabled,
}: {
  hostId: string;
  runId: string;
  onOpen: (path: string) => void;
  enabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[] | { error: string }>();
  const load = async () => {
    const answer = await window.parallax.request(hostId, "repo/files", { runId });
    setPaths("error" in answer ? { error: describeError(answer.error) } : answer.result.files);
  };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found =
    Array.isArray(paths) && words.length
      ? rank(paths, words, (path) => [
          [nameOf(path), 1],
          [path, 0.7],
        ]).slice(0, 50)
      : [];
  const clear = () => setQuery("");
  return (
    <div className="relative min-w-0 flex-1">
      <label className={`${searchField} h-7`}>
        <Search aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          value={query}
          disabled={!enabled}
          onFocus={() => void load()}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") clear();
            if (e.key === "Enter" && found[0]) {
              onOpen(found[0].item);
              clear();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-faint-foreground [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      {words.length > 0 && (
        <ul
          aria-label="Matching files"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {paths && "error" in paths && (
            <li role="alert" className="px-2 py-1 text-body text-danger">
              {paths.error}
            </li>
          )}
          {Array.isArray(paths) && found.length === 0 && (
            <li className="px-2 py-1 text-body text-muted-foreground">No files match.</li>
          )}
          {found.map(({ item: path }) => (
            <li key={path}>
              <button
                type="button"
                title={path}
                onClick={() => {
                  onOpen(path);
                  clear();
                }}
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-body hover:bg-hover"
              >
                <FileIcon path={path} />
                <span className="shrink-0">{nameOf(path)}</span>
                <span className="min-w-0 truncate text-meta text-faint-foreground">
                  {parentOf(path)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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

/** Whether tab `file` has edits that aren't on disk yet, for the mark on its tab. */
const unsavedMark = (file: OpenFile) => file.save !== "saved" || !!file.conflict;

/** The open files' tabs, a file's path and actions, the file, and its status line. */
function FileColumn({
  store,
  file,
  tabs,
  treeButton,
  onClose,
  hostId,
  runId,
}: {
  store: OpenFiles;
  file: OpenFile;
  tabs: readonly OpenFile[];
  treeButton: React.ReactNode;
  onClose: (tab: OpenFile) => void;
  hostId: string;
  runId: string;
}) {
  const { wordWrap } = useAppearance();
  const [cursor, setCursor] = useState<Cursor>();
  const folder = parentOf(file.path);
  const text = file.body.kind === "text" ? file.body : undefined;
  const markdown = !!text && isMarkdown(file.path);
  const preview = markdown && file.preview;
  return (
    <section aria-label={file.path} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        {treeButton}
        <ul
          role="tablist"
          aria-label="Open files"
          className="scrollbar-none flex min-w-0 flex-1 gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => (
            <li key={tab.id} className="group/tab relative shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === file.id}
                title={tab.path}
                onClick={() => store.activate(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(tab);
                }}
                className="flex h-7 max-w-44 items-center gap-1.5 rounded-md pr-6 pl-2 text-meta text-muted-foreground hover:bg-hover hover:text-foreground aria-selected:bg-selected aria-selected:text-foreground"
              >
                <FileIcon path={tab.path} />
                <span className="truncate">{nameOf(tab.path)}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${nameOf(tab.path)}`}
                title="Close"
                onClick={() => onClose(tab)}
                className="absolute top-1.5 right-1 grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {unsavedMark(tab) ? (
                  <span
                    aria-label="Not saved yet"
                    className="size-2 rounded-full bg-foreground/70 group-hover/tab:hidden"
                  />
                ) : null}
                <X
                  aria-hidden
                  className={`size-3 ${unsavedMark(tab) ? "hidden group-hover/tab:block" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"} ${tab.id === file.id ? "opacity-100" : ""}`}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-y border-border/60 pr-1 pl-3">
        <span title={file.path} className="flex min-w-0 flex-1 text-meta">
          {folder && <span className="min-w-0 truncate text-faint-foreground">{folder}/</span>}
          <span className="shrink-0 text-foreground">{nameOf(file.path)}</span>
        </span>
        {markdown && (
          <IconButton
            size="sm"
            label={preview ? "Show source" : "Show preview"}
            aria-pressed={preview}
            onClick={() => store.setPreview(file.id, !preview)}
          >
            {preview ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </IconButton>
        )}
        {text && !preview && (
          <IconButton
            size="sm"
            label="Word wrap"
            aria-pressed={wordWrap}
            onClick={() => setAppearance({ wordWrap: !wordWrap })}
          >
            <WrapText aria-hidden />
          </IconButton>
        )}
        <IconButton
          size="sm"
          label="Copy path"
          onClick={() => void navigator.clipboard.writeText(file.path)}
        >
          <Copy aria-hidden />
        </IconButton>
      </div>
      <FileBanner store={store} file={file} onClose={onClose} />
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <GithubMarkdown text={store.textNow(file.id)} repo="" />
        </div>
      ) : text ? (
        <Suspense fallback={<div className="flex-1" />}>
          <CodeEditor store={store} file={file} wrap={wordWrap} onCursor={setCursor} />
        </Suspense>
      ) : (
        <NonText file={file} hostId={hostId} runId={runId} />
      )}
      {text && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border/60 px-3 text-meta text-faint-foreground">
          <span className="min-w-0 flex-1 truncate">{saveLabel(file)}</span>
          {!preview && cursor && (
            <span className="shrink-0 tabular-nums">
              Ln {cursor.line}, Col {cursor.column}
              {cursor.selected > 0 && ` (${cursor.selected} selected)`}
            </span>
          )}
          {text.eol === "\r\n" && <span className="shrink-0">CRLF</span>}
          {cursor?.language && <span className="shrink-0">{cursor.language}</span>}
        </div>
      )}
    </section>
  );
}

/** The status line's word on a file's edits. */
function saveLabel(file: OpenFile): string {
  if (file.body.kind === "text" && file.body.readOnly) return "Read-only";
  if (file.conflict) return "Not saved";
  return { saved: "Saved", edited: "Edited", saving: "Saving…", failed: "Not saved" }[file.save];
}

/** What needs a decision on a file, or why it can't be edited, over its text. */
function FileBanner({
  store,
  file,
  onClose,
}: {
  store: OpenFiles;
  file: OpenFile;
  onClose: (tab: OpenFile) => void;
}) {
  const row =
    "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1.5 text-meta";
  const message = "min-w-0 flex-1 basis-40";
  if (file.body.kind !== "text") return null;
  if (file.conflict)
    return (
      <div role="alert" className={`${row} bg-warning/10`}>
        <span className={message}>
          {file.conflict.sha256
            ? "This file changed on disk since your edits."
            : "This file was deleted from disk."}
        </span>
        <Button size="sm" onClick={() => void store.overwrite(file.id)}>
          {file.conflict.sha256 ? "Overwrite" : "Save again"}
        </Button>
        {file.conflict.sha256 ? (
          <Button size="sm" onClick={() => void store.reload(file.id)}>
            Reload
          </Button>
        ) : (
          <Button size="sm" onClick={() => onClose(file)}>
            Close
          </Button>
        )}
      </div>
    );
  if (file.save === "failed")
    return (
      <div role="alert" className={`${row} bg-danger/10`}>
        <span className={message}>Couldn't save: {file.saveError}</span>
        <Button size="sm" onClick={() => void store.save(file.id)}>
          Try again
        </Button>
      </div>
    );
  if (file.body.readOnly)
    return (
      <div className={`${row} text-muted-foreground`}>
        <span className={message}>{file.body.readOnly}</span>
      </div>
    );
  return null;
}

/** A tab that isn't text: an image or video, a note with Download, or why it couldn't be read. */
function NonText({ file, hostId, runId }: { file: OpenFile; hostId: string; runId: string }) {
  const { body, path } = file;
  // The share of a large file read so far, while Download reads it.
  const [share, setShare] = useState<number>();
  if (body.kind === "loading" || body.kind === "text") return <div className="flex-1" />;
  if (body.kind === "media")
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
        {body.video ? (
          <video src={body.url} controls className="max-h-full max-w-full rounded-md" />
        ) : (
          <img src={body.url} alt={nameOf(path)} className="max-h-full max-w-full rounded-md" />
        )}
      </div>
    );
  const bytes = body.kind === "note" ? body.bytes : undefined;
  const save = bytes
    ? async () => bytes
    : body.kind === "note" && body.large
      ? () => readWorking(hostId, runId, path, setShare).finally(() => setShare(undefined))
      : undefined;
  return (
    <div className="px-4 pt-3">
      <p
        role={body.kind === "error" ? "alert" : undefined}
        className={`text-body ${body.kind === "error" ? "text-danger" : "text-muted-foreground"}`}
      >
        {body.kind === "error" ? body.error : body.note}
      </p>
      {save && (
        <div className="-ml-2 flex items-center gap-2 pt-1">
          <DownloadButton name={nameOf(path)} read={save} />
          {share !== undefined && (
            <span className="text-body text-muted-foreground tabular-nums">
              {Math.round(share * 100)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
