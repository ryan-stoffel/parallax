import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { diffBand, diffLook } from "./Approval";
import { icons } from "./icons";
import { parseDiff, type DiffFile, type DiffLine } from "./parseDiff";
import type { ThreadView } from "./pr/model";
import { DiffStat } from "./pr/parts";
import { fileTree, FileIcon, type TreeNode } from "./TurnChanges";
import { Checkbox } from "./ui";

type Row = { file: DiffFile; header?: boolean; line?: DiffLine; threads?: ThreadView[] };

/** Where a focus or jump scrolls: a file, and a line of its new side, from `line` to `end`. */
export type DiffFocus = { path?: string; line?: number; end?: number };

/**
 * The row `to` scrolls to: its file's first line at or after `to.line` on the new side, or the
 * file's header when it has no line, its lines are folded, or none is that far. -1 for a file not
 * in `rows`.
 */
export function focusRow(
  rows: readonly Pick<Row, "file" | "header" | "line">[],
  to?: DiffFocus,
): number {
  const header = rows.findIndex((r) => r.header && r.file.path === to?.path);
  if (header < 0 || to?.line === undefined) return header;
  const at = rows.findIndex(
    (r, i) =>
      i > header &&
      r.file.path === to.path &&
      !!r.line &&
      r.line.op !== "-" &&
      r.line.op !== "@" &&
      r.line.new !== undefined &&
      r.line.new >= to.line!,
  );
  return at < 0 ? header : at;
}

/** Whether `line` of `path` is in `to`'s lines. */
const focused = (to: DiffFocus | undefined, path: string, line?: DiffLine) =>
  !!to?.line &&
  to.path === path &&
  !!line &&
  line.op !== "-" &&
  line.new !== undefined &&
  line.new >= to.line &&
  line.new <= (to.end ?? to.line);

/**
 * The one diff renderer, for the Changes view (0062) and a pull request's Files tab: every file in
 * one virtualized window, so a huge file and many small ones both stay cheap. A new `focus`
 * scrolls to its file, or to its lines, which it marks (a guide's step, PLX-1188). With `onViewed`, each file has Viewed, and a viewed file folds. `threads`
 * sit under their line, or under their file's header when plxd doesn't say the line, drawn by
 * `renderThread`. With `tree`, a file tree that jumps to a file shows beside the diff once its
 * container (an `@container`) is at least 900px wide.
 */
export function ChangesDiff({
  diff,
  truncated,
  focus,
  viewed,
  onViewed,
  threads = [],
  renderThread,
  tree,
}: {
  diff: string;
  truncated?: boolean;
  focus?: DiffFocus;
  viewed?: ReadonlySet<string>;
  onViewed?: (path: string, viewed: boolean) => void;
  threads?: readonly ThreadView[];
  renderThread?: (thread: ThreadView) => ReactNode;
  tree?: boolean;
}) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [jump, setJump] = useState<DiffFocus>();
  const scroll = useRef<HTMLDivElement>(null);
  const shut = (path: string) => folded.has(path) || !!viewed?.has(path);
  const rows = useMemo(() => {
    const rows: Row[] = [];
    for (const file of files) {
      rows.push({ file, header: true });
      if (folded.has(file.path) || viewed?.has(file.path)) continue;
      const mine = renderThread ? threads.filter((t) => t.path === file.path) : [];
      const lines = new Set(file.lines.map((l) => l.new));
      const atLine = (n?: number) => mine.filter((t) => t.line !== undefined && t.line === n);
      const loose = mine.filter((t) => t.line === undefined || !lines.has(t.line));
      if (loose.length) rows.push({ file, threads: loose });
      if (file.binary) rows.push({ file });
      for (const line of file.lines) {
        rows.push({ file, line });
        const here = line.op !== "-" && line.op !== "@" ? atLine(line.new) : [];
        if (here.length) rows.push({ file, threads: here });
      }
    }
    return rows;
  }, [files, folded, viewed, threads, renderThread]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (i) => (rows[i]!.header ? 38 : rows[i]!.threads ? 140 : 20),
    overscan: 8,
  });
  const to = jump ?? focus;
  useEffect(() => {
    const at = focusRow(rows, to);
    if (at >= 0) virtualizer.scrollToIndex(at, { align: rows[at]!.header ? "start" : "center" });
    // Only a new focus or jump scrolls, not folding a file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, files]);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const toggle = (path: string) => {
    if (viewed?.has(path)) onViewed?.(path, false);
    else
      setFolded((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      });
    virtualizer.measure();
  };
  return (
    <>
      <p className="flex items-center gap-2 px-3 py-2 text-body text-muted-foreground">
        {files.length === 0 ? (
          "No files changed."
        ) : (
          <>
            {files.length} {files.length === 1 ? "file" : "files"} changed
            <DiffStat added={added} removed={removed} />
            {onViewed && (
              <span className="ml-auto text-meta tabular-nums">
                {files.filter((f) => viewed?.has(f.path)).length} / {files.length} viewed
              </span>
            )}
          </>
        )}
        {truncated && (
          <span className="text-warning">· cut short, open it on GitHub for the rest</span>
        )}
      </p>
      <div className="flex min-h-0 flex-1 border-t border-border">
        {tree && files.length > 1 && (
          <FileTree files={files} viewed={viewed} onPick={(path) => setJump({ path })} />
        )}
        <div
          ref={scroll}
          aria-label="Changed files"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const path = row.file.path;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.header ? (
                    <DiffFileHeader
                      file={row.file}
                      shut={shut(path)}
                      onToggle={() => toggle(path)}
                      threads={threads.filter((t) => t.path === path).length}
                    >
                      {onViewed && (
                        <Checkbox
                          checked={!!viewed?.has(path)}
                          onChange={(on) => {
                            onViewed(path, on);
                            virtualizer.measure();
                          }}
                        >
                          <span className="text-meta text-muted-foreground">Viewed</span>
                        </Checkbox>
                      )}
                    </DiffFileHeader>
                  ) : row.threads ? (
                    <div className="flex flex-col gap-2 border-y border-border bg-background px-3 py-2">
                      {row.threads.map((t, i) => (
                        <div key={t.id ?? i}>{renderThread!(t)}</div>
                      ))}
                    </div>
                  ) : (
                    <div
                      className={`font-mono text-meta leading-5 ${focused(to, path, row.line) ? "shadow-[inset_2px_0_0_var(--accent)]" : ""}`}
                    >
                      {row.line ? (
                        <DiffLineView line={row.line} />
                      ) : (
                        <p className="px-3 text-faint-foreground">Binary file not shown</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/** A file's header: a chevron that folds it, its path (both, renamed), its size, and `children`. */
export function DiffFileHeader({
  file,
  shut,
  onToggle,
  threads = 0,
  children,
}: {
  file: DiffFile;
  shut: boolean;
  onToggle: () => void;
  /** How many review threads are on it. */
  threads?: number;
  children?: ReactNode;
}) {
  const name = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className="flex h-10 items-center gap-2 border-b border-border bg-code px-3 text-body">
      <button
        type="button"
        aria-expanded={!shut}
        aria-label={`${shut ? "Show" : "Hide"} ${file.path}`}
        onClick={onToggle}
        className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-hover"
      >
        <icons.next
          aria-hidden
          className={`size-4 transition-transform duration-fast ${shut ? "" : "rotate-90"}`}
        />
      </button>
      <span className="min-w-0 flex-1 truncate font-mono text-body" title={name}>
        {name}
      </span>
      {threads > 0 && (
        <span
          title={`${threads} review ${threads === 1 ? "thread" : "threads"}`}
          className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground"
        >
          <icons.comment aria-hidden className="size-3.5" />
          {threads}
        </span>
      )}
      <DiffStat added={file.added} removed={file.removed} />
      {children}
    </div>
  );
}

/** A diff's line, wrapping, numbered on both sides, its change named for screen readers. */
export function DiffLineView({ line }: { line: DiffLine }) {
  return line.op === "@" ? (
    <div className={`${diffBand} code-lines break-all whitespace-pre-wrap`}>{line.text}</div>
  ) : (
    <div className={`flex ${diffLook[line.op].row}`}>
      <span
        aria-hidden
        className="w-10 shrink-0 pr-2 text-right text-faint-foreground/70 select-none"
      >
        {line.old}
      </span>
      <span
        aria-hidden
        className="w-10 shrink-0 pr-2 text-right text-faint-foreground/70 select-none"
      >
        {line.new}
      </span>
      <span aria-hidden className={`w-5 shrink-0 select-none ${diffLook[line.op].sign}`}>
        {line.op === "-" ? "−" : line.op}
      </span>
      {line.op !== " " && (
        <span className="sr-only">{line.op === "+" ? "Added: " : "Removed: "}</span>
      )}
      <span className="code-lines min-w-0 pr-3 break-all whitespace-pre-wrap">
        {line.text || " "}
      </span>
    </div>
  );
}

/**
 * The changed files as a folder tree beside the diff, shown only when its container is wide: a
 * file jumps to it, with a check once viewed.
 */
function FileTree({
  files,
  viewed,
  onPick,
}: {
  files: DiffFile[];
  viewed?: ReadonlySet<string>;
  onPick: (path: string) => void;
}) {
  const nodes = fileTree(
    files.map((f) => ({ path: f.path, additions: f.added, deletions: f.removed })),
  );
  const rows = (list: TreeNode[], depth: number): ReactNode[] =>
    list.flatMap((node) => {
      const indent = { paddingLeft: 8 + depth * 12 };
      if (node.kind === "dir")
        return [
          <li
            key={`d ${node.path}`}
            className="flex h-7 items-center gap-1.5 truncate pr-2 font-mono text-meta text-faint-foreground"
            style={indent}
            title={node.path}
          >
            <icons.folder aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
          </li>,
          ...rows(node.children, depth + 1),
        ];
      const seen = viewed?.has(node.file.path);
      return [
        <li key={node.file.path}>
          <button
            type="button"
            title={node.file.path}
            onClick={() => onPick(node.file.path)}
            className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-meta hover:bg-hover ${seen ? "text-faint-foreground" : ""}`}
            style={indent}
          >
            <FileIcon path={node.file.path} />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {seen ? (
              <icons.done aria-label="Viewed" className="size-3.5 shrink-0 text-added" />
            ) : (
              <DiffStat added={node.file.additions} removed={node.file.deletions} />
            )}
          </button>
        </li>,
      ];
    });
  return (
    <nav
      aria-label="Files"
      className="hidden w-64 shrink-0 overflow-y-auto border-r border-border p-1 @min-[900px]:block"
    >
      <ul>{rows(nodes, 0)}</ul>
    </nav>
  );
}
