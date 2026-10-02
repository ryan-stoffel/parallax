import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { GithubStatus } from "../../protocol/generated/protocol";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts, type Host } from "../hosts";
import { GitHubLogo } from "../logos";
import { IconButton } from "../ui";
import { HostPicker, PageTitle, quietButton, Section, settingRow, StatusDot } from "./parts";

/**
 * Settings > Source control: GitHub on a host, through the `gh` CLI plxd runs there for pull
 * requests: whether it's installed, its version, and the account it's signed in to.
 */
export function SourceControlSettings() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  return (
    <>
      <PageTitle title="Source control">
        Parallax opens and follows pull requests with the GitHub CLI on each host.
      </PageTitle>
      <GitHub key={host.id} host={host} hosts={hosts} onHost={setHostId} />
    </>
  );
}

function GitHub({
  host,
  hosts,
  onHost,
}: {
  host: Host;
  hosts: Host[];
  onHost: (id: string) => void;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  // A plxd from before `github/status` can't say.
  const supported = connected && "githubStatus" in connection.capabilities;
  const [status, setStatus] = useState<GithubStatus>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    const answer = await window.parallax.request(host.id, "github/status", {});
    setChecking(false);
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setStatus(answer.result);
      setError(undefined);
    }
  }, [host.id]);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);

  let detail: string;
  let tone: "on" | "off" | "warn" = "warn";
  if (!connected) detail = connection ? statusLabel(connection) : "Connecting…";
  else if (!supported) detail = "Update plxd on this host to see GitHub here.";
  else if (error) detail = error;
  else if (!status) detail = "Checking…";
  else if (!status.installed) {
    detail = "Not installed. Install the GitHub CLI on this host to open pull requests.";
    tone = "off";
  } else if (status.signedIn === false)
    detail = "Not signed in. Run `gh auth login` on this host, then refresh.";
  else if (status.signedIn) {
    detail = status.account ? `Signed in as @${status.account}` : "Signed in";
    tone = "on";
  } else detail = status.note ?? "Couldn't tell whether gh is signed in.";

  return (
    <Section
      title="Hosting"
      action={
        <div className="flex items-center gap-2">
          <HostPicker hosts={hosts} value={host.id} onChange={onHost} />
          <IconButton label="Refresh" disabled={!supported || checking} onClick={() => void load()}>
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
              <span className="text-[13px] font-medium">GitHub</span>
              {status?.version && (
                <span className="truncate font-mono text-[11.5px] text-faint-foreground">
                  gh {status.version}
                </span>
              )}
            </span>
            <span
              role={error ? "alert" : undefined}
              className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
            >
              <StatusDot tone={tone} />
              {detail}
            </span>
          </div>
        </div>
        {status && !status.installed && (
          <a
            href="https://cli.github.com"
            target="_blank"
            rel="noreferrer"
            className={`${quietButton} flex shrink-0 items-center gap-1 [&_svg]:size-3.5`}
          >
            Install
            <ArrowUpRight aria-hidden />
          </a>
        )}
      </div>
    </Section>
  );
}
