import { useEffect, useRef, useState } from "react";

import type { HostSettings } from "../../protocol/generated/protocol";
import { useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts } from "../hosts";
import { notify } from "../notifications";
import { newThreadPrefs, setNewThreadPrefs, type NewThreadPrefs } from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { Picker } from "../ui";
import { HostPicker, PageTitle, Row, rowField, Section, Switch } from "./parts";

/** What a branch prefix may hold, as plxd checks it: what a git ref allows, ending in / or -. */
const prefixShape = /^(?:[A-Za-z0-9._][A-Za-z0-9._/-]*[/-])?$/;

/**
 * Settings > Worktrees: where a new thread works and what it starts from, on this computer, then
 * its branch's prefix and when its worktree is removed, on a host (`host/settings`).
 */
export function WorktreeSettings({ onProjects }: { onProjects: () => void }) {
  const prefs = newThreadPrefs.use();
  return (
    <>
      <PageTitle title="Worktrees">
        A thread in a repository works in its own worktree, on its own branch. A repository can
        override these in{" "}
        <button type="button" className="underline hover:text-foreground" onClick={onProjects}>
          Projects
        </button>
        .
      </PageTitle>
      <Section title="New worktrees">
        <Row
          title="Workspace"
          description="Where a thread in a repository works. Each thread's menu can pick another."
        >
          <Picker
            field
            label="Workspace"
            value={prefs.workspace}
            onChange={(value) =>
              setNewThreadPrefs({ workspace: value as NewThreadPrefs["workspace"] })
            }
            options={workspaces}
            align="end"
            className="w-56"
            panelClassName="w-[24rem]"
          />
        </Row>
        <Row
          title="Start from"
          description="The branch a new worktree starts from. New Thread's menu can pick another."
        >
          <Picker
            field
            label="Start from"
            value={prefs.worktreeBase}
            onChange={(value) =>
              setNewThreadPrefs({ worktreeBase: value as NewThreadPrefs["worktreeBase"] })
            }
            options={[
              {
                value: "default",
                label: "Default branch",
                description: "origin/develop or origin/main, else the local one.",
              },
              {
                value: "current",
                label: "Current branch",
                description: "Whichever branch the repository's checkout has out.",
              },
            ]}
            align="end"
            className="w-56"
            panelClassName="w-[24rem]"
          />
        </Row>
      </Section>
      <HostWorktrees />
    </>
  );
}

/** A host's branch prefix and worktree cleanup. */
function HostWorktrees() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const cleanup = connected && "worktreeCleanup" in connection.capabilities;
  const prefixable = connected && "branchPrefix" in connection.capabilities;
  const [settings, setSettings] = useState<HostSettings>();
  const [error, setError] = useState<string>();
  // The host on screen, so a reply for one the picker has left is dropped.
  const shown = useRef(hostId);
  useEffect(() => {
    shown.current = hostId;
    setSettings(undefined);
    setError(undefined);
    if (!connected) return;
    let stale = false;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (stale) return;
      if ("error" in answer) setError(describeError(answer.error));
      else setSettings(answer.result);
    });
    return () => {
      stale = true;
    };
  }, [hostId, connected]);

  const set = async (change: { cleanWorktrees?: boolean; branchPrefix?: string }) => {
    const host = hostId;
    const answer = await window.parallax.request(host, "host/settings/set", change);
    if (shown.current !== host) return;
    if ("error" in answer)
      notify({
        tone: "error",
        title: "Couldn't save the worktree setting",
        body: describeError(answer.error),
      });
    else setSettings(answer.result);
  };
  const on = settings?.cleanWorktrees ?? true;
  const prefix = settings?.branchPrefix ?? "parallax/";

  return (
    <Section
      title="On this host"
      action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
    >
      <Row
        title="Branch prefix"
        description={
          !connected
            ? "This host isn't connected."
            : !prefixable
              ? "This host's plxd always uses parallax/. Update it to change this."
              : "What a new thread's branch starts with, such as ryan/ or feat-. Empty names it for the thread alone."
        }
      >
        <input
          // A saved value is the field's again.
          key={prefix}
          aria-label="Branch prefix"
          defaultValue={prefix}
          disabled={!prefixable || !settings}
          spellCheck={false}
          autoComplete="off"
          placeholder="None"
          maxLength={64}
          className={`${rowField} font-mono disabled:opacity-50`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next === prefix) return;
            if (!prefixShape.test(next)) {
              e.target.value = prefix;
              notify({
                tone: "error",
                title: "That prefix can't start a branch name",
                body: "Use letters, digits, ., _, -, and /, ending in / or -.",
              });
            } else void set({ branchPrefix: next });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Row>
      <Row
        title="Clean up merged worktrees"
        description={
          error ? (
            <span role="alert" className="text-danger">
              {error}
            </span>
          ) : connected && !cleanup ? (
            "This host's plxd can't clean up worktrees."
          ) : (
            "When a settled or archived thread's pull request merges, Parallax deletes its worktree and branch. The thread stays."
          )
        }
      >
        <Switch
          label="Clean up merged worktrees"
          checked={on}
          disabled={!cleanup || !settings}
          onChange={(cleanWorktrees) => void set({ cleanWorktrees })}
        />
      </Row>
    </Section>
  );
}
