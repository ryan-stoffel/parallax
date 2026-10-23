import type { AgentRun } from "../protocol/generated/protocol";
import type { ProjectContext } from "./ContextPanel";
import type { InboxView } from "./Inbox";
import { MemoryPanel, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import type { ContextFile } from "../protocol/generated/protocol";
import { age } from "./Sidebar";

// What counts as new: learned in the last day.
const freshMs = 24 * 60 * 60 * 1000;

/**
 * The side panel's Knowledge view: what a Project's agents know, in one list. A Project's opens on
 * what it knows, newest learned first, then Memory's brief, entries, and proposals. Its status
 * board and context files are on the Project tab. At its foot a mini prompt changes it in plain
 * words; `expanded`, it centers in the window with a larger one. Off a Project it's the
 * repository's memory alone. `memory` is whether the host's plxd has `memory`; without it a
 * Project shows only what it knows. Key it by host and folder.
 */
export function KnowledgePanel({
  hostId,
  project,
  repo,
  coordinator,
  context,
  memory,
  inbox,
  expanded,
}: {
  hostId: string;
  project?: string;
  repo?: string;
  coordinator?: AgentRun;
  /** The Project's context files, which count toward what it knows. */
  context: ProjectContext;
  memory: boolean;
  /** The Project's inbox, whose Learned items show as they arrive. */
  inbox?: InboxView;
  /** Whether the panel fills the window. */
  expanded?: boolean;
}) {
  const head = (memories: readonly Memory[]) =>
    project && (
      <Known memories={memories} files={context.files} inbox={inbox} expanded={expanded} />
    );
  const prompt = project && memory && (
    <MiniPrompt hostId={hostId} coordinator={coordinator} large={expanded} />
  );
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${expanded ? "mx-auto w-full max-w-3xl" : ""}`}>
      {memory ? (
        <MemoryPanel
          hostId={hostId}
          project={project}
          repo={repo}
          start={head}
          footer={prompt || undefined}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{head([])}</div>
      )}
    </div>
  );
}

/**
 * What the Project knows, at a glance: how much and how much is new today, then the few things its
 * agents learned last, newest first, before Memory's own list.
 */
function Known({
  memories,
  files,
  inbox,
  expanded,
}: {
  memories: readonly Memory[];
  files: readonly ContextFile[];
  inbox?: InboxView;
  expanded?: boolean;
}) {
  const now = Date.now();
  const fresh = (at: string) => now - Date.parse(at) < freshMs;
  const learned = (inbox?.items.filter((i) => i.kind === "learned") ?? []).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const total = memories.length + files.length + learned.length;
  const today = [
    ...memories.map((m) => m.modifiedAt),
    ...files.map((f) => f.modifiedAt),
    ...learned.map((i) => i.createdAt),
  ].filter(fresh).length;

  return (
    <section aria-label="What it knows" className="px-2.5 pt-6 pb-1">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-medium">What it knows</h3>
        {total > 0 && (
          <span className="text-[12px] text-faint-foreground tabular-nums">
            {total} {total === 1 ? "thing" : "things"}
            {today > 0 && <span className="text-added">, {today} new today</span>}
          </span>
        )}
      </div>
      {learned.length > 0 && (
        <ul aria-label="Learned lately" className="mt-2 flex flex-col">
          {learned.slice(0, expanded ? 5 : 3).map((i) => (
            <li
              key={i.id}
              className={`flex items-baseline gap-2.5 py-1 text-[13px] ${fresh(i.createdAt) ? "pixel-fade" : ""}`}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 translate-y-[-2px] rounded-[1px] bg-accent"
              />
              <span className="min-w-0 flex-1 text-foreground/90">
                {i.text.replace(/^Memory: /, "")}
              </span>
              <span className="shrink-0 text-[11.5px] text-faint-foreground tabular-nums">
                {age(i.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
