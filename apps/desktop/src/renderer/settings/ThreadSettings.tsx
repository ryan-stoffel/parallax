import { useEffect, useState } from "react";

import type {
  AgentPermission,
  HostSettings,
  HostSettingsSetParams,
} from "../../protocol/generated/protocol";
import { accessPrefs } from "../accessPrefs";
import { accessOptions } from "../Composer";
import { useConnection } from "../ConnectionStatus";
import { EffortMenu } from "../EffortMenu";
import { ImportButton } from "../ImportSessions";
import { localId, useHosts } from "../hosts";
import { ModelMenu } from "../ModelMenu";
import { models, useCatalog, type Provider } from "../models";
import { newThreadPrefs, setNewThreadPrefs } from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { archivePageSize, sidebarPrefs, type SidebarPrefs } from "../sidebarPrefs";
import { Picker } from "../ui";
import { HostPicker, PageTitle, Row, Section, Switch } from "./parts";

/** The composer's own menus are borderless; on a settings row they get a field's outline. */
const pickerBox = "rounded-lg border border-border bg-background";

/**
 * Settings > Threads: what a new thread starts with, how the sidebar lists threads, whether a
 * host's threads resume after a usage limit or a restart, and importing past sessions (PLX-881).
 */
export function ThreadSettings() {
  const sidebar = sidebarPrefs.use();
  const setSidebar = (patch: Partial<SidebarPrefs>) =>
    sidebarPrefs.set({ ...sidebarPrefs.get(), ...patch });
  return (
    <>
      <PageTitle title="Threads">
        What a new thread starts with, how the sidebar lists threads, and when they pick up again.
      </PageTitle>
      <NewThreads />
      <Section title="Sidebar">
        <Row
          title="Working section"
          description="While a thread is working, list it under Working, above Archived. Off keeps it in Threads."
        >
          <Switch
            label="Working section"
            checked={sidebar.workingSection}
            onChange={(workingSection) => setSidebar({ workingSection })}
          />
        </Row>
        <Row
          title="Archive pages"
          description={`Show ${archivePageSize} archived threads at a time, with Show more for the rest. Off lists them all.`}
        >
          <Switch
            label="Archive pages"
            checked={sidebar.pageArchived}
            onChange={(pageArchived) => setSidebar({ pageArchived })}
          />
        </Row>
      </Section>
      <Resuming />
      <Section title="Import">
        <Row
          title="Import sessions"
          description="Bring past sessions from the Claude, Codex, and Cursor desktop apps into Archived as threads on this computer."
        >
          <ImportButton />
        </Row>
      </Section>
    </>
  );
}

/**
 * What a new thread starts with, picked with the composer's own menus (`newThreadPrefs`). The
 * model list is this computer's; a thread on a host that lacks the model starts on that host's
 * first. The naming model is any Claude Code or Codex model; a host that lacks it names threads
 * with the thread's own provider's default (0058).
 */
function NewThreads() {
  const catalog = useCatalog(localId);
  const prefs = newThreadPrefs.use();
  const blocked: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (!i.enabled) blocked[i.id] = `${i.name} is turned off in Settings > Providers.`;
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
  const workspace = workspaces.find((w) => w.value === prefs.workspace) ?? workspaces[0]!;
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
    <Section title="New threads">
      <Row title="Model" description="The model a new thread starts on.">
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
          <span className="text-[13px] text-muted-foreground">No models</span>
        )}
      </Row>
      {/* A backend that maps no efforts (Cursor) has none to default. */}
      {model && instance?.efforts !== false && (
        <Row
          title="Reasoning"
          description="How hard it thinks, and its context window and fast mode where the model has them."
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
        <Row title="Permissions" description="What a new thread may do without asking.">
          <Picker
            field
            label="Permissions"
            value={permission}
            onChange={(value) => setNewThreadPrefs({ permission: value as AgentPermission })}
            options={permissions.map((p) => accessOptions[p])}
            align="end"
            className="w-56"
            panelClassName="w-[25rem]"
          />
        </Row>
      )}
      <Row
        title="Legacy Plan mode"
        description="List Plan in the Access picker. A thread already in Plan keeps it either way."
      >
        <Switch
          label="Legacy Plan mode"
          checked={legacyPlan}
          onChange={(next) => accessPrefs.set({ legacyPlan: next })}
        />
      </Row>
      <Row
        title="Workspace"
        description="Where a thread in a repository works. Each thread's menu can pick another."
      >
        <Picker
          field
          label="Workspace"
          value={workspace.value}
          onChange={(value) => setNewThreadPrefs({ workspace: value as typeof prefs.workspace })}
          options={workspaces}
          align="end"
          className="w-56"
          panelClassName="w-[24rem]"
        />
      </Row>
      <Row
        title="Naming model"
        description="Names a new thread and its branch from its first message, after it starts."
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
    </Section>
  );
}

/**
 * Whether a host's runs wait out a usage limit and resume when it resets (`host/settings`, 0049),
 * and whether a plain thread's turn a plxd restart cut off continues once plxd is up (0060). Both
 * are off by default. A thread's own toggle, in its menu, overrides the first.
 */
function Resuming() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const supported = connection?.status === "connected" && "autoResume" in connection.capabilities;
  const [settings, setSettings] = useState<HostSettings>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSettings(undefined);
    setError(undefined);
    if (!supported) return;
    let stale = false;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (stale) return;
      if ("error" in answer) setError(answer.error.message);
      else setSettings(answer.result);
    });
    return () => {
      stale = true;
    };
  }, [hostId, supported]);
  const set = async (
    change: Pick<HostSettingsSetParams, "autoResume" | "continueAfterRestart">,
  ) => {
    const before = settings;
    setSettings((prev) => prev && { ...prev, ...change });
    const answer = await window.parallax.request(hostId, "host/settings/set", change);
    if ("error" in answer) {
      setSettings(before);
      setError(answer.error.message);
    } else {
      setSettings(answer.result);
      setError(undefined);
    }
  };

  return (
    <Section
      title="Resuming threads"
      action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
    >
      <Row
        title="Resume after a usage limit"
        description={
          error ??
          (connection?.status === "connected" && !supported
            ? "This host's plxd can't resume threads after a usage limit."
            : "A thread a usage limit stopped continues once the limit resets. Each thread's menu can override this. A Project's threads always do.")
        }
      >
        <Switch
          label="Resume after a usage limit"
          checked={settings?.autoResume ?? false}
          disabled={settings === undefined}
          onChange={(next) => void set({ autoResume: next })}
        />
      </Row>
      {settings?.continueAfterRestart !== undefined && (
        <Row
          title="Continue threads after restarts"
          description="A thread that was working when plxd restarted, as after an update, is told to continue where it left off. Either way, its queued messages wait for Resume."
        >
          <Switch
            label="Continue threads after restarts"
            checked={settings.continueAfterRestart}
            onChange={(next) => void set({ continueAfterRestart: next })}
          />
        </Row>
      )}
    </Section>
  );
}
