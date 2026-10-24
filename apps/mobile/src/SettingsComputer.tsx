// A computer's settings, a page per section of the desktop's Settings, in its words: Accounts,
// Threads, Schedules, Source control, Computer use, Scripts, Connections, and Storage
// (SettingsProviders.tsx has Providers). Each reads and changes that computer's plxd, and a
// picker at the top moves the page to another computer.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { ArrowUpRight, Copy, Download, KeyRound, Plus, RefreshCw, ShieldCheck } from "lucide-react-native";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Alert, Linking, Switch, View } from "react-native";

import type {
  AccountsDefaultsGetResult,
  ComputerStatus,
  GithubStatus,
  ImportableSession,
  KeyAccount,
  Provider,
  RemotePairResult,
  RemoteSessionsResult,
  RepoScript,
  Role,
  ScheduledTask,
} from "../../desktop/src/protocol/generated/protocol";
import { describeError } from "../../desktop/src/renderer/errors";
import {
  accountOptions,
  accountsError,
  githubLine,
  importAccount,
  nextLabel,
  providerNames,
  scheduleLabel,
  scriptRoles,
  type AccountOption,
} from "../../desktop/src/renderer/settings/shared";
import { isRepository } from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { Choices } from "./Choices";
import { useComputer, type Computer } from "./fleet";
import { ago, type Screens } from "./nav";
import { choiceKey, pages, type SettingsPage } from "./settingsLogic";
import { ProvidersPage } from "./SettingsProviders";
import { Block, can, ComputerPicker, fail, Field, Note, Page, SwitchRow, useHostSettings } from "./SettingsParts";
import { Button, Dot, GitHubLogo, Row, Section, T, useColors } from "./ui";
import { font } from "./theme";

/** A setting row's action on its right, in the accent color. */
function Action({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <T
      accessibilityRole="button"
      onPress={disabled ? undefined : onPress}
      style={{ color: disabled ? c.faintForeground : c.accent }}
    >
      {label}
    </T>
  );
}

/** Asks for one line of text, resolving to it, or undefined when cancelled. */
const ask = (title: string, message?: string, secure = false) =>
  new Promise<string | undefined>((done) =>
    Alert.prompt(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => done(undefined) },
        { text: "OK", onPress: (text?: string) => done(text ?? "") },
      ],
      secure ? "secure-text" : "plain-text",
    ),
  );

/** Asks before something that can't be undone, then does it. */
const confirm = (title: string, message: string, action: string, run: () => void) =>
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: run },
  ]);

/**
 * Accounts: the host's default account for threads and for a Project's coordinator, as New
 * thread sets them, and its API keys, kept in its keychain.
 */
function AccountsPage({ m }: { m: Computer }) {
  const c = useColors();
  const id = m.machine.id;
  const [defaults, setDefaults] = useState<AccountsDefaultsGetResult>();
  const [options, setOptions] = useState<AccountOption[]>();
  const [keys, setKeys] = useState<KeyAccount[]>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState<Role>();

  const load = useCallback(async () => {
    const [got, offered, listed] = await Promise.all([
      window.parallax.request(id, "accounts/defaults/get", {}),
      accountOptions(id),
      window.parallax.request(id, "accounts/keys/list", {}),
    ]);
    if ("result" in got) setDefaults(got.result);
    if (typeof offered !== "string") setOptions(offered);
    if ("result" in listed) setKeys(listed.result.accounts);
    setError(
      "error" in got ? accountsError(got.error) : typeof offered === "string" ? offered : "error" in listed ? accountsError(listed.error) : undefined,
    );
  }, [id]);
  // Again once the computer connects, as the desktop reloads a host's settings.
  useEffect(() => {
    if (m.connected) void load();
  }, [load, m.connected]);

  const choose = async (role: Role, key: string) => {
    const option = options?.find((o) => choiceKey(o.account) === key);
    const answer = await window.parallax.request(id, "accounts/defaults/set", {
      role,
      ...(option && { account: option.account }),
    });
    if ("error" in answer) fail("Couldn't change the default account", accountsError(answer.error));
    else setDefaults(answer.result);
  };
  const labelOf = (role: Role) => {
    const chosen = defaults?.[role];
    if (!chosen) return "None";
    return options?.find((o) => choiceKey(o.account) === choiceKey(chosen))?.label ?? "Not on this host anymore";
  };
  const addKey = async (provider: Provider) => {
    const label = await ask(`Add ${providerNames[provider]} API key`, "Label, such as Work");
    if (!label?.trim()) return;
    const key = await ask(label.trim(), "API key. Kept in the host's keychain. Parallax never shows it again.", true);
    if (key === undefined) return;
    if (key.length < 20) return fail("Couldn't add the API key", "An API key is at least 20 characters.");
    const answer = await window.parallax.request(id, "accounts/keys/add", {
      id: uuidv7(),
      provider,
      label: label.trim().slice(0, 64),
      key,
    });
    if ("error" in answer) fail("Couldn't add the API key", accountsError(answer.error));
    else void load();
  };
  const removeKey = (account: KeyAccount) =>
    confirm(`Remove ${account.label}?`, "Remove this key? Parallax deletes it from the host's keychain.", "Remove", async () => {
      const answer = await window.parallax.request(id, "accounts/keys/remove", { id: account.id });
      // Already gone, such as removed by another client: that's what Remove wanted.
      if ("error" in answer && answer.error.data?.kind !== "accountNotFound")
        fail(`Couldn't remove ${account.label}`, accountsError(answer.error));
      else void load();
    });
  const roles: [Role, string, string][] = [
    ["worker", "Threads", "New threads run on it unless they pick another."],
    ["coordinator", "Projects", "A Project's coordinator runs on it."],
  ];

  return (
    <>
      {error && (
        <Section>
          <Note alert>{error}</Note>
        </Section>
      )}
      <Section title="Default accounts" footer="Accounts are the host's Claude Code sign-in and its Anthropic API keys.">
        {roles.map(([role, title, detail], i) => (
          <Row
            key={role}
            title={title}
            detail={detail}
            last={i === roles.length - 1}
            right={<T muted>{defaults ? labelOf(role) : "…"}</T>}
            chevron
            onPress={options ? () => setPicking(role) : undefined}
          />
        ))}
      </Section>
      {(["anthropic", "openai"] as const).map((provider) => (
        <Section key={provider} title={`${providerNames[provider]} API keys`}>
          {keys
            ?.filter((k) => k.provider === provider)
            .map((account) => (
              <Row
                key={account.id}
                icon={KeyRound}
                title={account.label}
                detail={`${providerNames[account.provider] ?? account.provider} API key · ${account.maskedKey}`}
                onPress={() => removeKey(account)}
              />
            ))}
          <Row icon={Plus} iconColor={c.accent} title="Add API key" last onPress={() => void addKey(provider)} />
        </Section>
      ))}
      <Choices
        title={picking === "coordinator" ? "Projects" : "Threads"}
        open={!!picking}
        value={choiceKey(picking && defaults?.[picking])}
        options={[
          { value: "", label: "None", description: "Each new thread asks." },
          ...(options ?? []).map((o) => ({ value: choiceKey(o.account), label: o.label })),
        ]}
        onChoose={(key) => picking && void choose(picking, key)}
        onClose={() => setPicking(undefined)}
      />
    </>
  );
}

/**
 * Threads: whether the host's runs wait out a usage limit and resume, and continue after a plxd
 * restart (0049, 0060), and importing past sessions from its desktop apps (PLX-881).
 */
function ThreadsPage({ m }: { m: Computer }) {
  const { settings, error, set } = useHostSettings(m);
  const supported = can(m, "autoResume");
  return (
    <>
      <Section title="Resuming threads">
        <SwitchRow
          title="Resume after a usage limit"
          detail={
            error ??
            (!supported
              ? "This host's plxd can't resume threads after a usage limit."
              : "A thread a usage limit stopped continues once the limit resets. Each thread's menu can override this. A Project's threads always do.")
          }
          value={settings?.autoResume ?? false}
          disabled={!supported || !settings}
          onChange={(autoResume) => void set({ autoResume }, `Couldn't turn resuming ${autoResume ? "on" : "off"}`)}
          last={settings?.continueAfterRestart === undefined}
        />
        {settings?.continueAfterRestart !== undefined && (
          <SwitchRow
            title="Continue threads after restarts"
            detail="A thread that was working when plxd restarted, as after an update, is told to continue where it left off. Either way, its queued messages wait for Resume."
            value={settings.continueAfterRestart}
            onChange={(continueAfterRestart) =>
              void set({ continueAfterRestart }, `Couldn't turn continuing ${continueAfterRestart ? "on" : "off"}`)
            }
            last
          />
        )}
      </Section>
      <ImportSessions m={m} />
    </>
  );
}

const appNames: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

/** The host's past sessions from the Claude, Codex, and Cursor desktop apps, each to import. */
function ImportSessions({ m }: { m: Computer }) {
  const id = m.machine.id;
  const [sessions, setSessions] = useState<ImportableSession[]>();
  const [error, setError] = useState<string>();
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState<string>();
  if (!can(m, "threadImport")) return null;
  const look = async () => {
    setLooking(true);
    const answer = await window.parallax.request(id, "thread/importable", {});
    setLooking(false);
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setSessions(answer.result.sessions);
      setError(undefined);
    }
  };
  const take = async (s: ImportableSession) => {
    setBusy(s.id);
    const providers = await window.parallax.request(id, "providers/list", { refresh: false });
    const account = importAccount(s.source, "result" in providers ? providers.result.providers : undefined);
    const answer = await window.parallax.request(id, "thread/import", { source: s.source, id: s.id, ...(account && { account }) });
    setBusy(undefined);
    if ("error" in answer) fail(`Couldn't import ${s.title}`, answer.error);
    else void look();
  };
  return (
    <Section title="Import">
      <Row
        icon={Download}
        title={looking ? "Looking for sessions in Claude, Codex, and Cursor…" : "Import sessions"}
        detail="Bring past sessions from the Claude, Codex, and Cursor desktop apps into Archived as threads on this computer."
        last={!sessions && !error}
        onPress={looking ? undefined : () => void look()}
      />
      {error && <Note alert>{error}</Note>}
      {sessions?.length === 0 && <Note>No sessions from the Claude, Codex, or Cursor desktop apps on this computer.</Note>}
      {sessions?.map((s, i) => (
        <Row
          key={`${s.source}:${s.id}`}
          title={s.title}
          detail={[appNames[s.source] ?? s.source, s.cwd?.split(/[\\/]/).filter(Boolean).pop(), ago(s.updatedAt)].filter(Boolean).join(" · ")}
          last={i === sessions.length - 1}
          right={
            s.thread ? <T muted>Imported</T> : <Action label={busy === s.id ? "Importing…" : "Import"} disabled={!!busy} onPress={() => void take(s)} />
          }
        />
      ))}
    </Section>
  );
}

/** Schedules: the host's scheduled tasks (0063), each to pause, run now, or delete. */
function SchedulesPage({ m }: { m: Computer }) {
  const id = m.machine.id;
  const [tasks, setTasks] = useState<ScheduledTask[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const supported = can(m, "schedules");
  const load = useCallback(async () => {
    const answer = await window.parallax.request(id, "schedule/list", {});
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setTasks(answer.result.tasks);
      setError(undefined);
    }
  }, [id]);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);

  const act = async (task: ScheduledTask, action: "pause" | "run" | "delete") => {
    setBusy(task.id);
    const answer =
      action === "run"
        ? await window.parallax.request(id, "schedule/run", { id: task.id })
        : action === "delete"
          ? await window.parallax.request(id, "schedule/delete", { id: task.id })
          : await window.parallax.request(id, "schedule/save", {
              id: task.id,
              title: task.title,
              prompt: task.prompt,
              enabled: !task.enabled,
              schedule: task.schedule,
              thread: task.thread,
              project: task.project,
              repo: task.repo,
              account: task.account,
              model: task.model,
              effort: task.effort,
              permission: task.permission,
            });
    setBusy(undefined);
    if ("error" in answer) {
      const verb = action === "pause" ? (task.enabled ? "pause" : "resume") : action;
      fail(`Couldn't ${verb} ${task.title}`, answer.error);
    }
    void load();
  };
  const menu = (task: ScheduledTask) =>
    Alert.alert(task.title, task.prompt, [
      ...(task.schedule.type !== "webhook" ? [{ text: "Run now", onPress: () => void act(task, "run") }] : []),
      { text: "Delete", style: "destructive" as const, onPress: () => void act(task, "delete") },
      { text: "Cancel", style: "cancel" as const },
    ]);

  const empty = !supported
    ? "This host's plxd can't schedule tasks."
    : error && !tasks
      ? error
      : tasks === undefined
        ? "Loading…"
        : tasks.length === 0
          ? "No scheduled tasks. Ask an agent to schedule one."
          : undefined;
  return (
    <Section title="Scheduled tasks" footer="Prompts that run on a timer or a webhook, in their thread or a new one.">
      {empty ? (
        <Note alert={empty === error}>{empty}</Note>
      ) : (
        tasks!.map((task, i) => {
          const when = !task.enabled
            ? "Paused"
            : task.schedule.type === "webhook"
              ? "Listening"
              : task.nextRunAt
                ? `Next run ${nextLabel(task.nextRunAt)}`
                : "Not scheduled";
          const last =
            task.lastRunStatus === "never"
              ? ""
              : ` · Last run ${task.lastRunStatus}${task.lastRunError ? `: ${task.lastRunError}` : ""}`;
          const prompt = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
          return (
            <Row
              key={task.id}
              title={task.title}
              detail={[prompt, `${scheduleLabel(task.schedule)} · ${when}${last}`, task.webhook?.url ?? task.webhook?.path]
                .filter(Boolean)
                .join("\n")}
              last={i === tasks!.length - 1}
              onPress={busy === task.id ? undefined : () => menu(task)}
              right={
                <Switch
                  accessibilityLabel={`Enable ${task.title}`}
                  value={task.enabled}
                  disabled={busy === task.id}
                  onValueChange={() => void act(task, "pause")}
                />
              }
            />
          );
        })
      )}
      {error && tasks && <Note alert>{error}</Note>}
    </Section>
  );
}

/**
 * Source control: GitHub through the `gh` CLI plxd runs on the host. On a plxd with
 * `githubSetup` (PLX-423), it installs `gh` and signs it in with a one-time code.
 */
function SourceControlPage({ m }: { m: Computer }) {
  const c = useColors();
  const id = m.machine.id;
  const supported = can(m, "githubStatus");
  const setup = can(m, "githubSetup");
  const [status, setStatus] = useState<GithubStatus>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const load = useCallback(async () => {
    const answer = await window.parallax.request(id, "github/status", {});
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setStatus(answer.result);
      setError(undefined);
    }
  }, [id]);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);
  // The row moves on by itself once the install ends or the browser approves the code.
  const waiting = !!status?.installing || !!status?.signingIn;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const install = async () => {
    const answer = await window.parallax.request(id, "github/install", {});
    if ("error" in answer) fail("Couldn't install the GitHub CLI", answer.error);
    else setStatus(answer.result);
  };
  const signIn = async () => {
    setStarting(true);
    const answer = await window.parallax.request(id, "github/signIn", {});
    setStarting(false);
    if ("error" in answer) return fail("Couldn't sign in to GitHub", answer.error);
    setStatus((s) => s && { ...s, signingIn: answer.result, setupNote: undefined });
    void Linking.openURL(answer.result.url);
  };
  const cancel = async () => {
    const answer = await window.parallax.request(id, "github/signInCancel", {});
    if ("error" in answer) fail("Couldn't cancel the GitHub sign-in", answer.error);
    await load();
  };

  const line = !supported
    ? { detail: "Update plxd on this host to see GitHub here.", tone: "warn" as const }
    : error
      ? { detail: error, tone: "warn" as const }
      : !status
        ? { detail: "Checking…", tone: "warn" as const }
        : githubLine(status, setup);
  const tones = { on: c.added, off: c.faintForeground, warn: c.warning };
  const pending = setup ? status?.signingIn : undefined;
  const note = setup ? status?.setupNote : undefined;
  const action =
    !status || error || !setup
      ? undefined
      : status.installing
        ? undefined
        : !status.installed
          ? { label: "Install", run: install }
          : status.signingIn
            ? { label: "Cancel", run: cancel }
            : status.signedIn === false
              ? { label: starting ? "Starting…" : "Sign in", run: signIn }
              : undefined;

  return (
    <Section title="Hosting" footer="Parallax opens and follows pull requests with the GitHub CLI on each host.">
      <Block>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 2 }}>
            <GitHubLogo size={20} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T medium>
              GitHub
              {status?.version && (
                <T faint style={{ fontSize: 13 }}>
                  {`  gh ${status.version}${status.managed ? " · installed by Parallax" : ""}`}
                </T>
              )}
            </T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Dot color={tones[line.tone]} />
              <T muted alert={!!error} style={{ fontSize: 13, lineHeight: 18, flex: 1 }}>
                {line.detail}
              </T>
            </View>
            {note && (
              <T alert style={{ fontSize: 13, lineHeight: 18, color: c.warning }}>
                {note}
              </T>
            )}
          </View>
          {action && <Action label={action.label} disabled={starting} onPress={() => void action.run()} />}
          {!setup && status && !status.installed && (
            <Action label="Install" onPress={() => void Linking.openURL("https://cli.github.com")} />
          )}
        </View>
      </Block>
      {pending && (
        <>
          <Block>
            <T muted style={{ fontSize: 13, lineHeight: 18 }}>
              {`Enter this code at ${pending.url.replace(/^https:\/\//, "")}. It expires at ${new Date(pending.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
            </T>
            <T
              accessibilityLabel="One-time code"
              selectable
              style={{ fontFamily: font.monoBold, fontSize: 24, lineHeight: 32, letterSpacing: 3, marginTop: 4 }}
            >
              {pending.code}
            </T>
          </Block>
          <Row icon={Copy} title="Copy" onPress={() => void Clipboard.setStringAsync(pending.code)} />
          <Row icon={ArrowUpRight} title="Open GitHub" onPress={() => void Linking.openURL(pending.url)} />
        </>
      )}
      <Row icon={RefreshCw} title="Refresh" last onPress={supported ? () => void load() : undefined} />
    </Section>
  );
}

/**
 * Computer use (PLX-897): whether plxd on a Mac has Accessibility and Screen Recording, Grant
 * access, which asks macOS there, and the apps every thread may use without asking.
 */
function ComputerUsePage({ m }: { m: Computer }) {
  const c = useColors();
  const id = m.machine.id;
  const supported = can(m, "computerUse");
  const [status, setStatus] = useState<ComputerStatus>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const load = useCallback(
    async (request = false) => {
      const answer = await window.parallax.request(id, "computer/status", { request });
      if ("error" in answer) setError(describeError(answer.error));
      else {
        setStatus(answer.result);
        setError(undefined);
      }
    },
    [id],
  );
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);
  // Turned on in System Settings, a permission shows here without a refresh.
  const missing = !!status && !(status.accessibility && status.screenRecording);
  useEffect(() => {
    if (!missing) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [missing, load]);

  if (!supported)
    return (
      <Section>
        <Note>Computer use needs plxd on macOS. Update Parallax, or use a Mac, to turn it on.</Note>
      </Section>
    );
  const permission = (title: string, detail: string, granted?: boolean, last = false) => (
    <Row
      title={title}
      detail={detail}
      last={last}
      right={
        granted === undefined ? (
          <T muted>Checking…</T>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot color={granted ? c.added : c.faintForeground} />
            <T muted>{granted ? "On" : "Off"}</T>
          </View>
        )
      }
    />
  );
  const forget = (app: string) =>
    confirm(`Remove ${app}?`, "A thread asks again before it next uses it.", "Remove", async () => {
      const answer = await window.parallax.request(id, "computer/forget", { app });
      if ("error" in answer) fail(`Couldn't remove ${app}`, answer.error);
      else setStatus(answer.result);
    });

  return (
    <>
      <Section
        title="Permissions"
        footer={
          missing && status
            ? `macOS lists Parallax's background service as ${status.program} under Privacy & Security. Turn it on there for each permission.`
            : "Agents can see and operate the apps on this Mac: read a window, click, type, scroll, and press keys, while your pointer and keyboard stay yours. A thread asks before it first uses each app."
        }
      >
        {permission("Accessibility", "Reads app windows, and clicks, types, and scrolls in them.", status?.accessibility)}
        {permission("Screen Recording", "Takes a screenshot of the window an agent works in.", status?.screenRecording, !missing && !error)}
        {error && <Note alert last={!missing}>{error}</Note>}
        {missing && (
          <Row
            icon={ShieldCheck}
            iconColor={c.accent}
            title={asking ? "Asking macOS…" : "Grant access"}
            last
            onPress={
              asking
                ? undefined
                : async () => {
                    setAsking(true);
                    await load(true);
                    setAsking(false);
                  }
            }
          />
        )}
      </Section>
      <Section
        title="Always allowed"
        footer="Computer use never controls terminals, script runners, Parallax itself, or Keychain Access, and agents are told not to type passwords, pay, or send messages unless you ask."
      >
        {!status ? (
          <Note>Checking…</Note>
        ) : status.apps.length === 0 ? (
          <Note>No apps yet. When a thread asks to use an app, choose Always allow to add it here.</Note>
        ) : (
          status.apps.map((app, i) => (
            <Row key={app} title={app} last={i === status.apps.length - 1} right={<Action label="Remove" onPress={() => forget(app)} />} />
          ))
        )}
      </Section>
    </>
  );
}

const blank: RepoScript = { id: "", name: "", command: "", runOnWorktreeCreate: true };

/**
 * Scripts (PLX-650): a repository's setup and settle scripts, which plxd runs in a thread's
 * worktree, and its parallax.json's, which run only once imported. Edits wait for Save.
 */
function ScriptsPage({ m }: { m: Computer }) {
  const c = useColors();
  const id = m.machine.id;
  const supported = can(m, "setupScripts");
  const repos = m.view.state.repos.filter(isRepository);
  const [repoId, setRepoId] = useState<string>();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const [picking, setPicking] = useState(false);
  const [saved, setSaved] = useState<RepoScript[]>();
  const [scripts, setScripts] = useState<RepoScript[]>([]);
  const [file, setFile] = useState<{ scripts: RepoScript[]; error?: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const repoKey = repo?.id;
  useEffect(() => {
    setSaved(undefined);
    setFile(undefined);
    setError(undefined);
    if (!supported || !repoKey) return;
    let live = true;
    void window.parallax.request(id, "repo/scripts", { repo: repoKey }).then((answer) => {
      if (!live) return;
      if ("error" in answer) return setError(describeError(answer.error));
      setSaved(answer.result.scripts);
      setScripts(answer.result.scripts);
      setFile({ scripts: answer.result.fileScripts ?? [], error: answer.result.fileError });
    });
    return () => {
      live = false;
    };
  }, [id, supported, repoKey]);

  if (!supported)
    return (
      <Section>
        <Note>This host's plxd can't run setup scripts.</Note>
      </Section>
    );
  if (!repo)
    return (
      <Section>
        <Note>No repositories on this host yet.</Note>
      </Section>
    );
  const save = async () => {
    setBusy(true);
    const answer = await window.parallax.request(id, "repo/saveScripts", { repo: repo.id, scripts });
    setBusy(false);
    if ("error" in answer) return fail(`Couldn't save ${repo.name}'s scripts`, answer.error);
    setSaved(answer.result.scripts);
    setScripts(answer.result.scripts);
  };
  const edit = (i: number, change: Partial<RepoScript>) => setScripts(scripts.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const dirty = JSON.stringify(scripts) !== JSON.stringify(saved);

  return (
    <>
      <Section footer="Commands that run in a thread's own worktree: a setup script once the worktree is created, and a settle script when the thread settles. Each runs in a terminal under the thread.">
        <Row
          title="Repository"
          right={<T muted>{repo.name}</T>}
          chevron={repos.length > 1}
          last
          onPress={repos.length > 1 ? () => setPicking(true) : undefined}
        />
      </Section>
      {saved === undefined ? (
        <Section title="Scripts">
          <Note alert={!!error}>{error ?? "Loading…"}</Note>
        </Section>
      ) : (
        <>
          {scripts.length === 0 && (
            <Section title="Scripts">
              <Note>No scripts. Add one, or import one from parallax.json.</Note>
            </Section>
          )}
          {scripts.map((script, i) => (
            <Section key={i} title={i === 0 ? "Scripts" : undefined}>
              <Field title="Name" value={script.name} onSave={(name) => edit(i, { name })} />
              <Field title="Command" placeholder="pnpm install" mono multiline value={script.command} onSave={(command) => edit(i, { command })} />
              <SwitchRow title="On a new worktree" value={script.runOnWorktreeCreate ?? false} onChange={(on) => edit(i, { runOnWorktreeCreate: on })} />
              {script.runOnWorktreeCreate && (
                <SwitchRow title="Agent waits for it" value={script.async === false} onChange={(on) => edit(i, { async: on ? false : undefined })} />
              )}
              <SwitchRow title="When a thread settles" value={script.runOnSettle ?? false} onChange={(on) => edit(i, { runOnSettle: on })} />
              <Row title="Remove" destructive last onPress={() => setScripts(scripts.filter((_, j) => j !== i))} />
            </Section>
          ))}
          <Section>
            <Row icon={Plus} iconColor={c.accent} title="Add script" last onPress={() => setScripts([...scripts, blank])} />
          </Section>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button label="Discard" disabled={!dirty || busy} onPress={() => setScripts(saved)} style={{ flex: 1 }} />
            <Button label="Save" primary disabled={!dirty || busy} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
          {(file?.error || (file?.scripts.length ?? 0) > 0) && (
            <Section title="From parallax.json" footer="The repository's parallax.json declares these. They run only once you import and save them.">
              {file?.error && <Note alert last={!file.scripts.length}>{file.error}</Note>}
              {file?.scripts.map((script, i) => (
                <Row
                  key={script.id}
                  title={scriptRoles(script) ? `${script.name} · ${scriptRoles(script)}` : script.name}
                  detail={script.command}
                  last={i === file.scripts.length - 1}
                  right={<Action label="Import" onPress={() => setScripts([...scripts, script])} />}
                />
              ))}
            </Section>
          )}
        </>
      )}
      <Choices
        title="Repository"
        open={picking}
        value={repo.id}
        options={repos.map((r) => ({ value: r.id, label: r.name }))}
        onChoose={setRepoId}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

/** What a paired computer can do, said before anyone pairs one. */
const GRANTS =
  "A paired computer has full control of this one: it can run agents and commands with full access, open terminals, change settings, and pair other computers. Pair only your own computers.";

/** A SHA-256 fingerprint in hex as browsers show it: `AB CD …`. */
const fingerprint = (hex: string) => hex.toUpperCase().match(/../g)!.join(" ");

const iconNames = { laptop: "Laptop", desktop: "PC", mini: "Mini PC", server: "Server" };

/**
 * Connections: the host's name and icon for Parallax Connect (0056), and pairing on its network
 * (PLX-641): its switch, Open in a browser, Pair a device's one-time code, and the computers
 * paired with it, each to revoke.
 */
function ConnectionsPage({ m }: { m: Computer }) {
  const id = m.machine.id;
  const { settings, error, set } = useHostSettings(m);
  const [status, setStatus] = useState<RemoteSessionsResult>();
  const [code, setCode] = useState<RemotePairResult & { before: number }>();
  const [picking, setPicking] = useState(false);
  const connect = can(m, "connect");
  const remote = can(m, "remote");
  const sessions = status?.sessions ?? [];
  const readSessions = useCallback(async () => {
    const answer = await window.parallax.request(id, "remote/sessions", {});
    if ("result" in answer) setStatus(answer.result);
  }, [id]);
  useEffect(() => {
    if (remote) void readSessions();
  }, [remote, readSessions]);
  // While a code is up, a computer that pairs shows up here, and the code goes, as it does once
  // plxd ends the pairing: used, locked, or expired.
  const showing = code && sessions.length <= code.before && status?.pairing !== false ? code : undefined;
  const on = settings?.remote;
  const polling = !!showing || (on && !status?.listening);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void readSessions(), 2000);
    return () => clearInterval(timer);
  }, [polling, readSessions]);

  const toggle = (next: boolean) => {
    const run = async () => {
      await set({ remote: next }, `Couldn't turn pairing ${next ? "on" : "off"}`);
      setCode(undefined);
      void readSessions();
    };
    // This phone may reach it this way: turning it off would end this connection.
    if (!next && m.machine.paired)
      return confirm(
        "Turn off pairing?",
        `This phone reaches ${m.machine.name} on this network, so it disconnects until pairing is on again.`,
        "Turn off",
        () => void run(),
      );
    void run();
  };
  const pair = async () => {
    const answer = await window.parallax.request(id, "remote/pair", {});
    if ("error" in answer) return fail("Couldn't make a pairing code", answer.error);
    setCode({ ...answer.result, before: sessions.length });
    void readSessions();
  };
  const revoke = (s: { id: string; name: string }) =>
    confirm(`Revoke ${s.name || "Unnamed computer"}?`, "It can't reach this computer until it pairs again.", "Revoke", async () => {
      const answer = await window.parallax.request(id, "remote/revoke", { id: s.id });
      if ("error" in answer) fail("Couldn't revoke the computer", answer.error);
      else setStatus(answer.result);
    });

  if (!connect && !remote)
    return (
      <Section>
        <Note>Update plxd on this computer to change its connections here.</Note>
      </Section>
    );
  return (
    <>
      {error && (
        <Section>
          <Note alert>{error}</Note>
        </Section>
      )}
      {connect && settings && (
        <Section title="Parallax Connect">
          <Field
            title="Device name"
            placeholder={m.machine.name}
            value={settings.deviceName ?? ""}
            onSave={(deviceName) => void set({ deviceName: deviceName.trim() }, `Couldn't rename ${m.machine.name}`)}
          />
          <Row
            title="Icon"
            right={<T muted>{iconNames[settings.deviceIcon as keyof typeof iconNames] ?? "Detected"}</T>}
            chevron
            last
            onPress={() => setPicking(true)}
          />
        </Section>
      )}
      {remote && on !== undefined && (
        <Section title="Same network">
          <SwitchRow title="Pair computers on this network" detail={GRANTS} value={on} onChange={toggle} last={!on && !sessions.length} />
          {on && status?.problem && <Note alert last={false}>{status.problem}</Note>}
          {on && settings?.remoteWeb !== undefined && (
            <SwitchRow
              title="Open in a browser"
              detail={`Serves Parallax at ${(showing?.addresses ?? ["this computer's address"])
                .map((a) => `https://${a.includes(":") ? a : `${a}:7341`}`)
                .join(", ")} for a browser, which pairs with a code from Pair a device. Use the tailnet address where you can: Tailscale vouches for this computer. On this network the browser warns about this computer's certificate. Continue only if the SHA-256 fingerprint it shows is the one below.${status?.fingerprint ? `\n${fingerprint(status.fingerprint)}` : ""}`}
              value={settings.remoteWeb}
              onChange={(remoteWeb) => void set({ remoteWeb }, `Couldn't turn Open in a browser ${remoteWeb ? "on" : "off"}`)}
            />
          )}
          {on && status?.listening && (
            <Row
              title={showing ? "New code" : "Pair a device"}
              detail={
                showing
                  ? `On the other computer, choose Add computer, pick ${showing.name}, and enter this code. It works once, for 5 minutes. Share it only with your own computer.`
                  : "Shows a short one-time code for another computer to pair with."
              }
              right={
                showing ? (
                  <T selectable style={{ fontFamily: font.monoBold, fontSize: 17, letterSpacing: 2 }}>
                    {showing.code}
                  </T>
                ) : undefined
              }
              last={!sessions.length}
              onPress={() => void pair()}
            />
          )}
          {sessions.map((s, i) => (
            <Row
              key={s.id}
              title={s.name || "Unnamed computer"}
              detail={`Paired ${new Date(s.createdAt).toLocaleDateString()}`}
              last={i === sessions.length - 1}
              right={<Action label="Revoke" onPress={() => revoke(s)} />}
            />
          ))}
        </Section>
      )}
      <Choices
        title="Icon"
        open={picking}
        value={settings?.deviceIcon ?? ""}
        options={[
          { value: "", label: "Detected", description: "From the computer's name." },
          ...Object.entries(iconNames).map(([value, label]) => ({ value, label })),
        ]}
        onChoose={(deviceIcon) => void set({ deviceIcon }, `Couldn't change ${m.machine.name}`)}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

/**
 * Storage: whether the host removes a merged thread's worktree (PLX-555), and its archived
 * threads, which Delete all removes with their worktrees.
 */
function StoragePage({ m }: { m: Computer }) {
  const id = m.machine.id;
  const { settings, error, set } = useHostSettings(m);
  const supported = can(m, "worktreeCleanup");
  const archived = m.view.state.threads.filter((t) => t.archived);
  const [deleting, setDeleting] = useState(false);
  const count = archived.length;
  const deleteAll = () =>
    confirm(
      "Delete all archived threads?",
      "Delete them? Their transcripts, worktrees, and branches go too. This can't be undone.",
      "Delete all",
      async () => {
        setDeleting(true);
        for (const t of archived) {
          const answer = await window.parallax.request(id, "thread/delete", { runId: t.id });
          if ("error" in answer) {
            fail("Couldn't delete the archived threads", answer.error);
            break;
          }
        }
        setDeleting(false);
      },
    );
  return (
    <>
      <Section title="Worktrees">
        <SwitchRow
          title="Clean up merged worktrees"
          detail={
            error ??
            (!supported
              ? "This host's plxd can't clean up worktrees."
              : "When a settled or archived thread's pull request merges, Parallax deletes its worktree and branch. The thread stays.")
          }
          value={settings?.cleanWorktrees ?? false}
          disabled={!supported || !settings}
          onChange={(cleanWorktrees) =>
            void set({ cleanWorktrees }, `Couldn't turn worktree cleanup ${cleanWorktrees ? "on" : "off"}`)
          }
          last
        />
      </Section>
      <Section title="Archived threads" footer="Deleting removes each one's transcript and worktree from the host.">
        <Row
          title={m.view.loading ? "Counting…" : `${count} archived ${count === 1 ? "thread" : "threads"}`}
          last
          right={<Action label={deleting ? "Deleting…" : "Delete all"} disabled={!count || deleting} onPress={deleteAll} />}
        />
      </Section>
    </>
  );
}

const bodies: Record<SettingsPage, ComponentType<{ m: Computer }>> = {
  providers: ProvidersPage,
  accounts: AccountsPage,
  threads: ThreadsPage,
  schedules: SchedulesPage,
  sourceControl: SourceControlPage,
  computerUse: ComputerUsePage,
  scripts: ScriptsPage,
  connections: ConnectionsPage,
  storage: StoragePage,
};

/** One of a computer's settings pages, with the computer it applies to at the top. */
export function ComputerSettingsScreen({ route, navigation }: NativeStackScreenProps<Screens, "ComputerSettings">) {
  const { id, page } = route.params;
  const m = useComputer(id);
  useEffect(() => navigation.setOptions({ title: pages[page] }), [page]);
  const Body = bodies[page];
  if (!m) return null;
  return (
    <Page>
      <ComputerPicker m={m} onChange={(next) => navigation.setParams({ id: next })} />
      {m.connected ? (
        <Body key={id} m={m} />
      ) : (
        <Section>
          <Row icon={RefreshCw} title="Reconnect" last onPress={() => void window.parallax.retry(id)} />
        </Section>
      )}
    </Page>
  );
}
