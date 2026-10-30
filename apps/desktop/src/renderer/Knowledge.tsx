import { MemoryPanel, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import type { AgentRun } from "../protocol/generated/protocol";

/**
 * The side panel's Knowledge view (0083): what an orchestrator's agents know, in one list. An
 * orchestrator's opens on its head, then Memory's proposals, brief, entries by kind, review list,
 * and documents. Its status board and context files are on the orchestrator tab. At its foot a mini
 * prompt changes it in plain words; `expanded`, it centers in the window with a larger one. Off an
 * orchestrator it's the repository's memory alone. `memory` is whether the host's plxd has
 * `memory`; without it a Orchestrator shows only its head. `titles` names the threads memory came
 * from. Key it by host and folder.
 */
export function KnowledgePanel({
  hostId,
  orchestrator,
  repo,
  orchestratorRun,
  titles,
  memory,
  expanded,
}: {
  hostId: string;
  orchestrator?: string;
  repo?: string;
  orchestratorRun?: AgentRun;
  /** Threads' titles by run id. */
  titles?: Readonly<Record<string, string>>;
  memory: boolean;
  /** Whether the panel fills the window. */
  expanded?: boolean;
}) {
  const head = (memories: readonly Memory[]) => orchestrator && <Head memories={memories} />;
  const prompt = orchestrator && memory && (
    <MiniPrompt hostId={hostId} orchestratorRun={orchestratorRun} large={expanded} />
  );
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${expanded ? "mx-auto w-full max-w-3xl" : ""}`}>
      {memory ? (
        <MemoryPanel
          hostId={hostId}
          orchestrator={orchestrator}
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

/** The view's head: its name, and how many memory entries and documents the orchestrator holds. */
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
        What this orchestrator's agents know{counts && `: ${counts}`}.
      </p>
    </header>
  );
}
