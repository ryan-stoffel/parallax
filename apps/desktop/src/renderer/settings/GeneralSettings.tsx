import { Plus, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import type { OpenTarget } from "../../preload/bridge";
import type { AgentPermission } from "../../protocol/generated/protocol";
import { accessOptions } from "../Composer";
import { useConnection } from "../ConnectionStatus";
import { EffortMenu } from "../EffortMenu";
import { localId, useHosts } from "../hosts";
import { ModelMenu } from "../ModelMenu";
import { useCatalog, type Provider } from "../models";
import { nameOf, OPEN_TARGET_KEY, TERMINAL_CHOSEN, targetIcon } from "../OpenMenu";
import {
  behaviorPrefs,
  newThreadPrefs,
  setBehaviorPrefs,
  setNewThreadPrefs,
  type BehaviorPrefs,
} from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { accessPrefs } from "../accessPrefs";
import { archivePageSize, sidebarPrefs, type SidebarPrefs } from "../sidebarPrefs";
import { Picker } from "../ui";
import { notices } from "./licenses";
import { HostPicker, PageTitle, quietButton, Row, Section, Switch } from "./parts";

const selectClass = "rounded-md border border-border bg-background px-2 py-1 text-[13px]";
/** The composer's own pickers are borderless; on a settings row they get the select's outline. */
const pickerBox = "rounded-md border border-border bg-background";

/**
 * Settings > General: what new threads start with, the sidebar's organization, where Open sends a
 * folder, how the app behaves, usage limits on a host, and the app's version and bundled-font
 * notices.
 */
export function GeneralSettings() {
  const [showNotices, setShowNotices] = useState(false);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [terminal, setTerminal] = useState<string | null>(null);
  const [icons, setIcons] = useState<Partial<Record<OpenTarget, string>>>({});
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    void window.parallax.openTargets(localId).then(setTargets);
    void window.parallax.terminalApp().then(setTerminal);
    void window.parallax.openTargetIcons().then(setIcons);
    void window.parallax.version().then(setVersion);
  }, []);
  const chooseTerminal = async () => {
    const name = await window.parallax.chooseTerminalApp();
    if (!name) return;
    setTerminal(name);
    setIcons(await window.parallax.openTargetIcons());
    setTargets(await window.parallax.openTargets(localId));
    window.dispatchEvent(new Event(TERMINAL_CHOSEN));
  };
  const current = targets.find((t) => t === chosen) ?? targets[0];
  const sidebar = sidebarPrefs.use();
  const setSidebar = (patch: Partial<SidebarPrefs>) =>
    sidebarPrefs.set({ ...sidebarPrefs.get(), ...patch });

  return (
    <>
      <PageTitle title="General" />
      <NewThreads />
      <Section title="Organization">
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
      <Section title="Access">
        <Row
          title="Legacy Plan mode"
          description="List Plan in the Access picker. A thread already in Plan keeps it either way."
        >
          <Switch
            label="Legacy Plan mode"
            checked={accessPrefs.use().legacyPlan}
            onChange={(legacyPlan) => accessPrefs.set({ legacyPlan })}
          />
        </Row>
      </Section>
      <Section title="Open">
        <Row
          title="Open folders in"
          description="What Open and its shortcut use, until you pick another from its menu."
        >
          {current ? (
            <span className={pickerBox}>
              <Picker
                label="Open folders in"
                value={current}
                onChange={(value) => {
                  localStorage.setItem(OPEN_TARGET_KEY, value);
                  setChosen(value);
                }}
                options={targets.map((t) => ({
                  value: t,
                  label: nameOf(t, terminal),
                  icon: targetIcon(t, icons),
                }))}
                align="end"
              />
            </span>
          ) : (
            <span className="text-[13px] text-muted-foreground">No apps found</span>
          )}
        </Row>
        <Row title="Terminal" description="The terminal Open lists for this computer's threads.">
          <span className={pickerBox}>
            <Picker
              label="Terminal"
              value={terminal ? "terminal" : "none"}
              onChange={(value) => {
                if (value === "choose") void chooseTerminal();
              }}
              options={[
                terminal
                  ? { value: "terminal", label: terminal, icon: targetIcon("terminal", icons) }
                  : { value: "none", label: "None", icon: <SquareTerminal /> },
                {
                  value: "choose",
                  label: terminal ? "Choose another app…" : "Choose an app…",
                  icon: <Plus />,
                  divider: true,
                },
              ]}
              align="end"
            />
          </span>
        </Row>
      </Section>
      <Behavior />
      <UsageLimits />
      <Section title="About">
        <Row title="Version">
          <span className="font-mono text-[12px] text-muted-foreground">{version ?? "…"}</span>
        </Row>
        <Row
          title="Open source licenses"
          description="Notices for the fonts bundled with Parallax."
        >
          <button
            type="button"
            aria-expanded={showNotices}
            onClick={() => setShowNotices(!showNotices)}
            className={quietButton}
          >
            {showNotices ? "Hide licenses" : "View licenses"}
          </button>
        </Row>
        {showNotices &&
          notices.map((n) => (
            <details key={n.name} className="border-t border-border px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium">
                {n.name}{" "}
                <span className="font-mono text-[12px] font-normal text-muted-foreground">
                  {n.license}
                </span>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
                {n.text}
              </pre>
            </details>
          ))}
      </Section>
    </>
  );
}

/**
 * What a new thread starts with, picked with the composer's own menus (`newThreadPrefs`). The
 * model list is this computer's; a thread on a host that lacks the model starts on that host's
 * first.
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
          <span className={pickerBox}>
            <Picker
              label="Permissions"
              value={permission}
              onChange={(value) => setNewThreadPrefs({ permission: value as AgentPermission })}
              options={permissions.map((p) => accessOptions[p])}
              align="end"
              panelClassName="w-[25rem]"
            />
          </span>
        </Row>
      )}
      <Row
        title="Workspace"
        description="Where a thread in a repository works. Each thread's menu can pick another."
      >
        <span className={pickerBox}>
          <Picker
            label="Workspace"
            value={workspace.value}
            onChange={(value) => setNewThreadPrefs({ workspace: value as typeof prefs.workspace })}
            options={workspaces}
            align="end"
            panelClassName="w-[24rem]"
          />
        </span>
      </Row>
    </Section>
  );
}

/** Notifications, the clock, and what sends a prompt (`behaviorPrefs`). */
function Behavior() {
  const prefs = behaviorPrefs.use();
  const set = (patch: Partial<BehaviorPrefs>) => setBehaviorPrefs(patch);
  const mac = window.parallax.platform === "darwin";
  return (
    <Section title="Behavior">
      <Row
        title="System notifications"
        description="An alert from your computer when a thread finishes, fails, or needs you while Parallax isn't in front."
      >
        <Switch
          label="System notifications"
          checked={prefs.systemNotifications}
          onChange={(systemNotifications) => set({ systemNotifications })}
        />
      </Row>
      <Row
        title="In-app notifications"
        description="A toast when a thread finishes, fails, or needs you."
      >
        <Switch
          label="In-app notifications"
          checked={prefs.inAppNotifications}
          onChange={(inAppNotifications) => set({ inAppNotifications })}
        />
      </Row>
      <Row title="Time format" description="System default follows your OS clock preference.">
        <select
          aria-label="Time format"
          value={prefs.timeFormat}
          onChange={(e) => set({ timeFormat: e.target.value as BehaviorPrefs["timeFormat"] })}
          className={selectClass}
        >
          <option value="system">System default</option>
          <option value="12">12-hour</option>
          <option value="24">24-hour</option>
        </select>
      </Row>
      <Row
        title="Send shortcut"
        description={
          prefs.sendKey === "enter"
            ? "Enter sends. Shift+Enter starts a new line."
            : `${mac ? "⌘ Enter" : "Ctrl+Enter"} sends. Enter starts a new line.`
        }
      >
        <select
          aria-label="Send shortcut"
          value={prefs.sendKey}
          onChange={(e) => set({ sendKey: e.target.value as BehaviorPrefs["sendKey"] })}
          className={selectClass}
        >
          <option value="enter">Enter</option>
          <option value="modEnter">{mac ? "⌘ Enter" : "Ctrl+Enter"}</option>
        </select>
      </Row>
    </Section>
  );
}

/**
 * Whether a host's runs wait out a usage limit and resume when it resets (`host/settings`, 0049).
 * A thread's own toggle, in its menu, overrides it.
 */
function UsageLimits() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const supported = connection?.status === "connected" && "autoResume" in connection.capabilities;
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setOn(undefined);
    setError(undefined);
    if (!supported) return;
    let stale = false;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (stale) return;
      if ("error" in answer) setError(answer.error.message);
      else setOn(answer.result.autoResume);
    });
    return () => {
      stale = true;
    };
  }, [hostId, supported]);
  const set = async (autoResume: boolean) => {
    setOn(autoResume);
    const answer = await window.parallax.request(hostId, "host/settings/set", { autoResume });
    if ("error" in answer) {
      setOn(!autoResume);
      setError(answer.error.message);
    } else {
      setOn(answer.result.autoResume);
      setError(undefined);
    }
  };

  return (
    <Section
      title="Usage limits"
      action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
    >
      <Row
        title="Resume after a usage limit"
        description={
          error ??
          (connection?.status === "connected" && !supported
            ? "This host's plxd can't resume threads after a usage limit."
            : "A thread a usage limit stopped continues once the limit resets. Each thread's menu can override this.")
        }
      >
        <Switch
          label="Resume after a usage limit"
          checked={on ?? false}
          disabled={on === undefined}
          onChange={(next) => void set(next)}
        />
      </Row>
    </Section>
  );
}
