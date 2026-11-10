import { useState } from "react";

import { useHosts } from "../hosts";
import { notify } from "../notifications";
import { newThreadPrefs, setNewThreadPrefs, type NewThreadPrefs } from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { Picker } from "../ui";
import { useHostSettings } from "./hostSettings";
import { allHosts, HostPicker, hostsOf, PageTitle, Row, rowField, Section, Switch } from "./parts";

/** What a branch prefix may hold, as plxd checks it: what a git ref allows, ending in / or -. */
const prefixShape = /^(?:[A-Za-z0-9._][A-Za-z0-9._/-]*[/-])?$/;

/** The most days plxd takes before it deletes an inactive worktree, and what turning it on sets. */
const maxInactiveDays = 3650;
const defaultInactiveDays = 30;

/**
 * Settings > Worktrees: where a new thread works and what it starts from, on this computer, then
 * its branch's prefix and when its worktree is removed, on every computer or the one picked
 * (`host/settings`).
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

/**
 * The branch prefix, merged worktree cleanup, and days before an inactive worktree is deleted, of
 * every computer or the one picked.
 */
function HostWorktrees() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const { able, connected, error, shared, set } = useHostSettings(hostsOf(hosts, scope));
  const cleanup = able("worktreeCleanup").length > 0;
  const prefixable = able("branchPrefix").length > 0;
  const clean = shared("worktreeCleanup", (s) => s.cleanWorktrees ?? true);
  const inactive = able("inactiveWorktrees").length > 0;
  // 0 is off.
  const days = shared("inactiveWorktrees", (s) => s.inactiveWorktreeDays ?? 0);
  const deletes = !days.mixed && (days.value ?? 0) > 0;
  const setDays = (inactiveWorktreeDays: number) =>
    void set(
      "inactiveWorktrees",
      { inactiveWorktreeDays },
      "Couldn't save when inactive worktrees are deleted",
    );
  const prefix = shared("branchPrefix", (s) => s.branchPrefix ?? "parallax/");
  const typed = prefix.mixed ? "" : (prefix.value ?? "parallax/");
  const differs = "Differs across computers, so a change here sets them all. ";

  return (
    <Section
      title="Branches and cleanup"
      action={<HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
    >
      <Row
        title="Branch prefix"
        description={
          !connected
            ? "Not connected."
            : !prefixable
              ? "This plxd always uses parallax/. Update it to change this."
              : `${prefix.mixed ? differs : ""}What a new thread's branch starts with, such as ryan/ or feat-. Empty names it for the thread alone.`
        }
      >
        <input
          // A saved value is the field's again.
          key={`${scope}/${prefix.mixed}/${typed}`}
          aria-label="Branch prefix"
          defaultValue={typed}
          disabled={!prefix.loaded}
          spellCheck={false}
          autoComplete="off"
          placeholder={prefix.mixed ? "Differs" : "None"}
          maxLength={64}
          className={`${rowField} font-mono disabled:opacity-50`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next === typed) return;
            if (!prefixShape.test(next)) {
              e.target.value = typed;
              notify({
                tone: "error",
                title: "That prefix can't start a branch name",
                body: "Use letters, digits, ., _, -, and /, ending in / or -.",
              });
            } else
              void set("branchPrefix", { branchPrefix: next }, "Couldn't save the branch prefix");
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
            "This plxd can't clean up worktrees."
          ) : (
            `${clean.mixed ? differs : ""}When a settled or archived thread's pull request merges, Parallax deletes its worktree and branch. The thread stays.`
          )
        }
      >
        <Switch
          label="Clean up merged worktrees"
          checked={!clean.mixed && (clean.value ?? true)}
          disabled={!clean.loaded}
          onChange={(cleanWorktrees) =>
            void set("worktreeCleanup", { cleanWorktrees }, "Couldn't save worktree cleanup")
          }
        />
      </Row>
      <Row
        title="Delete inactive worktrees"
        description={
          connected && !inactive
            ? "This plxd can't delete inactive worktrees."
            : `${days.mixed ? differs : ""}When a thread has had no activity for this many days, Parallax deletes its worktree, unless it has uncommitted changes. The branch and the thread stay.`
        }
      >
        {deletes && (
          <>
            <input
              // A saved value is the field's again.
              key={`${scope}/${days.value}`}
              type="number"
              aria-label="Days before an inactive worktree is deleted"
              min={1}
              max={maxInactiveDays}
              defaultValue={days.value}
              onBlur={(e) => {
                const next = Math.round(Number(e.target.value));
                if (next >= 1 && next <= maxInactiveDays && next !== days.value) setDays(next);
                else e.target.value = String(days.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="w-20 rounded-md border border-border bg-background px-2.5 py-1 text-right text-body tabular-nums"
            />
            <span className="text-meta text-muted-foreground">days</span>
          </>
        )}
        <Switch
          label="Delete inactive worktrees"
          checked={deletes}
          disabled={!days.loaded}
          onChange={(on) => setDays(on ? defaultInactiveDays : 0)}
        />
      </Row>
    </Section>
  );
}
