import { useState } from "react";

import { ContextReader, SharedNotes, StatusBoard, useProjectContext } from "./ContextPanel";
import { MemoryPanel } from "./MemoryPanel";

/**
 * The side panel's Knowledge view: what a Project's agents know, in one list. Memory's brief comes
 * first, then the coordinator's status board, then memory's entries, knowledge, and proposals, then
 * the Project's other shared notes. A note opens in place, with memory kept behind it. Off a
 * Project it's the repository's memory alone. `memory` is whether the host's plxd has `memory`;
 * without it a Project shows only its context. Key it by host and folder.
 */
export function KnowledgePanel({
  hostId,
  project,
  repo,
  coordinator,
  connected,
  memory,
}: {
  hostId: string;
  project?: string;
  repo?: string;
  coordinator?: string;
  connected: boolean;
  memory: boolean;
}) {
  const { files, error } = useProjectContext(hostId, project ?? "", connected && !!project);
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
  return (
    <>
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
            coordinator={coordinator}
            afterBrief={board}
            end={notes}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {board}
            {notes}
          </div>
        )}
      </div>
    </>
  );
}
