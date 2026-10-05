import { Plus, Terminal, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { noRepo, type ThreadsState, type ThreadsView } from "./threads";
import { IconButton } from "./ui";

// xterm.js loads with the first terminal shown.
const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/**
 * A folder a terminal opens in, on a host: a repository's checkout, or a No Repo thread's own.
 * `key` names it across hosts, and a thread's ends its terminals when the thread is deleted.
 */
export type ThreadFolder = { key: string; hostId: string; path: string; threadId?: string };

/** The `path` of a host's home folder, which main resolves, since the app can't know it. */
export const homePath = "~";

/**
 * Thread `threadId`'s folder: its own worktree, or a Current checkout thread's repository
 * checkout, shared with the repository's New thread. A thread with no run yet gets its
 * repository's checkout too. A No Repo thread has its scratch repository's, once its run made
 * one. Or with `repoId`, a repository's checkout, for New thread, or the host's home folder for
 * No Repo's. Undefined while a No Repo thread has none yet.
 */
export function folderOf(
  hostId: string,
  state: ThreadsState,
  open: { threadId: string } | { repoId: string },
): ThreadFolder | undefined {
  if ("repoId" in open) {
    const repo = state.repos.find((r) => r.id === open.repoId && !r.scratch);
    if (repo) return { key: `${hostId}/new/${repo.id}`, hostId, path: repo.path };
    return open.repoId === noRepo ? { key: `${hostId}/home`, hostId, path: homePath } : undefined;
  }
  const { threadId } = open;
  const thread = state.threads.find((t) => t.id === threadId);
  const repo = state.repos.find((r) => r.id === thread?.repo && !r.scratch);
  const path = state.runs[threadId]?.worktreePath;
  if (path !== undefined) return { key: `${hostId}/${threadId}`, hostId, path, threadId };
  return repo && folderOf(hostId, state, { repoId: repo.id });
}

/** The terminal id of a folder's first drawer tab, to type or run a command in it with `terminalInput`. */
export const drawerTerminalId = (folder: ThreadFolder) => `drawer:${folder.key}`;

/** The terminal id of a folder's drawer tab `n`. */
const tabTerminalId = (folder: ThreadFolder, n: number) =>
  n === 1 ? drawerTerminalId(folder) : `${drawerTerminalId(folder)}:${n}`;

// Each folder's shown drawer tab's terminal id, by folder key, where `runInDrawer` runs a command.
const shownTabs = new Map<string, string>();

// The terminals whose shell runs, and the command to run in each once it does, by terminal id.
// Main drops input to a terminal that hasn't started. A shell that exits drops its queue, and only
// the latest command waits for its restart.
const running = new Set<string>();
const queued = new Map<string, string>();

/**
 * Runs `command` in `folder`'s shown drawer tab, or its first while it has none: now if its shell
 * runs, else once it starts, in place of any command already waiting. Open the drawer on `folder`
 * too, so it starts.
 */
export function runInDrawer(folder: ThreadFolder, command: string) {
  const id = shownTabs.get(folder.key) ?? drawerTerminalId(folder);
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

/** A folder's drawer tabs: their numbers in order, the shown one, and the next new one's. */
type Tabs = { folder: ThreadFolder; open: number[]; active: number; next: number };

/**
 * The terminal drawer under the chat: `folder`'s tabs while `open`, and every other folder's it has
 * shown, hidden, each tab a shell kept running while another is shown. Its tab bar's + opens
 * another tab, and its X, or closing the last tab, calls `onClose`; the next open starts one fresh
 * tab. Its top edge drags, or takes the arrow keys, to resize it.
 */
export function TerminalDrawer({
  open,
  folder,
  deleted,
  onClose,
}: {
  open: boolean;
  folder: ThreadFolder | undefined;
  deleted: (folder: ThreadFolder) => boolean;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(280);
  const drag = useRef<{ y: number; height: number }>(undefined);
  const resize = (next: number) =>
    setHeight(Math.round(Math.min(Math.max(next, 96), window.innerHeight - 160)));

  const [tabs, setTabs] = useState<Readonly<Record<string, Tabs>>>({});
  const setTabsOf = (key: string, next: Tabs | undefined) => {
    const { [key]: _, ...rest } = tabs;
    setTabs(next ? { ...rest, [key]: next } : rest);
    if (next) shownTabs.set(key, tabTerminalId(next.folder, next.active));
    else shownTabs.delete(key);
  };
  if (open && folder && !deleted(folder) && !tabs[folder.key])
    setTabsOf(folder.key, { folder, open: [1], active: 1, next: 2 });
  else {
    const gone = Object.values(tabs).find((t) => deleted(t.folder));
    if (gone) setTabsOf(gone.folder.key, undefined);
  }
  const current = folder && tabs[folder.key];

  // Closing the shown tab shows the one after it, or before it; closing the last closes the drawer.
  const closeTab = (t: Tabs, n: number) => {
    const i = t.open.indexOf(n);
    const rest = t.open.toSpliced(i, 1);
    if (!rest.length) {
      setTabsOf(t.folder.key, undefined);
      onClose();
      return;
    }
    const active = n === t.active ? rest[Math.min(i, rest.length - 1)]! : t.active;
    setTabsOf(t.folder.key, { ...t, open: rest, active });
  };

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
      {current && (
        <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1.5">
          <ul aria-label="Terminals" className="flex min-w-0 gap-0.5 overflow-x-auto">
            {current.open.map((n) => (
              <li
                key={n}
                className={`flex shrink-0 items-center rounded-lg ${n === current.active ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
              >
                <button
                  type="button"
                  aria-current={n === current.active ? "true" : undefined}
                  onClick={() => setTabsOf(current.folder.key, { ...current, active: n })}
                  className="flex items-center gap-1.5 py-1 pl-2 text-[13px]"
                >
                  <Terminal aria-hidden className="size-3.5" />
                  Terminal {n}
                </button>
                <button
                  type="button"
                  aria-label={`Close Terminal ${n}`}
                  title={`Close Terminal ${n}`}
                  onClick={() => closeTab(current, n)}
                  className="mx-0.5 grid size-5 place-items-center rounded-md hover:bg-hover [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
          <IconButton
            label="New terminal"
            onClick={() =>
              setTabsOf(current.folder.key, {
                ...current,
                open: [...current.open, current.next],
                active: current.next,
                next: current.next + 1,
              })
            }
          >
            <Plus />
          </IconButton>
          <div className="ml-auto">
            <IconButton label="Hide terminal" command="terminal" onClick={onClose}>
              <X />
            </IconButton>
          </div>
        </div>
      )}
      {Object.values(tabs).flatMap((t) =>
        t.open.map((n) => (
          <PooledTerminal
            key={tabTerminalId(t.folder, n)}
            id={tabTerminalId(t.folder, n)}
            label="Terminal"
            folder={t.folder}
            hidden={!open || t !== current || n !== t.active}
          />
        )),
      )}
    </section>
  );
}
