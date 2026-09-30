import { ChevronLeft, FileText, NotebookText } from "lucide-react";
import { useEffect, useState } from "react";

import type { ContextFile, WispEvent } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { describeError } from "./errors";
import { age } from "./Sidebar";

/** Applies one of a Project's events to its context files: a changed file joins or replaces its row, by path. */
export function applyContextEvent(files: ContextFile[], event: WispEvent): ContextFile[] {
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
      // ponytail: `context/list` has no `seq` of its own (RYA-187), so subscribe after
      // `agent/list`'s, taken first: a change that lands before the list replays, harmlessly.
      const position = await window.wisp.request(hostId, "agent/list", { project });
      if (stopped) return;
      if ("error" in position) return setError(position.error.message);
      const list = await window.wisp.request(hostId, "context/list", { project });
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      setFiles(list.result.files);
      setError(undefined);
      const since = { after: position.result.seq, project, logId: position.logId };
      unsubscribe = window.wisp.subscribe(hostId, since, (message) => {
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
 * The side panel's Context view for a Project: its shared context files, each opening its content
 * as Markdown. The list and an open file follow the agents' writes.
 */
export function ContextPanel({
  hostId,
  project,
  connected,
}: {
  hostId: string;
  project: string;
  connected: boolean;
}) {
  const { files, error } = useProjectContext(hostId, project, connected);
  const [openPath, setOpenPath] = useState<string>();
  const open = files.find((f) => f.path === openPath);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {open ? (
        <ContextFileView
          hostId={hostId}
          project={project}
          file={open}
          onBack={() => setOpenPath(undefined)}
        />
      ) : files.length > 0 ? (
        <ul aria-label="Context files" className="min-h-0 flex-1 overflow-y-auto px-2">
          {files.map((f) => (
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
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
          <NotebookText aria-hidden className="mb-1 size-5 text-faint-foreground" />
          <p className="text-[13px] font-medium text-foreground">No context yet</p>
          <p className="text-[12.5px] text-muted-foreground">
            Notes the coordinator and its subagents share show up here.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 pb-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** One context file's content, read again on every change to it, under a button back to the list. */
function ContextFileView({
  hostId,
  project,
  file,
  onBack,
}: {
  hostId: string;
  project: string;
  file: ContextFile;
  onBack: () => void;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();

  // `file` is a new object for each `context.changed` to it, so each one reads it again.
  useEffect(() => {
    let stopped = false;
    void window.wisp.request(hostId, "context/read", { project, path: file.path }).then((read) => {
      if (stopped) return;
      if ("error" in read) return setError(describeError(read.error));
      setContent(read.result.content);
      setError(undefined);
    });
    return () => {
      stopped = true;
    };
  }, [hostId, project, file]);

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{file.path}</span>
      </button>
      <article
        aria-label={file.path}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4 text-[13px] leading-relaxed"
      >
        {error ? (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        ) : (
          content !== undefined && <MarkdownText text={content} />
        )}
      </article>
    </>
  );
}
