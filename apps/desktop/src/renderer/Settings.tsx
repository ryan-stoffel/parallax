import { ArrowUpRight, Monitor, Moon, Plus, RefreshCw, Sun } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { RpcError, ThemePreference, UpdateChannel } from "../preload/bridge";
import {
  ErrorCodes,
  type AccountUsage,
  type CliKind,
  type DetectedCli,
  type KeyAccount,
  type Provider,
} from "../protocol/generated/protocol";
import type { SettingsSection } from "./App";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { localId, useHosts, type Host } from "./hosts";
import { backends, models } from "./models";
import { age, backendLogos } from "./Sidebar";
import { IconButton, segment, Segmented } from "./ui";
import { periods, UsageLines, useUsage, type Period } from "./Usage";
import { uuidv7 } from "./uuidv7";

// xterm.js is large, so it loads when a sign-in first opens.
const SignInTerminal = lazy(() =>
  import("./SignInTerminal").then((m) => ({ default: m.SignInTerminal })),
);

const themeOptions: { value: ThemePreference; name: string; icon: ReactNode }[] = [
  { value: "system", name: "System", icon: <Monitor /> },
  { value: "light", name: "Parallax Light", icon: <Sun /> },
  { value: "dark", name: "Parallax Dark", icon: <Moon /> },
];

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
        className={`mx-auto px-8 pt-6 pb-16 ${section === "providers" ? "max-w-4xl" : "max-w-2xl"}`}
      >
        {section === "general" ? (
          <>
            <h1 className="mb-6 text-xl font-semibold">General</h1>
            <Section title="Appearance">
              <fieldset className="flex items-center justify-between gap-6 px-4 py-3.5">
                <legend className="float-left">
                  <span className="block text-[13px] font-medium">Theme</span>
                  <span className="block text-[12.5px] text-muted-foreground">
                    Follows your system unless you pick one.
                  </span>
                </legend>
                <div className="flex gap-0.5 rounded-lg border border-border p-0.5">
                  {themeOptions.map((opt) => (
                    <label key={opt.value} className={segment}>
                      <input
                        type="radio"
                        name="theme"
                        value={opt.value}
                        checked={theme === opt.value}
                        onChange={() => onThemeChange(opt.value)}
                        className="sr-only"
                      />
                      {opt.icon}
                      {opt.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            </Section>
            <UpdateSettings />
          </>
        ) : section === "hosts" ? (
          <HostsSettings />
        ) : (
          <ProvidersSettings />
        )}
      </div>
    </div>
  );
}

const updateChannels: { value: UpdateChannel; name: string; detail: string }[] = [
  { value: "nightly", name: "Nightly", detail: "Every push to develop." },
  { value: "release", name: "Standard", detail: "Released code only." },
];

/** Settings > General > Updates: which channel the sidebar's Update button follows. */
function UpdateSettings() {
  const [channel, setChannel] = useState<UpdateChannel>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void window.parallax.updateChannel().then(setChannel);
  }, []);
  const choose = async (next: UpdateChannel) => {
    const failed = await window.parallax.setUpdateChannel(next);
    setError(failed);
    if (!failed) setChannel(next);
  };
  return (
    <Section title="Updates">
      <div className={settingRow}>
        <div>
          <span className="block text-[13px] font-medium">Update channel</span>
          <span className="block text-[12.5px] text-muted-foreground">
            {updateChannels.find((c) => c.value === channel)?.detail ?? "Loading…"}
          </span>
        </div>
        <Segmented
          label="Update channel"
          options={updateChannels}
          value={channel ?? "nightly"}
          onChange={(next) => void choose(next)}
          disabled={channel === undefined}
        />
      </div>
      {error && (
        <p role="alert" className="px-4 pb-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

const settingRow =
  "flex items-center justify-between gap-4 border-border px-4 py-3 not-last:border-b";
const quietButton =
  "rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground";

/** Settings > Hosts: this computer, then the SSH hosts, which can be added, edited, and removed. */
function HostsSettings() {
  const hosts = useHosts();
  // The host whose form is open: its id, "new", or none.
  const [editing, setEditing] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const remove = async (id: string) => setRemoveError(await window.parallax.removeHost(id));

  return (
    <>
      <h1 className="mb-1.5 text-xl font-semibold">Hosts</h1>
      <p className="mb-6 text-[13px] text-muted-foreground">
        Machines your agents run on. Add one you reach over SSH, such as a Mac mini with plxd
        installed.
      </p>
      {removeError && (
        <p role="alert" className="mb-3 text-[12.5px] text-danger">
          {removeError}
        </p>
      )}
      <Section title="Hosts">
        {hosts.map((h) =>
          editing === h.id ? (
            <HostForm key={h.id} host={h} onDone={() => setEditing(undefined)} />
          ) : (
            <div key={h.id} className={settingRow}>
              <div className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{h.name}</span>
                <span className="block truncate text-[12.5px] text-muted-foreground">
                  {h.destination ?? "This computer"}
                </span>
              </div>
              {h.destination && (
                <div className="flex shrink-0 gap-1">
                  <button type="button" className={quietButton} onClick={() => setEditing(h.id)}>
                    Edit
                  </button>
                  <button type="button" className={quietButton} onClick={() => void remove(h.id)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {editing === "new" ? (
          <HostForm onDone={() => setEditing(undefined)} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <Plus aria-hidden />
            Add host
          </button>
        )}
      </Section>
    </>
  );
}

const field =
  "mt-1 block w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] placeholder:text-faint-foreground";

/** Adds a host, or edits `host`. `onDone` runs once it's saved or cancelled. */
function HostForm({ host, onDone }: { host?: Host; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async (form: HTMLFormElement) => {
    // Text inputs' values are strings.
    const data = new FormData(form);
    setSaving(true);
    const input = {
      name: data.get("name") as string,
      destination: data.get("destination") as string,
    };
    const failed = await window.parallax.saveHost(input, host?.id);
    setSaving(false);
    if (failed) setError(failed);
    else onDone();
  };

  return (
    <form
      aria-label={host ? `Edit ${host.name}` : "Add host"}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
      className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
    >
      <label className="text-[12.5px] text-muted-foreground">
        Name
        <input name="name" defaultValue={host?.name} placeholder="Mac mini" className={field} />
      </label>
      <label className="text-[12.5px] text-muted-foreground">
        SSH destination
        <input
          name="destination"
          required
          defaultValue={host?.destination}
          placeholder="mac-mini, or me@192.168.1.20"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={field}
        />
        <span className="mt-1 block text-faint-foreground">
          Anything ssh accepts. Parallax uses your ssh config and keys.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={quietButton}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
        >
          {host ? "Save" : "Add host"}
        </button>
      </div>
    </form>
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

const statusDot = (cli: DetectedCli) =>
  !cli.installed ? "bg-faint-foreground" : cli.signedIn ? "bg-added" : "bg-warning";

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
  const picker = hosts.length > 1 && (
    <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      on
      <select
        aria-label="Host"
        value={host.id}
        onChange={(e) => setHostId(e.target.value)}
        className="rounded-md bg-transparent py-0.5 pr-1 font-medium text-foreground hover:bg-hover"
      >
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h1 className="mb-1.5 text-xl font-semibold">Providers</h1>
      <p className="mb-6 text-[13px] text-muted-foreground">
        The AI subscriptions your agents run on. Sign in to each vendor's CLI on the host, or add an
        API key as a fallback.
      </p>
      <HostProviders key={host.id} host={host} picker={picker} />
    </>
  );
}

/**
 * One host's providers: each CLI plxd detects there as a tab, and the chosen one's pane. Loads
 * once the host is connected; Refresh probes the CLIs again. Usage over the chosen period and
 * limits are kept live.
 */
function HostProviders({ host, picker }: { host: Host; picker: ReactNode }) {
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
        {picker || <span />}
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
          <div className="grid gap-6 @2xl:grid-cols-[15rem_minmax(0,1fr)] @2xl:items-start">
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
                    className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-hover aria-selected:bg-selected"
                  >
                    {Logo && <Logo className="mt-0.5 size-4 shrink-0" />}
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[13px] font-medium">
                          {cliInfo[cli.cli]?.name ?? cli.cli}
                        </span>
                        {cli.version && (
                          <span className="truncate font-mono text-[11.5px] text-faint-foreground">
                            {cli.version}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 rounded-full ${statusDot(cli)}`}
                        />
                        {cliStatus(cli)}
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
  const provider = backends[cli.cli]?.provider;
  const offered = provider ? models.filter((m) => m.provider === provider) : [];

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
          <span className="ml-auto truncate font-mono text-[12px] text-muted-foreground">
            {cli.version}
          </span>
        )}
      </div>
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
              hostId={hostId}
              cli={cli.cli}
              name={name}
              onExit={onSignedIn}
              onClose={() => onSignIn(false)}
            />
          </Suspense>
        )}
      </Section>
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
              className="rounded-md bg-red-600 px-2.5 py-1 text-[12.5px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-50"
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
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
        >
          Add key
        </button>
      </div>
    </form>
  );
}

/** A titled card of settings rows. `action` sits at the end of the title's line. */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mb-8">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-[12.5px] font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      <div className="rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}
