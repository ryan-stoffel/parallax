import { ArrowUpRight, Plus, RefreshCw, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { HOME_VARS, type RpcError, type ThemePreference } from "../preload/bridge";
import {
  ErrorCodes,
  type AccountUsage,
  type CliKind,
  type DetectedCli,
  type KeyAccount,
  type Provider,
  type ProviderEnvVar,
  type ProviderInfo,
  type ProviderInstance,
} from "../protocol/generated/protocol";
import { AddProviderDialog } from "./AddProviderDialog";
import type { SettingsSection } from "./App";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { localId, useHosts, type Host } from "./hosts";
import { models, setCliEnabled, useDisabledClis } from "./models";
import { Avatar, useProfile } from "./profile";
import {
  builtInIds,
  kindOf,
  logoOf,
  loadProviders,
  removeProvider,
  saveProvider,
  useProviders,
} from "./providers";
import { age, backendLogos } from "./Sidebar";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { ConnectionSettings } from "./settings/ConnectionSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { KeybindSettings } from "./settings/KeybindSettings";
import {
  dangerButton,
  field,
  HostPicker,
  PageTitle,
  primaryButton,
  quietButton,
  Row,
  rowField,
  Section,
  settingRow,
  StatusDot,
  Switch,
} from "./settings/parts";
import { ProviderModels } from "./settings/ProviderModels";
import { SourceControlSettings } from "./settings/SourceControlSettings";
import { StorageSettings } from "./settings/StorageSettings";
import { IconButton, Segmented } from "./ui";
import { periods, UsageLines, useUsage, type Period } from "./Usage";
import { uuidv7 } from "./uuidv7";

// xterm.js is large, so it loads when a sign-in first opens.
const SignInTerminal = lazy(() =>
  import("./SignInTerminal").then((m) => ({ default: m.SignInTerminal })),
);

interface SettingsProps {
  section: SettingsSection;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

/** The Settings page body. The sidebar's SettingsNav picks the section. */
export function Settings({ section, theme, onThemeChange }: SettingsProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={`mx-auto px-8 pt-6 pb-16 ${section === "providers" ? "max-w-5xl" : "max-w-3xl"}`}
      >
        {section === "account" ? (
          <AccountSettings />
        ) : section === "general" ? (
          <GeneralSettings />
        ) : section === "appearance" ? (
          <AppearanceSettings theme={theme} onThemeChange={onThemeChange} />
        ) : section === "keybinds" ? (
          <KeybindSettings />
        ) : section === "providers" ? (
          <ProvidersSettings />
        ) : section === "sourceControl" ? (
          <SourceControlSettings />
        ) : section === "storage" ? (
          <StorageSettings />
        ) : (
          <ConnectionSettings />
        )}
      </div>
    </div>
  );
}

/**
 * Settings > Account: the Parallax account (0037) and Sign out, or while signed out, Sign in and
 * Create an account, which open the sign-in page in the browser.
 */
function AccountSettings() {
  const profile = useProfile();
  const [note, setNote] = useState<string>();
  // Only the latest sign-in's answer shows: a replaced one answers "cancelled" late.
  const latest = useRef(0);
  const signIn = async (create: boolean) => {
    const n = ++latest.current;
    setNote("Finish signing in in your browser.");
    const answer = await window.parallax.signIn(create);
    if (n === latest.current) setNote(answer);
  };

  if (profile === undefined) return null;
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">Account</h1>
      {profile ? (
        <Section title="Signed in">
          <div className={settingRow}>
            <div className="flex min-w-0 items-center gap-3">
              <Avatar profile={profile} size={36} />
              <div className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {profile.name || profile.email}
                </span>
                {profile.name && (
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {profile.email}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void window.parallax.signOut()}
              className={quietButton}
            >
              Sign out
            </button>
          </div>
        </Section>
      ) : (
        <Section title="Sign in to Parallax">
          <div className={settingRow}>
            <p role="status" className="text-[12.5px] text-muted-foreground">
              {note ?? "Sign in with GitHub, Google, Apple, or email in your browser."}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => void signIn(true)} className={quietButton}>
                Create an account
              </button>
              <button
                type="button"
                onClick={() => void signIn(false)}
                className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
              >
                Sign in
              </button>
            </div>
          </div>
        </Section>
      )}
    </>
  );
}

/**
 * The vendor CLIs plxd detects (0004), by `CliKind`: where each says how to install it, and the
 * provider its API keys are for. Not Cursor's: 0004 rules out `CURSOR_API_KEY` as a fallback.
 */
const cliInfo: Record<string, { name: string; install: string; keyProvider?: Provider }> = {
  claude: {
    name: "Claude Code",
    install: "https://code.claude.com/docs/en/setup",
    keyProvider: "anthropic",
  },
  codex: {
    name: "Codex",
    install: "https://learn.chatgpt.com/docs/codex/cli",
    keyProvider: "openai",
  },
  cursor: { name: "Cursor", install: "https://cursor.com/docs/cli/installation" },
};

const providerNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/**
 * A failed accounts request, for people. A plxd without these methods is too old. A keychain
 * failure shows plxd's message, which names the fix on that host's OS.
 */
function accountsError(error: RpcError): string {
  if (error.code === ErrorCodes.MethodNotFound)
    return "Update plxd on this host to manage its accounts here.";
  if (error.data?.kind === "keychainUnavailable")
    return `This host's keychain isn't available: ${error.message}.`;
  return describeError(error);
}

/** A CLI's state in a few words: "Signed in · Max", "Not signed in", "Not installed". */
function cliStatus(cli: DetectedCli): string {
  if (!cli.installed) return "Not installed";
  if (cli.signedIn === false) return "Not signed in";
  // plxd couldn't tell; its note says why.
  if (cli.signedIn !== true) return "Sign-in unknown";
  // Plans come as the vendor writes them, such as Claude's "max".
  const plan = cli.plan && cli.plan[0]!.toUpperCase() + cli.plan.slice(1);
  return plan ? `Signed in · ${plan}` : "Signed in";
}

const cliTone = (cli: DetectedCli) => (!cli.installed ? "off" : cli.signedIn ? "on" : "warn");

/** "Checked just now", "Checked 12m ago". */
function checkedLabel(checkedAt: string): string {
  const ago = age(checkedAt);
  return ago === "now" ? "Checked just now" : `Checked ${ago} ago`;
}

/**
 * Settings > Providers: one host's vendor CLIs as a list, and the chosen one's account, usage,
 * API keys, and models. With more than one host, a picker chooses which.
 */
function ProvidersSettings() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const picker = <HostPicker hosts={hosts} value={host.id} onChange={setHostId} />;
  return (
    <>
      <PageTitle title="Providers">
        The AI subscriptions your agents run on. Sign in to each vendor's CLI on the host, or add an
        API key as a fallback. Turn one off to hide its models.
      </PageTitle>
      <HostProviders key={host.id} host={host} picker={picker} />
    </>
  );
}

/**
 * One host's providers: its provider instances on a plxd with `providers`, else the CLIs an older
 * one detects.
 */
function HostProviders({ host, picker }: { host: Host; picker: ReactNode }) {
  const connection = useConnection(host.id);
  return connection?.status === "connected" && "providers" in connection.capabilities ? (
    <HostInstances host={host} picker={picker} />
  ) : (
    <HostClis host={host} picker={picker} />
  );
}

/**
 * One host's providers on an older plxd: each CLI it detects there as a tab, and the chosen one's
 * pane. Loads once the host is connected; Refresh probes the CLIs again. Usage over the chosen
 * period and limits are kept live.
 */
function HostClis({ host, picker }: { host: Host; picker: ReactNode }) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const [detected, setDetected] = useState<DetectedCli[]>();
  const [checkedAt, setCheckedAt] = useState<string>();
  const [keys, setKeys] = useState<KeyAccount[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<CliKind>("claude");
  // The one sign-in terminal: main runs one per window.
  const [signingIn, setSigningIn] = useState<CliKind>();
  const [period, setPeriod] = useState<Period>("today");
  // By account id: a subscription's is its CLI's kind, the backend that runs it (0012).
  const { usage } = useUsage(host.id, connected);
  const tabs = useId();
  const off = useDisabledClis();

  // `accounts/list` may answer from plxd's cache; `accounts/refresh` always probes again. Keys
  // are listed again too, since another client may have changed them, and shown as soon as they
  // answer: the probe can take seconds, and a list held until then would undo an add or remove
  // made meanwhile.
  const load = useCallback(
    async (method: "accounts/list" | "accounts/refresh") => {
      setChecking(true);
      const [clis, keyList] = await Promise.all([
        window.parallax.request(host.id, method, {}),
        window.parallax.request(host.id, "accounts/keys/list", {}).then((answer) => {
          if ("result" in answer) setKeys(answer.result.accounts);
          return answer;
        }),
      ]);
      setChecking(false);
      if ("result" in clis) {
        setDetected(clis.result.clis);
        setCheckedAt(clis.result.checkedAt);
      }
      const failed = "error" in clis ? clis.error : "error" in keyList ? keyList.error : undefined;
      setError(failed && accountsError(failed));
    },
    [host.id],
  );
  useEffect(() => {
    if (connected) void load("accounts/list");
  }, [connected, load]);

  const current = detected?.find((c) => c.cli === selected) ?? detected?.[0];
  // Up and Down move between the tabs, wrapping at the ends, and choose the one they reach.
  const moveTab = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step || !detected || !current) return;
    e.preventDefault();
    const i = detected.indexOf(current);
    const next = detected[(i + step + detected.length) % detected.length]!;
    setSelected(next.cli);
    document.getElementById(`${tabs}-${next.cli}`)?.focus();
  };

  return (
    <>
      <div className="mb-2 flex min-h-7 items-center justify-between gap-4">
        {picker}
        <div className="flex items-center gap-1 text-[12.5px] text-muted-foreground">
          {checking ? "Checking…" : checkedAt && checkedLabel(checkedAt)}
          <IconButton
            label="Refresh"
            disabled={!connected || checking}
            onClick={() => void load("accounts/refresh")}
          >
            <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
          </IconButton>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {!connected || !current ? (
        <>
          <p className="mb-8 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
            {!connected
              ? connection
                ? statusLabel(connection)
                : "Connecting…"
              : error
                ? "Couldn't check this host's CLIs."
                : "Checking…"}
          </p>
          {/* The CLIs failed but the keys answered: they can still be seen and removed. */}
          {connected && !!keys?.length && (
            <Section title="API keys">
              {keys.map((account) => (
                <KeyRow
                  key={account.id}
                  hostId={host.id}
                  account={account}
                  usage={usage && <UsageLines usage={usage.get(account.id)} period={period} />}
                  onRemoved={() => setKeys((all) => all?.filter((k) => k.id !== account.id))}
                />
              ))}
            </Section>
          )}
        </>
      ) : (
        // Stacked until there's room for the list beside the pane.
        <div className="@container">
          <div className="grid gap-6 @2xl:grid-cols-[17rem_minmax(0,1fr)] @2xl:items-start">
            <div
              role="tablist"
              aria-label="Providers"
              aria-orientation="vertical"
              onKeyDown={moveTab}
              className="flex flex-col gap-0.5 rounded-xl border border-border bg-surface p-1"
            >
              {detected!.map((cli) => {
                const Logo = backendLogos[cli.cli];
                const on = cli === current;
                const name = cliInfo[cli.cli]?.name ?? cli.cli;
                const enabled = !off.includes(cli.cli);
                return (
                  <button
                    key={cli.cli}
                    id={`${tabs}-${cli.cli}`}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-controls={`${tabs}-${cli.cli}-pane`}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setSelected(cli.cli)}
                    className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-hover aria-selected:bg-selected ${enabled ? "" : "opacity-60"}`}
                  >
                    {Logo && <Logo className="mt-0.5 size-4 shrink-0" />}
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[13px] font-medium">{name}</span>
                        {cli.version && (
                          <span className="truncate font-mono text-[11.5px] text-faint-foreground">
                            {cli.version}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                        <StatusDot tone={enabled ? cliTone(cli) : "off"} />
                        {enabled ? cliStatus(cli) : "Off"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Every pane stays mounted, so a sign-in outlives a switch to another tab. */}
            {detected!.map((cli) => (
              <ProviderPane
                key={cli.cli}
                id={`${tabs}-${cli.cli}-pane`}
                tabId={`${tabs}-${cli.cli}`}
                hidden={cli !== current}
                signingIn={signingIn === cli.cli}
                onSignIn={(open) => setSigningIn(open ? cli.cli : undefined)}
                hostId={host.id}
                cli={cli}
                usage={usage}
                period={period}
                onPeriod={setPeriod}
                keys={keys}
                onKeys={setKeys}
                onSignedIn={() => void load("accounts/refresh")}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A CLI's pane, `hidden` unless its tab is chosen: its account, with Sign in (in a terminal under it, after which the CLIs
 * are probed again with `onSignedIn`) or Install; its usage over `period`; the API keys for its
 * provider, which can be added and removed; and the models Parallax runs on it.
 */
function ProviderPane({
  id,
  tabId,
  hidden,
  signingIn,
  onSignIn,
  hostId,
  cli,
  usage,
  period,
  onPeriod,
  keys,
  onKeys,
  onSignedIn,
}: {
  id: string;
  tabId: string;
  hidden: boolean;
  /** Whether this CLI's sign-in terminal is open. */
  signingIn: boolean;
  /** Opens its sign-in terminal, closing any other, or closes it. */
  onSignIn: (open: boolean) => void;
  hostId: string;
  cli: DetectedCli;
  usage?: ReadonlyMap<string, AccountUsage>;
  period: Period;
  onPeriod: (period: Period) => void;
  keys?: KeyAccount[];
  onKeys: (update: (keys?: KeyAccount[]) => KeyAccount[] | undefined) => void;
  onSignedIn: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const info = cliInfo[cli.cli];
  const name = info?.name ?? cli.cli;
  const Logo = backendLogos[cli.cli];
  const keyProvider = info?.keyProvider;
  const offered = models.filter((m) => m.provider === cli.cli);
  const off = useDisabledClis();
  const enabled = !off.includes(cli.cli);
  // One provider stays on, so a new thread always has one to start on.
  const last = enabled && builtInIds.every((c) => c === cli.cli || off.includes(c));

  let action: ReactNode;
  if (!cli.installed)
    action = info && (
      <a
        href={info.install}
        target="_blank"
        rel="noreferrer"
        className={`${quietButton} flex shrink-0 items-center gap-1 [&_svg]:size-3.5`}
      >
        Install
        <ArrowUpRight aria-hidden />
      </a>
    );
  else if (cli.signedIn !== true && info && !signingIn)
    action = (
      <button
        type="button"
        aria-label={`Sign in to ${name}`}
        onClick={() => onSignIn(true)}
        className={`${quietButton} -my-1 shrink-0`}
      >
        Sign in
      </button>
    );

  return (
    <div id={id} role="tabpanel" aria-labelledby={tabId} hidden={hidden} className="min-w-0">
      <div className="mb-5 flex items-center gap-2.5">
        {Logo && <Logo className="size-5 shrink-0" />}
        <h2 className="text-[15px] font-semibold">{name}</h2>
        {cli.version && (
          <span className="truncate font-mono text-[12px] text-muted-foreground">
            {cli.version}
          </span>
        )}
        <label
          className="ml-auto flex items-center gap-2 text-[12.5px] text-muted-foreground"
          title={last ? "One provider stays on, for new threads." : undefined}
        >
          {enabled ? "On" : "Off"}
          <Switch
            label={`Use ${name}`}
            checked={enabled}
            disabled={last}
            onChange={(next) => setCliEnabled(cli.cli, next)}
          />
        </label>
      </div>
      {!enabled && (
        <p className="mb-5 rounded-xl border border-border bg-surface px-4 py-3 text-[12.5px] text-muted-foreground">
          Off on this computer: new threads and model menus leave out {name}'s models. Threads
          already on {name} keep running.
        </p>
      )}
      <Section title="Account">
        <div className={settingRow}>
          <div className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{cliStatus(cli)}</span>
            {!cli.installed ? (
              <span className="block truncate text-[12.5px] text-muted-foreground">
                Install {name} on this host, then refresh.
              </span>
            ) : (
              cli.signedIn === undefined &&
              cli.note && (
                <span className="block text-[12.5px] text-muted-foreground">{cli.note}</span>
              )
            )}
          </div>
          {action}
        </div>
        {signingIn && (
          <Suspense>
            <SignInTerminal
              target={{ hostId, cli: cli.cli }}
              name={name}
              onExit={onSignedIn}
              onClose={() => onSignIn(false)}
            />
          </Suspense>
        )}
      </Section>
      {cli.installed && (
        <Section title="Runtime">
          <div className={settingRow}>
            <div className="min-w-0">
              <span className="block text-[13px] font-medium">Binary</span>
              <span className="block text-[12.5px] text-muted-foreground">
                The {name} CLI plxd found on this host's PATH, which runs your agents.
              </span>
            </div>
            <span
              className="max-w-[50%] truncate font-mono text-[12px] text-muted-foreground"
              title={cli.path}
            >
              {cli.path ?? "Unknown"}
            </span>
          </div>
          {/* A newer plxd may send kinds this doesn't know, which say nothing here. */}
          {(cli.authKind === "subscription" || cli.authKind === "apiKey") && (
            <div className={settingRow}>
              <span className="text-[13px] font-medium">Signed in with</span>
              <span className="text-[12.5px] text-muted-foreground">
                {cli.authKind === "subscription" ? "A subscription" : "An API key"}
              </span>
            </div>
          )}
        </Section>
      )}
      {usage && (
        <Section
          title="Usage"
          action={
            <Segmented label="Usage period" options={periods} value={period} onChange={onPeriod} />
          }
        >
          <div className={settingRow}>
            <div className="min-w-0">
              <UsageLines usage={usage.get(cli.cli)} period={period} />
            </div>
          </div>
        </Section>
      )}
      {keyProvider && keys && (
        <Section title={`${providerNames[keyProvider]} API keys`}>
          {keys
            .filter((k) => k.provider === keyProvider)
            .map((account) => (
              <KeyRow
                key={account.id}
                hostId={hostId}
                account={account}
                usage={usage && <UsageLines usage={usage.get(account.id)} period={period} />}
                onRemoved={() => onKeys((all) => all?.filter((k) => k.id !== account.id))}
              />
            ))}
          {adding ? (
            <KeyForm
              hostId={hostId}
              provider={keyProvider}
              onDone={(account) => {
                setAdding(false);
                if (account) onKeys((all) => [...(all ?? []), account]);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
            >
              <Plus aria-hidden />
              Add API key
            </button>
          )}
        </Section>
      )}
      <Section title="Models">
        {offered.length ? (
          offered.map((m) => (
            <div key={m.id} className={settingRow}>
              <span className="truncate text-[13px]">{m.name}</span>
              <span className="truncate font-mono text-[12px] text-faint-foreground">{m.id}</span>
            </div>
          ))
        ) : (
          <p className={`${settingRow} text-[12.5px] text-muted-foreground`}>
            Parallax doesn't run {name} models yet.
          </p>
        )}
      </Section>
    </div>
  );
}

/** An instance's state in a few words: "Signed in · Max", "Not signed in", "Not installed". */
function instanceStatus(info: ProviderInfo): string {
  if (!info.installed) return "Not installed";
  if (info.signedIn === false) return "Not signed in";
  if (info.signedIn !== true) return info.login ? "Sign-in unknown" : "Ready";
  return info.account ? `Signed in · ${info.account}` : "Signed in";
}

const instanceTone = (info: ProviderInfo) =>
  !info.installed ? "off" : info.signedIn === false ? "warn" : "on";

/**
 * One host's provider instances (`providers/list`) as tabs, each with a switch that turns it on or
 * off on the host, and the chosen one's pane. Refresh probes them again, and + adds one.
 */
function HostInstances({ host, picker }: { host: Host; picker: ReactNode }) {
  const providers = useProviders(host.id);
  const [keys, setKeys] = useState<KeyAccount[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState("claude");
  // The one sign-in terminal: main runs one per window.
  const [signingIn, setSigningIn] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [period, setPeriod] = useState<Period>("today");
  const { usage } = useUsage(host.id, true);
  const tabs = useId();

  const loadKeys = useCallback(async () => {
    const answer = await window.parallax.request(host.id, "accounts/keys/list", {});
    if ("result" in answer) setKeys(answer.result.accounts);
    return "error" in answer ? accountsError(answer.error) : undefined;
  }, [host.id]);
  useEffect(() => {
    let live = true;
    void Promise.all([loadProviders(host.id), loadKeys()]).then(
      (errors) => live && setError(errors.find(Boolean)),
    );
    return () => {
      live = false;
    };
  }, [host.id, loadKeys]);
  const refresh = async () => {
    setChecking(true);
    const errors = await Promise.all([loadProviders(host.id, true), loadKeys()]);
    setChecking(false);
    setError(errors.find(Boolean));
  };
  const save = async (instance: ProviderInstance) =>
    setError(await saveProvider(host.id, instance));

  const list = providers?.providers;
  const current = list?.find((p) => p.instance.id === selected) ?? list?.[0];
  const on = list?.filter((p) => p.instance.enabled) ?? [];
  // Up and Down move between the tabs, wrapping at the ends, and choose the one they reach.
  const moveTab = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step || !list || !current) return;
    e.preventDefault();
    const next = list[(list.indexOf(current) + step + list.length) % list.length]!;
    setSelected(next.instance.id);
    document.getElementById(`${tabs}-${next.instance.id}`)?.focus();
  };

  return (
    <>
      <div className="mb-2 flex min-h-7 items-center justify-between gap-4">
        {picker}
        <div className="ml-auto flex items-center gap-1 text-[12.5px] text-muted-foreground">
          {checking ? "Checking…" : providers && checkedLabel(providers.checkedAt)}
          <IconButton label="Refresh" disabled={checking} onClick={() => void refresh()}>
            <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
          </IconButton>
          <IconButton label="Add provider" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
          </IconButton>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {adding && list && (
        <AddProviderDialog
          hostId={host.id}
          hostName={host.name}
          instances={list.map((p) => p.instance)}
          onAdded={setSelected}
          onClose={() => setAdding(false)}
        />
      )}
      {!list || !current ? (
        <p className="mb-8 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
          {error ? "Couldn't list this host's providers." : "Checking…"}
        </p>
      ) : (
        // Stacked until there's room for the list beside the pane.
        <div className="@container">
          <div className="grid gap-6 @2xl:grid-cols-[17rem_minmax(0,1fr)] @2xl:items-start">
            <div
              role="tablist"
              aria-label="Providers"
              aria-orientation="vertical"
              onKeyDown={moveTab}
              className="flex flex-col gap-0.5 rounded-xl border border-border bg-surface p-1"
            >
              {list.map((info) => {
                const { instance } = info;
                const Logo = logoOf(instance);
                const chosen = info === current;
                // One instance stays on, so a new thread always has one to start on.
                const last = instance.enabled && on.length === 1;
                return (
                  <div
                    key={instance.id}
                    className={`flex items-center gap-2 rounded-lg pr-3 hover:bg-hover has-[[aria-selected=true]]:bg-selected ${instance.enabled ? "" : "opacity-60"}`}
                  >
                    <button
                      id={`${tabs}-${instance.id}`}
                      type="button"
                      role="tab"
                      aria-selected={chosen}
                      aria-controls={`${tabs}-${instance.id}-pane`}
                      tabIndex={chosen ? 0 : -1}
                      onClick={() => setSelected(instance.id)}
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-lg py-2.5 pl-3 text-left"
                    >
                      <Logo className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[13px] font-medium">{instance.name}</span>
                          {info.version && (
                            <span className="truncate font-mono text-[11.5px] text-faint-foreground">
                              {info.version}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                          <StatusDot tone={instance.enabled ? instanceTone(info) : "off"} />
                          <span className="truncate">
                            {instance.enabled ? instanceStatus(info) : "Off"}
                          </span>
                        </span>
                      </span>
                    </button>
                    <span title={last ? "One provider stays on, for new threads." : undefined}>
                      <Switch
                        label={`Use ${instance.name}`}
                        checked={instance.enabled}
                        disabled={last}
                        onChange={(next) => void save({ ...instance, enabled: next })}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
            {/* Every pane stays mounted, so a sign-in outlives a switch to another tab. */}
            {list.map((info) => (
              <InstancePane
                key={info.instance.id}
                id={`${tabs}-${info.instance.id}-pane`}
                tabId={`${tabs}-${info.instance.id}`}
                hidden={info !== current}
                signingIn={signingIn === info.instance.id}
                onSignIn={(open) => setSigningIn(open ? info.instance.id : undefined)}
                hostId={host.id}
                info={info}
                usage={usage}
                period={period}
                onPeriod={setPeriod}
                keys={keys}
                onKeys={setKeys}
                onSignedIn={() => void loadProviders(host.id, true)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A text field that saves its value on blur or Enter, when it changed. A `required` one that's
 * emptied goes back to `value`.
 */
function SavedField({
  value,
  onSave,
  ...props
}: { value: string; onSave: (value: string) => void } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      // A new value, once saved, is the field's again.
      key={value}
      defaultValue={value}
      spellCheck={false}
      autoComplete="off"
      className={rowField}
      onBlur={(e) => {
        const next = e.target.value;
        if (next === value) return;
        if (props.required && !next.trim()) e.target.value = value;
        else onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      {...props}
    />
  );
}

/** A field's words as arguments, split on spaces. ponytail: no quoting, so no argument has a space. */
const argsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * A provider instance's pane, `hidden` unless its tab is chosen: its display name and account,
 * with Sign in (in a terminal under it, after which the instances are probed again with
 * `onSignedIn`); how it runs; its variables; Claude's and Codex's usage and API keys; its models;
 * and Remove, for one the user added. Each change saves the instance on the host.
 */
function InstancePane({
  id,
  tabId,
  hidden,
  signingIn,
  onSignIn,
  hostId,
  info,
  usage,
  period,
  onPeriod,
  keys,
  onKeys,
  onSignedIn,
}: {
  id: string;
  tabId: string;
  hidden: boolean;
  /** Whether its sign-in terminal is open. */
  signingIn: boolean;
  /** Opens its sign-in terminal, closing any other, or closes it. */
  onSignIn: (open: boolean) => void;
  hostId: string;
  info: ProviderInfo;
  usage?: ReadonlyMap<string, AccountUsage>;
  period: Period;
  onPeriod: (period: Period) => void;
  keys?: KeyAccount[];
  onKeys: (update: (keys?: KeyAccount[]) => KeyAccount[] | undefined) => void;
  onSignedIn: () => void;
}) {
  const { instance } = info;
  const kind = kindOf(instance.kind);
  const KindLogo = logoOf(instance);
  const homeVar = HOME_VARS[instance.kind];
  const builtIn = builtInIds.includes(instance.id);
  // The host's keys are for the built-in Claude Code and Codex.
  const keyProvider = builtIn ? cliInfo[instance.id]?.keyProvider : undefined;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (change: Partial<ProviderInstance>) =>
    setError(await saveProvider(hostId, { ...instance, ...change }));

  let account = instanceStatus(info);
  if (info.signedIn === true && info.account) account = `Authenticated as ${info.account}`;

  return (
    <div id={id} role="tabpanel" aria-labelledby={tabId} hidden={hidden} className="min-w-0">
      <div className="mb-5 flex items-center gap-2.5">
        <KindLogo className="size-5 shrink-0" />
        <h2 className="truncate text-[15px] font-semibold">{instance.name}</h2>
        {info.version && (
          <span className="ml-auto truncate font-mono text-[12px] text-muted-foreground">
            {info.version}
          </span>
        )}
      </div>
      {!instance.enabled && (
        <p className="mb-5 rounded-xl border border-border bg-surface px-4 py-3 text-[12.5px] text-muted-foreground">
          Off on this host: new threads and model menus leave out {instance.name}'s models.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-5 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <Section title="Account">
        <Row
          title="Display name"
          description={
            <>
              {account}
              {info.note && <span className="block">{info.note}</span>}
            </>
          }
        >
          <SavedField
            aria-label="Display name"
            required
            maxLength={64}
            value={instance.name}
            onSave={(name) => void save({ name: name.trim() })}
          />
        </Row>
        {info.login && info.installed && info.signedIn !== true && !signingIn && (
          <Row title="Sign in" description={`Runs ${info.login.join(" ")} on this host.`}>
            <button
              type="button"
              aria-label={`Sign in to ${instance.name}`}
              onClick={() => onSignIn(true)}
              className={quietButton}
            >
              Sign in
            </button>
          </Row>
        )}
        {signingIn && (
          <Suspense>
            <SignInTerminal
              target={{ hostId, provider: instance.id }}
              name={instance.name}
              onExit={onSignedIn}
              onClose={() => onSignIn(false)}
            />
          </Suspense>
        )}
      </Section>
      <Section title="Runtime">
        <Row
          title="Binary path"
          description={info.path ? `Runs ${info.path}.` : `Not found on this host's PATH.`}
        >
          <SavedField
            aria-label="Binary path"
            placeholder={kind.program}
            required={instance.kind === "acp"}
            value={instance.program ?? ""}
            onSave={(program) => void save({ program: program.trim() || undefined })}
          />
        </Row>
        {homeVar && (
          <Row title={`${homeVar} path`} description="Its own home, for a second account.">
            <SavedField
              aria-label={`${homeVar} path`}
              placeholder="Default"
              value={instance.home ?? ""}
              onSave={(home) => void save({ home: home.trim() || undefined })}
            />
          </Row>
        )}
        <Row
          title={kind.wholeArgs ? "Arguments" : "Launch arguments"}
          description={
            kind.wholeArgs
              ? "Everything after the program, separated by spaces."
              : "Added after its own, separated by spaces."
          }
        >
          <SavedField
            aria-label={kind.wholeArgs ? "Arguments" : "Launch arguments"}
            value={instance.args.join(" ")}
            onSave={(args) => void save({ args: argsOf(args) })}
          />
        </Row>
      </Section>
      <EnvSection env={instance.env} onSave={(env) => save({ env })} />
      {usage && (instance.kind === "claude" || instance.kind === "codex") && (
        <Section
          title="Usage"
          action={
            <Segmented label="Usage period" options={periods} value={period} onChange={onPeriod} />
          }
        >
          <div className={settingRow}>
            <div className="min-w-0">
              <UsageLines usage={usage.get(instance.id)} period={period} />
            </div>
          </div>
        </Section>
      )}
      {keyProvider && keys && (
        <Section title={`${providerNames[keyProvider]} API keys`}>
          {keys
            .filter((k) => k.provider === keyProvider)
            .map((account) => (
              <KeyRow
                key={account.id}
                hostId={hostId}
                account={account}
                usage={usage && <UsageLines usage={usage.get(account.id)} period={period} />}
                onRemoved={() => onKeys((all) => all?.filter((k) => k.id !== account.id))}
              />
            ))}
          {adding ? (
            <KeyForm
              hostId={hostId}
              provider={keyProvider}
              onDone={(account) => {
                setAdding(false);
                if (account) onKeys((all) => [...(all ?? []), account]);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
            >
              <Plus aria-hidden />
              Add API key
            </button>
          )}
        </Section>
      )}
      <ProviderModels hostId={hostId} info={info} onSave={(models) => save({ models })} />
      {!builtIn && <RemoveProvider hostId={hostId} instance={instance} />}
    </div>
  );
}

/**
 * An instance's variables: each by name, with its value to edit (a secret's never shows, and a
 * new one replaces it), and Remove; and Add variable, a secret by default for a name with KEY,
 * TOKEN, or SECRET in it.
 */
function EnvSection({
  env,
  onSave,
}: {
  env: ProviderEnvVar[];
  onSave: (env: ProviderEnvVar[]) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  // Unset until the box is clicked: then the name decides.
  const [secretPick, setSecret] = useState<boolean>();
  const secret = secretPick ?? /KEY|TOKEN|SECRET/i.test(name);
  const reset = () => {
    setAdding(false);
    setName("");
    setSecret(undefined);
  };

  return (
    <Section title="Environment">
      {env.map((v, i) => (
        <div key={v.name} className={settingRow}>
          <div className="min-w-0">
            <span className="block truncate font-mono text-[12.5px]">{v.name}</span>
            {v.secret && (
              <span className="block text-[12.5px] text-muted-foreground">
                Secret, kept in the host's keychain
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SavedField
              aria-label={`Value of ${v.name}`}
              type={v.secret ? "password" : "text"}
              placeholder={v.secret ? "••••" : ""}
              value={v.secret ? "" : (v.value ?? "")}
              onSave={(value) => {
                // An emptied secret keeps the stored one.
                if (!v.secret || value)
                  void onSave(env.map((each, j) => (j === i ? { ...each, value } : each)));
              }}
            />
            <IconButton
              label={`Remove ${v.name}`}
              onClick={() => void onSave(env.filter((_, j) => j !== i))}
            >
              <X aria-hidden />
            </IconButton>
          </div>
        </div>
      ))}
      {adding ? (
        <form
          aria-label="Add variable"
          onSubmit={(e) => {
            e.preventDefault();
            const value = (e.currentTarget.elements.namedItem("value") as HTMLInputElement).value;
            void onSave([...env.filter((v) => v.name !== name), { name, value, secret }]);
            reset();
          }}
          className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] text-muted-foreground">
              Name
              <input
                name="name"
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                title="Letters, digits, and _, not starting with a digit."
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className={`${field} font-mono`}
              />
            </label>
            <label className="text-[12.5px] text-muted-foreground">
              Value
              <input
                name="value"
                type={secret ? "password" : "text"}
                spellCheck={false}
                autoComplete="off"
                className={field}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
            Secret: kept in the host's keychain, and never shown again
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={reset} className={quietButton}>
              Cancel
            </button>
            <button type="submit" className={primaryButton}>
              Add variable
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
        >
          <Plus aria-hidden />
          Add variable
        </button>
      )}
    </Section>
  );
}

/** Remove provider, for an instance the user added. It asks first, in place, as KeyRow does. */
function RemoveProvider({ hostId, instance }: { hostId: string; instance: ProviderInstance }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setRemoving(true);
    const failed = await removeProvider(hostId, instance.id);
    // Gone from the list, this pane goes too.
    setRemoving(false);
    setError(failed);
  };

  return (
    <Section title="Remove">
      <div className={settingRow}>
        <div className="min-w-0">
          <span className="block text-[13px] font-medium">Remove provider</span>
          <span className="block text-[12.5px] text-muted-foreground">
            {confirming
              ? `Remove ${instance.name}? Its settings and secrets leave this host.`
              : "Its threads keep their transcripts."}
          </span>
          {error && (
            <span role="alert" className="block text-[12.5px] text-danger">
              {error}
            </span>
          )}
        </div>
        {/* Cancel takes Remove's place and focus, so a double click or a second Enter can't remove. */}
        <div className="flex shrink-0 gap-1">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={removing}
                onClick={() => void remove()}
                className={dangerButton}
              >
                Remove
              </button>
              <button
                type="button"
                autoFocus
                className={quietButton}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={quietButton} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

/** A stored API key, shown only masked, with its `usage` lines. Remove asks first, in place. */
function KeyRow({
  hostId,
  account,
  usage,
  onRemoved,
}: {
  hostId: string;
  account: KeyAccount;
  usage?: ReactNode;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setRemoving(true);
    const answer = await window.parallax.request(hostId, "accounts/keys/remove", {
      id: account.id,
    });
    setRemoving(false);
    // Already gone, such as removed by another client: that's what Remove wanted.
    if ("error" in answer && answer.error.data?.kind !== "accountNotFound")
      setError(accountsError(answer.error));
    else onRemoved();
  };

  return (
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{account.label}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">
          {confirming
            ? "Remove this key? Parallax deletes it from the host's keychain."
            : `${providerNames[account.provider] ?? account.provider} API key · ${account.maskedKey}`}
        </span>
        {usage}
        {error && (
          <span role="alert" className="block text-[12.5px] text-danger">
            {error}
          </span>
        )}
      </div>
      {/* Cancel takes Remove's place and focus, so a double click or a second Enter can't remove. */}
      <div className="flex shrink-0 gap-1">
        {confirming ? (
          <>
            <button
              type="button"
              disabled={removing}
              onClick={() => void remove()}
              className={dangerButton}
            >
              Remove
            </button>
            <button
              type="button"
              autoFocus
              className={quietButton}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className={quietButton} onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Adds an API key for `provider` on a host. The key is read from its field once, then the field is cleared:
 * plxd keeps it in the host's keychain and only ever answers with its masked form. `onDone`
 * gets the new account, or nothing when cancelled.
 */
function KeyForm({
  hostId,
  provider,
  onDone,
}: {
  hostId: string;
  provider: Provider;
  onDone: (account?: KeyAccount) => void;
}) {
  // One id while the form is open, so sending it again can't store the key twice (0007).
  const [id] = useState(uuidv7);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const keyField = form.elements.namedItem("key") as HTMLInputElement;
    const params = {
      id,
      provider,
      label: data.get("label") as string,
      key: keyField.value,
    };
    keyField.value = "";
    setSaving(true);
    const answer = await window.parallax.request(hostId, "accounts/keys/add", params);
    setSaving(false);
    if ("error" in answer) setError(accountsError(answer.error));
    else onDone(answer.result.account);
  };

  return (
    <form
      aria-label="Add API key"
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
      className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
    >
      <label className="text-[12.5px] text-muted-foreground">
        Label
        {/* Within plxd's limits (a label with a non-space, of at most 256 bytes, and a key of at
            least 20), so it never answers invalidParams. */}
        <input
          name="label"
          required
          pattern=".*\S.*"
          title="A label can't be only spaces."
          maxLength={64}
          placeholder="Work"
          className={field}
        />
      </label>
      <label className="text-[12.5px] text-muted-foreground">
        API key
        <input
          name="key"
          type="password"
          required
          minLength={20}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <span className="mt-1 block text-faint-foreground">
          Kept in the host's keychain. Parallax never shows it again.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onDone()} className={quietButton}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={primaryButton}>
          Add key
        </button>
      </div>
    </form>
  );
}
