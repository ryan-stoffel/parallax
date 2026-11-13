import { t } from "i18next";
import { useState } from "react";

import type { AgentPermission } from "../../protocol/generated/protocol";
import { accessPrefs } from "../accessPrefs";
import { accessOptions } from "../Composer";
import { EffortMenu } from "../EffortMenu";
import { ImportButton } from "../ImportSessions";
import { localId, useHosts } from "../hosts";
import { ModelMenu } from "../ModelMenu";
import { models, useCatalog, type Provider } from "../models";
import {
  behaviorPrefs,
  newThreadPrefs,
  setBehaviorPrefs,
  setNewThreadPrefs,
  type BehaviorPrefs,
} from "../prefs";
import { RunTargetMenu } from "../RunTargetMenu";
import { msg } from "../../i18n";
import { Picker, type PickerOption } from "../ui";
import { useHostSettings } from "./hostSettings";
import { allHosts, field, HostPicker, hostsOf, PageTitle, Row, Section, Switch } from "./parts";

/** The composer's own menus are borderless; on a settings row they get a field's outline. */
const pickerBox = "rounded-lg border border-border bg-background";

/** An option from a table marked with `msg`, in the shown language. */
const shown = (o: PickerOption): PickerOption => ({
  ...o,
  label: t(o.label),
  description: o.description && t(o.description),
});

/**
 * Settings > Threads: what a new thread starts with, how its title and a reply's text are written
 * (PLX-1523), whether a host's threads resume after a usage limit or a restart, and importing past
 * sessions (PLX-881) and exported chats (PLX-883).
 * How the sidebar lists threads is Appearance's (0094).
 */
export function ThreadSettings() {
  return (
    <>
      <PageTitle title={t("Threads")}>
        {t("What a new thread starts with, how text is written, and when threads pick up again.")}
      </PageTitle>
      <NewThreads />
      <TextGeneration />
      <Resuming />
      <Section title={t("Import")}>
        <Row
          title={t("Import sessions")}
          description={t(
            "Bring past sessions from the Claude, Codex, and Cursor desktop apps and Claude Code and Codex Remote Control into Archived as threads, on this computer or another connected one.",
          )}
        >
          <ImportButton what="sessions" />
        </Row>
        <Row
          title={t("Import chats")}
          description={t(
            "Bring chats from a ChatGPT or Claude data export (.zip) into Archived as threads.",
          )}
        >
          <ImportButton what="chats" />
        </Row>
      </Section>
    </>
  );
}

/**
 * What a new thread starts with, picked with the composer's own menus (`newThreadPrefs`), and the
 * computer with New Thread's own. The model list is this computer's; a thread on a host that lacks the model starts on that host's
 * first.
 */
function NewThreads() {
  const hosts = useHosts();
  const catalog = useCatalog(localId);
  const prefs = newThreadPrefs.use();
  const blocked: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (!i.enabled)
      blocked[i.id] = t("{{name}} is turned off in Settings > Providers.", { name: i.name });
  const choices = catalog.models.filter((m) => !blocked[m.provider]);
  const model =
    choices.find((m) => m.provider === prefs.model?.provider && m.id === prefs.model.id) ??
    choices[0];
  const instance = catalog.instances.find((i) => i.id === model?.provider);
  // Plan is legacy: listed only while Legacy Plan mode is on (accessPrefs).
  const legacyPlan = accessPrefs.use().legacyPlan;
  const permissions = (instance?.permissions ?? []).filter((p) => p !== "plan" || legacyPlan);
  const permission = permissions.includes(prefs.permission) ? prefs.permission : "edit";
  const contexts = model?.contexts ?? [];
  const context =
    prefs.context !== undefined && contexts.includes(prefs.context) ? prefs.context : contexts[0];
  const hasFast = !!model?.fast;

  return (
    <Section title={t("New threads")}>
      <Row
        title={t("Computer")}
        description={t(
          "The computer a new thread starts on, while it's connected. New Thread's menu can pick another.",
        )}
      >
        <span className={pickerBox}>
          <RunTargetMenu
            hosts={hosts}
            hostId={prefs.host}
            onHostChange={(host) => setNewThreadPrefs({ host })}
          />
        </span>
      </Row>
      <Row title={t("Model")} description={t("The model a new thread starts on.")}>
        {model ? (
          <span className={pickerBox}>
            <ModelMenu
              catalog={catalog}
              unavailable={blocked}
              value={model}
              onChange={(m) =>
                setNewThreadPrefs({ model: { provider: m.provider, id: m.id }, context: undefined })
              }
            />
          </span>
        ) : (
          <span className="text-body text-muted-foreground">{t("No models")}</span>
        )}
      </Row>
      {/* A backend that maps no efforts (Cursor) has none to default. */}
      {model && instance?.efforts !== false && (
        <Row
          title={t("Reasoning")}
          description={t(
            "How hard it thinks, and its context window and fast mode where the model has them.",
          )}
        >
          <span className={pickerBox}>
            <EffortMenu
              value={prefs.effort}
              onChange={(effort) => setNewThreadPrefs({ effort })}
              contexts={contexts}
              context={context}
              onContext={(next) => setNewThreadPrefs({ context: next })}
              fastMode={hasFast ? instance?.kind : undefined}
              fast={hasFast && prefs.fast}
              onFast={(fast) => setNewThreadPrefs({ fast })}
            />
          </span>
        </Row>
      )}
      {permissions.length > 1 && (
        <Row title={t("Permissions")} description={t("What a new thread may do without asking.")}>
          <Picker
            field
            label={t("Permissions")}
            value={permission}
            onChange={(value) => setNewThreadPrefs({ permission: value as AgentPermission })}
            options={permissions.map((p) => shown(accessOptions[p]))}
            align="end"
            className="w-56"
            panelClassName="w-[25rem]"
          />
        </Row>
      )}
      <Row
        title={t("Legacy Plan mode")}
        description={t(
          "List Plan in the Access picker. A thread already in Plan keeps it either way.",
        )}
      >
        <Switch
          label={t("Legacy Plan mode")}
          checked={legacyPlan}
          onChange={(next) => accessPrefs.set({ legacyPlan: next })}
        />
      </Row>
    </Section>
  );
}

/** Response streaming's choices, in the picker's order. */
const streamingOptions: { value: BehaviorPrefs["responseStreaming"]; label: string }[] = [
  { value: "live", label: msg("As it's written") },
  { value: "paragraphs", label: msg("Show finished paragraphs") },
  { value: "full", label: msg("Wait for the full response") },
];

/** What each of Response streaming's choices does, under the row's title. */
const streamingDescriptions: Record<BehaviorPrefs["responseStreaming"], string> = {
  live: msg("A reply's text appears as the agent writes it."),
  paragraphs: msg("Each paragraph, list, or code block of a reply appears once it's complete."),
  full: msg("A reply's text appears once the reply is complete."),
};

/**
 * The text Parallax writes or shows for a thread (PLX-1523): the model that names a new thread and
 * its branch, the user's own instructions for its title, and when a reply's text shows while it
 * arrives. The naming model is any Claude Code or Codex model; a host that lacks it names threads
 * with the thread's own provider's default (0058). All three are kept on this computer
 * (`newThreadPrefs`, `behaviorPrefs`).
 */
function TextGeneration() {
  const catalog = useCatalog(localId);
  const prefs = newThreadPrefs.use();
  const streaming = behaviorPrefs.use().responseStreaming;
  const blocked: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (!i.enabled)
      blocked[i.id] = t("{{name}} is turned off in Settings > Providers.", { name: i.name });
  const namers = catalog.instances.filter((i) => i.kind === "claude" || i.kind === "codex");
  const namerCatalog = {
    ...catalog,
    instances: namers,
    models: catalog.models.filter((m) => namers.some((i) => i.id === m.provider)),
  };
  const naming = prefs.naming;
  const namer = [...namerCatalog.models, ...models].find(
    (m) => m.provider === naming.provider && m.id === naming.id,
  ) ?? { id: naming.id, name: naming.id, provider: naming.provider, contexts: [] };

  return (
    <Section title={t("Text generation")}>
      <Row
        title={t("Naming model")}
        description={t(
          "Names a new thread and its branch from its first message, after it starts.",
        )}
      >
        <span className="flex gap-2">
          <span className={pickerBox}>
            <ModelMenu
              catalog={namerCatalog}
              unavailable={blocked}
              value={namer}
              onChange={(m) => setNewThreadPrefs({ naming: { provider: m.provider, id: m.id } })}
            />
          </span>
          <span className={pickerBox}>
            <EffortMenu
              value={prefs.namingEffort}
              onChange={(namingEffort) => setNewThreadPrefs({ namingEffort })}
            />
          </span>
        </span>
      </Row>
      {/* A row of its own shape: the field takes the card's width, under its title. */}
      <div
        data-setting="thread-title-instructions"
        className="border-border/40 px-4 py-3 not-last:border-b"
      >
        <span className="block text-body font-medium">{t("Thread title instructions")}</span>
        <span className="mt-0.5 block text-meta text-muted-foreground">
          {t(
            "Added to the prompt that names a new thread. A computer on an older plxd names threads without them.",
          )}
        </span>
        <textarea
          aria-label={t("Thread title instructions")}
          rows={4}
          maxLength={2048}
          placeholder={t("Keep titles to a few words. Lead with the main subject.")}
          value={prefs.namingInstructions}
          onChange={(e) => setNewThreadPrefs({ namingInstructions: e.target.value })}
          className={`${field} mt-2`}
        />
      </div>
      <Row title={t("Response streaming")} description={t(streamingDescriptions[streaming])}>
        <Picker
          field
          label={t("Response streaming")}
          value={streaming}
          onChange={(value) =>
            setBehaviorPrefs({ responseStreaming: value as BehaviorPrefs["responseStreaming"] })
          }
          options={streamingOptions.map((o) => ({ ...o, label: t(o.label) }))}
          align="end"
          className="w-60"
          panelClassName="min-w-60"
        />
      </Row>
    </Section>
  );
}

/**
 * Whether runs wait out a usage limit and resume when it resets (`host/settings`, 0049), and
 * whether a plain thread's turn a plxd restart cut off continues once plxd is up (0060), on every
 * computer or the one picked. Both are off by default. A thread's own toggle, in its menu, overrides the first.
 */
function Resuming() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const { able, connected, error, shared, set } = useHostSettings(hostsOf(hosts, scope));
  const resume = shared("autoResume", (s) => s.autoResume);
  const carryOn = shared("autoResume", (s) => s.continueAfterRestart);
  const differs = `${t("Differs across computers, so a change here sets them all.")} `;
  const failed = (host: string) => t("Couldn't save the setting on {{host}}", { host });

  return (
    <Section
      title={t("Resuming threads")}
      action={<HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
    >
      <Row
        title={t("Resume after a usage limit")}
        description={
          error ??
          (connected && !able("autoResume").length
            ? t("This plxd can't resume threads after a usage limit.")
            : `${resume.mixed ? differs : ""}${t("A thread a usage limit stopped continues once the limit resets. Each thread's menu can override this. An orchestrator's threads always do.")}`)
        }
      >
        <Switch
          label={t("Resume after a usage limit")}
          checked={!resume.mixed && (resume.value ?? false)}
          disabled={!resume.loaded}
          onChange={(next) => void set("autoResume", { autoResume: next }, failed)}
        />
      </Row>
      {carryOn.value !== undefined && (
        <Row
          title={t("Continue threads after restarts")}
          description={`${carryOn.mixed ? differs : ""}${t("A thread that was working when plxd restarted, as after an update, is told to continue where it left off. Either way, its queued messages wait for Resume.")}`}
        >
          <Switch
            label={t("Continue threads after restarts")}
            checked={!carryOn.mixed && !!carryOn.value}
            onChange={(next) => void set("autoResume", { continueAfterRestart: next }, failed)}
          />
        </Row>
      )}
    </Section>
  );
}
