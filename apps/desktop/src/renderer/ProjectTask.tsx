import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project, PromptImage } from "../protocol/generated/protocol";
import { Composer, tabItem } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { imageCaps } from "./images";
import type { RunOptions } from "./models";
import { defaultBackend } from "./NewThread";
import type { ProjectAgentsView } from "./ProjectAgents";
import { statusLooks } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { titleOf } from "./threads";
import { uuidv7 } from "./uuidv7";

/**
 * A Project's New task page (0042): a composer whose every message starts a child on the worker
 * default, and is free again at once, so tasks go out one after another. What it started shows
 * under the heading, live, each opening its chat. Talking to the coordinator is its own chat.
 * Key it by host and Project.
 */
export function ProjectTask({
  hostId,
  project,
  startTask,
  agents,
  titles = {},
  onOpen,
  disabledReason,
}: {
  hostId: string;
  project: Project;
  startTask: ThreadsView["startTask"];
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  onOpen: (runId: string) => void;
  disabledReason?: string;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const [backend, setBackend] = useState<string>();
  // What this page started, newest first.
  const [started, setStarted] = useState<{ id: string; text: string }[]>([]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void defaultBackend(hostId, "worker").then((b) => live && setBackend(b));
    return () => {
      live = false;
    };
  }, [hostId, connected]);

  const send = async (
    text: string,
    options: RunOptions,
    images: PromptImage[],
    threads: string[],
  ) => {
    const id = uuidv7();
    const error = await startTask(project.id, id, text, images, options, threads);
    if (error) return describeError(error);
    setStarted((prev) => [{ id, text }, ...prev]);
    return undefined;
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-8 pb-6">
          <h2 className="text-[20px] font-medium tracking-tight">New task</h2>
          <p className="mt-1.5 max-w-lg text-[14px] text-muted-foreground">
            Each task gets its own agent and worktree in {project.name}. Send one, then the next;
            they run side by side and report back in the sidebar.
          </p>
          {started.length > 0 && (
            <section aria-label="Started here" className="mt-5 min-h-0 overflow-y-auto">
              <h3 className="pb-1.5 text-[12px] text-faint-foreground">Started here</h3>
              <ul className="flex flex-col gap-1">
                {started.map(({ id, text }) => {
                  const run = agents.runs.find((r) => r.id === id);
                  const look = run && (statusLooks[run.status] ?? statusLooks.completed!);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => onOpen(id)}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-[13px] hover:bg-hover"
                      >
                        {look ? (
                          <look.Icon aria-hidden className={`size-3.5 shrink-0 ${look.color}`} />
                        ) : (
                          <span className="size-3.5 shrink-0 rounded-full border border-border" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {(run && (titles[run.id] ?? titleOf(run))) ?? text}
                        </span>
                        <span className="shrink-0 text-[12px] text-faint-foreground">Open</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">
        <Composer
          newThread
          onSend={send}
          backend={backend}
          hostId={hostId}
          disabledReason={disabledReason}
          imageCaps={imageCaps(connection)}
          menus={connected && "composerMenus" in connection.capabilities ? { hostId } : undefined}
          projectMode={project.permission}
          tab={
            <span className={tabItem} title={project.repoPath}>
              <GitBranch aria-hidden />
              <span className="truncate">
                Each in its own worktree from {project.branch ?? "the default branch"}
              </span>
            </span>
          }
        />
      </div>
    </>
  );
}
