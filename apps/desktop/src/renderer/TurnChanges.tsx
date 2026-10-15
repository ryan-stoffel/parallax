import { ChevronRight, ChevronsDownUp, ChevronsUpDown, File, FileDiff, Folder } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import type { CheckpointFile, ThreadRun } from "../protocol/generated/protocol";

/** A folder of a turn's changed files, single-child folders joined into one, or a file. */
export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; file: CheckpointFile };

/**
 * `files` as a folder tree: folders first, then files, each by name, and a folder whose only child
 * is a folder joined with it, as `apps/desktop/src`.
 */
export function fileTree(files: readonly CheckpointFile[]): TreeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: CheckpointFile[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push(file);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const nodes = (dir: Dir, at: string): TreeNode[] => [
    ...[...dir.dirs.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, sub]): TreeNode => {
        while (sub.files.length === 0 && sub.dirs.size === 1) {
          const [next, only] = [...sub.dirs.entries()][0]!;
          name = `${name}/${next}`;
          sub = only;
        }
        const path = at ? `${at}/${name}` : name;
        return { kind: "dir", name, path, children: nodes(sub, path) };
      }),
    ...dir.files
      .map((file): TreeNode => ({ kind: "file", name: file.path.split("/").pop()!, file }))
      .sort((a, b) => byName(a.name, b.name)),
  ];
  return nodes(root, "");
}

const dirsOf = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...dirsOf(n.children)] : []));

/**
 * What each turn's changes card reads, given by the transcript's chat: the turns by the id their
 * prompt's row has (the first prompt's row has none), which folders the user folded or opened, by
 * `turn\npath`, since rows unmount off screen, and, where there's a Changes view, how to open it.
 */
export interface TurnChangesTarget {
  turns: ReadonlyMap<string | undefined, ThreadRun>;
  folds: ReadonlyMap<string, boolean>;
  setFolds: (folds: Record<string, boolean>) => void;
  open?: (ordinal: number, path?: string) => void;
}

export const TurnChangesContext = createContext<TurnChangesTarget | undefined>(undefined);

/** A turn's changed files with more than this many start folded. */
const OPEN_UP_TO = 10;

/**
 * The files the turn `turnId` changed, as its checkpoint counts them (0062), under its last reply:
 * how many and their lines, as a folder tree, and Open diff, which shows the turn in the side
 * panel's Changes view. A file opens there too, scrolled to it. Nothing while the turn has no
 * ready checkpoint or changed nothing.
 */
export function TurnChanges({ turnId }: { turnId: string | undefined }) {
  const target = useContext(TurnChangesContext);
  const run = target?.turns.get(turnId);
  const files = run?.checkpoint?.status === "ready" ? (run.checkpoint.files ?? []) : [];
  if (!target || !run?.ordinal || files.length === 0) return null;
  const { folds, setFolds, open } = target;
  const ordinal = run.ordinal;
  const tree = fileTree(files);
  const dirs = dirsOf(tree);
  const key = (path: string) => `${run.id}\n${path}`;
  const isOpen = (path: string) => folds.get(key(path)) ?? files.length <= OPEN_UP_TO;
  const anyOpen = dirs.some(isOpen);
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  const AllIcon = anyOpen ? ChevronsDownUp : ChevronsUpDown;

  const rows = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      const indent = { paddingLeft: 12 + depth * 16 };
      if (node.kind === "file") {
        const { file } = node;
        const label = (
          <>
            <File aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <Counts added={file.additions} removed={file.deletions} />
          </>
        );
        const row = "flex h-7 w-full items-center gap-2 rounded-md pr-3 text-left";
        return open ? (
          <button
            key={file.path}
            type="button"
            title={file.path}
            onClick={() => open(ordinal, file.path)}
            className={`${row} hover:bg-hover`}
            style={indent}
          >
            {label}
          </button>
        ) : (
          <div key={file.path} title={file.path} className={row} style={indent}>
            {label}
          </div>
        );
      }
      const shown = isOpen(node.path);
      return [
        <button
          key={node.path}
          type="button"
          aria-expanded={shown}
          title={node.path}
          onClick={() => setFolds({ [key(node.path)]: !shown })}
          className="flex h-7 w-full items-center gap-2 rounded-md pr-3 text-left text-muted-foreground hover:bg-hover"
          style={indent}
        >
          <ChevronRight
            aria-hidden
            className={`-ml-1 size-3.5 shrink-0 transition-transform ${shown ? "rotate-90" : ""}`}
          />
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{node.name}</span>
          {!shown && <Counts {...totals(node.children)} />}
        </button>,
        ...(shown ? rows(node.children, depth + 1) : []),
      ];
    });

  return (
    <section
      aria-label={`Turn ${ordinal}'s changed files`}
      className="mt-1 overflow-hidden rounded-xl border border-border bg-surface"
    >
      <header className="flex h-10 items-center gap-2 border-b border-border pr-1.5 pl-3.5 text-[13px]">
        <span className="font-medium text-foreground">
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </span>
        <Counts added={added} removed={removed} />
        <span className="flex-1" />
        {dirs.length > 0 && (
          <button
            type="button"
            aria-label={anyOpen ? "Fold all folders" : "Open all folders"}
            title={anyOpen ? "Fold all folders" : "Open all folders"}
            onClick={() => setFolds(Object.fromEntries(dirs.map((d) => [key(d), !anyOpen])))}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <AllIcon aria-hidden className="size-3.5" />
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={() => open(ordinal)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <FileDiff aria-hidden className="size-3.5" />
            Open diff
          </button>
        )}
      </header>
      <div className="p-1 text-[13px]">{rows(tree, 0)}</div>
    </section>
  );
}

function totals(nodes: TreeNode[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const n of nodes) {
    const t =
      n.kind === "file"
        ? { added: n.file.additions, removed: n.file.deletions }
        : totals(n.children);
    added += t.added;
    removed += t.removed;
  }
  return { added, removed };
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums">
      <span className="text-added">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}
