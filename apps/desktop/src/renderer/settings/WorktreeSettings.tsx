import { t } from "i18next";
import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";

import { msg } from "../../i18n";
import type { WorktreeKeep } from "../../protocol/generated/protocol";
import { useHosts } from "../hosts";
import { notify } from "../notifications";
import { newThreadPrefs, setNewThreadPrefs, type NewThreadPrefs } from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { Picker, type PickerOption } from "../ui";
import { useHostSettings } from "./hostSettings";
import { allHosts, HostPicker, hostsOf, PageTitle, Row, rowField, Section, Switch } from "./parts";
import { anchorOf } from "./search";

/** What a branch prefix may hold, as plxd checks it: what a git ref allows, ending in / or -. */
const prefixShape = /^(?:[A-Za-z0-9._][A-Za-z0-9._/-]*[/-])?$/;

/** How wide every control on the page is, so they share a right edge, in a card with the room. */
const control = "w-56 max-w-full";

/** The days a rule's picker offers. A stored number of days that isn't one is offered too. */
const dayPresets = [1, 3, 7, 14, 30, 60, 90];

/** What `worktreeKeep` can be, each with what it means for a worktree's other files. */
const keeps: (PickerOption & { value: WorktreeKeep })[] = [
  {
    value: "anyLocalFiles",
    label: msg("Any local files"),
    description: msg("Includes ignored files, except node_modules."),
  },
  {
    value: "uncommittedChanges",
    label: msg("Uncommitted changes"),
    description: msg("Keeps edits and untracked files. Deletes ignored files, including .env."),
  },
  {
    value: "trackedChanges",
    label: msg("Edited tracked files"),
    description: msg("Deletes untracked and ignored files, including .env."),
  },
];

/** An option from a table marked with `msg`, in the shown language. */
const shown = (o: PickerOption): PickerOption => ({
  ...o,
  label: t(o.label),
  description: o.description && t(o.description),
});

/** A row's description with its lines evened out, so none ends on a stray word or two. */
const even = (text: ReactNode) => <span className="block text-balance">{text}</span>;

/** The rows under Advanced, which a search for one opens. */
const advanced = ["Delete unchanged worktrees", "Keep worktrees with"];

/**
 * Settings > Worktrees: where a new thread works and what it starts from, on this computer, then
 * its branch's prefix and the rules that delete its worktree, on every computer or the one picked
 * (`host/settings`). `focus` is the row a search picked.
 */
export function WorktreeSettings({
  onProjects,
  focus,
}: {
  onProjects: () => void;
  focus?: { anchor: string };
}) {
  const prefs = newThreadPrefs.use();
  return (
    <>
      <PageTitle title={t("Worktrees")}>
        <Trans>
          A thread in a repository works in its own worktree, on its own branch. A repository can
          override these in{" "}
          <button type="button" className="underline hover:text-foreground" onClick={onProjects}>
            Projects
          </button>
          .
        </Trans>
      </PageTitle>
      <Section title={t("New worktrees")}>
        <Row
          title={t("Workspace")}
          description={even(
            t("Where a thread in a repository works. Each thread's menu can pick another."),
          )}
        >
          <Picker
            field
            label={t("Workspace")}
            value={prefs.workspace}
            onChange={(value) =>
              setNewThreadPrefs({ workspace: value as NewThreadPrefs["workspace"] })
            }
            options={workspaces.map(shown)}
            align="end"
            className={control}
            panelClassName="w-[24rem]"
          />
        </Row>
        <Row
          title={t("Start from")}
          description={even(
            t("The branch a new worktree starts from. New Thread's menu can pick another."),
          )}
        >
          <Picker
            field
            label={t("Start from")}
            value={prefs.worktreeBase}
            onChange={(value) =>
              setNewThreadPrefs({ worktreeBase: value as NewThreadPrefs["worktreeBase"] })
            }
            options={[
              {
                value: "default",
                label: t("Default branch"),
                description: t("origin/develop or origin/main, else the local one."),
              },
              {
                value: "current",
                label: t("Current branch"),
                description: t("Whichever branch the repository's checkout has out."),
              },
            ]}
            align="end"
            className={control}
            panelClassName="w-[24rem]"
          />
        </Row>
      </Section>
      <HostWorktrees focus={focus} />
    </>
  );
}

/**
 * The branch prefix and the cleanup rules of every computer, or the one picked. The picker sits
 * over the two sections it governs, under the one it doesn't.
 */
function HostWorktrees({ focus }: { focus?: { anchor: string } }) {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const { able, connected, error, shared, set } = useHostSettings(hostsOf(hosts, scope));
  const prefixable = able("branchPrefix").length > 0;
  const prefix = shared("branchPrefix", (s) => s.branchPrefix ?? "parallax/");
  const typed = prefix.mixed ? "" : (prefix.value ?? "parallax/");
  const differs = `${t("Differs across computers, so a change here sets them all.")} `;

  const cleanup = able("worktreeCleanup").length > 0;
  const merged = shared("worktreeCleanup", (s) => s.cleanWorktrees ?? true);
  const ruled = able("worktreeRules").length > 0;
  const deleted = shared("worktreeRules", (s) => s.deletedThreadWorktrees ?? true);
  const inactive = shared("worktreeRules", (s) => s.inactiveWorktreeDays ?? null);
  const archived = shared("worktreeRules", (s) => s.archivedWorktreeDays ?? null);
  const unchanged = shared("worktreeRules", (s) => s.unchangedWorktrees ?? false);
  const keep = shared("worktreeRules", (s) => s.worktreeKeep ?? "uncommittedChanges");
  /** A rule's description: why it can't be set here, or what it does, after a note that it differs. */
  const says = (rule: { mixed: boolean }, text: string) =>
    even(
      connected && !ruled
        ? t("This plxd doesn't have this rule. Update it to use it.")
        : `${rule.mixed ? differs : ""}${text}`,
    );
  const rule = (change: Parameters<typeof set>[1]) =>
    void set("worktreeRules", change, (host) =>
      t("Couldn't save the worktree rule on {{host}}", { host }),
    );

  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focus && advanced.some((title) => anchorOf(title) === focus.anchor)) setOpen(true);
  }, [focus]);

  return (
    <>
      {hosts.length > 1 && (
        <div className="mb-4">
          <HostPicker
            hosts={hosts}
            value={scope}
            onChange={setScope}
            all
            scope={t("branches and cleanup")}
          />
        </div>
      )}
      <Section title={t("Branches")}>
        <Row
          title={t("Branch prefix")}
          description={even(
            !connected
              ? t("Not connected.")
              : !prefixable
                ? t("This plxd always uses parallax/. Update it to change this.")
                : `${prefix.mixed ? differs : ""}${t("What a new thread's branch starts with, such as ryan/ or feat-. Empty names it for the thread alone.")}`,
          )}
        >
          <input
            // A saved value is the field's again.
            key={`${scope}/${prefix.mixed}/${typed}`}
            aria-label={t("Branch prefix")}
            defaultValue={typed}
            disabled={!prefix.loaded}
            spellCheck={false}
            autoComplete="off"
            placeholder={prefix.mixed ? t("Differs") : t("None")}
            maxLength={64}
            className={`${rowField} max-w-full font-mono disabled:opacity-50`}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next === typed) return;
              if (!prefixShape.test(next)) {
                e.target.value = typed;
                notify({
                  tone: "error",
                  title: t("That prefix can't start a branch name"),
                  body: t("Use letters, digits, ., _, -, and /, ending in / or -."),
                });
              } else
                void set("branchPrefix", { branchPrefix: next }, (host) =>
                  t("Couldn't save the branch prefix on {{host}}", { host }),
                );
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </Row>
      </Section>
      <Section title={t("Cleanup")}>
        <Row
          title={t("Delete worktrees with deleted threads")}
          description={says(
            deleted,
            t(
              "Deleting a thread deletes its worktree and branch, uncommitted changes included. Off, both stay on disk.",
            ),
          )}
        >
          <Switch
            label={t("Delete worktrees with deleted threads")}
            checked={!deleted.mixed && (deleted.value ?? true)}
            disabled={!deleted.loaded}
            onChange={(deletedThreadWorktrees) => rule({ deletedThreadWorktrees })}
          />
        </Row>
        <Row
          title={t("Delete merged worktrees")}
          description={even(
            error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : connected && !cleanup ? (
              t("This plxd can't clean up worktrees.")
            ) : (
              `${merged.mixed ? differs : ""}${t("When a thread's pull request merges, the thread is archived unless you've messaged it since. Once a merged thread is done or archived, its worktree and branch go.")}`
            ),
          )}
        >
          <Switch
            label={t("Delete merged worktrees")}
            checked={!merged.mixed && (merged.value ?? true)}
            disabled={!merged.loaded}
            onChange={(cleanWorktrees) =>
              void set("worktreeCleanup", { cleanWorktrees }, (host) =>
                t("Couldn't save worktree cleanup on {{host}}", { host }),
              )
            }
          />
        </Row>
        <Row
          title={t("Delete inactive worktrees")}
          description={says(
            inactive,
            t(
              "When a thread has had no activity for this long, its worktree goes. The branch and the thread stay.",
            ),
          )}
        >
          <DaysPicker
            label={t("Delete inactive worktrees")}
            days={inactive}
            onChange={(inactiveWorktreeDays) => rule({ inactiveWorktreeDays })}
          />
        </Row>
        <Row
          title={t("Delete archived worktrees")}
          description={says(
            archived,
            t(
              "When a thread has been archived for this long, its worktree folder goes. The thread and its branch stay, and a new message brings the folder back.",
            ),
          )}
        >
          <DaysPicker
            label={t("Delete archived worktrees")}
            days={archived}
            zero={t("At the next cleanup")}
            onChange={(archivedWorktreeDays) => rule({ archivedWorktreeDays })}
          />
        </Row>
        <details
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
          className="[&[open]>summary_svg]:rotate-90"
        >
          <summary className="flex cursor-default list-none items-center gap-1.5 px-4 py-3 text-body font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden />
            {t("Advanced")}
          </summary>
          <div className="border-t border-border/40">
            <Row
              title={t("Delete unchanged worktrees")}
              description={says(
                unchanged,
                t(
                  "A worktree with no commits beyond the default branch goes once its thread is idle for an hour. The branch and the thread stay.",
                ),
              )}
            >
              <Switch
                label={t("Delete unchanged worktrees")}
                checked={!unchanged.mixed && (unchanged.value ?? false)}
                disabled={!unchanged.loaded}
                onChange={(unchangedWorktrees) => rule({ unchangedWorktrees })}
              />
            </Row>
            <Row
              title={t("Keep worktrees with")}
              description={says(
                keep,
                t(
                  "A worktree with these stays, unless its thread is deleted. Other files, such as an ignored .env, go with it.",
                ),
              )}
            >
              <Picker
                field
                label={t("Keep worktrees with")}
                value={keep.loaded && !keep.mixed ? keep.value : ""}
                placeholder={keep.mixed ? t("Differs") : t("Uncommitted changes")}
                disabled={!keep.loaded}
                onChange={(worktreeKeep) => rule({ worktreeKeep: worktreeKeep as WorktreeKeep })}
                options={keeps.map(shown)}
                align="end"
                className={control}
                panelClassName="w-[24rem]"
              />
            </Row>
          </div>
        </details>
      </Section>
    </>
  );
}

/**
 * A rule's days as a picker: Off, `zero` for 0 days when the rule takes it, then the presets and
 * the stored number when it isn't one. It reads Differs while the computers do.
 */
function DaysPicker({
  label,
  days,
  zero,
  onChange,
}: {
  label: string;
  days: { loaded: boolean; mixed: boolean; value?: number | null };
  zero?: string;
  onChange: (days: number | null) => void;
}) {
  const stored = days.mixed ? null : (days.value ?? null);
  const offered = [...new Set([...dayPresets, ...(stored ? [stored] : [])])].sort((a, b) => a - b);
  return (
    <Picker
      field
      label={label}
      value={!days.loaded || days.mixed ? "" : stored === null ? "off" : String(stored)}
      placeholder={days.mixed ? t("Differs") : t("Off")}
      disabled={!days.loaded}
      onChange={(value) => onChange(value === "off" ? null : Number(value))}
      options={[
        { value: "off", label: t("Off") },
        ...(zero ? [{ value: "0", label: zero }] : []),
        ...offered.map((d) => ({
          value: String(d),
          label: t("{{count}} days", { count: d, defaultValue_one: "{{count}} day" }),
        })),
      ]}
      align="end"
      className={control}
      panelClassName={control}
    />
  );
}
