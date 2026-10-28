import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  MessageSquare,
  Monitor,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { flushSync } from "react-dom";

import type { ThemePreference } from "../preload/bridge";
import type { GrepMatch } from "../protocol/generated/protocol";
import { close, Footer, navigate } from "./AddDialog";
import { setAppearance, shownThemes, useAppearance } from "./appearance";
import { lastPrompt } from "./attention";
import { marks, queryWords, rank } from "./commandSearch";
import { useShortcutLabel, type Command } from "./keybindings";
import { age, ProjectIcon, RepoIcon, type HostThreads } from "./Sidebar";
import { FileIcon } from "./TurnChanges";
import { useAddedThemes, type Mode } from "./vscodeThemes";

/** A page of the menu: its root, or one an item opened. */
export type MenuPage = "root" | "repos" | "theme" | "appearance" | "files" | "contents";

/** One row the menu lists. Picking it opens `page` in the menu's place, or else closes the menu and runs `run`. */
export interface MenuItem {
  id: string;
  label: ReactNode;
  /** What search reads: the label as text. */
  text: string;
  /** What search also reads, weighed less, such as a repository's path. */
  keywords?: string;
  /** A line under the label. */
  hint?: ReactNode;
  icon: ReactNode;
  /** The command whose shortcut shows at its right. */
  command?: Command;
  checked?: boolean;
  page?: Exclude<MenuPage, "root">;
  run?: () => void;
}

/** Opens the menu, at its root or straight at one of its pages. */
export type CommandMenuHandle = { open: (page?: MenuPage) => void; toggle: () => void };

/** A row as the list draws it, under its group's heading. */
type Row = MenuItem & { group: string };

const pageTitles: Record<Exclude<MenuPage, "root">, string> = {
  repos: "New thread in",
  theme: "Change theme",
  appearance: "Change appearance",
  files: "Go to file",
  contents: "Search project contents",
};
const placeholders: Record<MenuPage, string> = {
  root: "Search commands, projects, and threads…",
  repos: "Search repositories…",
  theme: "Search themes…",
  appearance: "Search…",
  files: "Search files by name…",
  contents: "Search the thread's files for text…",
};
/** Parallax's own themes, which Settings > Appearance calls each just Parallax. */
const parallaxThemes: { id: string; name: string; mode: Mode }[] = [
  { id: "parallax-light", name: "Parallax", mode: "light" },
  { id: "parallax-dark", name: "Parallax", mode: "dark" },
];

/**
 * The command menu (PLX-993), on Mod+K: one search over the app's actions, every computer's
 * repositories, Projects, and threads, and the open thread's files. With no query it lists the
 * actions, then the most recent threads. Typing ranks each group fuzzily (commandSearch.ts) and
 * orders the groups by their best match; plxd's index of messages (`thread/search`) adds threads
 * that match only there, with the line that matched. Some actions open a page in its place: a
 * repository to start a thread in, a theme, Light, Dark, or System, a file by name (`repo/files`),
 * or a line of the thread's files (`repo/grep`). Up and Down move, Enter or a click picks,
 * Backspace in an empty search goes back from a page, and Escape closes.
 */
export function CommandMenu({
  ref,
  hosts,
  actions,
  repos,
  files,
  grep,
  theme,
  onThemeChange,
  onOpenThread,
  onOpenProject,
  onOpenFile,
}: {
  ref: Ref<CommandMenuHandle>;
  /** Every host's threads and Projects. */
  hosts: HostThreads[];
  /** The root's actions, in order. */
  actions: MenuItem[];
  /** The repositories a new thread can go in, for search and New thread in…. */
  repos: MenuItem[];
  /** The open thread whose files Go to file lists, if any. */
  files?: { hostId: string; runId: string };
  /** Whether that thread's plxd searches its files' contents (`repoGrep`). */
  grep: boolean;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenThread: (hostId: string, threadId: string) => void;
  onOpenProject: (hostId: string, projectId: string) => void;
  onOpenFile: (runId: string, path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<MenuPage>("root");
  // Closed, it lists nothing: no rows in the page, and nothing ranked on every render.
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const words = queryWords(query);
  const wordsKey = words.join(" ");

  const show = (next: MenuPage) => {
    setShown(true);
    setPage(next);
    setQuery("");
    setActive(0);
    input.current?.focus();
  };
  useImperativeHandle(ref, () => ({
    open: (start = "root") => {
      flushSync(() => show(start));
      if (!dialog.current?.open) dialog.current?.showModal();
    },
    toggle: () => {
      if (dialog.current?.open) return dialog.current.close();
      flushSync(() => show("root"));
      dialog.current?.showModal();
    },
  }));

  // plxd's matches in messages, by host and thread, for the words they were for.
  const [found, setFound] = useState<{ words: string; hits: Map<string, string | undefined> }>();
  useEffect(() => {
    if (page !== "root" || !wordsKey) return;
    let live = true;
    const timer = setTimeout(async () => {
      const hits = new Map<string, string | undefined>();
      await Promise.all(
        hosts
          .filter(({ view }) => "threadContext" in view.capabilities)
          .map(async ({ host }) => {
            const answer = await window.parallax.request(host.id, "thread/search", {
              query: wordsKey,
              limit: 20,
            });
            if (!("result" in answer)) return;
            const { threads, snippets } = answer.result;
            for (const t of threads) hits.set(`${host.id}/${t.id}`, snippets?.[t.id]);
          }),
      );
      if (live) setFound({ words: wordsKey, hits });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Hosts change with every event; a new query is what asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, wordsKey]);
  const messageHits = found?.words === wordsKey ? found.hits : undefined;

  // The open thread's files, read once each time Go to file opens.
  const [fileList, setFileList] = useState<{ runId: string; files: string[] } | string>();
  useEffect(() => {
    if (page !== "files" || !files) return;
    let live = true;
    setFileList(undefined);
    void window.parallax.request(files.hostId, "repo/files", { runId: files.runId }).then((a) => {
      if (live)
        setFileList("error" in a ? a.error.message : { runId: files.runId, files: a.result.files });
    });
    return () => {
      live = false;
    };
  }, [page, files?.hostId, files?.runId]);

  // The lines `repo/grep` found, for the thread and query they were for.
  const [grepped, setGrepped] = useState<
    { runId: string; query: string; matches: GrepMatch[] } | string
  >();
  const trimmed = query.trim();
  useEffect(() => {
    if (page !== "contents" || !files || !grep || !trimmed) return;
    let live = true;
    const timer = setTimeout(async () => {
      const answer = await window.parallax.request(files.hostId, "repo/grep", {
        runId: files.runId,
        query: trimmed,
      });
      if (!live) return;
      setGrepped(
        "error" in answer
          ? answer.error.message
          : { runId: files.runId, query: trimmed, matches: answer.result.matches },
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [page, trimmed, grep, files?.hostId, files?.runId]);

  const appearance = useAppearance();
  const added = useAddedThemes();
  const threadRows = useMemo(
    () =>
      (shown ? hosts : []).flatMap(({ host, view }) =>
        view.state.threads.map((t) => {
          const repo = view.state.repos.find((r) => r.id === t.repo);
          const run = view.state.runs[t.id];
          return {
            key: `${host.id}/${t.id}`,
            hostId: host.id,
            thread: t,
            title: view.state.titles[t.id] ?? "Thread",
            repo,
            place: [
              repo && !repo.scratch ? repo.name : host.name,
              run?.branch,
              ...(run?.pullRequests ?? []).map((url) => `#${url.split("/").pop()}`),
              hosts.length > 1 ? host.name : undefined,
            ]
              .filter(Boolean)
              .join(" "),
          };
        }),
      ),
    [hosts, shown],
  );

  const listed = shown ? page : undefined;
  const rows: Row[] = [];
  const add = (group: string, items: MenuItem[]) =>
    rows.push(...items.map((i) => ({ ...i, group })));
  const ranked = (items: MenuItem[]) =>
    rank(items, words, (i) => [
      [i.text, 1],
      [i.keywords ?? "", 0.6],
    ]);

  if (listed === "root") {
    const threadItem = (r: (typeof threadRows)[number], snippet?: string): MenuItem => ({
      id: `thread:${r.key}`,
      label: r.title,
      text: r.title,
      keywords: r.place,
      hint: snippet ? (
        <Marked text={snippet} words={words} />
      ) : (
        `${r.place} · ${age(lastPrompt(r.thread))}`
      ),
      icon: r.thread.archived ? (
        <Archive aria-hidden className="size-4 text-faint-foreground" />
      ) : r.repo && !r.repo.scratch ? (
        <RepoIcon repo={r.repo} />
      ) : (
        <MessageSquare aria-hidden className="size-4 text-faint-foreground" />
      ),
      run: () => onOpenThread(r.hostId, r.thread.id),
    });
    if (!words.length) {
      add("Actions", actions);
      const recent = threadRows
        .filter((r) => !r.thread.archived && !r.thread.parent)
        .sort((a, b) => Date.parse(lastPrompt(b.thread)) - Date.parse(lastPrompt(a.thread)))
        .slice(0, 8);
      add(
        "Recent threads",
        recent.map((r) => threadItem(r)),
      );
    } else {
      const projects: MenuItem[] = hosts.flatMap(({ host, view }) =>
        view.state.projects.map((p) => ({
          id: `project:${host.id}/${p.id}`,
          label: p.name,
          text: p.name,
          keywords: hosts.length > 1 ? host.name : undefined,
          hint: hosts.length > 1 ? host.name : undefined,
          icon: <ProjectIcon icon={p.icon} />,
          run: () => onOpenProject(host.id, p.id),
        })),
      );
      // Archived threads rank under open ones that match as well.
      const threads = rank(threadRows, words, (r) => [
        [r.title, r.thread.archived ? 0.9 : 1],
        [r.place, 0.6],
      ]);
      const titled = new Set(threads.map((t) => t.item.key));
      const inMessages = threadRows.filter((r) => !titled.has(r.key) && messageHits?.has(r.key));
      const groups = [
        { name: "Actions", found: ranked(actions) },
        { name: "Repositories", found: ranked(repos).slice(0, 6) },
        { name: "Projects", found: ranked(projects).slice(0, 6) },
        {
          name: "Threads",
          found: [
            ...threads.slice(0, 20).map((t) => ({
              item: threadItem(t.item),
              score: t.score,
            })),
            ...inMessages.slice(0, 20).map((r) => ({
              item: threadItem(r, messageHits?.get(r.key)),
              score: 0,
            })),
          ],
        },
      ];
      // The group with the best match first; ties keep this order.
      for (const g of groups
        .filter((g) => g.found.length)
        .sort((a, b) => (b.found[0]?.score ?? 0) - (a.found[0]?.score ?? 0)))
        add(
          g.name,
          g.found.map((f) => f.item),
        );
    }
  } else if (listed === "repos") {
    add(
      "Repositories",
      ranked(repos).map((r) => r.item),
    );
  } else if (listed === "theme") {
    const shown = shownThemes(appearance, added);
    const themes = [
      ...parallaxThemes,
      ...added.flatMap((e) => e.themes.map((t) => ({ id: t.id, name: t.name, mode: t.mode }))),
    ];
    const items = themes.map((t): MenuItem => ({
      id: `theme:${t.id}`,
      label: t.name,
      text: t.name,
      keywords: t.mode,
      hint: t.mode === "light" ? "Light" : "Dark",
      icon: (
        <span
          aria-hidden
          className={`scheme-${t.mode} theme-${t.id} theme-orb block size-4 rounded-full border border-border`}
        />
      ),
      checked: shown[t.mode] === t.id,
      run: () => {
        setAppearance(t.mode === "light" ? { lightTheme: t.id } : { darkTheme: t.id });
        // A theme for the mode that isn't showing switches to it, so the pick shows.
        const dark = document.documentElement.classList.contains("dark");
        if (dark !== (t.mode === "dark")) onThemeChange(t.mode);
      },
    }));
    add(
      "Themes",
      ranked(items).map((r) => r.item),
    );
  } else if (listed === "appearance") {
    const modes: [ThemePreference, string, ReactNode][] = [
      ["light", "Light", <Sun aria-hidden className="size-4" />],
      ["dark", "Dark", <Moon aria-hidden className="size-4" />],
      ["system", "System", <Monitor aria-hidden className="size-4" />],
    ];
    const items = modes.map(([value, name, icon]): MenuItem => ({
      id: `appearance:${value}`,
      label: name,
      text: name,
      icon,
      checked: theme === value,
      run: () => onThemeChange(value),
    }));
    add(
      "Appearance",
      ranked(items).map((r) => r.item),
    );
  } else if (listed === "files" && files && typeof fileList === "object") {
    const found = rank(fileList.files, words, (path) => [
      [path.slice(path.lastIndexOf("/") + 1), 1],
      [path, 0.7],
    ]).slice(0, 100);
    add(
      "Files",
      found.map(({ item: path }) => ({
        id: `file:${path}`,
        label: path.slice(path.lastIndexOf("/") + 1),
        text: path,
        hint: path,
        icon: <FileIcon path={path} />,
        run: () => onOpenFile(fileList.runId, path),
      })),
    );
  } else if (
    listed === "contents" &&
    files &&
    typeof grepped === "object" &&
    grepped.runId === files.runId &&
    trimmed
  ) {
    add(
      "Matches",
      grepped.matches.map((m) => ({
        id: `line:${m.path}:${m.line}`,
        label: <Marked text={m.text || " "} words={[grepped.query.toLowerCase()]} />,
        text: m.text,
        hint: `${m.path}:${m.line}`,
        icon: <FileIcon path={m.path} />,
        run: () => onOpenFile(files.runId, m.path),
      })),
    );
  }
  const current = rows[Math.min(active, rows.length - 1)];
  // The active row stays in view as Up and Down move it.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, page]);

  // A row runs once the menu has closed, so a dialog it opens can open.
  const pick = (row: Row) => {
    if (row.page) return show(row.page);
    dialog.current?.close();
    row.run?.();
  };

  // Why the page lists nothing, when it doesn't.
  let empty: string | undefined;
  if (shown && !rows.length) {
    if (page === "files")
      empty = !files
        ? "Open a thread to search its files"
        : fileList === undefined
          ? "Reading files…"
          : typeof fileList === "string"
            ? fileList
            : "No files match";
    else if (page === "contents")
      empty = !files
        ? "Open a thread to search its files"
        : !grep
          ? "Update Parallax on this computer to search file contents"
          : !trimmed
            ? "Type to search the thread's files"
            : typeof grepped === "string"
              ? grepped
              : grepped?.runId === files.runId && grepped.query === trimmed
                ? "Nothing found"
                : "Searching…";
    else if (page === "root" && words.length && !messageHits) empty = "Searching…";
    else empty = "No results";
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Command menu"
      onClose={() => {
        // What was found for one thread never shows for the next.
        setGrepped(undefined);
        setFileList(undefined);
        setShown(false);
        setPage("root");
        setQuery("");
        setActive(0);
      }}
      // A click on the backdrop, outside the panel, closes it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dialog.current?.close();
      }}
      className="mx-auto mt-[14vh] w-[40rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div
        onKeyDown={(e) => {
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          if (step && rows.length) {
            e.preventDefault();
            const i = current ? rows.indexOf(current) : 0;
            setActive((i + step + rows.length) % rows.length);
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (current) pick(current);
          } else if (e.key === "Backspace" && !query && page !== "root") {
            e.preventDefault();
            show("root");
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          {page === "root" ? (
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          ) : (
            <button
              type="button"
              aria-label="Back"
              onClick={() => show("root")}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
            >
              <ArrowLeft />
            </button>
          )}
          {page !== "root" && (
            <span className="shrink-0 rounded-md bg-selected px-1.5 py-0.5 text-meta text-foreground">
              {pageTitles[page]}
            </span>
          )}
          <input
            ref={(el) => {
              input.current = el;
              // The native attribute, so showModal focuses the search box.
              el?.setAttribute("autofocus", "");
            }}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current && `${listId}-${rows.indexOf(current)}`}
            aria-label={
              page === "root" ? "Search commands, projects, and threads" : pageTitles[page]
            }
            placeholder={placeholders[page]}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(60vh,28rem)] overflow-y-auto px-2 pb-2"
        >
          {rows.map((row, i) => (
            <div key={`${row.group}/${row.id}`}>
              {row.group !== rows[i - 1]?.group && (
                <p className="px-2.5 pt-2 pb-1.5 text-meta font-medium text-faint-foreground">
                  {row.group}
                </p>
              )}
              <MenuRow
                id={`${listId}-${i}`}
                row={row}
                words={words}
                active={row === current}
                onHover={() => setActive(i)}
                onPick={() => pick(row)}
              />
            </div>
          ))}
          {empty && <p className="px-2.5 py-3 text-body text-faint-foreground">{empty}</p>}
        </div>
        <Footer keys={[navigate, ["Enter", "Select"], close]} />
      </div>
    </dialog>
  );
}

/** One row: its icon, label and hint, then its shortcut, a check, or a chevron to its page. */
function MenuRow({
  id,
  row,
  words,
  active,
  onHover,
  onPick,
}: {
  id: string;
  row: Row;
  words: readonly string[];
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const shortcut = useShortcutLabel(row.command);
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      // Not focusable, so focus stays in the search box.
      tabIndex={-1}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left data-active:bg-hover"
    >
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
        {row.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">
          {typeof row.label === "string" ? <Marked text={row.label} words={words} /> : row.label}
        </span>
        {row.hint && (
          <span className="block truncate text-meta text-muted-foreground">{row.hint}</span>
        )}
      </span>
      {shortcut && (
        <kbd className="shrink-0 font-sans text-caption tracking-wider text-muted-foreground">
          {shortcut}
        </kbd>
      )}
      {row.checked && <Check aria-label="Current" className="size-4 shrink-0 text-accent" />}
      {row.page && <ChevronRight aria-hidden className="size-4 shrink-0 text-faint-foreground" />}
    </button>
  );
}

/** `text` with the query's words marked where they appear. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return marks(text, words).map((run, i) =>
    run.mark ? (
      <mark key={i} className="bg-transparent font-semibold text-foreground">
        {run.text}
      </mark>
    ) : (
      run.text
    ),
  );
}
