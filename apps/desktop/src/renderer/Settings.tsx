import { ArrowUpRight, Monitor, Moon, Plus, Sun } from "lucide-react";
import { Fragment, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";

import type { RpcError, ThemePreference, UpdateChannel } from "../preload/bridge";
import {
  ErrorCodes,
  type CliKind,
  type DetectedCli,
  type KeyAccount,
  type Provider,
} from "../protocol/generated/protocol";
import type { SettingsSection } from "./App";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { useHosts, type Host } from "./hosts";
import { segment, Segmented } from "./ui";
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
      <div className="mx-auto max-w-2xl px-8 pt-6 pb-16">
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

/** The vendor CLIs plxd detects (0004), by `CliKind`, and where each says how to install it. */
const cliInfo: Record<string, { name: string; install: string }> = {
  claude: { name: "Claude Code", install: "https://code.claude.com/docs/en/setup" },
  codex: { name: "Codex", install: "https://learn.chatgpt.com/docs/codex/cli" },
  cursor: { name: "Cursor", install: "https://cursor.com/docs/cli/installation" },
};

const providerNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  cursor: "Cursor",
};
/** The providers a key can be added for. Not Cursor: 0004 rules out `CURSOR_API_KEY` as a fallback. */
const keyProviders: Provider[] = ["anthropic", "openai"];

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

/** Settings > Providers: each host's vendor CLIs and API keys, with each one's usage. */
function ProvidersSettings() {
  const hosts = useHosts();
  // The one sign-in terminal, across every host: the app runs one per window.
  const [signIn, setSignIn] = useState<{ hostId: string; cli: CliKind }>();
  const [period, setPeriod] = useState<Period>("today");
  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Providers</h1>
        <Segmented label="Usage period" options={periods} value={period} onChange={setPeriod} />
      </div>
      <p className="mb-6 text-[13px] text-muted-foreground">
        The AI subscriptions your agents run on. Sign in to each vendor's CLI on the host, or add an
        API key as a fallback.
      </p>
      {hosts.map((h) => (
        <HostAccounts
          key={h.id}
          host={h}
          period={period}
          signingIn={signIn?.hostId === h.id ? signIn.cli : undefined}
          onSignIn={(cli) => setSignIn(cli && { hostId: h.id, cli })}
        />
      ))}
    </>
  );
}

/**
 * One host's accounts: each CLI plxd detects there, then its API keys, which can be added and
 * removed, each with its usage over `period` and its limits, kept live. Loads once the host is
 * connected; Refresh probes the CLIs again. A CLI that isn't signed in signs in in a terminal
 * under its row (`signingIn`), and the CLIs are probed again when it ends.
 */
function HostAccounts({
  host,
  period,
  signingIn,
  onSignIn,
}: {
  host: Host;
  period: Period;
  signingIn?: CliKind;
  /** Opens a CLI's sign-in terminal, or closes it with undefined. */
  onSignIn: (cli?: CliKind) => void;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const [detected, setDetected] = useState<DetectedCli[]>();
  const [keys, setKeys] = useState<KeyAccount[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  // By account id: a subscription's is its CLI's kind, the backend that runs it (0012).
  const { usage } = useUsage(host.id, connected);
  const usageOf = (id: string) => usage && <UsageLines usage={usage.get(id)} period={period} />;

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
      if ("result" in clis) setDetected(clis.result.clis);
      const failed = "error" in clis ? clis.error : "error" in keyList ? keyList.error : undefined;
      setError(failed && accountsError(failed));
    },
    [host.id],
  );
  useEffect(() => {
    if (connected) void load("accounts/list");
  }, [connected, load]);

  const refresh = (
    <button
      type="button"
      disabled={!connected || checking}
      onClick={() => void load("accounts/refresh")}
      className={`${quietButton} -my-1 disabled:opacity-50`}
    >
      Refresh
    </button>
  );

  return (
    <Section title={host.name} action={refresh}>
      {!connected ? (
        <p className={`${settingRow} text-muted-foreground`}>
          {connection ? statusLabel(connection) : "Connecting…"}
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
              {error}
            </p>
          )}
          {!detected && !error && (
            <p className={`${settingRow} text-muted-foreground`}>Checking…</p>
          )}
          {detected?.map((cli) => (
            <Fragment key={cli.cli}>
              <CliRow
                cli={cli}
                usage={cli.installed && usageOf(cli.cli)}
                onSignIn={signingIn === cli.cli ? undefined : () => onSignIn(cli.cli)}
              />
              {signingIn === cli.cli && (
                <Suspense>
                  <SignInTerminal
                    hostId={host.id}
                    cli={cli.cli}
                    name={cliInfo[cli.cli]?.name ?? cli.cli}
                    onExit={() => void load("accounts/refresh")}
                    onClose={() => onSignIn(undefined)}
                  />
                </Suspense>
              )}
            </Fragment>
          ))}
          {keys?.map((account) => (
            <KeyRow
              key={account.id}
              hostId={host.id}
              account={account}
              usage={usageOf(account.id)}
              onRemoved={() => setKeys((all) => all?.filter((k) => k.id !== account.id))}
            />
          ))}
          {keys &&
            (adding ? (
              <KeyForm
                hostId={host.id}
                onDone={(account) => {
                  setAdding(false);
                  if (account) setKeys((all) => [...(all ?? []), account]);
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
            ))}
        </>
      )}
    </Section>
  );
}

/**
 * A detected CLI: its version and plan, its `usage` lines, and whether it's signed in, or where
 * to install it. A known CLI that isn't signed in offers Sign in, while `onSignIn` is given.
 */
function CliRow({
  cli,
  usage,
  onSignIn,
}: {
  cli: DetectedCli;
  usage?: ReactNode;
  onSignIn?: () => void;
}) {
  const info = cliInfo[cli.cli];
  // Plans come as the vendor writes them, such as Claude's "max".
  const plan = cli.plan && cli.plan[0]!.toUpperCase() + cli.plan.slice(1);
  const details = cli.installed
    ? [cli.version, plan].filter(Boolean).join(" · ") || "Installed"
    : "Not installed";
  let status: ReactNode;
  if (!cli.installed)
    status = info && (
      <a
        href={info.install}
        target="_blank"
        rel="noreferrer"
        className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
      >
        Install
        <ArrowUpRight aria-hidden />
      </a>
    );
  else if (cli.signedIn === true) status = <span className="text-foreground">Signed in</span>;
  else {
    status = (
      <span className="flex items-center gap-2">
        {cli.signedIn === false ? (
          "Not signed in"
        ) : (
          // plxd couldn't tell; its note says why.
          <span title={cli.note}>Sign-in unknown</span>
        )}
        {info && onSignIn && (
          <button
            type="button"
            aria-label={`Sign in to ${info.name}`}
            onClick={onSignIn}
            className={`${quietButton} -my-1`}
          >
            Sign in
          </button>
        )}
      </span>
    );
  }

  return (
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{info?.name ?? cli.cli}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">{details}</span>
        {usage}
      </div>
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{status}</span>
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
 * Adds an API key on a host. The key is read from its field once, then the field is cleared:
 * plxd keeps it in the host's keychain and only ever answers with its masked form. `onDone`
 * gets the new account, or nothing when cancelled.
 */
function KeyForm({ hostId, onDone }: { hostId: string; onDone: (account?: KeyAccount) => void }) {
  // One id while the form is open, so sending it again can't store the key twice (0007).
  const [id] = useState(uuidv7);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const keyField = form.elements.namedItem("key") as HTMLInputElement;
    const params = {
      id,
      provider: data.get("provider") as Provider,
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
        Provider
        <select name="provider" className={field}>
          {keyProviders.map((p) => (
            <option key={p} value={p}>
              {providerNames[p]}
            </option>
          ))}
        </select>
      </label>
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
