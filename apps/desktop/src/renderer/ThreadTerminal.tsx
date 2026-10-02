import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import type { ThreadsState, ThreadsView } from "./threads";

// xterm.js loads with the first terminal shown.
const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/**
 * A folder a terminal opens in, on a host: a repository's checkout, or a No Repo thread's own.
 * `key` names it across hosts, and a thread's ends its terminals when the thread is deleted.
 */
export type ThreadFolder = { key: string; hostId: string; path: string; threadId?: string };

/**
 * Thread `threadId`'s folder: its repository's checkout, shared with the repository's other
 * threads and New thread, never its worktree. A No Repo thread has its own scratch repository's,
 * once its run made one. Or with `repoId`, a repository's, for New thread. Undefined while there
 * is none yet, and for No Repo's New thread.
 */
export function folderOf(
  hostId: string,
  state: ThreadsState,
  open: { threadId: string } | { repoId: string },
): ThreadFolder | undefined {
  if ("repoId" in open) {
    const repo = state.repos.find((r) => r.id === open.repoId && !r.scratch);
    return repo && { key: `${hostId}/new/${repo.id}`, hostId, path: repo.path };
  }
  const { threadId } = open;
  const thread = state.threads.find((t) => t.id === threadId);
  const repo = state.repos.find((r) => r.id === thread?.repo && !r.scratch);
  if (repo) return folderOf(hostId, state, { repoId: repo.id });
  const path = state.runs[threadId]?.worktreePath;
  return path === undefined ? undefined : { key: `${hostId}/${threadId}`, hostId, path, threadId };
}

/** The drawer's terminal id for a folder, to type or run a command in it with `terminalInput`. */
export const drawerTerminalId = (folder: ThreadFolder) => `drawer:${folder.key}`;

// The terminals whose shell runs, and the command to run in each once it does, by terminal id.
// Main drops input to a terminal that hasn't started. A shell that exits drops its queue, and only
// the latest command waits for its restart.
const running = new Set<string>();
const queued = new Map<string, string>();

/**
 * Runs `command` in `folder`'s drawer terminal: now if its shell runs, else once it starts, in
 * place of any command already waiting. Open the drawer on `folder` too, so it starts.
 */
export function runInDrawer(folder: ThreadFolder, command: string) {
  const id = drawerTerminalId(folder);
  const input = `${command}\r`;
  if (running.has(id)) window.parallax.terminalInput(id, input);
  else queued.set(id, input);
}

function started(id: string) {
  running.add(id);
  const input = queued.get(id);
  queued.delete(id);
  if (input) window.parallax.terminalInput(id, input);
}

/**
 * Whether a folder's thread was deleted: its host listed it and doesn't anymore. Its terminals
 * end then.
 */
export function useDeleted(
  views: Readonly<Record<string, ThreadsView>>,
): (folder: ThreadFolder) => boolean {
  const listed = useRef(new Set<string>());
  for (const [hostId, view] of Object.entries(views))
    for (const t of view.state.threads) listed.current.add(`${hostId}/${t.id}`);
  return (folder) =>
    folder.threadId !== undefined &&
    listed.current.has(folder.key) &&
    !views[folder.hostId]?.state.threads.some((t) => t.id === folder.threadId);
}

/**
 * A terminal for each folder it has shown, as `active`, each kept running, hidden, while another
 * is shown. `prefix` keeps its terminal ids apart from another pool's. `empty` stands in while
 * none is shown.
 */
export function TerminalPool({
  prefix,
  label,
  active,
  deleted,
  empty,
}: {
  prefix: string;
  /** Each terminal's accessible name. */
  label: string;
  active: ThreadFolder | undefined;
  deleted: (folder: ThreadFolder) => boolean;
  empty?: ReactNode;
}) {
  const [shown, setShown] = useState<ThreadFolder[]>([]);
  if (active && !deleted(active) && !shown.some((f) => f.key === active.key))
    setShown([...shown, active]);
  if (shown.some(deleted)) setShown(shown.filter((f) => !deleted(f)));
  return (
    <>
      {shown.map((folder) => (
        <PooledTerminal
          key={folder.key}
          id={`${prefix}:${folder.key}`}
          label={label}
          folder={folder}
          hidden={folder.key !== active?.key}
        />
      ))}
      {!active && empty}
    </>
  );
}

/** A shell in `folder`, restarted from a bar under it once it exits or fails to start. */
function PooledTerminal({
  id,
  label,
  folder,
  hidden,
}: {
  id: string;
  label: string;
  folder: ThreadFolder;
  hidden: boolean;
}) {
  // Each start is a new TerminalView, so a restart opens a new session.
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState<{ error?: string }>();
  useEffect(() => () => void running.delete(id), [id]);
  return (
    <div hidden={hidden} className="flex min-h-0 flex-1 flex-col">
      {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
      <div className="min-h-0 flex-1 py-1.5 pl-3">
        <Suspense>
          <TerminalView
            key={start}
            id={id}
            target={{ hostId: folder.hostId, path: folder.path }}
            label={label}
            background="--background"
            onStart={() => started(id)}
            onEnd={(error) => {
              running.delete(id);
              queued.delete(id);
              setEnd({ error });
            }}
          />
        </Suspense>
      </div>
      {end && (
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[12.5px]">
          <span
            role={end.error ? "alert" : undefined}
            className={end.error ? "text-danger" : "text-muted-foreground"}
          >
            {end.error ?? "The shell exited."}
          </span>
          <button
            type="button"
            onClick={() => {
              setEnd(undefined);
              setStart(start + 1);
            }}
            className="rounded-md px-2 py-0.5 text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The terminal drawer under the chat: `folder`'s terminal while `open`, and every other folder's
 * it has shown, hidden. Its top edge drags, or takes the arrow keys, to resize it.
 */
export function TerminalDrawer({
  open,
  folder,
  deleted,
}: {
  open: boolean;
  folder: ThreadFolder | undefined;
  deleted: (folder: ThreadFolder) => boolean;
}) {
  const [height, setHeight] = useState(280);
  const drag = useRef<{ y: number; height: number }>(undefined);
  const resize = (next: number) =>
    setHeight(Math.round(Math.min(Math.max(next, 96), window.innerHeight - 160)));
  return (
    <section
      id="terminal-drawer"
      aria-label="Terminal"
      hidden={!open}
      style={{ height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, height };
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.height + drag.current.y - e.clientY);
        }}
        onPointerUp={() => (drag.current = undefined)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") resize(height + 24);
          else if (e.key === "ArrowDown") resize(height - 24);
          else return;
          e.preventDefault();
        }}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize focus-visible:bg-ring/40"
      />
      <TerminalPool
        prefix="drawer"
        label="Terminal"
        active={open ? folder : undefined}
        deleted={deleted}
      />
    </section>
  );
}
