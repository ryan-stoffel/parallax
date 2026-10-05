import { ChevronLeft, Circle, CircleCheck, GitMerge } from "lucide-react";
import { useEffect, useState, type SVGProps } from "react";
import type { Components } from "react-markdown";

import type { ContextFile, ParallaxEvent } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { describeError } from "./errors";
import { GitHubLogo } from "./logos";

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
      // `shell` leaves out the runs' output, which only the transcript reads (PLX-453).
      const since = { after: position.result.seq, project, shell: true, logId: position.logId };
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

/** The Markdown mark (dcurtis/markdown-mark, CC0), sized like a lucide icon. */
function MarkdownMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 208 128" fill="currentColor" aria-hidden {...props}>
      <path d="M15 10h178a5 5 0 0 1 5 5v98a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V15a5 5 0 0 1 5-5zm0-10A15 15 0 0 0 0 15v98a15 15 0 0 0 15 15h178a15 15 0 0 0 15-15V15A15 15 0 0 0 193 0z" />
      <path d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z" />
    </svg>
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
