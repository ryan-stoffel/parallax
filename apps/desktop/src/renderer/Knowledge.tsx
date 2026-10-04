import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useState } from "react";

import type { AgentRun, ContextFile } from "../protocol/generated/protocol";
import { ContextReader, SharedNotes, StatusBoard, useProjectContext } from "./ContextPanel";
import type { InboxView } from "./Inbox";
import { Loader } from "./Loader";
import { MemoryPanel, sectionsOf, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import { PixelField, type Pixel } from "./Pixels";
import { age } from "./Sidebar";
import { IconButton } from "./ui";

// What counts as new: learned in the last day.
const freshMs = 24 * 60 * 60 * 1000;

/**
 * The side panel's Knowledge view: what a Project's agents know, in one list. A Project's opens on
 * how much it knows, a square a fact as a field that fills as agents learn, and what it learned
 * last; then Memory's brief, the coordinator's status board, memory's entries, knowledge, and
 * proposals, then the Project's other shared notes. A note opens in place, with memory kept
 * behind it. At its foot a mini prompt changes it in plain words; `expanded`, it centers in the
 * window with a larger one. Off a Project it's the repository's memory alone. `memory` is whether
 * the host's plxd has `memory`; without it a Project shows only its context. Key it by host and
 * folder.
 */
export function KnowledgePanel({
  hostId,
  project,
  repo,
  coordinator,
  connected,
  memory,
  inbox,
  working,
  expanded,
  onExpand,
}: {
  hostId: string;
  project?: string;
  repo?: string;
  coordinator?: AgentRun;
  connected: boolean;
  memory: boolean;
  /** The Project's inbox, whose Learned items show as they arrive. */
  inbox?: InboxView;
  /** Whether any of its agents is working, so the field is live. */
  working?: boolean;
  expanded?: boolean;
  /** Fills the window with it, or puts it back. */
  onExpand?: (expanded: boolean) => void;
}) {
  const { files, error } = useProjectContext(hostId, project ?? "", connected && !!project);
  const [memories, setMemories] = useState<readonly Memory[]>([]);
  const onFiles = useCallback((f: readonly Memory[]) => setMemories(f), []);
  const [openPath, setOpenPath] = useState<string>();
  const open = files.find((f) => f.path === openPath);
  const board = project && (
    <StatusBoard
      hostId={hostId}
      project={project}
      files={files}
      error={error}
      onOpen={setOpenPath}
    />
  );
  const notes = project && <SharedNotes files={files} onOpen={setOpenPath} />;
  const head = project && (
    <Growth
      memories={memories}
      files={files}
      inbox={inbox}
      working={working}
      expanded={expanded}
      onExpand={onExpand}
    />
  );
  const prompt = project && memory && (
    <MiniPrompt hostId={hostId} coordinator={coordinator} large={expanded} />
  );
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${expanded ? "mx-auto w-full max-w-3xl" : ""}`}>
      {open && project && (
        <ContextReader
          hostId={hostId}
          project={project}
          files={files}
          file={open}
          onOpen={setOpenPath}
          onBack={() => setOpenPath(undefined)}
        />
      )}
      <div hidden={!!open} className="flex min-h-0 flex-1 flex-col">
        {memory ? (
          <MemoryPanel
            hostId={hostId}
            project={project}
            repo={repo}
            coordinator={coordinator?.id}
            start={head}
            afterBrief={board}
            end={notes}
            footer={prompt || undefined}
            onFiles={onFiles}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {head}
            {board}
            {notes}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How much the Project knows and how it grows: a count, what's new today, the field of squares,
 * and the latest few things learned, newest first.
 */
function Growth({
  memories,
  files,
  inbox,
  working,
  expanded,
  onExpand,
}: {
  memories: readonly Memory[];
  files: readonly ContextFile[];
  inbox?: InboxView;
  working?: boolean;
  expanded?: boolean;
  onExpand?: (expanded: boolean) => void;
}) {
  const now = Date.now();
  const fresh = (at: string) => now - Date.parse(at) < freshMs;
  const proposals = new Set(sectionsOf(memories).proposals);
  const learned = inbox?.items.filter((i) => i.kind === "learned") ?? [];
  const facts = [
    ...memories.map((m) => ({
      id: `m/${m.scope.kind}/${m.path}`,
      tone: proposals.has(m) ? ("proposal" as const) : ("memory" as const),
      title: m.title ?? m.path,
      at: m.modifiedAt,
    })),
    ...files.map((f) => ({
      id: `c/${f.path}`,
      tone: "note" as const,
      title: f.path,
      at: f.modifiedAt,
    })),
    ...learned.map((i) => ({
      id: `l/${i.id}`,
      tone: "learned" as const,
      title: i.text,
      at: i.createdAt,
    })),
  ].toSorted((a, b) => a.at.localeCompare(b.at));
  const pixels: Pixel[] = facts.map((f) => ({ ...f, fresh: fresh(f.at) }));
  const today = facts.filter((f) => fresh(f.at)).length;
  const latest = facts
    .filter((f) => f.tone !== "note")
    .toReversed()
    .slice(0, expanded ? 5 : 3);

  return (
    <section aria-label="What it knows" className="px-2.5 pt-3 pb-2">
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-[11px] tracking-wide text-faint-foreground uppercase">
          Knowledge
        </h3>
        {working && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-working">
            <Loader kind="matrix" variant="ripple" size={11} />
            growing
          </span>
        )}
        {onExpand && (
          <span className="ml-auto">
            <IconButton
              label={expanded ? "Back to the side" : "Full screen"}
              onClick={() => onExpand(!expanded)}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          </span>
        )}
      </div>
      <p className="mt-1 flex items-baseline gap-2">
        <span className={`font-medium tabular-nums ${expanded ? "text-[28px]" : "text-[20px]"}`}>
          {facts.length}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {facts.length === 1 ? "thing known" : "things known"}
        </span>
        {today > 0 && (
          <span className="ml-auto font-mono text-[11px] text-added tabular-nums">
            +{today} today
          </span>
        )}
      </p>
      <div className="mt-2.5">
        <PixelField pixels={pixels} live={working} slots={expanded ? 120 : 64} />
      </div>
      {latest.length > 0 && (
        <ul aria-label="Learned lately" className="mt-3 flex flex-col">
          {latest.map((f) => (
            <li
              key={f.id}
              className={`flex items-baseline gap-2.5 py-1 text-[12.5px] ${fresh(f.at) ? "pixel-fade" : ""}`}
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 translate-y-[-1px] rounded-[1px] ${f.tone === "learned" ? "bg-accent" : f.tone === "proposal" ? "bg-warning" : "bg-foreground/55"}`}
              />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{f.title}</span>
              <span className="shrink-0 font-mono text-[11px] text-faint-foreground tabular-nums">
                {age(f.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
