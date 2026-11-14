import { t } from "i18next";
import { ArrowUpRight, Check, Copy, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { msg } from "../../i18n";
import type { RpcError } from "../../preload/bridge";
import type { GithubStatus, PrMergeMethod } from "../../protocol/generated/protocol";
import { useCopy } from "../AgentChat";
import { statusLabel, useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { locale } from "../locale";
import { GitHubLogo } from "../logos";
import { notify } from "../notifications";
import { IconButton, Picker } from "../ui";
import {
  allHosts,
  HostPicker,
  hostsOf,
  PageTitle,
  primaryButton,
  quietButton,
  Row,
  Section,
  settingRow,
  StatusDot,
  Switch,
} from "./parts";
import { behaviorPrefs, clockOptions, setBehaviorPrefs, type BehaviorPrefs } from "../prefs";
import { githubLine } from "./shared";

/** How often the status is read while plxd installs `gh` or waits on a sign-in. */
const POLL_MS = 2000;

/**
 * Settings > Source control: GitHub on a host, through the `gh` CLI plxd runs there for pull
 * requests: whether it's installed, its version, and the account it's signed in to. On a plxd with
 * `githubSetup` (PLX-423), the row installs `gh` and signs it in. `hostId` picks the host it opens
 * on, as Set up GitHub does; every computer otherwise.
 */
export function SourceControlSettings({ hostId: opened }: { hostId?: string }) {
  const hosts = useHosts();
  const [scope, setScope] = useState(opened ?? allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <>
      <PageTitle title={t("Source control")}>
        {t(
          "Parallax opens and follows pull requests with the GitHub CLI on each host. How worktrees and branches work is in Worktrees.",
        )}
      </PageTitle>
      {targets.map((host, i) => (
        <GitHub
          key={host.id}
          host={host}
          title={targets.length > 1 ? t("Hosting on {{host}}", { host: host.name }) : t("Hosting")}
          picker={i === 0 && <HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
        />
      ))}
      <PullRequests />
    </>
  );
}

const mergeMethods: { value: PrMergeMethod | "default"; label: string; description?: string }[] = [
  {
    value: "default",
    label: msg("Repository's first"),
    description: msg("Whichever the repository lists first."),
  },
  { value: "squash", label: msg("Squash and merge") },
  { value: "merge", label: msg("Create a merge commit") },
  { value: "rebase", label: msg("Rebase and merge") },
];

/** How pull requests open and merge, on this computer. */
function PullRequests() {
  const prefs = behaviorPrefs.use();
  const mac = window.parallax.platform === "darwin";
  return (
    <Section title={t("Pull requests")}>
      <Row title={t("Open pull requests in")} description={t("Where Open on GitHub goes.")}>
        <Picker
          field
          label={t("Open pull requests in")}
          value={prefs.openPrsIn}
          onChange={(v) => setBehaviorPrefs({ openPrsIn: v as BehaviorPrefs["openPrsIn"] })}
          options={[
            { value: "external", label: t("System browser") },
            { value: "browser", label: t("Side panel browser") },
          ]}
          align="end"
          className="w-56"
          panelClassName="min-w-56"
        />
      </Row>
      <Row
        title={t("Click a pull request link to")}
        description={t("A link to the thread's pull request. {{click}} does the other.", {
          click: mac ? "⌘-click" : "Ctrl+click",
        })}
      >
        <Picker
          field
          label={t("Click a pull request link to")}
          value={prefs.prLinkClick}
          onChange={(v) => setBehaviorPrefs({ prLinkClick: v as BehaviorPrefs["prLinkClick"] })}
          options={[
            { value: "parallax", label: t("Open in Parallax") },
            { value: "github", label: t("Open on GitHub") },
          ]}
          align="end"
          className="w-56"
          panelClassName="min-w-56"
        />
      </Row>
      <Row
        title={t("Merge method")}
        description={t(
          "What a pull request's merge box starts on, where the repository allows it.",
        )}
      >
        <Picker
          field
          label={t("Merge method")}
          value={prefs.mergeMethod ?? "default"}
          onChange={(v) =>
            setBehaviorPrefs({ mergeMethod: v === "default" ? undefined : (v as PrMergeMethod) })
          }
          options={mergeMethods.map((m) => ({
            ...m,
            label: t(m.label),
            description: m.description && t(m.description),
          }))}
          align="end"
          className="w-56"
          panelClassName="w-72"
        />
      </Row>
      <Row
        title={t("Delete branch on merge")}
        description={t("Whether the merge box's Delete branch starts checked.")}
      >
        <Switch
          label={t("Delete branch on merge")}
          checked={prefs.deleteBranchOnMerge}
          onChange={(deleteBranchOnMerge) => setBehaviorPrefs({ deleteBranchOnMerge })}
        />
      </Row>
    </Section>
  );
}

function GitHub({
  host,
  title,
  picker,
}: {
  host: Host;
  title: string;
  /** Which computer's it shows, beside the first's title. */
  picker: ReactNode;
}) {
  const connection = useShownConnection(host.id);
  const connected = connection?.status === "connected";
  // A plxd from before `github/status` can't say, and one from before `githubSetup` can't set up.
  const supported = connected && "githubStatus" in connection.capabilities;
  const connectedNow = useConnectedNow(host.id);
  const setup = connected && "githubSetup" in connection.capabilities;
  const [status, setStatus] = useState<GithubStatus>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  // Why Install, Sign in, or Cancel was refused. Why one that ran didn't finish, or what of it
  // failed, is plxd's `setupNote`, which stays under the row.
  const refused = (title: string, error: RpcError) =>
    notify({ key: `github/${host.id}`, tone: "error", title, body: describeError(error) });
  const [starting, setStarting] = useState(false);
  const [copied, copy] = useCopy();

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setChecking(true);
      const answer = await window.parallax.request(host.id, "github/status", {});
      if (!quiet) setChecking(false);
      if ("error" in answer) setError(describeError(answer.error));
      else {
        setStatus(answer.result);
        setError(undefined);
      }
    },
    [host.id],
  );
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);
  // The row moves on by itself once the install ends or the browser approves the code.
  const waiting = !!status?.installing || !!status?.signingIn;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  // An install or sign-in that ends is news, as a notification (PLX-507).
  const before = useRef<GithubStatus>(undefined);
  useEffect(() => {
    const was = before.current;
    before.current = status;
    if (!was || !status) return;
    const key = `github/${host.id}`;
    const on = t("On {{host}}.", { host: host.name });
    if (was.installing && !status.installing)
      notify(
        status.installed
          ? { key, tone: "success", title: t("GitHub CLI installed"), body: on }
          : {
              key,
              tone: "error",
              title: t("Couldn't install the GitHub CLI"),
              body: status.setupNote,
            },
      );
    else if (was.signingIn && !status.signingIn)
      if (status.signedIn)
        notify({
          key,
          tone: "success",
          title: t("Signed in to GitHub"),
          body: status.account ? `${t("As @{{account}}.", { account: status.account })} ${on}` : on,
        });
      else if (status.setupNote)
        notify({
          key,
          tone: "error",
          title: t("GitHub sign-in didn't finish"),
          body: status.setupNote,
        });
  }, [status, host.id, host.name]);

  const install = async () => {
    const answer = await window.parallax.request(host.id, "github/install", {});
    if ("error" in answer) refused(t("Couldn't install the GitHub CLI"), answer.error);
    else setStatus(answer.result);
  };
  const signIn = async () => {
    setStarting(true);
    const answer = await window.parallax.request(host.id, "github/signIn", {});
    setStarting(false);
    if ("error" in answer) return refused(t("Couldn't sign in to GitHub"), answer.error);
    setStatus((s) => s && { ...s, signingIn: answer.result, setupNote: undefined });
    // The device page opens here even for an SSH host, whose browser is this computer's.
    window.open(answer.result.url, "_blank");
  };
  const cancel = async () => {
    const answer = await window.parallax.request(host.id, "github/signInCancel", {});
    if ("error" in answer) refused(t("Couldn't cancel the GitHub sign-in"), answer.error);
    await load(true);
  };

  let detail: string;
  let tone: "on" | "off" | "warn" = "warn";
  if (!connected) detail = connection ? statusLabel(connection) : t("Connecting…");
  else if (!supported) detail = t("Update plxd on this host to see GitHub here.");
  else if (error) detail = error;
  else if (!status) detail = t("Checking…");
  else ({ detail, tone } = githubLine(status, setup));

  let action: ReactNode = null;
  if (status && !error && setup) {
    if (status.installing)
      action = (
        <span className={`${quietButton} flex items-center gap-1.5 [&_svg]:size-3.5`}>
          <LoaderCircle aria-hidden className="animate-spin" />
          {t("Installing")}
        </span>
      );
    else if (!status.installed)
      action = (
        <button type="button" className={primaryButton} onClick={() => void install()}>
          {t("Install")}
        </button>
      );
    else if (status.signingIn)
      action = (
        <button type="button" className={quietButton} onClick={() => void cancel()}>
          {t("Cancel")}
        </button>
      );
    else if (status.signedIn === false)
      action = (
        <button
          type="button"
          className={primaryButton}
          disabled={starting}
          onClick={() => void signIn()}
        >
          {starting ? t("Starting…") : t("Sign in")}
        </button>
      );
  } else if (status && !status.installed)
    action = (
      <a
        href="https://cli.github.com"
        target="_blank"
        rel="noreferrer"
        className={`${quietButton} flex shrink-0 items-center gap-1 [&_svg]:size-3.5`}
      >
        {t("Install")}
        <ArrowUpRight aria-hidden />
      </a>
    );

  const pending = setup ? status?.signingIn : undefined;
  const note = setup ? status?.setupNote : undefined;
  return (
    <Section
      title={title}
      action={
        <div className="flex items-center gap-2">
          {picker}
          <IconButton
            label={t("Refresh")}
            disabled={!supported || checking}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
          </IconButton>
        </div>
      }
    >
      <div className={settingRow}>
        <div className="flex min-w-0 items-start gap-3">
          <GitHubLogo className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="text-body font-medium">GitHub</span>
              {status?.version && (
                <span className="truncate font-mono text-meta text-faint-foreground">
                  gh {status.version}
                  {status.managed && ` · ${t("installed by Parallax")}`}
                </span>
              )}
            </span>
            <span
              role={error ? "alert" : undefined}
              className="flex items-center gap-1.5 text-body text-muted-foreground"
            >
              <StatusDot tone={tone} />
              {detail}
            </span>
            {note && (
              <span role="alert" className="mt-1 block text-body text-warning">
                {note}
              </span>
            )}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {pending && (
        <div className={`${settingRow} flex-wrap`}>
          <div className="min-w-0">
            <span className="block text-body text-muted-foreground">
              {t("Enter this code at {{url}}. It expires at {{time}}.", {
                url: pending.url.replace(/^https:\/\//, ""),
                time: new Date(pending.expiresAt).toLocaleTimeString(locale(), clockOptions()),
              })}
            </span>
            <span
              aria-label={t("One-time code")}
              className="mt-1 block font-mono text-heading font-semibold tracking-widest select-all"
            >
              {pending.code}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
              onClick={() => copy(pending.code)}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? t("Copied") : t("Copy")}
            </button>
            <button
              type="button"
              className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
              onClick={() => window.open(pending.url, "_blank")}
            >
              {t("Open GitHub")}
              <ArrowUpRight aria-hidden />
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
