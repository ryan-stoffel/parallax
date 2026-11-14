import { t } from "i18next";
import { useEffect, useState } from "react";

import type { CommandStatus, OpenApp, TerminalApp } from "../../preload/bridge";
import { isLanguage, languages, matchLanguage } from "../../i18n";
import { localId } from "../hosts";
import { chooseLanguage, languageChoice } from "../language";
import { locale } from "../locale";
import { appIcon, OPEN_TARGET_KEY, TERMINAL_CHOSEN, terminalIcon } from "../OpenMenu";
import { behaviorPrefs, setBehaviorPrefs, type BehaviorPrefs } from "../prefs";
import { Picker } from "../ui";
import { updatePrefs, type UpdatePrefs } from "../updateEverything";
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
      ? t("Type parallax in a terminal to open Parallax there. Installed at {{path}}.", {
          path: status.path,
        })
      : t(
          "Installed at {{path}}, but its folder isn't on your PATH yet. Add it there, or sign out and back in, then open a new terminal.",
          { path: status.path },
        ),
    stale: t("The command at {{path}} is for another copy of Parallax.", { path: status.path }),
    missing: t("Type parallax in a terminal to open Parallax there."),
    other: t("Something else named parallax is at {{path}}, so Parallax leaves it alone.", {
      path: status.path,
    }),
  }[status.state];
  const action =
    status.state === "installed" ? "Remove" : status.state === "other" ? undefined : "Install";
  return (
    <Row title={t("Terminal command")} description={error ?? description}>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(action === "Install")}
          className={quietButton}
        >
          {status.state === "stale"
            ? t("Reinstall")
            : action === "Install"
              ? t("Install")
              : t("Remove")}
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
    <Section title={t("Updates")}>
      {window.parallax.updatable && (
        <Row
          title={t("Download updates automatically")}
          description={t(
            "Download a new Parallax release as soon as it's out, so updating only restarts the app.",
          )}
        >
          <Switch
            label={t("Download updates automatically")}
            checked={prefs.autoDownload}
            onChange={(autoDownload) => set({ autoDownload })}
          />
        </Row>
      )}
      <Row
        title={t("Check for provider updates")}
        description={t(
          "Check each computer's Claude Code and Codex for new releases every 30 minutes, and list them under Update.",
        )}
      >
        <Switch
          label={t("Check for provider updates")}
          checked={prefs.providers}
          onChange={(providers) => set({ providers })}
        />
      </Row>
      <Row
        title={t("Update providers automatically")}
        description={t(
          "Update Claude Code and Codex as soon as a new release is found. Running threads keep going.",
        )}
      >
        <Switch
          label={t("Update providers automatically")}
          checked={prefs.providers && prefs.autoProviders}
          disabled={!prefs.providers}
          onChange={(autoProviders) => set({ autoProviders })}
        />
      </Row>
    </Section>
  );
}

/**
 * The language the app shows (0105): the OS's, when Parallax has it, or one picked here. Picking
 * reloads the window into it.
 */
function Language() {
  const choice = languageChoice.use();
  const system = languages.find((language) => language.code === matchLanguage([locale()]));
  return (
    <Section title={t("Language")}>
      <Row
        title={t("Language")}
        description={t("The language Parallax shows its menus and text in.")}
      >
        <Picker
          field
          label={t("Language")}
          value={choice}
          onChange={(value) => chooseLanguage(isLanguage(value) ? value : "system")}
          options={[
            { value: "system", label: t("System"), hint: system?.name },
            ...languages.map((language, index) => ({
              value: language.code,
              label: language.name,
              divider: index === 0,
            })),
          ]}
          align="end"
          className="w-56"
        />
      </Row>
    </Section>
  );
}

/**
 * Settings > General: the language, where Open sends a folder, notifications, the clock and send key, and how the
 * app updates.
 */
export function GeneralSettings() {
  // Undefined until main answers, so the row doesn't flash "No apps found".
  const [targets, setTargets] = useState<OpenApp[]>();
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [terminal, setTerminal] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalApp[]>([]);
  useEffect(() => {
    void window.parallax
      .openTargets(localId)
      .then((found) => setTargets(found.filter((t) => t.target !== "terminal")));
    void window.parallax.terminalApps().then(setTerminals);
    void window.parallax.terminalApp().then(setTerminal);
  }, []);
  const chooseTerminal = async (path: string) => {
    const name = await window.parallax.selectTerminalApp(path);
    if (!name) return;
    setTerminal(name);
    window.dispatchEvent(new Event(TERMINAL_CHOSEN));
  };
  const current = targets?.find((t) => t.target === chosen) ?? targets?.[0];

  return (
    <>
      <PageTitle title={t("General")}>
        {t("How Parallax opens folders, tells you what happened, and keeps itself up to date.")}
      </PageTitle>
      <Language />
      <Section title={t("Open")}>
        <Row
          title={t("Open folders in")}
          description={t("What Open and its shortcut use, until you pick another from its menu.")}
        >
          {current ? (
            <Picker
              field
              label={t("Open folders in")}
              value={current.target}
              onChange={(value) => {
                localStorage.setItem(OPEN_TARGET_KEY, value);
                setChosen(value);
              }}
              options={(targets ?? []).map((t) => ({
                value: t.target,
                label: t.name,
                icon: appIcon(t),
              }))}
              align="end"
              className="w-56"
            />
          ) : (
            targets && <span className="text-body text-muted-foreground">{t("No apps found")}</span>
          )}
        </Row>
        <Row
          title={t("Terminal")}
          description={t("The terminal used to open folders on this computer.")}
        >
          <Picker
            field
            label={t("Terminal")}
            value={terminals.find((app) => app.name === terminal)?.path ?? "none"}
            onChange={(value) => void chooseTerminal(value)}
            options={
              terminals.length
                ? terminals.map((app) => ({
                    value: app.path,
                    label: app.name,
                    icon: terminalIcon(app),
                  }))
                : [{ value: "none", label: t("No terminals found"), icon: terminalIcon() }]
            }
            align="end"
            className="w-56"
          />
        </Row>
        <TerminalCommand />
      </Section>
      <Behavior />
      <Updates />
    </>
  );
}

/** Notifications, then the clock, what sends a prompt, and where pull requests open (`behaviorPrefs`). */
function Behavior() {
  const prefs = behaviorPrefs.use();
  const mac = window.parallax.platform === "darwin";
  return (
    <>
      <Section title={t("Notifications")}>
        <Row
          title={t("System notifications")}
          description={t(
            "An alert from your computer when a thread finishes, fails, or needs you while Parallax isn't in front.",
          )}
        >
          <Switch
            label={t("System notifications")}
            checked={prefs.systemNotifications}
            onChange={(systemNotifications) => setBehaviorPrefs({ systemNotifications })}
          />
        </Row>
        <Row
          title={t("In-app notifications")}
          description={t("A toast when a thread finishes, fails, or needs you.")}
        >
          <Switch
            label={t("In-app notifications")}
            checked={prefs.inAppNotifications}
            onChange={(inAppNotifications) => setBehaviorPrefs({ inAppNotifications })}
          />
        </Row>
      </Section>
      <Section title={t("Preferences")}>
        <Row
          title={t("Clean up dictation")}
          description={t(
            "A small model from your providers removes filler words, fixes punctuation, and restores code names. It receives the text and the names of files you mention, and your audio stays on this computer. Off, dictation goes in as transcribed.",
          )}
        >
          <Switch
            label={t("Clean up dictation")}
            checked={prefs.cleanDictation}
            onChange={(cleanDictation) => setBehaviorPrefs({ cleanDictation })}
          />
        </Row>
        <Row
          title={t("Time format")}
          description={t("System default follows your OS clock preference.")}
        >
          <Picker
            field
            label={t("Time format")}
            value={prefs.timeFormat}
            onChange={(v) => setBehaviorPrefs({ timeFormat: v as BehaviorPrefs["timeFormat"] })}
            options={[
              { value: "system", label: t("System default") },
              { value: "12", label: t("12-hour") },
              { value: "24", label: t("24-hour") },
            ]}
            className="w-48"
            panelClassName="min-w-48"
          />
        </Row>
        <Row
          title={t("Send shortcut")}
          description={
            prefs.sendKey === "enter"
              ? t("Enter sends. Shift+Enter starts a new line.")
              : t("{{keys}} sends. Enter starts a new line.", {
                  keys: mac ? "⌘ Enter" : "Ctrl+Enter",
                })
          }
        >
          <Picker
            field
            label={t("Send shortcut")}
            value={prefs.sendKey}
            onChange={(v) => setBehaviorPrefs({ sendKey: v as BehaviorPrefs["sendKey"] })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "modEnter", label: mac ? "⌘ Enter" : "Ctrl+Enter" },
            ]}
            className="w-48"
            panelClassName="min-w-48"
          />
        </Row>
      </Section>
    </>
  );
}
