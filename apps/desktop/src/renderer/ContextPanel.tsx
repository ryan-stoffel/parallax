import {
  BookOpen,
  ChevronLeft,
  Circle,
  CircleCheck,
  FileText,
  GitMerge,
  NotebookText,
  Search,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import type { Components } from "react-markdown";

import type { ContextFile, ParallaxEvent } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { describeError } from "./errors";
import { GitHubLogo } from "./logos";
import { age } from "./Sidebar";
import { IconButton } from "./ui";

/** The status board the coordinator keeps (coordinator.md), which the view opens on. */
export const board = "notes.md";

/** Applies one of a Project's events to its context files: a changed file joins or replaces its row, by path. */
function applyContextEvent(files: ContextFile[], event: ParallaxEvent): ContextFile[] {
  if (event.kind !== "context.changed") return files;
  const rest = files.filter((f) => f.path !== event.file.path);
  return [...rest, event.file].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * A Project's shared context files (0005), by path, kept live: `context/list`, then the Project's
 * `context.changed` events, starting over on `resync`. Loads only while `connected`.
 */
export function useProjectContext(hostId: string, project: string, connected: boolean) {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let unsubscribe = () => {};

    async function load() {
      // ponytail: `context/list` has no `seq` of its own (PLX-187), so subscribe after
      // `agent/list`'s, taken first: a change that lands before the list replays, harmlessly.
      const position = await window.parallax.request(hostId, "agent/list", { project });
      if (stopped) return;
      if ("error" in position) return setError(position.error.message);
      const list = await window.parallax.request(hostId, "context/list", { project });
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      setFiles(list.result.files);
      setError(undefined);
      const since = { after: position.result.seq, project, logId: position.logId };
      unsubscribe = window.parallax.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type === "error") return setError(message.error.message);
        setFiles((prev) => applyContextEvent(prev, message.event.event));
      });
    }

    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, project, connected]);

  return { files, error };
}

/**
 * The side panel's Context view for a Project. It opens on the coordinator's status board,
 * `notes.md`; the book button, or a board not written yet, shows All files and Recents instead,
 * and search filters the files by name. Any file opens in the view as Markdown, and everything
 * follows the agents' writes.
 */
export function ContextPanel({
  hostId,
  project,
  name,
  connected,
}: {
  hostId: string;
  project: string;
  /** The Project's name, for the header. */
  name: string;
  connected: boolean;
}) {
  const { files, error } = useProjectContext(hostId, project, connected);
  const [openPath, setOpenPath] = useState<string>();
  const [allFiles, setAllFiles] = useState(false);
  // What search filters the files by, or undefined while it's closed.
  const [query, setQuery] = useState<string>();
  const notes = files.find((f) => f.path === board);
  const open = files.find((f) => f.path === openPath);
  const showFiles = allFiles || !notes || query !== undefined;
  const components = contextComponents(files, setOpenPath);
  const doc = (file: ContextFile) => (
    <ContextDoc
      key={file.path}
      hostId={hostId}
      project={project}
      file={file}
      components={components}
    />
  );

  let body: ReactNode;
  if (open)
    body = (
      <>
        <button
          type="button"
          onClick={() => setOpenPath(undefined)}
          className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{open.path}</span>
        </button>
        {doc(open)}
      </>
    );
  else if (!showFiles) body = doc(notes);
  else if (files.length === 0)
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
        <NotebookText aria-hidden className="mb-1 size-5 text-faint-foreground" />
        <p className="text-[13px] font-medium text-foreground">No context yet</p>
        <p className="text-[12.5px] text-muted-foreground">{boardHint}</p>
      </div>
    );
  else {
    const q = query?.toLowerCase() ?? "";
    const shown = files.filter((f) => f.path.toLowerCase().includes(q));
    const recent = files
      .toSorted((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
      .slice(0, 3);
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!notes && query === undefined && (
          <p className="px-2.5 pb-2 text-[12.5px] text-muted-foreground">{boardHint}</p>
        )}
        <h3 className={sectionHeading}>All files</h3>
        {shown.length === 0 && (
          <p className="px-2.5 py-2 text-[13px] text-faint-foreground">No files match.</p>
        )}
        <ul aria-label="All files">
          {shown.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setOpenPath(f.path)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
              >
                <FileText aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{f.path}</span>
                <span className="shrink-0 text-[11.5px] text-faint-foreground">
                  {age(f.modifiedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {query === undefined && (
          <>
            <h3 className={`${sectionHeading} mt-3`}>Recents</h3>
            <ul aria-label="Recents" className="flex flex-col gap-2 px-1">
              {recent.map((f) => (
                <RecentCard
                  key={f.path}
                  hostId={hostId}
                  project={project}
                  file={f}
                  onOpen={() => setOpenPath(f.path)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 pr-2 pb-1 pl-4">
        {query === undefined ? (
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</h2>
        ) : (
          <input
            autoFocus
            aria-label="Search files"
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setQuery(undefined);
              document.getElementById("context-search")?.focus();
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        )}
        <IconButton
          id="context-search"
          label={query === undefined ? "Search files" : "Close search"}
          onClick={() => {
            setOpenPath(undefined);
            setQuery(query === undefined ? "" : undefined);
          }}
        >
          {query === undefined ? <Search /> : <X />}
        </IconButton>
        <IconButton
          label="All files"
          aria-pressed={showFiles}
          disabled={!notes}
          onClick={() => {
            setOpenPath(undefined);
            setQuery(undefined);
            setAllFiles(!showFiles);
          }}
        >
          <BookOpen />
        </IconButton>
      </div>
      {body}
      {error && (
        <p role="alert" className="px-4 pb-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const boardHint = "The coordinator writes a status board to notes.md as work starts.";
const sectionHeading = "px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-faint-foreground";

/**
 * A context file's content, read again whenever `file` changes: it's a new object for each
 * `context.changed` to it.
 */
export function useContent(hostId: string, project: string, file: ContextFile) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stopped = false;
    void window.parallax
      .request(hostId, "context/read", { project, path: file.path })
      .then((read) => {
        if (stopped) return;
        if ("error" in read) return setError(describeError(read.error));
        setContent(read.result.content);
        setError(undefined);
      });
    return () => {
      stopped = true;
    };
  }, [hostId, project, file]);
  return { content, error };
}

/** A context file, rendered as Markdown with `components`. */
function ContextDoc({
  hostId,
  project,
  file,
  components,
}: {
  hostId: string;
  project: string;
  file: ContextFile;
  components: Components;
}) {
  const { content, error } = useContent(hostId, project, file);
  return (
    <article
      aria-label={file.path}
      className="context-doc min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4"
    >
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : (
        content !== undefined && <MarkdownText text={content} components={components} />
      )}
    </article>
  );
}

/**
 * A recently changed file: its name and age, then the top of it rendered small, with nothing in it
 * to click. The name's button stretches over the whole card.
 */
function RecentCard({
  hostId,
  project,
  file,
  onOpen,
}: {
  hostId: string;
  project: string;
  file: ContextFile;
  onOpen: () => void;
}) {
  const { content } = useContent(hostId, project, file);
  return (
    <li className="relative rounded-lg border border-border hover:bg-hover">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 px-3 pt-2 text-left after:absolute after:inset-0"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{file.path}</span>
        <span className="shrink-0 text-[11.5px] text-faint-foreground">{age(file.modifiedAt)}</span>
      </button>
      <div
        aria-hidden
        className="context-preview max-h-24 overflow-hidden mask-b-from-60% px-3 pb-2"
      >
        {/* More than a card shows, without rendering all of a large file. */}
        {content !== undefined && (
          <MarkdownText text={content.slice(0, 2000)} components={previewComponents} />
        )}
      </div>
    </li>
  );
}

const pullRequest = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const issue = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/;
// Another file in the flat context folder, such as `archived.md` or `./archived.md`.
const contextLink = /^(?:\.\/)?([^/:?#]+)$/;

/**
 * How context files render beyond `MarkdownText`: tasks as an open or a check circle, GitHub pull
 * request and issue links with their icons, and a link to another context file as a button that
 * opens it here, off while that file doesn't exist.
 */
function contextComponents(files: ContextFile[], onOpen: (path: string) => void): Components {
  return {
    input: taskIcon,
    a: ({ href, children }) => {
      const path = href && contextLink.exec(href)?.[1];
      if (path)
        return (
          <button
            type="button"
            disabled={!files.some((f) => f.path === path)}
            onClick={() => onOpen(path)}
            className="text-accent underline-offset-2 hover:underline disabled:text-faint-foreground disabled:no-underline"
          >
            <MarkdownMark className={inlineIcon} />
            {children}
          </button>
        );
      const Icon =
        href && pullRequest.test(href) ? GitMerge : href && issue.test(href) ? GitHubLogo : null;
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {Icon && <Icon aria-hidden className={inlineIcon} />}
          {children}
        </a>
      );
    },
  };
}

const inlineIcon = "mr-1 inline size-3.5 align-[-0.15em]";

/** A task's checkbox as an open or a check circle. */
const taskIcon: Components["input"] = ({ type, checked }) =>
  type !== "checkbox" ? null : checked ? (
    <CircleCheck aria-label="Done" className={`${inlineIcon} text-faint-foreground`} />
  ) : (
    <Circle aria-label="Open" className={inlineIcon} />
  );

// A Recents card's preview has nothing to click: links and images are text, and code has no copy
// button.
const previewComponents: Components = {
  input: taskIcon,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt || "Image"}</span>,
  pre: ({ children }) => <pre>{children}</pre>,
};

/** The Markdown mark (dcurtis/markdown-mark, CC0), sized like a lucide icon. */
function MarkdownMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 208 128" fill="currentColor" aria-hidden {...props}>
      <path d="M15 10h178a5 5 0 0 1 5 5v98a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V15a5 5 0 0 1 5-5zm0-10A15 15 0 0 0 0 15v98a15 15 0 0 0 15 15h178a15 15 0 0 0 15-15V15A15 15 0 0 0 193 0z" />
      <path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z" />
    </svg>
  );
}

/** The Knowledge view's status board: the coordinator's `notes.md` as a card, or how it starts. */
export function StatusBoard({
  hostId,
  project,
  files,
  error,
  onOpen,
}: {
  hostId: string;
  project: string;
  files: ContextFile[];
  error?: string;
  onOpen: (path: string) => void;
}) {
  const notes = files.find((f) => f.path === board);
  return (
    <section aria-label="Status board">
      <h3 className={`${sectionHeading} mt-1`}>Status board</h3>
      {notes ? (
        <ul className="px-1">
          <RecentCard
            hostId={hostId}
            project={project}
            file={notes}
            onOpen={() => onOpen(notes.path)}
          />
        </ul>
      ) : (
        <p className="px-2.5 py-1 text-[12.5px] text-muted-foreground">{boardHint}</p>
      )}
      {error && (
        <p role="alert" className="px-2.5 py-1 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** The Knowledge view's shared notes: a Project's context files besides the board, by name. */
export function SharedNotes({
  files,
  onOpen,
}: {
  files: ContextFile[];
  onOpen: (path: string) => void;
}) {
  const rest = files.filter((f) => f.path !== board);
  if (rest.length === 0) return null;
  return (
    <section aria-label="Shared notes">
      <h3 className={`${sectionHeading} mt-2`}>Shared notes</h3>
      <ul>
        {rest.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onOpen(f.path)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <FileText aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{f.path}</span>
              <span className="shrink-0 text-[11.5px] text-faint-foreground">
                {age(f.modifiedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A context file opened from the Knowledge view, with a way back and its links to other files. */
export function ContextReader({
  hostId,
  project,
  files,
  file,
  onOpen,
  onBack,
}: {
  hostId: string;
  project: string;
  files: ContextFile[];
  file: ContextFile;
  onOpen: (path: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{file.path}</span>
      </button>
      <ContextDoc
        key={file.path}
        hostId={hostId}
        project={project}
        file={file}
        components={contextComponents(files, onOpen)}
      />
    </div>
  );
}
