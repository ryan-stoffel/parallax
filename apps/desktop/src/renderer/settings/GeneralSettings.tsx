import { useEffect, useState } from "react";

import type { CommandStatus, OpenTarget, TerminalApp } from "../../preload/bridge";
import { localId } from "../hosts";
import { nameOf, OPEN_TARGET_KEY, TERMINAL_CHOSEN, targetIcon, terminalIcon } from "../OpenMenu";
import { behaviorPrefs, setBehaviorPrefs, type BehaviorPrefs } from "../prefs";
import { Picker } from "../ui";
import { updatePrefs, type UpdatePrefs } from "../updateEverything";
import { notices } from "./licenses";
import { PageTitle, quietButton, Row, Section, Switch } from "./parts";

/**
 * The `parallax` command that opens Parallax in a terminal (PLX-750): installs, reinstalls, or
 * removes it. Hidden where this app can't offer it: a dev build, or one run from its disk image.
 */
function TerminalCommand() {
  const [status, setStatus] = useState<CommandStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.parallax.command().then(setStatus);
  }, []);
  if (!status || status.state === "unavailable") return null;
  const act = async (install: boolean) => {
    setBusy(true);
    const failed = await (install
      ? window.parallax.installCommand()
      : window.parallax.removeCommand());
    setError(failed === "Cancelled." ? null : failed);
    setStatus(await window.parallax.command());
    setBusy(false);
  };
  const description = {
    installed: status.onPath
      ? `Type parallax in a terminal to open Parallax there. Installed at ${status.path}.`
      : `Installed at ${status.path}, but its folder isn't on your PATH yet. Add it there, or sign out and back in, then open a new terminal.`,
    stale: `The command at ${status.path} is for another copy of Parallax.`,
    missing: "Type parallax in a terminal to open Parallax there.",
    other: `Something else named parallax is at ${status.path}, so Parallax leaves it alone.`,
  }[status.state];
  const action =
    status.state === "installed" ? "Remove" : status.state === "other" ? undefined : "Install";
  return (
    <Row title="Terminal command" description={error ?? description}>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(action === "Install")}
          className={quietButton}
        >
          {status.state === "stale" ? "Reinstall" : action}
        </button>
      )}
    </Row>
  );
}

/**
 * How the sidebar's Update button behaves (PLX-783): whether a Parallax release downloads as soon
 * as it's found, and whether each host's Claude Code and Codex are checked, and updated on their
 * own. Downloading needs an app that updates itself.
 */
function Updates() {
  const prefs = updatePrefs.use();
  const set = (change: Partial<UpdatePrefs>) => updatePrefs.set({ ...prefs, ...change });
  return (
    <Section title="Updates">
      {window.parallax.updatable && (
        <Row
          title="Download updates automatically"
          description="Download a new Parallax release as soon as it's out, so updating only restarts the app."
        >
          <Switch
            label="Download updates automatically"
            checked={prefs.autoDownload}
            onChange={(autoDownload) => set({ autoDownload })}
          />
        </Row>
      )}
      <Row
        title="Check for provider updates"
        description="Check each computer's Claude Code and Codex for new releases every 30 minutes, and list them under Update."
      >
        <Switch
          label="Check for provider updates"
          checked={prefs.providers}
          onChange={(providers) => set({ providers })}
        />
      </Row>
      <Row
        title="Update providers automatically"
        description="Update Claude Code and Codex as soon as a new release is found. Running threads keep going."
      >
        <Switch
          label="Update providers automatically"
          checked={prefs.providers && prefs.autoProviders}
          disabled={!prefs.providers}
          onChange={(autoProviders) => set({ autoProviders })}
        />
      </Row>
    </Section>
  );
}

/**
 * Settings > General: where Open sends a folder, notifications, the clock and send key, how the
 * app updates, and its version and bundled-font notices.
 */
export function GeneralSettings() {
  const [showNotices, setShowNotices] = useState(false);
  // Undefined until main answers, so the row doesn't flash "No apps found".
  const [targets, setTargets] = useState<OpenTarget[]>();
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [terminal, setTerminal] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalApp[]>([]);
  const [icons, setIcons] = useState<Partial<Record<OpenTarget, string>>>({});
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    void window.parallax
      .openTargets(localId)
      .then((found) => setTargets(found.filter((t) => t !== "terminal")));
    void window.parallax.terminalApps().then(setTerminals);
    void window.parallax.terminalApp().then(setTerminal);
    void window.parallax.openTargetIcons().then(setIcons);
    void window.parallax.version().then(setVersion);
  }, []);
  const chooseTerminal = async (path: string) => {
    const name = await window.parallax.selectTerminalApp(path);
    if (!name) return;
    setTerminal(name);
    setIcons(await window.parallax.openTargetIcons());
    setTargets((await window.parallax.openTargets(localId)).filter((t) => t !== "terminal"));
    window.dispatchEvent(new Event(TERMINAL_CHOSEN));
  };
  const current = targets?.find((t) => t === chosen) ?? targets?.[0];

  return (
    <>
      <PageTitle title="General">
        How Parallax opens folders, tells you what happened, and keeps itself up to date.
      </PageTitle>
      <Section title="Open">
        <Row
          title="Open folders in"
          description="What Open and its shortcut use, until you pick another from its menu."
        >
          {current ? (
            <Picker
              field
              label="Open folders in"
              value={current}
              onChange={(value) => {
                localStorage.setItem(OPEN_TARGET_KEY, value);
                setChosen(value);
              }}
              options={(targets ?? []).map((t) => ({
                value: t,
                label: nameOf(t, terminal),
                icon: targetIcon(t, icons),
              }))}
              align="end"
              className="w-56"
            />
          ) : (
            targets && <span className="text-[13px] text-muted-foreground">No apps found</span>
          )}
        </Row>
        <Row title="Terminal" description="The terminal used to open folders on this computer.">
          <Picker
            field
            label="Terminal"
            value={terminals.find((app) => app.name === terminal)?.path ?? "none"}
            onChange={(value) => void chooseTerminal(value)}
            options={
              terminals.length
                ? terminals.map((app) => ({
                    value: app.path,
                    label: app.name,
                    icon: terminalIcon(
                      app.name,
                      app.name === terminal ? icons.terminal : undefined,
                    ),
                  }))
                : [{ value: "none", label: "No terminals found", icon: terminalIcon(null) }]
            }
            align="end"
            className="w-56"
          />
        </Row>
        <TerminalCommand />
      </Section>
      <Behavior />
      <Updates />
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

/** Notifications, then the clock, what sends a prompt, and where pull requests open (`behaviorPrefs`). */
function Behavior() {
  const prefs = behaviorPrefs.use();
  const set = (patch: Partial<BehaviorPrefs>) => setBehaviorPrefs(patch);
  const mac = window.parallax.platform === "darwin";
  return (
    <>
      <Section title="Notifications">
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
      </Section>
      <Section title="Preferences">
        <Row title="Time format" description="System default follows your OS clock preference.">
          <Picker
            field
            label="Time format"
            value={prefs.timeFormat}
            onChange={(v) => set({ timeFormat: v as BehaviorPrefs["timeFormat"] })}
            options={[
              { value: "system", label: "System default" },
              { value: "12", label: "12-hour" },
              { value: "24", label: "24-hour" },
            ]}
            className="w-48"
            panelClassName="min-w-48"
          />
        </Row>
        <Row
          title="Send shortcut"
          description={
            prefs.sendKey === "enter"
              ? "Enter sends. Shift+Enter starts a new line."
              : `${mac ? "⌘ Enter" : "Ctrl+Enter"} sends. Enter starts a new line.`
          }
        >
          <Picker
            field
            label="Send shortcut"
            value={prefs.sendKey}
            onChange={(v) => set({ sendKey: v as BehaviorPrefs["sendKey"] })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "modEnter", label: mac ? "⌘ Enter" : "Ctrl+Enter" },
            ]}
            className="w-48"
            panelClassName="min-w-48"
          />
        </Row>
        <Row
          title="Open pull requests in"
          description="Where Open on GitHub goes: your system browser, or the Browser in the side panel."
        >
          <Picker
            field
            label="Open pull requests in"
            value={prefs.openPrsIn}
            onChange={(v) => set({ openPrsIn: v as BehaviorPrefs["openPrsIn"] })}
            options={[
              { value: "external", label: "System browser" },
              { value: "browser", label: "Side panel browser" },
            ]}
            className="w-48"
            panelClassName="min-w-48"
          />
        </Row>
      </Section>
    </>
  );
}
