import { Folder, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project } from "../protocol/generated/protocol";
import { AgentChat } from "./AgentChat";
import { Composer, tabItem } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { RunOptions } from "./models";
import { accountOptions, defaultBackend } from "./NewThread";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { uuidv7 } from "./uuidv7";

/**
 * A Project's coordinator chat (0024). Until its first message the Project introduces itself, and
 * sending starts the coordinator. From then on it is the coordinator run's `AgentChat`, so replies,
 * Stop, and the transcript work as a thread's do. Key it by host and Project.
 */
export function ProjectChat({
  hostId,
  project,
  prompt,
  startCoordinator,
}: {
  hostId: string;
  project: Project;
  /** The coordinator's first message, shown until its transcript loads. */
  prompt?: string;
  startCoordinator: ThreadsView["startCoordinator"];
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  // The first message's run id, reused when it's sent again after failing (0007).
  const [runId] = useState(uuidv7);
  // Which account the first message picked, when the host had no coordinator account.
  const [notice, setNotice] = useState<string>();
  // The coordinator default's backend, whose models and efforts the first message offers.
  const [backend, setBackend] = useState<string>();
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void defaultBackend(hostId, "coordinator").then((b) => live && setBackend(b));
    return () => {
      live = false;
    };
  }, [hostId, connected]);

  // The coordinator works in the Project's repository itself, not a worktree.
  const tab = (
    <>
      <span className={tabItem} title={project.repoPath}>
        <Folder aria-hidden />
        <span className="truncate">{project.repoPath}</span>
      </span>
      {project.branch && (
        <span className={tabItem}>
          <GitBranch aria-hidden />
          {project.branch}
        </span>
      )}
    </>
  );

  if (project.coordinator)
    return (
      <AgentChat
        key={project.coordinator}
        hostId={hostId}
        runId={project.coordinator}
        prompt={prompt}
        notice={notice}
        tab={tab}
      />
    );

  const send = async (text: string, options: RunOptions) => {
    let error = await startCoordinator(project.id, runId, text, options);
    const kind = error?.data?.kind;
    if (kind === "noDefaultAccount" || kind === "accountNotFound") {
      // The host's first Claude account from now on: its Claude Code login, then its API keys,
      // subscriptions first as 0004 has it.
      const accounts = await accountOptions(hostId);
      if (typeof accounts === "string") return accounts;
      const first = accounts[0];
      if (!first)
        return "No account can run the coordinator yet. Sign in to Claude Code, or add an API key, then try again.";
      const set = await window.wisp.request(hostId, "accounts/defaults/set", {
        role: "coordinator",
        account: first.account,
      });
      if ("error" in set) return describeError(set.error);
      setNotice(`Using ${first.label} for Project coordinators on this host.`);
      error = await startCoordinator(project.id, runId, text, options);
    }
    return error && describeError(error);
  };

  let disabledReason: string | undefined;
  if (connection?.status === "failed") disabledReason = "Disconnected from wispd";
  else if (!connected) disabledReason = "Connecting to wispd…";
  else if (!("coordinator" in connection.capabilities))
    disabledReason = "This host's wispd can't run a Project's coordinator yet";

  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh] text-center">
        <ProjectIcon className="size-10" />
        <h2 className="mt-5 text-[18px] font-medium tracking-tight">{project.name}</h2>
        <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">
          Agents working on {project.name} report back and coordinate here.
        </p>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        <Composer
          newThread
          onSend={send}
          backend={backend}
          noWrite
          disabledReason={disabledReason}
          tab={tab}
        />
      </div>
    </>
  );
}
