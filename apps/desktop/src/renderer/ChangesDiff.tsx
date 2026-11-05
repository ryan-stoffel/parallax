import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { diffBand, diffLook } from "./Approval";
import { icons } from "./icons";
import { diffRows, sameRow, type DiffLayout, type Row } from "./diffRows";
import { parseDiff, type DiffFile, type DiffLine } from "./parseDiff";
import type { ThreadView } from "./pr/model";
import { DiffStat } from "./pr/parts";
import { fileTree, FileIcon, type TreeNode } from "./TurnChanges";
import { Checkbox, Segmented } from "./ui";

/** Where the Unified/Split choice is kept, for every diff. */
const LAYOUT_KEY = "parallax.diffLayout";

/** The diff column's narrowest width for split, about 40 columns of code on each side. */
const SPLIT_MIN_WIDTH = 760;

/** Where a focus or jump scrolls: a file, and a line of its new side, from `line` to `end`. */
export type DiffFocus = { path?: string; line?: number; end?: number };

/**
 * The row `to` scrolls to: its file's first line at or after `to.line` on the new side, or the
 * file's header when it has no line, its lines are folded, or none is that far. -1 for a file not
 * in `rows`.
 */
export function focusRow(
  rows: readonly Pick<Row, "file" | "header" | "line" | "right">[],
  to?: DiffFocus,
): number {
  const header = rows.findIndex((r) => r.header && r.file.path === to?.path);
  if (header < 0 || to?.line === undefined) return header;
  const at = rows.findIndex((r, i) => {
    const line = r.line ?? r.right;
    return (
      i > header &&
      r.file.path === to.path &&
      !!line &&
      line.op !== "-" &&
      line.op !== "@" &&
      line.new !== undefined &&
      line.new >= to.line!
    );
  });
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
 * one virtualized window, so a huge file and many small ones both stay cheap, unified or split as
 * the reader chose and the width allows. A new `focus` scrolls to its file, or to its lines, which
 * it marks (a guide's step, PLX-1188). With `onViewed`, each file has Viewed, and a viewed file
 * folds; `changedSinceViewed` names the files viewed before a later commit changed them. A file's
 * header stays at the top while its lines scroll. `threads` sit under their line on their side, or under their file's header when plxd
 * doesn't say the line, drawn by `renderThread`. With `tree`, a file tree that jumps to a file
 * shows beside the diff once its container (an `@container`) is at least 900px wide.
 */
export function ChangesDiff({
  diff,
  truncated,
  focus,
  viewed,
  changedSinceViewed,
  onViewed,
  threads = [],
  renderThread,
  tree,
}: {
  diff: string;
  truncated?: boolean;
  focus?: DiffFocus;
  viewed?: ReadonlySet<string>;
  changedSinceViewed?: ReadonlySet<string>;
  onViewed?: (path: string, viewed: boolean) => void;
  threads?: readonly ThreadView[];
  renderThread?: (thread: ThreadView) => ReactNode;
  tree?: boolean;
}) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [jump, setJump] = useState<DiffFocus>();
  const scroll = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<DiffLayout>(() =>
    localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified",
  );
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setNarrow(el.clientWidth < SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const layout = narrow ? "unified" : chosen;
  const shut = (path: string) => folded.has(path) || !!viewed?.has(path);
  const rows = useMemo(
    () =>
      diffRows(
        files,
        layout,
        (path) => folded.has(path) || !!viewed?.has(path),
        renderThread ? threads : [],
      ),
    [files, layout, folded, viewed, threads, renderThread],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (i) => (rows[i]!.header ? 38 : rows[i]!.threads || rows[i]!.sides ? 140 : 20),
    overscan: 8,
  });
  const to = jump ?? focus;
  useEffect(() => {
    const at = focusRow(rows, to);
    if (at >= 0) virtualizer.scrollToIndex(at, { align: rows[at]!.header ? "start" : "center" });
    // Only a new focus or jump scrolls, not folding a file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, files]);
  // The other layout has other rows, so it stays on the line at the top rather than the row number.
  const top = useRef<Row>(undefined);
  useLayoutEffect(() => {
    virtualizer.measure();
    const at = top.current ? sameRow(rows, top.current) : -1;
    if (at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
    // Only the layout changing moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  useEffect(() => {
    top.current = rows[virtualizer.range?.startIndex ?? 0];
  });
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
  // The header of the file at the top, once its own header has scrolled off.
  const offset = virtualizer.scrollOffset ?? 0;
  const topItem = virtualizer.getVirtualItems().find((item) => item.end > offset);
  const topRow = topItem && rows[topItem.index];
  const stuck = topRow && !(topRow.header && topItem.start >= offset) ? topRow.file : undefined;
  const fileHeader = (file: DiffFile, pinned?: boolean) => {
    const path = file.path;
    // Folding from the pinned header would leave the reader far below it.
    const backToHeader = () => {
      if (pinned)
        virtualizer.scrollToIndex(
          rows.findIndex((r) => r.header && r.file === file),
          { align: "start" },
        );
    };
    return (
      <DiffFileHeader
        file={file}
        shut={shut(path)}
        onToggle={() => {
          toggle(path);
          backToHeader();
        }}
        threads={threads.filter((t) => t.path === path).length}
      >
        {changedSinceViewed?.has(path) && (
          <span className="shrink-0 text-meta text-warning">Changed since viewed</span>
        )}
        {onViewed && (
          <Checkbox
            checked={!!viewed?.has(path)}
            onChange={(on) => {
              onViewed(path, on);
              virtualizer.measure();
              backToHeader();
            }}
          >
            <span className="text-meta text-muted-foreground">Viewed</span>
          </Checkbox>
        )}
      </DiffFileHeader>
    );
  };
  return (
    <>
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5 text-body text-muted-foreground">
        {files.length === 0 ? (
          "No files changed."
        ) : (
          <>
            {files.length} {files.length === 1 ? "file" : "files"} changed
            <DiffStat added={added} removed={removed} />
          </>
        )}
        {truncated && (
          <span className="text-warning">· cut short, open it on GitHub for the rest</span>
        )}
        {files.length > 0 && (
          <div className="ml-auto flex items-center gap-3">
            {onViewed && (
              <span className="text-meta tabular-nums">
                {files.filter((f) => viewed?.has(f.path)).length} / {files.length} viewed
              </span>
            )}
            {narrow && chosen === "split" && (
              <span className="text-meta text-faint-foreground">Too narrow for split</span>
            )}
            <Segmented
              label="Diff layout"
              value={layout}
              onChange={(next) => {
                localStorage.setItem(LAYOUT_KEY, next);
                setChosen(next);
              }}
              options={[
                { value: "unified", name: layoutName(icons.unified, "Unified") },
                {
                  value: "split",
                  name: layoutName(icons.split, "Split"),
                  disabled: narrow,
                  title: narrow ? "Too narrow for split" : undefined,
                },
              ]}
            />
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-border">
        {tree && files.length > 1 && (
          <FileTree
            files={files}
            viewed={viewed}
            changed={changedSinceViewed}
            onPick={(path) => setJump({ path })}
          />
        )}
        <div
          ref={scroll}
          aria-label="Changed files"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          {stuck && <div className="sticky top-0 z-10 h-0">{fileHeader(stuck, true)}</div>}
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
                    fileHeader(row.file)
                  ) : row.threads ? (
                    <ThreadColumn threads={row.threads} render={renderThread!} edged />
                  ) : row.sides ? (
                    <div className="grid grid-cols-2 border-y border-border bg-background">
                      <ThreadColumn threads={row.sides.left} render={renderThread!} />
                      <ThreadColumn threads={row.sides.right} render={renderThread!} divider />
                    </div>
                  ) : (
                    <div
                      className={`font-mono text-meta leading-5 ${focused(to, path, row.line ?? row.right) ? "bg-accent/10" : ""}`}
                    >
                      {row.left || row.right ? (
                        <div className="grid grid-cols-2">
                          <DiffSide line={row.left} />
                          <DiffSide line={row.right} divider />
                        </div>
                      ) : row.line ? (
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

/** Threads under a line: across the diff when `edged`, else one side of a split row. */
function ThreadColumn({
  threads,
  render,
  edged,
  divider,
}: {
  threads: readonly ThreadView[];
  render: (thread: ThreadView) => ReactNode;
  edged?: boolean;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 ${threads.length ? "px-3 py-2" : ""} ${edged ? "border-y border-border bg-background" : ""} ${divider ? "border-l border-border" : ""}`}
    >
      {threads.map((t, i) => (
        <div key={t.id ?? i}>{render(t)}</div>
      ))}
    </div>
  );
}

/** A layout option's name: its icon and word. */
const layoutName = (Icon: typeof icons.unified, name: string) => (
  <>
    <Icon aria-hidden />
    {name}
  </>
);

/** A line's text, its changed part marked. */
function LineText({ line }: { line: DiffLine }) {
  if (!line.mark) return line.text || " ";
  return (
    <>
      {line.text.slice(0, line.mark[0])}
      <span className={line.op === "+" ? "diff-word-added" : "diff-word-removed"}>
        {line.text.slice(line.mark[0], line.mark[1])}
      </span>
      {line.text.slice(line.mark[1])}
    </>
  );
}

/**
 * One side of a split row: its line number, sign, and text, or a filler where this side has no line.
 * Always wrapping, whatever Settings says, so both sides of a row keep one height.
 */
function DiffSide({ line, divider }: { line?: DiffLine; divider?: boolean }) {
  const edge = divider ? "border-l border-border" : "";
  if (!line) return <div aria-hidden className={`min-w-0 bg-hover/40 ${edge}`} />;
  const look = diffLook[line.op as keyof typeof diffLook];
  return (
    <div className={`flex min-w-0 ${look.row} ${edge}`}>
      <span aria-hidden className="w-10 shrink-0 pr-2 text-right text-faint-foreground select-none">
        {divider ? line.new : line.old}
      </span>
      <span aria-hidden className={`w-5 shrink-0 select-none ${look.sign}`}>
        {line.op === "-" ? "−" : line.op}
      </span>
      {line.op !== " " && (
        <span className="sr-only">{line.op === "+" ? "Added: " : "Removed: "}</span>
      )}
      <span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">
        <LineText line={line} />
      </span>
    </div>
  );
}

/** A diff's line, wrapping, numbered on both sides, its change named for screen readers. */
export function DiffLineView({ line }: { line: DiffLine }) {
  return line.op === "@" ? (
    <div className={`${diffBand} code-lines break-all whitespace-pre-wrap`}>{line.text}</div>
  ) : (
    <div className={`flex ${diffLook[line.op].row}`}>
      <span aria-hidden className="w-10 shrink-0 pr-2 text-right text-faint-foreground select-none">
        {line.old}
      </span>
      <span aria-hidden className="w-10 shrink-0 pr-2 text-right text-faint-foreground select-none">
        {line.new}
      </span>
      <span aria-hidden className={`w-5 shrink-0 select-none ${diffLook[line.op].sign}`}>
        {line.op === "-" ? "−" : line.op}
      </span>
      {line.op !== " " && (
        <span className="sr-only">{line.op === "+" ? "Added: " : "Removed: "}</span>
      )}
      <span className="code-lines min-w-0 pr-3 break-all whitespace-pre-wrap">
        <LineText line={line} />
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
  changed,
  onPick,
}: {
  files: DiffFile[];
  viewed?: ReadonlySet<string>;
  changed?: ReadonlySet<string>;
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
            title={
              changed?.has(node.file.path)
                ? `${node.file.path}, changed since viewed`
                : node.file.path
            }
            onClick={() => onPick(node.file.path)}
            className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-meta hover:bg-hover ${seen ? "text-faint-foreground" : ""}`}
            style={indent}
          >
            <FileIcon path={node.file.path} />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {changed?.has(node.file.path) && (
              <span
                aria-label="Changed since viewed"
                className="size-1.5 shrink-0 rounded-full bg-warning"
              />
            )}
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
