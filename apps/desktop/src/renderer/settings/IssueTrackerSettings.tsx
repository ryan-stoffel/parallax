import { t } from "i18next";
import { ArrowUpRight, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import type {
  IssueConnectParams,
  IssueConnection,
  IssueProvider,
} from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { knownConnections, providerNames } from "../issues";
import { notify } from "../notifications";
import { TrackerLogo } from "../TrackerLogo";
import {
  allHosts,
  ConfirmRemove,
  field,
  HostPicker,
  hostsOf,
  outlineButton,
  PageTitle,
  primaryButton,
  quietButton,
  StatusDot,
} from "./parts";
import { anchorOf } from "./search";

const LINEAR_KEYS = "https://linear.app/settings/account/security";
const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Settings > Issue trackers (0107): the accounts each computer reads issues with, for the Issues
 * page. GitHub is the computer's `gh` sign-in, which Source control sets up. Linear takes a
 * personal API key, and Jira a site, an email, and an API token; plxd checks each with its tracker
 * and keeps the token in the computer's keychain. `hostId` picks the computer it opens on; every
 * computer otherwise.
 */
export function IssueTrackerSettings({
  hostId: opened,
  onSourceControl,
}: {
  hostId?: string;
  /** Opens Settings > Source control on a computer, where GitHub signs in. */
  onSourceControl: (hostId: string) => void;
}) {
  const hosts = useHosts();
  const [scope, setScope] = useState(opened ?? allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <>
      <PageTitle title={t("Issue trackers")}>
        {t(
          "The GitHub, Linear, and Jira accounts each computer reads your issues with. The Issues page lists the open ones assigned to you.",
        )}
      </PageTitle>
      {targets.map((host, i) => (
        <HostTrackers
          key={host.id}
          host={host}
          title={
            targets.length > 1 ? t("Trackers on {{host}}", { host: host.name }) : t("Trackers")
          }
          picker={i === 0 && <HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
          onSourceControl={() => onSourceControl(host.id)}
        />
      ))}
    </>
  );
}

const card = "mb-3 rounded-xl border border-border/50 bg-(--pane-card)";
const logoTile = "grid size-8 shrink-0 place-items-center rounded-lg bg-hover [&_svg]:size-4";

/** One computer's trackers: a card each for GitHub, Linear, and Jira. */
function HostTrackers({
  host,
  title,
  picker,
  onSourceControl,
}: {
  host: Host;
  title: string;
  picker: ReactNode;
  onSourceControl: () => void;
}) {
  const hostId = host.id;
  const connection = useShownConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "issues" in connection.capabilities;
  const connectedNow = useConnectedNow(hostId);
  const [accounts, setAccounts] = useState<IssueConnection[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The tracker whose form is open.
  const [adding, setAdding] = useState<IssueProvider>();
  // The id of the account whose disconnect is waiting to be confirmed.
  const [removing, setRemoving] = useState<string>();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "issue/connections", {});
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setAccounts(knownConnections(answer.result.connections));
      setError(undefined);
    }
  }, [hostId]);
  useEffect(() => {
    setAccounts(undefined);
    setError(undefined);
  }, [supported, hostId]);
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);

  const connect = async (params: IssueConnectParams) => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "issue/connect", params);
    setBusy(false);
    if ("error" in answer) {
      notify({
        tone: "error",
        title: t("Couldn't connect {{tracker}}", { tracker: providerNames[params.provider] }),
        body: describeError(answer.error),
      });
      return;
    }
    setAdding(undefined);
    void load();
  };
  const disconnect = async (account: IssueConnection) => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "issue/disconnect", { id: account.id });
    setBusy(false);
    setRemoving(undefined);
    if ("error" in answer)
      notify({
        tone: "error",
        title: t("Couldn't disconnect {{tracker}}", { tracker: providerNames[account.provider] }),
        body: describeError(answer.error),
      });
    void load();
  };

  const status = !connected
    ? t("Not connected")
    : !supported
      ? t("Update Parallax on this computer to connect issue trackers.")
      : error && !accounts
        ? error
        : accounts === undefined
          ? t("Loading…")
          : undefined;
  const of = (provider: IssueProvider) => accounts?.filter((a) => a.provider === provider) ?? [];
  const github = of("github")[0];
  // A tracker's saved accounts and its form, under its card's first row.
  const saved = (provider: "linear" | "jira") => (
    <>
      {of(provider).map((account) => (
        <div
          key={account.id}
          className="flex min-h-12 items-center gap-3 border-t border-border/40 py-2 pr-4 pl-15"
        >
          <div className="min-w-0 flex-1">
            <span className="block truncate text-body">{account.account}</span>
            {account.site && (
              <span className="block truncate text-meta text-muted-foreground">{account.site}</span>
            )}
          </div>
          {removing === account.id ? (
            <div className="flex shrink-0 items-center gap-2">
              <ConfirmRemove
                label={t("Disconnect")}
                disabled={busy}
                onRemove={() => void disconnect(account)}
                onCancel={() => setRemoving(undefined)}
              />
            </div>
          ) : (
            <button
              type="button"
              className={quietButton}
              aria-label={t("Disconnect {{account}}", { account: account.account })}
              onClick={() => setRemoving(account.id)}
            >
              {t("Disconnect")}
            </button>
          )}
        </div>
      ))}
      {adding === provider && (
        <ConnectForm
          provider={provider}
          busy={busy}
          onConnect={connect}
          onCancel={() => setAdding(undefined)}
        />
      )}
    </>
  );
  const add = (provider: "linear" | "jira") =>
    adding !== provider && (
      <button type="button" onClick={() => setAdding(provider)} className={outlineButton}>
        <Plus aria-hidden />
        {of(provider).length ? t("Add account") : t("Connect")}
      </button>
    );
  return (
    <section
      aria-label={title}
      data-setting={anchorOf(t("Trackers"))}
      className="mb-10 scroll-mt-6"
    >
      <div className="mb-3 flex min-h-7 items-center justify-between gap-4">
        <h2 className="text-reading font-semibold">{title}</h2>
        {picker}
      </div>
      {status ? (
        <div className={card}>
          <p className="px-4 py-3 text-body text-muted-foreground">{status}</p>
        </div>
      ) : (
        <>
          <TrackerCard
            provider="github"
            on={!!github}
            detail={
              github
                ? t("Signed in as @{{account}}", { account: github.account })
                : t("Uses this computer's GitHub sign-in, in Source control.")
            }
            action={
              <button type="button" onClick={onSourceControl} className={outlineButton}>
                {github ? t("Manage") : t("Sign in")}
              </button>
            }
          />
          <TrackerCard
            provider="linear"
            on={of("linear").length > 0}
            detail={of("linear").length ? t("Connected") : t("Connects with a personal API key.")}
            action={add("linear")}
          >
            {saved("linear")}
          </TrackerCard>
          <TrackerCard
            provider="jira"
            on={of("jira").length > 0}
            detail={
              of("jira").length
                ? t("Connected")
                : t("Connects to a Jira Cloud site with your email and an API token.")
            }
            action={add("jira")}
          >
            {saved("jira")}
          </TrackerCard>
        </>
      )}
      {error && accounts && (
        <p role="alert" className="px-4 py-1 text-body text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** A tracker's card: its logo, its name, whether it's connected, and its one action. */
function TrackerCard({
  provider,
  on,
  detail,
  action,
  children,
}: {
  provider: IssueProvider;
  on: boolean;
  detail: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-setting={anchorOf(providerNames[provider])} className={card}>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span aria-hidden className={logoTile}>
          <TrackerLogo provider={provider} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block text-body font-medium">{providerNames[provider]}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
            <StatusDot tone={on ? "on" : "off"} />
            {detail}
          </span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

const fieldLabel = "block text-body font-medium";

/**
 * The form that connects a Linear or Jira account. A token stays in its field, never in state.
 * Escape cancels.
 */
function ConnectForm({
  provider,
  busy,
  onConnect,
  onCancel,
}: {
  provider: "linear" | "jira";
  busy: boolean;
  onConnect: (params: IssueConnectParams) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const name = providerNames[provider];
  return (
    <form
      aria-label={t("Connect {{tracker}}", { tracker: name })}
      onSubmit={(e) => {
        e.preventDefault();
        const value = (field: string) =>
          (e.currentTarget.elements.namedItem(field) as HTMLInputElement).value.trim();
        onConnect(
          provider === "linear"
            ? { provider, apiKey: value("token") }
            : { provider, site: value("site"), email: value("email"), apiToken: value("token") },
        );
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Not Settings' too.
        e.preventDefault();
        onCancel();
      }}
      className="flex flex-col gap-4 border-t border-border/40 py-4 pr-4 pl-15"
    >
      {provider === "jira" && (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}site`} className={fieldLabel}>
              {t("Site")}
            </label>
            <input
              id={`${id}site`}
              name="site"
              required
              autoFocus
              placeholder="acme.atlassian.net"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className={field}
            />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}email`} className={fieldLabel}>
              {t("Email")}
            </label>
            <input
              id={`${id}email`}
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="off"
              className={field}
            />
          </div>
        </div>
      )}
      <div>
        <label htmlFor={`${id}token`} className={fieldLabel}>
          {provider === "linear" ? t("API key") : t("API token")}
        </label>
        <input
          id={`${id}token`}
          name="token"
          type="password"
          required
          autoFocus={provider === "linear"}
          spellCheck={false}
          autoComplete="off"
          className={`${field} font-mono`}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <a
          href={provider === "linear" ? LINEAR_KEYS : JIRA_TOKENS}
          target="_blank"
          rel="noreferrer"
          className="mr-auto inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground hover:underline"
        >
          {provider === "linear" ? t("Create an API key in Linear") : t("Create an API token")}
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
        <button type="button" onClick={onCancel} className={quietButton}>
          {t("Cancel")}
        </button>
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? t("Connecting…") : t("Connect")}
        </button>
      </div>
    </form>
  );
}
