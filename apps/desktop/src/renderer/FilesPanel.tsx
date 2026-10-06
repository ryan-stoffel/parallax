import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
} from "lucide-react";
import { type KeyboardEvent, type ToggleEvent, useEffect, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentEntry, AgentFileResult } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { IconButton, menuItem, menuPanel, moveFocus, openOnContextMenu } from "./ui";

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

/**
 * The side panel's Files view (PLX-296): a run's folder on its host, its worktree or a Current
 * checkout thread's checkout, as a tree. A folder lists its entries from `agent/files` each time
 * it opens, so closing and opening it again shows the agent's latest files. A file opens in the
 * view, read-only, from `agent/file`'s `working` side. `unavailable` says why it can't load, such
 * as a plxd without the `files` capability.
 *
 * `editable`, on a plxd with `fileEdit` (PLX-590), adds New file and New folder above the tree
 * and a menu on each entry, on right-click or its `…`: New file, New folder, Rename, and Delete.
 * Names are typed in the tree, where Enter or leaving the field saves and Escape cancels; F2
 * renames the focused entry and Delete deletes it, after asking.
 */
export function FilesPanel({
  hostId,
  runId,
  unavailable,
  editable,
}: {
  hostId: string;
  runId: string;
  unavailable?: string;
  editable?: boolean;
}) {
  // Each listed folder by path, the root's as "".
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [openPath, setOpenPath] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [draftError, setDraftError] = useState<string>();
  // The draft a save may still take: cleared while one is saving, so Enter and the blur after it
  // save once.
  const saving = useRef<Draft>(undefined);
  const [target, setTarget] = useState<Target>();
  const [toDelete, setToDelete] = useState<Target>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);

  const show = (folder: string) => (listing: Listing) =>
    setListings((prev) => ({ ...prev, [folder]: listing }));
  useEffect(() => {
    if (!unavailable) void listFolder(hostId, runId, "").then(show(""));
  }, [hostId, runId, unavailable]);
  const relist = (...folders: string[]) =>
    Promise.all([...new Set(folders)].map((f) => listFolder(hostId, runId, f).then(show(f))));

  const toggle = (folder: string) => {
    const next = new Set(expanded);
    if (next.delete(folder)) return setExpanded(next);
    setExpanded(next.add(folder));
    void listFolder(hostId, runId, folder).then(show(folder));
  };

  const startDraft = (next: Draft) => {
    if ("folder" in next && next.folder && !expanded.has(next.folder)) toggle(next.folder);
    saving.current = next;
    setDraft(next);
    setDraftError(undefined);
  };
  const cancelDraft = () => {
    saving.current = undefined;
    setDraft(undefined);
  };
  /** Creates or renames `d`'s entry as `value`; a blank or unchanged name just closes it. */
  const save = async (d: Draft, value: string) => {
    if (saving.current !== d) return;
    const name = value.trim();
    const from = "path" in d ? d.path : undefined;
    const folder = from === undefined ? (d as { folder: string }).folder : parentOf(from);
    if (!name || (from !== undefined && name === nameOf(from))) return cancelDraft();
    const path = join(folder, name);
    saving.current = undefined;
    const answer =
      from === undefined
        ? await window.parallax.request(hostId, "agent/fileCreate", {
            runId,
            path,
            folder: "isFolder" in d && d.isFolder,
          })
        : await window.parallax.request(hostId, "agent/fileRename", { runId, from, to: path });
    if ("error" in answer) {
      saving.current = d;
      return setDraftError(reason(answer.error));
    }
    setDraft(undefined);
    if (from !== undefined) {
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
  if (openPath)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setOpenPath(undefined)}
          className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{openPath}</span>
        </button>
        <FileView key={openPath} hostId={hostId} runId={runId} path={openPath} />
      </div>
    );

  const root = listings[""];
  const empty = root && "entries" in root && root.entries.length === 0 && !draft;
  if (empty && !editable) return <Empty title="No files" hint="This thread's folder is empty." />;

  /** The field a name is typed in, in place of a row, with why the last save failed under it. */
  const nameField = (d: Draft, depth: number, isFolder: boolean, initial = "") => {
    const indent = { paddingLeft: `${10 + depth * 14}px` };
    const Icon = isFolder ? Folder : File;
    return (
      <div>
        <div style={indent} className="flex items-center gap-1.5 py-0.5 pr-2">
          <ChevronRight aria-hidden className="invisible size-3.5 shrink-0" />
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
            className={`min-w-0 flex-1 rounded-md border bg-background px-1.5 py-0.5 text-[13px] text-foreground focus-visible:outline-none ${draftError ? "border-danger" : "border-ring"}`}
          />
        </div>
        {draftError && (
          <p role="alert" style={indent} className="pr-2 pb-1 text-[12px] text-danger">
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
        <p role="alert" style={indent} className="py-1 pr-2 text-[12.5px] text-danger">
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
          const Icon = isFolder
            ? open
              ? FolderOpen
              : Folder
            : entry.kind === "symlink"
              ? FileSymlink
              : File;
          const renaming = draft && "path" in draft && draft.path === path;
          return (
            <li
              key={entry.name}
              role="treeitem"
              aria-expanded={isFolder ? open : undefined}
              className="group/row relative"
            >
              {renaming ? (
                nameField(draft, depth, isFolder, entry.name)
              ) : (
                <button
                  type="button"
                  style={indent}
                  onClick={() => (isFolder ? toggle(path) : setOpenPath(path))}
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
                  className={`flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] hover:bg-hover ${target?.path === path ? "bg-hover" : ""} ${editable ? "group-has-[:focus-visible]/row:pr-8 group-hover/row:pr-8" : ""}`}
                >
                  <ChevronRight
                    aria-hidden
                    className={`size-3.5 shrink-0 text-faint-foreground ${isFolder ? "" : "invisible"} ${open ? "rotate-90" : ""}`}
                  />
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
              )}
              {editable && !renaming && (
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
              {open && tree(path, depth + 1)}
            </li>
          );
        })}
        {listing.truncated && (
          <li style={indent} className="py-1 pr-2 text-[12.5px] text-faint-foreground">
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && (
        <div className="flex shrink-0 justify-end gap-0.5 px-2 pb-1">
          <IconButton label="New file" onClick={() => startDraft({ folder: "", isFolder: false })}>
            <FilePlus />
          </IconButton>
          <IconButton label="New folder" onClick={() => startDraft({ folder: "", isFolder: true })}>
            <FolderPlus />
          </IconButton>
        </div>
      )}
      {empty ? (
        <Empty title="No files" hint="This thread's folder is empty." />
      ) : (
        <div role="tree" aria-label="Files" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tree("", 0)}
        </div>
      )}
      {editable && (
        <>
          <div
            ref={menu}
            popover="auto"
            role="menu"
            aria-label={target ? `Actions for ${nameOf(target.path)}` : "File actions"}
            onToggle={(e: ToggleEvent<HTMLDivElement>) => {
              if (e.newState === "open")
                e.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
              else setTarget(undefined);
            }}
            onKeyDown={moveFocus}
            className={`${menuPanel("end")} min-w-36 p-1`}
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
                  <span className="ml-auto text-[11.5px] text-faint-foreground">F2</span>
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
          </div>
          <dialog
            ref={deleteDialog}
            aria-labelledby="delete-entry-title"
            className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
          >
            <form method="dialog" className="px-5 pt-4 pb-4">
              <h2 id="delete-entry-title" className="text-[15px] font-semibold break-all">
                Delete “{toDelete && nameOf(toDelete.path)}”?
              </h2>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                {toDelete?.isFolder
                  ? "This folder and everything in it are deleted from disk."
                  : "This is deleted from disk."}{" "}
                This can't be undone.
              </p>
              {deleteError && (
                <p role="alert" className="mt-2 text-[12.5px] text-danger">
                  {deleteError}
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="submit"
                  value="cancel"
                  className="rounded-md px-3 py-1.5 text-[13px] hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </form>
          </dialog>
        </>
      )}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <Folder aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="text-[12.5px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/** A file's text, or a note when it's binary, too large, or gone. */
export function fileText(file: AgentFileResult): { text: string } | { note: string } {
  if (!file.exists) return { note: "This file isn't there anymore." };
  if (file.tooLarge) return { note: "This file is too large to show." };
  const bytes = Uint8Array.from(atob(file.content ?? ""), (c) => c.charCodeAt(0));
  if (bytes.includes(0)) return { note: "This is a binary file." };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { note: "This is a binary file." };
  }
}

/** One file as it is on disk now, as plain monospace text. */
function FileView({ hostId, runId, path }: { hostId: string; runId: string; path: string }) {
  const [shown, setShown] = useState<{ text: string } | { note: string } | { error: string }>();
  useEffect(() => {
    let stopped = false;
    void window.parallax
      .request(hostId, "agent/file", { runId, path, side: "working" })
      .then((read) => {
        if (stopped) return;
        setShown("error" in read ? { error: describeError(read.error) } : fileText(read.result));
      });
    return () => {
      stopped = true;
    };
  }, [hostId, runId, path]);

  if (!shown) return null;
  if ("text" in shown)
    return (
      <pre
        aria-label={path}
        className="code-lines min-h-0 flex-1 overflow-auto px-4 pt-2 pb-4 font-mono text-[12px] leading-[1.6] text-foreground"
      >
        {shown.text}
      </pre>
    );
  return (
    <p
      role={"error" in shown ? "alert" : undefined}
      className={`px-4 pt-2 text-[12.5px] ${"error" in shown ? "text-danger" : "text-muted-foreground"}`}
    >
      {"error" in shown ? shown.error : shown.note}
    </p>
  );
}
