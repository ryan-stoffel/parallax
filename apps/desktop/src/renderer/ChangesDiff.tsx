import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { diffBand, diffLook } from "./Approval";
import { icons } from "./icons";
import {
  diffRows,
  numberOn,
  pickRange,
  sameRow,
  sideOf,
  type CommentTarget,
  type DiffLayout,
  type DiffSideName,
  type LineRange,
  type Row,
} from "./diffRows";
import { parseDiff, type DiffFile, type DiffLine } from "./parseDiff";
import type { ThreadView } from "./pr/model";
import { DiffStat } from "./pr/parts";
import { fileTree, FileIcon, type TreeNode } from "./TurnChanges";
import { Checkbox, IconButton, Segmented } from "./ui";

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

/** Commenting on a diff's lines: where the box is open, and how to draw it. */
export type DiffComments = {
  target?: CommentTarget;
  /** Whether a new target may replace the open one, which holds no text. */
  canRetarget: boolean;
  onTarget: (target: CommentTarget) => void;
  renderBox: () => ReactNode;
};

/** A line's gutter: pressing it starts a pick, entering it extends one, unless it's not `active`. */
type Gutter = {
  selected: boolean;
  active: boolean;
  label: string;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerEnter: () => void;
  onKeyboard: () => void;
};

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
 * doesn't say the line, drawn by `renderThread`. With `comments`, a line's gutter takes a comment:
 * its + on hover, a drag or a shift-click for a range, and each file's header for the whole file.
 * `actions` sit in the bar above the files. With `tree`, a file tree that jumps to a file shows
 * beside the diff once its container (an `@container`) is at least 900px wide.
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
  comments,
  actions,
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
  comments?: DiffComments;
  actions?: ReactNode;
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
        comments?.target,
      ),
    [files, layout, folded, viewed, threads, renderThread, comments?.target],
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
  // A pick of lines in progress, and the line it started from, which a shift-click goes on from.
  const [picking, setPicking] = useState<{ path: string; range: LineRange }>();
  const pick = useRef<{ file: DiffFile; side: DiffSideName; from: number; range: LineRange }>(
    undefined,
  );
  const anchor = useRef<{ path: string; side: DiffSideName; from: number }>(undefined);
  const gutterOf = (file: DiffFile, side: DiffSideName, n?: number): Gutter | undefined => {
    if (!comments || n === undefined) return undefined;
    const shown = picking?.path === file.path ? picking.range : undefined;
    const open = comments.target?.path === file.path ? comments.target.range : undefined;
    const lit = shown ?? open;
    const extend = (from: number, to: number) => {
      const range = pickRange(file.lines, side, from, to);
      pick.current = { file, side, from, range };
      setPicking({ path: file.path, range });
    };
    return {
      selected: !!lit && lit.side === side && n >= lit.start && n <= lit.end,
      active: comments.canRetarget,
      label: `Comment on line ${n}${side === "left" ? " of the old file" : ""}`,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        // Not a text selection, and the button's focus would scroll.
        e.preventDefault();
        const last = anchor.current;
        const from = e.shiftKey && last?.path === file.path && last.side === side ? last.from : n;
        extend(from, n);
        const end = () => {
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          const done = pick.current;
          pick.current = undefined;
          setPicking(undefined);
          if (!done) return;
          anchor.current = { path: done.file.path, side: done.side, from: done.from };
          comments.onTarget({ path: done.file.path, range: done.range });
        };
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      },
      onPointerEnter: () => {
        const now = pick.current;
        if (now?.file === file && now.side === side) extend(now.from, n);
      },
      onKeyboard: () =>
        comments.onTarget({ path: file.path, range: pickRange(file.lines, side, n, n) }),
    };
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
        {comments?.canRetarget && (
          <IconButton
            size="sm"
            label={`Comment on ${file.path}`}
            onClick={() => {
              if (shut(path)) toggle(path);
              comments.onTarget({ path });
              backToHeader();
            }}
          >
            <icons.comment aria-hidden />
          </IconButton>
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
            {actions}
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
                  ) : row.composer ? (
                    <ComposerRow side={row.composer}>{comments?.renderBox()}</ComposerRow>
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
                          <DiffSide
                            line={row.left}
                            gutter={row.left && gutterOf(row.file, "left", row.left.old)}
                          />
                          <DiffSide
                            line={row.right}
                            gutter={row.right && gutterOf(row.file, "right", row.right.new)}
                            divider
                          />
                        </div>
                      ) : row.line ? (
                        <DiffLineView
                          line={row.line}
                          gutter={
                            row.line.op === "@"
                              ? undefined
                              : gutterOf(
                                  row.file,
                                  sideOf(row.line),
                                  numberOn(row.line, sideOf(row.line)),
                                )
                          }
                        />
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

/** The comment box's row: across the diff, or under its side of a split row. */
function ComposerRow({
  side,
  children,
}: {
  side: "left" | "right" | "across";
  children: ReactNode;
}) {
  if (side === "across")
    return <div className="border-y border-border bg-background px-3 py-2">{children}</div>;
  return (
    <div className="grid grid-cols-2 border-y border-border bg-background">
      <div
        className={`min-w-0 px-3 py-2 ${side === "right" ? "col-start-2 border-l border-border" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

/** A line's + for a comment, shown when its row is hovered or it has focus. */
function AddComment({ gutter }: { gutter: Gutter }) {
  return (
    <button
      type="button"
      aria-label={gutter.label}
      onPointerDown={gutter.onPointerDown}
      onClick={(e) => {
        // A press is handled from pointer events: only the keyboard clicks with no pointer.
        if (e.detail === 0) gutter.onKeyboard();
      }}
      className="absolute top-0.5 left-0.5 grid size-4 place-items-center rounded-sm bg-accent text-accent-foreground opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <icons.add aria-hidden strokeWidth={3} className="size-3" />
    </button>
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
function DiffSide({
  line,
  gutter,
  divider,
}: {
  line?: DiffLine;
  gutter?: Gutter;
  divider?: boolean;
}) {
  const edge = divider ? "border-l border-border" : "";
  if (!line) return <div aria-hidden className={`min-w-0 bg-hover/40 ${edge}`} />;
  const look = diffLook[line.op as keyof typeof diffLook];
  return (
    <div
      className={`group/line relative flex min-w-0 ${look.row} ${edge} ${gutter?.selected ? "diff-row-picked" : ""}`}
    >
      {gutter?.active && <AddComment gutter={gutter} />}
      <span
        aria-hidden
        onPointerDown={gutter?.active ? gutter.onPointerDown : undefined}
        onPointerEnter={gutter?.active ? gutter.onPointerEnter : undefined}
        className={`w-10 shrink-0 pr-2 text-right text-faint-foreground select-none ${gutter?.active ? "cursor-pointer hover:text-foreground" : ""}`}
      >
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
export function DiffLineView({ line, gutter }: { line: DiffLine; gutter?: Gutter }) {
  return line.op === "@" ? (
    <div className={`${diffBand} code-lines break-all whitespace-pre-wrap`}>{line.text}</div>
  ) : (
    <div
      className={`group/line relative flex ${diffLook[line.op].row} ${gutter?.selected ? "diff-row-picked" : ""}`}
    >
      {gutter?.active && <AddComment gutter={gutter} />}
      <span
        aria-hidden
        onPointerDown={gutter?.active ? gutter.onPointerDown : undefined}
        onPointerEnter={gutter?.active ? gutter.onPointerEnter : undefined}
        className={`flex shrink-0 text-faint-foreground select-none ${gutter?.active ? "cursor-pointer hover:text-foreground" : ""}`}
      >
        <span className="w-10 pr-2 text-right">{line.old}</span>
        <span className="w-10 pr-2 text-right">{line.new}</span>
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
