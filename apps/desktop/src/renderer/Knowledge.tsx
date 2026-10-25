import { MemoryPanel, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import type { AgentRun } from "../protocol/generated/protocol";

/**
 * The side panel's Knowledge view (0083): what a Project's agents know, in one list. A Project's
 * opens on its head, then Memory's proposals, brief, entries by kind, review list, and documents.
 * Its status board and context files are on the Project tab. At its foot a mini prompt changes it
 * in plain words; `expanded`, it centers in the window with a larger one. Off a Project it's the
 * repository's memory alone. `memory` is whether the host's plxd has `memory`; without it a
 * Project shows only its head. `titles` names the threads memory came from. Key it by host and
 * folder.
 */
export function KnowledgePanel({
  hostId,
  project,
  repo,
  coordinator,
  titles,
  memory,
  expanded,
}: {
  hostId: string;
  project?: string;
  repo?: string;
  coordinator?: AgentRun;
  /** Threads' titles by run id. */
  titles?: Readonly<Record<string, string>>;
  memory: boolean;
  /** Whether the panel fills the window. */
  expanded?: boolean;
}) {
  const head = (memories: readonly Memory[]) => project && <Head memories={memories} />;
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
          titles={titles}
          start={head}
          footer={prompt || undefined}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">{head([])}</div>
      )}
    </div>
  );
}

/** The view's head: its name, and how many memory entries and documents the Project holds. */
function Head({ memories }: { memories: readonly Memory[] }) {
  const entries = memories.filter((m) => m.path.startsWith("memory/")).length;
  const documents = memories.filter((m) => m.path.startsWith("knowledge/")).length;
  const counts = [
    entries > 0 && `${entries} memory ${entries === 1 ? "entry" : "entries"}`,
    documents > 0 && `${documents} ${documents === 1 ? "document" : "documents"}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <header className="px-1 pt-5">
      <h2 className="text-heading leading-tight font-semibold tracking-tight">Knowledge</h2>
      <p className="mt-0.5 text-body text-muted-foreground">
        What this Project's agents know{counts && `: ${counts}`}.
      </p>
    </header>
  );
}
