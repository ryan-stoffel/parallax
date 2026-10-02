import { ChevronLeft, ChevronRight, File, FileSymlink, Folder, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentEntry, AgentFileResult } from "../protocol/generated/protocol";
import { describeError } from "./errors";

/** A folder's entries once listed, or why they couldn't be. */
type Listing = { entries: AgentEntry[]; truncated: boolean } | { error: string };

/** Folders first, then by name, as a file browser lists them. */
const byKind = (a: AgentEntry, b: AgentEntry) =>
  Number(b.kind === "dir") - Number(a.kind === "dir") || (a.name < b.name ? -1 : 1);

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** `folder` of the run's folder, "" for the folder itself. */
async function listFolder(hostId: string, runId: string, folder: string): Promise<Listing> {
  const listed = await window.parallax.request(hostId, "agent/files", {
    runId,
    ...(folder && { path: folder }),
  });
  return "error" in listed ? { error: describeError(listed.error) } : listed.result;
}

/**
 * The side panel's Files view (RYA-296): a run's folder on its host, its worktree or a Current
 * checkout thread's checkout, as a tree. A folder lists its entries from `agent/files` each time
 * it opens, so closing and opening it again shows the agent's latest files. A file opens in the
 * view, read-only, from `agent/file`'s `working` side. `unavailable` says why it can't load, such
 * as a plxd without the `files` capability.
 */
export function FilesPanel({
  hostId,
  runId,
  unavailable,
}: {
  hostId: string;
  runId: string;
  unavailable?: string;
}) {
  // Each listed folder by path, the root's as "".
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [openPath, setOpenPath] = useState<string>();

  const show = (folder: string) => (listing: Listing) =>
    setListings((prev) => ({ ...prev, [folder]: listing }));
  useEffect(() => {
    if (!unavailable) void listFolder(hostId, runId, "").then(show(""));
  }, [hostId, runId, unavailable]);

  const toggle = (folder: string) => {
    const next = new Set(expanded);
    if (next.delete(folder)) return setExpanded(next);
    setExpanded(next.add(folder));
    void listFolder(hostId, runId, folder).then(show(folder));
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
  if (root && "entries" in root && root.entries.length === 0)
    return <Empty title="No files" hint="This thread's folder is empty." />;

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
        {listing.entries.toSorted(byKind).map((entry) => {
          const path = join(folder, entry.name);
          const open = expanded.has(path);
          const Icon =
            entry.kind === "dir"
              ? open
                ? FolderOpen
                : Folder
              : entry.kind === "symlink"
                ? FileSymlink
                : File;
          return (
            <li
              key={entry.name}
              role="treeitem"
              aria-expanded={entry.kind === "dir" ? open : undefined}
            >
              <button
                type="button"
                style={indent}
                onClick={() => (entry.kind === "dir" ? toggle(path) : setOpenPath(path))}
                className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] hover:bg-hover"
              >
                <ChevronRight
                  aria-hidden
                  className={`size-3.5 shrink-0 text-faint-foreground ${entry.kind === "dir" ? "" : "invisible"} ${open ? "rotate-90" : ""}`}
                />
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>
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

  return (
    <div role="tree" aria-label="Files" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {tree("", 0)}
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
        className="min-h-0 flex-1 overflow-auto px-4 pt-2 pb-4 font-mono text-[12px] leading-[1.6] text-foreground"
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
