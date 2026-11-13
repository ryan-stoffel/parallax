import { t } from "i18next";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  File,
  Folder,
  PanelLeft,
  LoaderCircle,
  Lock,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { AgentEntry } from "../protocol/generated/protocol";
import { setAppearance, useAppearance } from "./appearance";
import type { Cursor, EditorHandle } from "./CodeEditor";
import { readWorking } from "./documents";
import { describeError } from "./errors";
import { DownloadButton } from "./FileCards";
import type { MarkdownView, OpenFile, OpenFiles } from "./openFiles";
import { GithubMarkdown } from "./pr/GithubMarkdown";
import type { OpenApp, OpenTarget } from "../preload/bridge";
import { appIcon, OPEN_TARGET_KEY } from "./OpenMenu";
import { type FilesTabs, PanelTabIcon, panelTab, panelTabButton } from "./SidePanel";
import { FileIcon } from "./TurnChanges";
import { Button, IconButton, Menu, menuItem } from "./ui";

// The editor and its languages load when a file first opens.
const CodeEditor = lazy(() => import("./CodeEditor"));

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);

/** How long a split's preview waits after typing before it draws again. */
const PREVIEW_AFTER_MS = 150;

/**
 * The open file and everything around it: its path from `folder`, the run's folder, as a
 * breadcrumb with its actions, the text, and a status line. Its tab is in the side panel's row
 * (FileTabs). `wide` has room for the tree beside it, which `onToggleTree` shows or hides, a split
 * Markdown view, and the status line's details.
 */
export function FileEditor({
  store,
  file,
  folder,
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
  folder?: string;
  wide: boolean;
  treeOpen: boolean;
  onToggleTree: () => void;
  /** Shows `path`, a file or folder, in the tree. */
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
      {/* T3 Code's file header: the path from the project's folder, then quiet icon toggles. The
          files toggle leads, on the side the tree opens on. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border/60 pr-2 pl-1.5">
        <IconButton
          size="sm"
          label={treeOpen ? t("Hide files") : t("Show files")}
          aria-pressed={treeOpen}
          onClick={wide ? onToggleTree : () => store.showHome(true)}
        >
          <PanelLeft aria-hidden />
        </IconButton>
        <Breadcrumb
          root={folder ? nameOf(folder.replace(/[\\/]+$/, "").replaceAll("\\", "/")) : undefined}
          path={file.path}
          hostId={hostId}
          runId={runId}
          onOpen={(path, link) => store.open(path, { link, transient: true })}
          onFolder={onReveal}
        />
        {folder && <OpenFileIn hostId={hostId} folder={folder} path={file.path} />}
        {markdown && wide && (
          <IconButton
            size="sm"
            label={t("Split preview")}
            aria-pressed={view === "split"}
            onClick={() => store.setView(file.id, view === "split" ? "code" : "split")}
          >
            <Columns2 aria-hidden />
          </IconButton>
        )}
        {markdown && (
          <IconButton
            size="sm"
            label={t("Preview")}
            aria-pressed={view === "preview"}
            onClick={() => store.setView(file.id, view === "preview" ? "code" : "preview")}
          >
            {view === "preview" ? <Code2 aria-hidden /> : <Eye aria-hidden />}
          </IconButton>
        )}
        {text && view !== "preview" && (
          <IconButton
            size="sm"
            label={t("Word wrap")}
            aria-pressed={wordWrap}
            onClick={() => setAppearance({ wordWrap: !wordWrap })}
          >
            <WrapText aria-hidden />
          </IconButton>
        )}
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

/**
 * The mark on a tab's icon, as T3 Code's: a dot for edits on their way, a warning-colored one for
 * edits that are stuck.
 */
function TabMark({ tab }: { tab: OpenFile }) {
  const stuck = !!tab.conflict || tab.save === "failed";
  if (!stuck && tab.save === "saved") return null;
  return (
    <span
      aria-label={stuck ? t("Not saved") : t("Saving")}
      className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-pane ${stuck ? "bg-warning" : "bg-foreground"}`}
    />
  );
}

/**
 * The Files view's tab and its open files, drawn in the side panel's own row as T3 Code's panel
 * does, so the view has one row of tabs. The Files tab shows the tree, and a file's tab shows the
 * file. A file opened with one click is in italics until it's kept, by a double-click or an edit.
 */
export function FileTabs({
  store,
  id,
  current,
  show,
  close,
  icon: Icon,
}: {
  store: OpenFiles;
} & Parameters<FilesTabs>[0]) {
  const { tabs, active, home, closing } = useSyncExternalStore(store.subscribe, store.get);
  const fileShown = current && active !== undefined && !home;
  // A close that asks first asks in the Files view, so it comes to the front.
  useEffect(() => {
    if (closing !== undefined && !current) show();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on a new question only
  }, [closing]);
  const menu = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<OpenFile>();
  const choose = (action: (tab: OpenFile) => void) => () => {
    menu.current?.hidePopover();
    if (target) action(target);
  };
  // The tab in front stays in view, however many are open.
  const shownTab = useRef<HTMLLIElement>(null);
  useEffect(() => {
    shownTab.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, fileShown]);
  return (
    <>
      <li className={panelTab(current && !fileShown)}>
        <PanelTabIcon label={t("Files")} onClose={close}>
          <Icon aria-hidden />
        </PanelTabIcon>
        <button
          type="button"
          id={id}
          aria-current={current && !fileShown ? "true" : undefined}
          onClick={() => {
            show();
            store.showHome(true);
          }}
          className={panelTabButton}
        >
          <span className="truncate">{t("Files")}</span>
        </button>
      </li>
      {tabs.map((tab) => {
        const shown = fileShown && tab.id === active;
        return (
          <li
            key={tab.id}
            ref={shown ? shownTab : undefined}
            onAuxClick={(e) => {
              if (e.button === 1) void store.askClose(tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setTarget(tab);
              menu.current?.showPopover({ source: e.currentTarget });
            }}
            className={panelTab(shown)}
          >
            <PanelTabIcon label={nameOf(tab.path)} onClose={() => void store.askClose(tab.id)}>
              <FileIcon path={tab.path} />
              <TabMark tab={tab} />
            </PanelTabIcon>
            <button
              type="button"
              aria-current={shown ? "true" : undefined}
              title={tab.path}
              onClick={() => {
                show();
                store.activate(tab.id);
              }}
              onDoubleClick={() => store.pin(tab.id)}
              className={panelTabButton}
            >
              <span className={`truncate ${tab.transient ? "italic" : ""}`}>
                {nameOf(tab.path)}
              </span>
            </button>
          </li>
        );
      })}
      <Menu
        ref={menu}
        label={target ? t("Actions for {{name}}", { name: nameOf(target.path) }) : t("Tab actions")}
        align="start"
        className="min-w-44 p-1"
      >
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => void store.askClose(tab.id))}
        >
          {t("Close")}
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => void store.closeAll(tab.id))}
        >
          {t("Close others")}
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose(() => void store.closeAll())}
        >
          {t("Close all")}
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={choose((tab) => void navigator.clipboard.writeText(tab.path))}
        >
          {t("Copy path")}
        </button>
      </Menu>
    </>
  );
}

/**
 * The file's path as a breadcrumb from the run's folder, `root`, as T3 Code draws it: a folder's
 * name shows it in the tree (`onFolder`), and the chevron after it lists what's in it, to open a
 * sibling without the tree. A long path scrolls, with its end in view.
 */
function Breadcrumb({
  root,
  path,
  hostId,
  runId,
  onOpen,
  onFolder,
}: {
  root?: string;
  path: string;
  hostId: string;
  runId: string;
  onOpen: (path: string, link: boolean) => void;
  onFolder: (path: string) => void;
}) {
  const row = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState<string>();
  const [listed, setListed] = useState<{ entries: AgentEntry[] } | { error: string }>();
  useEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth;
  }, [path]);
  const list = (next: string) => {
    setFolder(next);
    setListed(undefined);
    void window.parallax
      .request(hostId, "agent/files", { runId, ...(next && { path: next }) })
      .then((answer) =>
        setListed("error" in answer ? { error: describeError(answer.error) } : answer.result),
      );
  };
  // Each folder by its path, the run's folder as "", then the file.
  const parts = path.split("/");
  const crumbs = [
    ...(root === undefined ? [] : [{ at: "", name: root }]),
    ...parts.map((name, i) => ({ at: parts.slice(0, i + 1).join("/"), name })),
  ];
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
        aria-label={t("File path")}
        title={path}
        className="flex h-full min-w-0 flex-1 items-center overflow-x-auto text-meta [scrollbar-width:none]"
      >
        {crumbs.map(({ at, name }) => {
          if (at === path)
            return (
              <span
                key={at}
                aria-current="page"
                className="shrink-0 truncate px-0.5 font-medium text-foreground"
              >
                {name}
              </span>
            );
          return (
            <span key={at || "/"} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => onFolder(at)}
                className="max-w-40 truncate rounded-sm px-0.5 text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {name}
              </button>
              <button
                type="button"
                aria-label={t("Browse {{name}}", { name })}
                aria-haspopup="menu"
                onClick={(e) => {
                  list(at);
                  menu.current?.showPopover({ source: e.currentTarget });
                }}
                className={`mx-0.5 grid h-5 w-4 shrink-0 place-items-center rounded-sm text-faint-foreground hover:bg-hover hover:text-foreground`}
              >
                <ChevronRight aria-hidden className="size-3.5" />
              </button>
            </span>
          );
        })}
      </nav>
      <Menu
        ref={menu}
        label={folder ? t("Files in {{folder}}", { folder }) : t("Files")}
        align="start"
        className="max-h-80 min-w-56 overflow-y-auto p-1"
      >
        {folder && (
          <>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => list(parentOf(folder))}
            >
              <ArrowLeft aria-hidden />
              <span className="truncate">
                {nameOf(parentOf(folder)) || root
                  ? t("Back to {{folder}}", { folder: nameOf(parentOf(folder)) || root })
                  : t("Back to top folder")}
              </span>
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
                if (dir) return list(at);
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

/**
 * Opens the file in the editor last chosen, as T3 Code's file header does, with a chevron listing
 * the others; choosing one keeps it, as Thread details' Open in does (OpenMenu). On another
 * computer, it's there once Open in knows where to reach that computer.
 */
function OpenFileIn({ hostId, folder, path }: { hostId: string; folder: string; path: string }) {
  const menu = useRef<HTMLDivElement>(null);
  const [editors, setEditors] = useState<OpenApp[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.parallax.openTargets(hostId),
      hostId === "local" || window.parallax.sshDestination(hostId, folder),
    ]).then(([apps, reached]) => {
      if (live && reached)
        setEditors(apps.filter((app) => app.target !== "files" && app.target !== "terminal"));
    });
    return () => {
      live = false;
    };
  }, [hostId, folder]);
  const current = editors.find((app) => app.target === chosen) ?? editors[0];
  if (!current) return null;
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const file = `${folder.replace(/[\\/]+$/, "")}${sep}${path.replaceAll("/", sep)}`;
  const open = (target: OpenTarget) => void window.parallax.openFolder(hostId, target, file);
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border/60">
      <button
        type="button"
        aria-label={t("Open in {{app}}", { app: current.name })}
        title={t("Open in {{app}}", { app: current.name })}
        onClick={() => open(current.target)}
        className="grid h-6 w-7 place-items-center rounded-l-md hover:bg-hover [&_img]:size-3.5 [&_svg]:size-3.5"
      >
        {appIcon(current)}
      </button>
      <button
        type="button"
        aria-label={t("Choose editor")}
        aria-haspopup="menu"
        onClick={(e) => menu.current?.togglePopover({ source: e.currentTarget })}
        className="grid h-6 w-5 place-items-center rounded-r-md border-l border-border/60 text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ChevronDown aria-hidden className="size-3" />
      </button>
      <Menu ref={menu} label={t("Open in")} align="end" className="min-w-48 p-1">
        {editors.map((app) => (
          <button
            key={app.target}
            type="button"
            role="menuitem"
            className={`${menuItem} [&_img]:size-4 [&_svg]:size-4`}
            onClick={() => {
              menu.current?.hidePopover();
              localStorage.setItem(OPEN_TARGET_KEY, app.target);
              setChosen(app.target);
              open(app.target);
            }}
          >
            {appIcon(app)}
            <span className="flex-1">{app.name}</span>
            {app === current && <Check aria-hidden className="text-muted-foreground" />}
          </button>
        ))}
      </Menu>
    </div>
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
      onDisk ? t("This file changed on disk") : t("This file was deleted from disk"),
      comparing
        ? t("Showing your edits against what's on disk. Nothing is saved until you choose.")
        : onDisk
          ? t(
              "Something else wrote to it while you were editing, such as the agent. Your edits aren't saved yet.",
            )
          : t("Something else deleted it while you were editing. Your edits aren't saved yet."),
      <>
        {onDisk && (
          <Button size="sm" onClick={() => void store.toggleCompare(file.id)}>
            {comparing ? t("Stop comparing") : t("Compare")}
          </Button>
        )}
        {onDisk ? (
          <Button size="sm" onClick={() => void store.reload(file.id)}>
            {t("Use disk version")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => onClose(file)}>
            {t("Close")}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void store.overwrite(file.id)}>
          {onDisk ? t("Keep my edits") : t("Save again")}
        </Button>
      </>,
    );
  }
  if (file.save === "failed")
    return card(
      t("Couldn't save this file"),
      t("{{error}} Your edits are kept, and saving tries again on its own.", {
        error: file.saveError ?? t("plxd didn't answer."),
      }),
      <Button size="sm" variant="primary" onClick={() => void store.save(file.id)}>
        {t("Try again")}
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
      {t("Not saved")}
    </>
  ) : file.save === "saved" ? (
    <>
      <Check aria-hidden className={icon} />
      {t("Saved")}
    </>
  ) : (
    <>
      <LoaderCircle aria-hidden className={`${icon} animate-spin`} />
      {t("Saving…")}
    </>
  );
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border/60 pr-1.5 pl-3 text-meta text-faint-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5" title={readOnly}>
        {state}
      </span>
      {cursor && (
        <button
          type="button"
          title={t("Go to line")}
          onClick={onGoToLine}
          className="shrink-0 rounded-sm px-1.5 tabular-nums hover:bg-hover hover:text-foreground"
        >
          {cursor.selected > 0
            ? t("Ln {{line}}, Col {{column}} ({{count}} selected)", {
                line: cursor.line,
                column: cursor.column,
                count: cursor.selected,
              })
            : t("Ln {{line}}, Col {{column}}", { line: cursor.line, column: cursor.column })}
        </button>
      )}
      {wide && cursor?.indent && <span className="shrink-0">{cursor.indent}</span>}
      {eol === "\r\n" && <span className="shrink-0">CRLF</span>}
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
