import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { diffLook } from "./Approval";
import { languageOf, lineTokens, markTokens } from "./diffHighlight";
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
  linesInRange,
} from "./diffRows";
import { parseDiff, type DiffFile, type DiffLine } from "./parseDiff";
import { kindsOf, type ThreadView } from "./pr/model";
import { DiffStat } from "./pr/parts";
import { fileTree, FileIcon, type TreeNode } from "./TurnChanges";
import { Checkbox, IconButton, Menu, menuPanel, MenuOption, Segmented } from "./ui";

/** Where the Unified/Split choice is kept, for every diff. */
const LAYOUT_KEY = "parallax.diffLayout";

/** Where the file tree's choice is kept, for every diff. */
const TREE_KEY = "parallax.diffTree";

/** The diff column's narrowest width for split, about 40 columns of code on each side. */
const SPLIT_MIN_WIDTH = 760;

/** The whole view's narrowest width with the file tree beside the diff. */
const TREE_MIN_WIDTH = 900;

/** The file tree's width beside the diff. */
const TREE_WIDTH = 256;

/** Below this width, the bar drops its line count, which the header above also has. */
const TIGHT_WIDTH = 400;

/** Below this width, the bar also drops its viewed count, which each file's checkbox shows. */
const TIGHTER_WIDTH = 360;

/** How far into the diff counts as reading it, past a stray nudge at its top. */
const SCROLLED_PAST = 40;

/** Below this width, the bar's controls fold into a menu and a file's header drops its words. */
const COMPACT_WIDTH = 560;

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
  /** Draws the box, given the new-side text it's on, for a suggestion. */
  renderBox: (lines?: string[]) => ReactNode;
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
 * `actions` sit in the bar above the files, with `leading` at its start. `onScrolled` hears when the
 * reader scrolls in, so a header above can fold. With `tree`, a file tree
 * that jumps to a file shows beside the diff when there's room, and from a button when there isn't.
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
  leading,
  roomForActions,
  onScrolled,
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
  leading?: ReactNode;
  /** `actions` need more of a narrow bar than usual, so its counts give way. */
  roomForActions?: boolean;
  /** Told whether the reader has scrolled into the diff, or back to its top. */
  onScrolled?: (scrolled: boolean) => void;
  tree?: boolean;
}) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [jump, setJump] = useState<DiffFocus>();
  const scroll = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const [chosen, setChosen] = useState<DiffLayout>(() =>
    localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified",
  );
  const [treeOn, setTreeOn] = useState(() => localStorage.getItem(TREE_KEY) !== "off");
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const hasTree = !!tree && files.length > 1;
  const treeFits = width >= TREE_MIN_WIDTH;
  const compact = width < COMPACT_WIDTH;
  // What the narrowest bars let go of, in turn. Unmeasured, nothing goes.
  const tight = width > 0 && (width < TIGHT_WIDTH || (compact && !!roomForActions));
  const tighter = width > 0 && (width < TIGHTER_WIDTH || (compact && !!roomForActions));
  const treeBeside = hasTree && treeFits && treeOn;
  const narrow = width - (treeBeside ? TREE_WIDTH : 0) < SPLIT_MIN_WIDTH;
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
    estimateSize: (i) => {
      const row = rows[i]!;
      if (row.header || row.line?.op === "@") return 36;
      return row.threads || row.sides ? 120 : 20;
    },
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
  const kinds = useMemo(() => kindsOf(files), [files]);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const allShut = files.length > 0 && files.every((f) => shut(f.path));
  const foldAll = () => {
    setFolded(allShut ? new Set() : new Set(files.map((f) => f.path)));
    virtualizer.measure();
  };
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
  const scrolled = offset > SCROLLED_PAST;
  useEffect(() => onScrolled?.(scrolled), [scrolled, onScrolled]);
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
        {changedSinceViewed?.has(path) &&
          (compact ? (
            <span
              role="img"
              aria-label="Changed since viewed"
              title="Changed since viewed"
              className="size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : (
            <span className="shrink-0 text-meta text-warning">Changed since viewed</span>
          ))}
        {comments?.canRetarget && (
          <span className="opacity-0 transition-opacity group-hover/file:opacity-100 focus-within:opacity-100">
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
          </span>
        )}
        {onViewed && (
          <span className="ml-1 flex shrink-0">
            <Checkbox
              checked={!!viewed?.has(path)}
              onChange={(on) => {
                onViewed(path, on);
                virtualizer.measure();
                backToHeader();
              }}
            >
              <span className={compact ? "sr-only" : "text-meta text-muted-foreground"}>
                Viewed
              </span>
            </Checkbox>
          </span>
        )}
      </DiffFileHeader>
    );
  };
  const seen = files.filter((f) => viewed?.has(f.path)).length;
  const currentPath = topRow?.file.path;
  const setLayout = (next: DiffLayout) => {
    localStorage.setItem(LAYOUT_KEY, next);
    setChosen(next);
  };
  const setTree = (on: boolean) => {
    localStorage.setItem(TREE_KEY, on ? "on" : "off");
    setTreeOn(on);
  };
  // Beside the diff there's room to list the kinds in the bar. Otherwise they open from the count.
  const stat =
    treeFits || kinds.length < 2 ? (
      <DiffStat added={added} removed={removed} />
    ) : (
      <span tabIndex={0} className="group/stat relative shrink-0 rounded-sm outline-offset-2">
        <DiffStat added={added} removed={removed} />
        <span
          role="tooltip"
          className="invisible absolute top-full left-0 z-30 mt-2 w-44 rounded-lg border border-border bg-surface p-2 opacity-0 shadow-composer transition-opacity group-hover/stat:visible group-hover/stat:opacity-100 group-focus/stat:visible group-focus/stat:opacity-100"
        >
          {kinds.map((k) => (
            <span key={k.kind} className="flex items-center justify-between gap-3 py-0.5">
              <span className="text-muted-foreground">{k.kind}</span>
              <DiffStat added={k.added} removed={k.removed} />
            </span>
          ))}
        </span>
      </span>
    );
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Diff"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2 text-meta text-muted-foreground"
      >
        {leading}
        {files.length === 0 ? (
          <span className="px-1">No files changed.</span>
        ) : (
          <>
            {!leading && (
              <span className="shrink-0 px-1 tabular-nums">
                {files.length} {files.length === 1 ? "file" : "files"}
              </span>
            )}
            {!tight && stat}
            {treeFits && kinds.length > 1 && (
              <span className="flex min-w-0 items-center gap-3 overflow-hidden pl-1 whitespace-nowrap text-faint-foreground">
                {kinds.map((k) => (
                  <span key={k.kind} className="flex items-center gap-1.5">
                    {k.kind}
                    <DiffStat added={k.added} removed={k.removed} />
                  </span>
                ))}
              </span>
            )}
          </>
        )}
        {truncated && (
          <icons.warning
            role="img"
            aria-label="Cut short, open it on GitHub for the rest"
            className="size-3.5 shrink-0 text-warning"
          >
            <title>Cut short, open it on GitHub for the rest</title>
          </icons.warning>
        )}
        <span className="flex-1" />
        {onViewed && files.length > 0 && !tighter && (
          <span title={`${seen} of ${files.length} files viewed`} className="shrink-0 tabular-nums">
            {seen}/{files.length}
            {compact ? "" : " viewed"}
          </span>
        )}
        {actions}
        {files.length > 0 &&
          (compact ? (
            <DiffOptions
              layout={layout}
              narrow={narrow}
              onLayout={setLayout}
              allShut={allShut}
              onFoldAll={foldAll}
            />
          ) : (
            <>
              {narrow && chosen === "split" && (
                <span className="shrink-0 text-faint-foreground">Too narrow for split</span>
              )}
              <Segmented
                label="Diff layout"
                value={layout}
                onChange={setLayout}
                options={[
                  {
                    value: "unified",
                    title: "Unified",
                    name: layoutName(icons.unified, "Unified"),
                  },
                  {
                    value: "split",
                    name: layoutName(icons.split, "Split"),
                    disabled: narrow,
                    title: narrow ? "Too narrow for split" : "Split",
                  },
                ]}
              />
              <IconButton
                size="sm"
                label={allShut ? "Expand all files" : "Collapse all files"}
                onClick={foldAll}
              >
                {allShut ? <icons.expandAll aria-hidden /> : <icons.collapseAll aria-hidden />}
              </IconButton>
            </>
          ))}
        {hasTree &&
          (treeFits ? (
            <IconButton
              size="sm"
              label={treeOn ? "Hide file tree" : "Show file tree"}
              aria-pressed={treeOn}
              onClick={() => setTree(!treeOn)}
            >
              <icons.fileTree aria-hidden />
            </IconButton>
          ) : (
            <>
              <IconButton
                size="sm"
                label="Files"
                aria-haspopup="dialog"
                popoverTarget={`${treeId}-tree`}
              >
                <icons.fileTree aria-hidden />
              </IconButton>
              <div
                id={`${treeId}-tree`}
                popover="auto"
                className={`${menuPanel("end")} max-h-[70vh] w-[min(22rem,90vw)] overflow-y-auto p-1`}
              >
                <FileTree
                  files={files}
                  viewed={viewed}
                  changed={changedSinceViewed}
                  current={currentPath}
                  onPick={(path) => {
                    document.getElementById(`${treeId}-tree`)?.hidePopover();
                    setJump({ path });
                  }}
                />
              </div>
            </>
          ))}
      </div>
      <div className="flex min-h-0 flex-1">
        {treeBeside && (
          <nav
            aria-label="Files"
            style={{ width: TREE_WIDTH }}
            className="shrink-0 overflow-y-auto border-r border-border p-1"
          >
            <FileTree
              files={files}
              viewed={viewed}
              changed={changedSinceViewed}
              current={currentPath}
              onPick={(path) => setJump({ path })}
            />
          </nav>
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
                    <ComposerRow side={row.composer} indent={!compact}>
                      {comments?.renderBox(linesInRange(row.file, comments.target?.range))}
                    </ComposerRow>
                  ) : row.threads ? (
                    <ThreadColumn threads={row.threads} render={renderThread!} indent={!compact} />
                  ) : row.sides ? (
                    <div className="grid grid-cols-2">
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
                            lang={languageOf(path)}
                            gutter={row.left && gutterOf(row.file, "left", row.left.old)}
                          />
                          <DiffSide
                            line={row.right}
                            lang={languageOf(path)}
                            gutter={row.right && gutterOf(row.file, "right", row.right.new)}
                            divider
                          />
                        </div>
                      ) : row.line ? (
                        <DiffLineView
                          line={row.line}
                          lang={languageOf(path)}
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
    </div>
  );
}

/** The bar's controls when narrow: the diff's layout, and folding every file. */
function DiffOptions({
  layout,
  narrow,
  onLayout,
  allShut,
  onFoldAll,
}: {
  layout: DiffLayout;
  narrow: boolean;
  onLayout: (layout: DiffLayout) => void;
  allShut: boolean;
  onFoldAll: () => void;
}) {
  const id = useId();
  return (
    <>
      <IconButton size="sm" label="Diff options" aria-haspopup="menu" popoverTarget={id}>
        <icons.options aria-hidden />
      </IconButton>
      <Menu id={id} label="Diff options" align="end" className="w-56 p-1">
        <MenuOption
          option={{ value: "unified", label: "Unified", icon: <icons.unified aria-hidden /> }}
          checked={layout === "unified"}
          onClick={() => onLayout("unified")}
        />
        <MenuOption
          option={{
            value: "split",
            label: "Split",
            icon: <icons.split aria-hidden />,
            hint: narrow ? "Too narrow" : undefined,
          }}
          checked={layout === "split"}
          disabled={narrow}
          onClick={() => onLayout("split")}
        />
        <MenuOption
          option={{
            value: "fold",
            label: allShut ? "Expand all files" : "Collapse all files",
            icon: allShut ? <icons.expandAll aria-hidden /> : <icons.collapseAll aria-hidden />,
            divider: true,
          }}
          role="menuitemcheckbox"
          checked={false}
          onClick={onFoldAll}
        />
      </Menu>
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
  const cut = file.path.lastIndexOf("/") + 1;
  return (
    <div className="group/file flex h-9 items-center gap-1.5 border-b border-border bg-surface pr-2 pl-1.5 text-meta">
      <button
        type="button"
        aria-expanded={!shut}
        aria-label={`${shut ? "Show" : "Hide"} ${file.path}`}
        onClick={onToggle}
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground"
      >
        <icons.next
          aria-hidden
          className={`size-3.5 transition-transform duration-fast ${shut ? "" : "rotate-90"}`}
        />
      </button>
      <FileIcon path={file.path} />
      {/* The folders give way first, so the file's name is what stays. */}
      <span className="flex min-w-0 flex-1 items-baseline" title={name}>
        {file.oldPath && (
          <span className="min-w-0 truncate text-faint-foreground">{file.oldPath} → </span>
        )}
        <span className="min-w-0 truncate text-muted-foreground">{file.path.slice(0, cut)}</span>
        <span className="shrink-0 font-medium text-foreground">{file.path.slice(cut)}</span>
      </span>
      {threads > 0 && (
        <span
          title={`${threads} review ${threads === 1 ? "thread" : "threads"}`}
          className="flex shrink-0 items-center gap-1 text-faint-foreground"
        >
          <icons.comment aria-hidden className="size-3" />
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
  indent,
  children,
}: {
  side: "left" | "right" | "across";
  indent?: boolean;
  children: ReactNode;
}) {
  if (side === "across")
    return (
      <div className={`py-2 pr-3 ${indent ? "pl-11" : "pl-2"}`}>
        <div className="max-w-3xl">{children}</div>
      </div>
    );
  return (
    <div className="grid grid-cols-2">
      <div
        className={`min-w-0 px-2 py-2 ${side === "right" ? "col-start-2 border-l border-border" : ""}`}
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

/** Threads under a line: across the diff, past its gutter with `indent`, or one side of a split row. */
function ThreadColumn({
  threads,
  render,
  indent,
  divider,
}: {
  threads: readonly ThreadView[];
  render: (thread: ThreadView) => ReactNode;
  indent?: boolean;
  divider?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 ${threads.length ? `py-2 pr-3 ${indent ? "pl-11" : "pl-2"}` : ""} ${divider ? "border-l border-border" : ""}`}
    >
      {threads.map((t, i) => (
        <div key={t.id ?? i} className="max-w-3xl">
          {render(t)}
        </div>
      ))}
    </div>
  );
}

/** A layout option's name: its icon, its word for screen readers. */
const layoutName = (Icon: typeof icons.unified, name: string) => (
  <>
    <Icon aria-hidden />
    <span className="sr-only">{name}</span>
  </>
);

/** A line's text, in its language's colors, its changed part marked. */
function LineText({ line, lang }: { line: DiffLine; lang?: string }) {
  if (!line.text) return " ";
  return markTokens(lineTokens(lang, line.text), line.mark).map((t, i) => {
    const look = `${t.cls ?? ""} ${
      t.marked ? (line.op === "+" ? "diff-word-added" : "diff-word-removed") : ""
    }`.trim();
    return look ? (
      <span key={i} className={look}>
        {t.text}
      </span>
    ) : (
      t.text
    );
  });
}

/** A line's number, which holds its + for a comment and takes a pick. */
function LineNumber({ n, gutter }: { n?: number; gutter?: Gutter }) {
  return (
    <span
      aria-hidden
      onPointerDown={gutter?.active ? gutter.onPointerDown : undefined}
      onPointerEnter={gutter?.active ? gutter.onPointerEnter : undefined}
      className={`diff-gutter w-10 shrink-0 pr-2 text-right tabular-nums select-none ${gutter?.active ? "cursor-pointer" : ""}`}
    >
      {n}
    </span>
  );
}

/** What a change is, for screen readers, since a colored bar says it by sight alone. */
const ChangeName = ({ op }: { op: DiffLine["op"] }) =>
  op === "+" || op === "-" ? (
    <span className="sr-only">{op === "+" ? "Added: " : "Removed: "}</span>
  ) : null;

/**
 * One side of a split row: its line number and text, or a filler where this side has no line.
 * Always wrapping, whatever Settings says, so both sides of a row keep one height.
 */
function DiffSide({
  line,
  lang,
  gutter,
  divider,
}: {
  line?: DiffLine;
  lang?: string;
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
      <LineNumber n={divider ? line.new : line.old} gutter={gutter} />
      <ChangeName op={line.op} />
      <span className="min-w-0 flex-1 pr-3 pl-2 wrap-anywhere whitespace-pre-wrap">
        <LineText line={line} lang={lang} />
      </span>
    </div>
  );
}

/** A hunk's band: how many unchanged lines it skips, and where it picks up. */
function HunkBand({ line }: { line: DiffLine }) {
  const { hidden, context } = line;
  if (!hidden && !context) return <div className="h-1" />;
  return (
    <div
      title={line.text}
      className="mx-2 my-1 flex h-6 items-center gap-2 rounded-md bg-hover px-2 font-sans text-meta text-faint-foreground"
    >
      {!!hidden && (
        <span className="shrink-0">
          {hidden} unmodified {hidden === 1 ? "line" : "lines"}
        </span>
      )}
      {context && <span className="min-w-0 truncate font-mono">{context}</span>}
    </div>
  );
}

/** A diff's line, numbered as T3 Code numbers one: its own side's number, its change a colored bar. */
export function DiffLineView({
  line,
  lang,
  gutter,
}: {
  line: DiffLine;
  lang?: string;
  gutter?: Gutter;
}) {
  if (line.op === "@") return <HunkBand line={line} />;
  return (
    <div
      className={`group/line relative flex ${diffLook[line.op].row} ${gutter?.selected ? "diff-row-picked" : ""}`}
    >
      {gutter?.active && <AddComment gutter={gutter} />}
      <LineNumber n={line.new ?? line.old} gutter={gutter} />
      <ChangeName op={line.op} />
      <span className="code-lines min-w-0 flex-1 pr-3 pl-2">
        <LineText line={line} lang={lang} />
      </span>
    </div>
  );
}

/** The changed files as a folder tree: a file jumps to it, with a check once viewed. */
function FileTree({
  files,
  viewed,
  changed,
  current,
  onPick,
}: {
  files: DiffFile[];
  viewed?: ReadonlySet<string>;
  changed?: ReadonlySet<string>;
  current?: string;
  onPick: (path: string) => void;
}) {
  const nodes = fileTree(
    files.map((f) => ({ path: f.path, additions: f.added, deletions: f.removed })),
  );
  const rows = (list: TreeNode[], depth: number): ReactNode[] =>
    list.flatMap((node) => {
      const indent = { paddingLeft: 6 + depth * 12 };
      if (node.kind === "dir")
        return [
          <li
            key={`d ${node.path}`}
            className="flex h-6 items-center truncate pr-2 text-meta text-faint-foreground"
            style={indent}
            title={node.path}
          >
            <span className="truncate">{node.name}</span>
          </li>,
          ...rows(node.children, depth + 1),
        ];
      const seen = viewed?.has(node.file.path);
      const here = current === node.file.path;
      return [
        <li key={node.file.path}>
          <button
            type="button"
            title={
              changed?.has(node.file.path)
                ? `${node.file.path}, changed since viewed`
                : node.file.path
            }
            aria-current={here || undefined}
            onClick={() => onPick(node.file.path)}
            className={`flex h-6 w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-meta hover:bg-hover ${here ? "bg-selected" : ""} ${seen ? "text-faint-foreground" : "text-muted-foreground"}`}
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
  return <ul>{rows(nodes, 0)}</ul>;
}
