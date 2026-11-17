import { t } from "i18next";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { IssueConnection, IssueProvider } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { knownConnections, providerNames } from "../issues";
import { notify } from "../notifications";
import { TrackerLogo } from "../TrackerLogo";
import {
  allHosts,
  ConfirmRemove,
  HostPicker,
  hostsOf,
  outlineButton,
  PageTitle,
  quietButton,
  StatusDot,
} from "./parts";
import { anchorOf } from "./search";
import { TrackerSetupDialog } from "./TrackerSetupDialog";

/**
 * Settings > Issue trackers (0107): the accounts each computer reads issues with, for the Issues
 * page. A tracker with no account is its card and Set up, which opens that tracker's own dialog
 * (TrackerSetupDialog). One with accounts lists them, each with Disconnect, and Add account opens
 * the same dialog. GitHub is the computer's `gh` sign-in, which Source control manages. `hostId`
 * picks the computer it opens on; every computer otherwise.
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
  // The tracker whose set-up dialog is open.
  const [setting, setSetting] = useState<IssueProvider>();
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
  const setUp = (provider: IssueProvider) => (
    <button type="button" onClick={() => setSetting(provider)} className={outlineButton}>
      {of(provider).length > 0 && <Plus aria-hidden />}
      {of(provider).length ? t("Add account") : t("Set up")}
    </button>
  );
  // A tracker's saved accounts, under its card's first row.
  const saved = (provider: "linear" | "jira") =>
    of(provider).map((account) => (
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
    ));
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
              github ? (
                <button type="button" onClick={onSourceControl} className={outlineButton}>
                  {t("Manage")}
                </button>
              ) : (
                setUp("github")
              )
            }
          />
          <TrackerCard
            provider="linear"
            on={of("linear").length > 0}
            detail={of("linear").length ? t("Connected") : t("Connects with a personal API key.")}
            action={setUp("linear")}
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
            action={setUp("jira")}
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
      {setting && (
        <TrackerSetupDialog
          provider={setting}
          hostId={hostId}
          onSourceControl={onSourceControl}
          onConnected={() => void load()}
          onDone={() => setSetting(undefined)}
        />
      )}
    </section>
  );
}

/**
 * A tracker's card: its logo, its name, a line saying how it connects or that it has, and its one
 * action. Its accounts, as `children`, list under that row.
 */
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
            {on && <StatusDot tone="on" />}
            {detail}
          </span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
