import { Folder, House } from "lucide-react";
import { useRef, useState } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { Composer } from "./Composer";
import { noRepo, type ThreadGroup } from "./threads";
import { Picker } from "./ui";
import { uuidv7 } from "./uuidv7";

// The picker's value that opens the folder picker instead of choosing a group.
const addRepository = "add-repository";

interface NewThreadProps {
  /** Repositories and No Repo, as the sidebar groups them. */
  groups: ThreadGroup[];
  groupId: string;
  onGroupChange: (groupId: string) => void;
  /** Whether the host is this computer, so its folders can be picked. */
  local: boolean;
  addRepo: (path: string) => Promise<Repo | string>;
  start: (runId: string, groupId: string, prompt: string) => Promise<string | undefined>;
  /** Called once wispd has the thread. */
  onStarted: (runId: string) => void;
  disabledReason?: string;
}

/**
 * The New Thread screen: a centered composer, and under it where the thread runs. Errors from
 * wispd are written for people, so they show as they come, under the box.
 */
export function NewThread({
  groups,
  groupId,
  onGroupChange,
  local,
  addRepo,
  start,
  onStarted,
  disabledReason,
}: NewThreadProps) {
  const [repoError, setRepoError] = useState<string>();
  // The last failed start: retrying the same prompt in the same place reuses its run id, so a
  // start wispd did get never makes a second thread (0007).
  const failed = useRef<{ runId: string; groupId: string; prompt: string }>(undefined);
  const group = groups.find((g) => g.id === groupId) ?? groups.at(-1)!;

  const send = async (prompt: string) => {
    const last = failed.current;
    const runId =
      last && last.groupId === group.id && last.prompt === prompt ? last.runId : uuidv7();
    const error = await start(runId, group.id, prompt);
    failed.current = error ? { runId, groupId: group.id, prompt } : undefined;
    if (!error) onStarted(runId);
    return error;
  };

  const pickRepository = async () => {
    setRepoError(undefined);
    const path = await window.wisp.pickFolder();
    if (!path) return;
    const repo = await addRepo(path);
    if (typeof repo === "string") setRepoError(repo);
    else onGroupChange(repo.id);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[12vh]">
      <div className="w-full max-w-2xl">
        <h1 className="mb-6 text-center text-[22px] font-medium tracking-tight">
          {group.id === noRepo
            ? "What should we work on?"
            : `What should we build in ${group.name}?`}
        </h1>
        <Composer
          hero
          newThread
          onSend={send}
          disabledReason={disabledReason}
          footer={
            <div className="flex flex-col items-start px-2 pt-2">
              <Picker
                label="Repository"
                icon={group.id === noRepo ? <House /> : <Folder />}
                value={group.id}
                onChange={(e) => {
                  if (e.target.value === addRepository) return void pickRepository();
                  setRepoError(undefined);
                  onGroupChange(e.target.value);
                }}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                {local && <option value={addRepository}>Add repository…</option>}
              </Picker>
              {repoError && (
                <p role="alert" className="px-2 pt-1.5 text-[12.5px] text-danger">
                  {repoError}
                </p>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
