import {
  ArrowLeft,
  Check,
  ChevronRight,
  Columns2,
  Copy,
  Ellipsis,
  Eye,
  File,
  FileCode,
  Folder,
  FolderTree,
  LoaderCircle,
  Lock,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";

import type { AgentEntry } from "../protocol/generated/protocol";
import { setAppearance, useAppearance } from "./appearance";
import type { Cursor, EditorHandle } from "./CodeEditor";
import { readWorking } from "./documents";
import { describeError } from "./errors";
import { DownloadButton } from "./FileCards";
import type { MarkdownView, OpenFile, OpenFiles } from "./openFiles";
import { GithubMarkdown } from "./pr/GithubMarkdown";
import { FileIcon } from "./TurnChanges";
import { Button, IconButton, Menu, menuItem, Segmented } from "./ui";

// The editor and its languages load when a file first opens.
const CodeEditor = lazy(() => import("./CodeEditor"));

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);

/** How long a split's preview waits after typing before it draws again. */
const PREVIEW_AFTER_MS = 150;

/**
 * The open file and everything around it, laid out like VS Code: a strip of tabs joined to the
 * editor, the file's path as a breadcrumb, the text, and a status bar. `wide` has room for a
 * split Markdown view and the status bar's details. `treeOpen` draws the button that shows the tree.
 */
export function FileEditor({
  store,
  file,
  tabs,
  wide,
  treeOpen,
  onToggleTree,
  onReveal,
  onClose,
  hostId,
  runId,
}: {
  store: OpenFiles;
  file: OpenFile;
  tabs: readonly OpenFile[];
  wide: boolean;
  treeOpen: boolean;
  onToggleTree: () => void;
  /** Shows `path` in the tree. */
  onReveal: (path: string) => void;
  onClose: (tab: OpenFile) => void;
  hostId: string;
  runId: string;
}) {
  const { wordWrap } = useAppearance();
  const [cursor, setCursor] = useState<Cursor>();
  const editor = useRef<EditorHandle>(null);
  const text = file.body.kind === "text" ? file.body : undefined;
  const markdown = !!text && isMarkdown(file.path);
  // A split needs room, so a narrow panel shows it as the text.
  const view: MarkdownView = !markdown
    ? "code"
    : !wide && file.view === "split"
      ? "code"
      : file.view;
  // What a split's preview shows, kept up with typing.
  const [live, setLive] = useState("");
  const liveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A preview waiting to draw belongs to the tab and view it was typed in.
  useEffect(() => () => clearTimeout(liveTimer.current), [file.id, view]);
  const reloads = text?.reloads ?? 0;
  useEffect(() => {
    if (view !== "code") setLive(store.textNow(file.id));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- what it shows changes with these
  }, [store, file.id, view, reloads]);
  const onEdit = (read: () => string) => {
    if (view !== "split") return;
    clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => setLive(read()), PREVIEW_AFTER_MS);
  };
  const preview = (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
      <GithubMarkdown text={live} repo="" />
    </div>
  );
  return (
    <section aria-label={file.path} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TabStrip
        store={store}
        file={file}
        tabs={tabs}
        treeOpen={treeOpen}
        onToggleTree={onToggleTree}
        onReveal={onReveal}
        onClose={onClose}
      />
      <div className="flex h-8 shrink-0 items-center gap-2 pr-1.5">
        <Breadcrumb
          path={file.path}
          hostId={hostId}
          runId={runId}
          onOpen={(path, link) => store.open(path, { link, transient: true })}
        />
        {markdown && (
          <div className="[&_label]:py-0.5 [&_label]:text-meta">
            <Segmented<MarkdownView>
              label="Show Markdown as"
              value={view}
              onChange={(next) => store.setView(file.id, next)}
              options={[
                { value: "code", name: viewName(FileCode, "Code") },
                ...(wide ? [{ value: "split" as const, name: viewName(Columns2, "Split") }] : []),
                { value: "preview", name: viewName(Eye, "Preview") },
              ]}
            />
          </div>
        )}
        <FileMenu
          file={file}
          hasText={!!text && view !== "preview"}
          wordWrap={wordWrap}
          onReveal={onReveal}
          onClose={onClose}
          onFind={() => editor.current?.find()}
          onGoToLine={() => editor.current?.goToLine()}
        />
      </div>
      {/* Room under the text for the notice, so it never covers the last lines. */}
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 ${file.conflict || file.save === "failed" ? "[&_.cm-content]:pb-40!" : ""}`}
      >
        {view !== "preview" &&
          (text ? (
            <Suspense fallback={<div className="flex-1" />}>
              <CodeEditor
                handle={editor}
                store={store}
                file={file}
                wrap={wordWrap}
                roomy={wide}
                onCursor={setCursor}
                onEdit={onEdit}
              />
            </Suspense>
          ) : (
            <NonText file={file} hostId={hostId} runId={runId} />
          ))}
        {view === "split" && <div className="w-px shrink-0 bg-border/60" />}
        {view !== "code" && preview}
        <FileNotice store={store} file={file} onClose={onClose} />
      </div>
      {text && (
        <StatusBar
          file={file}
          cursor={view === "preview" ? undefined : cursor}
          wide={wide}
          onGoToLine={() => editor.current?.goToLine()}
        />
      )}
    </section>
  );
}

const viewName = (Icon: typeof Eye, name: string) => (
  <>
    <Icon aria-hidden />
    {name}
  </>
);

/** The mark on a tab: a dot for edits on their way, a warning for edits that are stuck. */
function TabMark({ tab }: { tab: OpenFile }) {
  if (tab.conflict || tab.save === "failed")
    return <span aria-label="Not saved" className="block size-2 rounded-full bg-warning" />;
  if (tab.save !== "saved")
    return <span aria-label="Saving" className="block size-2 rounded-full bg-foreground/60" />;
  return null;
}

/** The open files' tabs, joined to the editor below, as in VS Code. */
function TabStrip({
  store,
  file,
  tabs,
  treeOpen,
  onToggleTree,
  onReveal,
  onClose,
}: {
  store: OpenFiles;
  file: OpenFile;
  tabs: readonly OpenFile[];
  treeOpen: boolean;
  onToggleTree: () => void;
  onReveal: (path: string) => void;
  onClose: (tab: OpenFile) => void;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<OpenFile>();
  // The tab on screen is in view, however many are open.
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [file.id, tabs.length]);
  const choose = (action: (tab: OpenFile) => void) => () => {
    menu.current?.hidePopover();
    if (target) action(target);
  };
  return (
    <div className="flex h-9 shrink-0 border-b border-border/60 files-chrome">
      <button
        type="button"
        aria-label={treeOpen ? "Hide files" : "Show files"}
        aria-pressed={treeOpen}
        title={treeOpen ? "Hide files" : "Show files"}
        onClick={onToggleTree}
        className="grid w-9 shrink-0 place-items-center border-r border-border/60 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:text-foreground"
      >
        <FolderTree aria-hidden className="size-4" />
      </button>
      <ul
        ref={strip}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const current = tab.id === file.id;
          const mark = tab.conflict || tab.save !== "saved";
          return (
            <li
              key={tab.id}
              className={`group/tab relative -mb-px flex shrink-0 border-r border-border/60 ${current ? "z-10 bg-background" : ""}`}
            >
              {current && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
              <button
                type="button"
                role="tab"
                aria-selected={current}
                title={tab.path}
                onClick={() => store.activate(tab.id)}
                onDoubleClick={() => store.pin(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(tab);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTarget(tab);
                  menu.current?.showPopover({ source: e.currentTarget });
                }}
                className={`flex h-full max-w-52 items-center gap-1.5 pr-7 pl-3 text-meta transition-colors ${current ? "text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
              >
                <FileIcon path={tab.path} />
                <span className={`truncate ${tab.transient ? "italic" : ""}`}>
                  {nameOf(tab.path)}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${nameOf(tab.path)}`}
                title="Close"
                onClick={() => onClose(tab)}
                className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {mark && (
                  <span className="grid place-items-center group-hover/tab:hidden">
                    <TabMark tab={tab} />
                  </span>
                )}
                <X
                  aria-hidden
                  className={`size-3.5 ${mark ? "hidden group-hover/tab:block" : current ? "" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"}`}
                />
              </button>
            </li>
          );
        })}
      </ul>
      <Menu
        ref={menu}
        label={target ? `Actions for ${nameOf(target.path)}` : "Tab actions"}
        align="start"
        className="min-w-44 p-1"
      >
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => onClose(tab))}
        >
          Close
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => void store.closeAll(tab.id))}
        >
          Close others
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose(() => void store.closeAll())}
        >
          Close all
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => void navigator.clipboard.writeText(tab.path))}
        >
          Copy path
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => onReveal(tab.path))}
        >
          Show in files
        </button>
      </Menu>
    </div>
  );
}

/**
 * The file's path as a breadcrumb, as in VS Code and T3 Code: each folder opens its entries, to go
 * to a sibling without the tree. A long path scrolls, with its end in view.
 */
function Breadcrumb({
  path,
  hostId,
  runId,
  onOpen,
}: {
  path: string;
  hostId: string;
  runId: string;
  onOpen: (path: string, link: boolean) => void;
}) {
  const row = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState<string>();
  const [listed, setListed] = useState<{ entries: AgentEntry[] } | { error: string }>();
  const parts = path.split("/");
  useEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth;
  }, [path]);
  const show = (next: string) => {
    setFolder(next);
    setListed(undefined);
    void window.parallax
      .request(hostId, "agent/files", { runId, ...(next && { path: next }) })
      .then((answer) =>
        setListed("error" in answer ? { error: describeError(answer.error) } : answer.result),
      );
  };
  const segment =
    "flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-meta text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-expanded:bg-hover";
  const entries =
    listed && "entries" in listed
      ? listed.entries.toSorted(
          (a, b) =>
            Number(b.kind === "dir") - Number(a.kind === "dir") || (a.name < b.name ? -1 : 1),
        )
      : [];
  return (
    <>
      <nav
        ref={row}
        aria-label="File path"
        title={path}
        className="flex min-w-0 flex-1 items-center overflow-x-auto pl-2"
      >
        {parts.map((part, i) => {
          const last = i === parts.length - 1;
          const parent = parts.slice(0, i).join("/");
          return (
            <span key={`${i}/${part}`} className="flex shrink-0 items-center">
              {i > 0 && (
                <ChevronRight aria-hidden className="size-3 shrink-0 text-faint-foreground" />
              )}
              <button
                type="button"
                onClick={(e) => {
                  show(parent);
                  menu.current?.showPopover({ source: e.currentTarget });
                }}
                className={`${segment} ${last ? "text-foreground" : ""}`}
              >
                {last && <FileIcon path={path} />}
                {part}
              </button>
            </span>
          );
        })}
      </nav>
      <Menu
        ref={menu}
        label={folder ? `Files in ${folder}` : "Files"}
        align="start"
        className="max-h-80 min-w-56 overflow-y-auto p-1"
      >
        {folder && (
          <>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => show(parentOf(folder))}
            >
              <ArrowLeft aria-hidden />
              <span className="truncate">{nameOf(parentOf(folder)) || "Top folder"}</span>
            </button>
            <div className="my-1 h-px bg-border" />
          </>
        )}
        {listed && "error" in listed && (
          <p role="alert" className="px-2 py-1 text-meta text-danger">
            {listed.error}
          </p>
        )}
        {entries.map((entry) => {
          const at = folder ? `${folder}/${entry.name}` : entry.name;
          const dir = entry.kind === "dir";
          return (
            <button
              key={entry.name}
              type="button"
              role="menuitem"
              aria-current={at === path ? "true" : undefined}
              className={`${menuItem} aria-[current]:bg-selected`}
              onClick={() => {
                if (dir) return show(at);
                menu.current?.hidePopover();
                onOpen(at, entry.kind === "symlink");
              }}
            >
              {dir ? (
                <Folder aria-hidden className="text-muted-foreground" />
              ) : (
                <FileIcon path={at} />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
              {dir && <ChevronRight aria-hidden className="text-faint-foreground" />}
            </button>
          );
        })}
      </Menu>
    </>
  );
}

/** The file's less common actions, out of the way. */
function FileMenu({
  file,
  hasText,
  wordWrap,
  onReveal,
  onClose,
  onFind,
  onGoToLine,
}: {
  file: OpenFile;
  hasText: boolean;
  wordWrap: boolean;
  onReveal: (path: string) => void;
  onClose: (tab: OpenFile) => void;
  onFind: () => void;
  onGoToLine: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover();
    action();
  };
  return (
    <>
      <IconButton
        size="sm"
        label="File actions"
        aria-haspopup="menu"
        onClick={(e) => menu.current?.togglePopover({ source: e.currentTarget })}
      >
        <Ellipsis aria-hidden />
      </IconButton>
      <Menu ref={menu} label="File actions" align="end" className="min-w-52 p-1">
        {hasText && (
          <>
            <button type="button" role="menuitem" className={menuItem} onClick={choose(onFind)}>
              Find in file
            </button>
            <button type="button" role="menuitem" className={menuItem} onClick={choose(onGoToLine)}>
              Go to line
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={wordWrap}
              className={menuItem}
              onClick={choose(() => setAppearance({ wordWrap: !wordWrap }))}
            >
              <WrapText aria-hidden />
              <span className="flex-1 text-left">Word wrap</span>
              {wordWrap && <Check aria-hidden />}
            </button>
            <div className="my-1 h-px bg-border" />
          </>
        )}
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose(() => void navigator.clipboard.writeText(file.path))}
        >
          <Copy aria-hidden />
          Copy path
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose(() => onReveal(file.path))}
        >
          <FolderTree aria-hidden />
          Show in files
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose(() => onClose(file))}
        >
          <X aria-hidden />
          Close
        </button>
      </Menu>
    </>
  );
}

/**
 * What needs a decision on this file, as a card over the corner of the editor, as VS Code's save
 * conflict is: the text stays put and readable under it. Compare shows your edits against what's on
 * disk before you choose.
 */
function FileNotice({
  store,
  file,
  onClose,
}: {
  store: OpenFiles;
  file: OpenFile;
  onClose: (tab: OpenFile) => void;
}) {
  if (file.body.kind !== "text") return null;
  const card = (title: string, detail: ReactNode, actions: ReactNode) => (
    <div
      role="alert"
      className="absolute right-3 bottom-3 z-20 w-[min(24rem,calc(100%-1.5rem))] rounded-xl border border-border bg-surface p-3 font-sans shadow-lg"
    >
      <div className="flex gap-2.5">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-meta text-muted-foreground">{detail}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">{actions}</div>
    </div>
  );
  if (file.conflict) {
    const onDisk = !!file.conflict.sha256;
    const comparing = file.compare !== undefined;
    return card(
      onDisk ? "This file changed on disk" : "This file was deleted from disk",
      comparing
        ? "Showing your edits against what's on disk. Nothing is saved until you choose."
        : onDisk
          ? "Something else wrote to it while you were editing, such as the agent. Your edits aren't saved yet."
          : "Something else deleted it while you were editing. Your edits aren't saved yet.",
      <>
        {onDisk && (
          <Button size="sm" onClick={() => void store.toggleCompare(file.id)}>
            {comparing ? "Stop comparing" : "Compare"}
          </Button>
        )}
        {onDisk ? (
          <Button size="sm" onClick={() => void store.reload(file.id)}>
            Use disk version
          </Button>
        ) : (
          <Button size="sm" onClick={() => onClose(file)}>
            Close
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void store.overwrite(file.id)}>
          {onDisk ? "Keep my edits" : "Save again"}
        </Button>
      </>,
    );
  }
  if (file.save === "failed")
    return card(
      "Couldn't save this file",
      `${file.saveError ?? "plxd didn't answer."} Your edits are kept, and saving tries again on its own.`,
      <Button size="sm" variant="primary" onClick={() => void store.save(file.id)}>
        Try again
      </Button>,
    );
  return null;
}

/** The line under the editor: where its edits are on the left, and about the text on the right. */
function StatusBar({
  file,
  cursor,
  wide,
  onGoToLine,
}: {
  file: OpenFile;
  cursor?: Cursor;
  wide: boolean;
  onGoToLine: () => void;
}) {
  if (file.body.kind !== "text") return null;
  const { readOnly, eol } = file.body;
  const icon = "size-3 shrink-0";
  const state = readOnly ? (
    <>
      <Lock aria-hidden className={icon} />
      <span className="truncate">{readOnly}</span>
    </>
  ) : file.conflict || file.save === "failed" ? (
    <>
      <TriangleAlert aria-hidden className={`${icon} text-warning`} />
      Not saved
    </>
  ) : file.save === "saved" ? (
    <>
      <Check aria-hidden className={icon} />
      Saved
    </>
  ) : (
    <>
      <LoaderCircle aria-hidden className={`${icon} animate-spin`} />
      Saving…
    </>
  );
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border/60 files-chrome pr-1.5 pl-3 text-meta text-faint-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5" title={readOnly}>
        {state}
      </span>
      {cursor && (
        <button
          type="button"
          title="Go to line"
          onClick={onGoToLine}
          className="shrink-0 rounded-sm px-1.5 tabular-nums hover:bg-hover hover:text-foreground"
        >
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selected > 0 && ` (${cursor.selected} selected)`}
        </button>
      )}
      {wide && cursor?.indent && <span className="shrink-0">{cursor.indent}</span>}
      {wide && <span className="shrink-0">UTF-8</span>}
      {(wide || eol === "\r\n") && (
        <span className="shrink-0">{eol === "\r\n" ? "CRLF" : "LF"}</span>
      )}
      {cursor?.language && <span className="shrink-0 pr-1.5">{cursor.language}</span>}
    </div>
  );
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
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-16 text-center">
      <File aria-hidden className="size-5 text-faint-foreground" />
      <p
        role={body.kind === "error" ? "alert" : undefined}
        className={`text-body ${body.kind === "error" ? "text-danger" : "text-muted-foreground"}`}
      >
        {body.kind === "error" ? body.error : body.note}
      </p>
      {save && (
        <div className="flex items-center gap-2">
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
