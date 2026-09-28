import { Folder, House } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type { AccountChoice, Repo } from "../protocol/generated/protocol";
import { Composer } from "./Composer";
import { describeError } from "./errors";
import { noRepo, type ThreadGroup } from "./threads";
import { Picker } from "./ui";
import { uuidv7 } from "./uuidv7";

// The picker's value that opens the folder picker instead of choosing a group.
const addRepository = "add-repository";

interface NewThreadProps {
  hostId: string;
  /** Repositories and No Repo, as the sidebar groups them. */
  groups: ThreadGroup[];
  groupId: string;
  onGroupChange: (groupId: string) => void;
  /** Whether the host is this computer, so its folders can be picked. */
  local: boolean;
  addRepo: (path: string) => Promise<Repo | string>;
  start: (runId: string, groupId: string, prompt: string) => Promise<RpcError | undefined>;
  /** Called once wispd has the thread, with a note for it, such as which account it picked. */
  onStarted: (runId: string, notice?: string) => void;
  disabledReason?: string;
}

/** One start of a thread. Retrying it reuses its run id, so wispd never makes a second thread (0007). */
interface Attempt {
  runId: string;
  groupId: string;
  prompt: string;
}

/** An account a worker can run on, as the account chooser lists it. */
interface AccountOption {
  label: string;
  account: AccountChoice;
}

/**
 * The host's accounts a thread can run on: its signed-in Claude Code login, then its Anthropic key
 * accounts. Resolves to wispd's error, for people, when either list fails.
 */
async function accountOptions(hostId: string): Promise<AccountOption[] | string> {
  const [clis, keys] = await Promise.all([
    window.wisp.request(hostId, "accounts/list", {}),
    window.wisp.request(hostId, "accounts/keys/list", {}),
  ]);
  if ("error" in clis) return describeError(clis.error);
  if ("error" in keys) return describeError(keys.error);
  // ponytail: mirrors wispd's backend registry, where only Claude runs workers today. RYA-99 has
  // wispd report which accounts can run a thread, so this stops hard-coding it.
  return [
    ...clis.result.clis
      .filter((c) => c.cli === "claude" && c.signedIn)
      .map((c) => ({
        label: "Claude Code",
        account: { kind: "subscription", backend: c.cli } as const,
      })),
    ...keys.result.accounts
      .filter((k) => k.provider === "anthropic")
      .map((k) => ({
        label: `${k.label} (API key)`,
        account: { kind: "key", id: k.id } as const,
      })),
  ];
}

const noAccounts =
  "No account can run this thread yet. Sign in to Claude Code, or add an API key, then try again.";

/**
 * The New Thread screen: a centered composer, and under it where the thread runs. When the host
 * has no usable default account for threads, it picks the only one there is (and says so), or asks
 * which to use, sets it as the default, and retries the same start. wispd never picks one itself, so it never spends
 * a subscription the user didn't choose.
 */
export function NewThread({
  hostId,
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
  // Open while the host needs an account for the failed start.
  const [choices, setChoices] = useState<AccountOption[]>();
  const [picked, setPicked] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string>();
  const failed = useRef<Attempt>(undefined);
  const group = groups.find((g) => g.id === groupId) ?? groups.at(-1)!;

  // Focus the chosen account when the chooser opens, so a screen reader announces it.
  const chooser = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (choices) chooser.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [choices]);

  // Starts `attempt`. Resolves to an error message, or "" when the account chooser opened.
  // `notice` goes to the thread once it starts.
  const attemptStart = async (
    attempt: Attempt,
    askForAccount = true,
    notice?: string,
  ): Promise<string | undefined> => {
    const error = await start(attempt.runId, attempt.groupId, attempt.prompt);
    failed.current = error ? attempt : undefined;
    if (!error) {
      onStarted(attempt.runId, notice);
      return undefined;
    }
    // No default, or one naming a removed key account: both need an account picked. Asks once
    // per Send, so a default that doesn't take can't loop.
    const kind = error.data?.kind;
    if ((kind !== "noDefaultAccount" && kind !== "accountNotFound") || !askForAccount)
      return describeError(error);
    const options = await accountOptions(hostId);
    if (typeof options === "string") return options;
    if (options.length === 0) return noAccounts;
    if (options.length === 1)
      return runOn(
        attempt,
        options[0]!,
        `Using ${options[0]!.label} for new threads on this host.`,
      );
    setPicked(0);
    setChooseError(undefined);
    setChoices(options);
    return "";
  };

  // Makes `option` the worker default, then retries `attempt` with its run id.
  const runOn = async (
    attempt: Attempt,
    option: AccountOption,
    notice?: string,
  ): Promise<string | undefined> => {
    const set = await window.wisp.request(hostId, "accounts/defaults/set", {
      role: "worker",
      account: option.account,
    });
    if ("error" in set) return describeError(set.error);
    return attemptStart(attempt, false, notice);
  };

  const send = async (prompt: string) => {
    setChoices(undefined);
    const last = failed.current;
    const runId =
      last && last.groupId === group.id && last.prompt === prompt ? last.runId : uuidv7();
    return attemptStart({ runId, groupId: group.id, prompt });
  };

  const continueWith = async (option: AccountOption) => {
    setChoosing(true);
    setChooseError(undefined);
    const error = await runOn(failed.current!, option);
    setChoosing(false);
    if (error) setChooseError(error);
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
                  setChoices(undefined);
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
              {choices && (
                <fieldset
                  ref={chooser}
                  className="mt-3 w-full rounded-xl border border-border px-4 py-3"
                >
                  <legend className="float-left mb-2.5 w-full">
                    <span className="block text-[13px] font-medium">
                      Choose an account to run this thread
                    </span>
                    <span className="block text-[12.5px] text-muted-foreground">
                      New threads on this host use it from now on.
                    </span>
                  </legend>
                  <div className="clear-left flex flex-wrap gap-1">
                    {choices.map((choice, i) => (
                      <label
                        key={i}
                        className="flex items-center rounded-md border border-border px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground has-checked:bg-selected has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
                      >
                        <input
                          type="radio"
                          name="account"
                          checked={picked === i}
                          onChange={() => setPicked(i)}
                          className="sr-only"
                        />
                        {choice.label}
                      </label>
                    ))}
                  </div>
                  {chooseError && (
                    <p role="alert" className="pt-2 text-[12.5px] text-danger">
                      {chooseError}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={choosing}
                    onClick={() => void continueWith(choices[picked]!)}
                    className="mt-3 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
                  >
                    Continue
                  </button>
                </fieldset>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
