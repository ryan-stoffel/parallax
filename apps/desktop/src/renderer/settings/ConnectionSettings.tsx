import { Pencil, Plus, Server } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { olderVersion, type ConnectionError, type ConnectionState } from "../../preload/bridge";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { DeviceIcon } from "../DeviceIcon";
import { localId, useHosts, type Host } from "../hosts";
import { IconButton } from "../ui";
import { ConnectSettings } from "./ConnectSettings";
import { LanSettings } from "./LanSettings";
import { SshHostDialog } from "./SshHostDialog";
import {
  PageTitle,
  primaryButton,
  quietButton,
  RenameForm,
  Row,
  Section,
  settingRow,
  StatusDot,
} from "./parts";

// xterm.js is large, so it loads when a sign-in first opens.
const SignInTerminal = lazy(() =>
  import("../SignInTerminal").then((m) => ({ default: m.SignInTerminal })),
);

/**
 * Whether a master can fix `error`: ssh was refused for lack of a login, or doesn't trust the
 * host's key yet, which the master's terminal asks about. Not a changed host key, which needs
 * known_hosts edited, or the other `sshSetup` failures.
 */
const signInFixes = ({ reason, exitCode, stderr = "" }: ConnectionError) =>
  reason === "sshSetup" &&
  exitCode === 255 &&
  !stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED") &&
  /Permission denied|Host key verification failed/.test(stderr);

/**
 * What Parallax can do about an SSH host's plxd (PLX-642): install it where none was found (exit
 * 127, after `LOCATE_PLXD`), or update one older than this app (`appVersion`), connected or not.
 * Nothing for a development build, which has no release to install.
 */
export function plxdFix(
  state: ConnectionState | undefined,
  appVersion: string | undefined,
): "install" | "update" | undefined {
  if (!appVersion || !/^\d+\.\d+\.\d+(-nightly)?$/.test(appVersion)) return undefined;
  if (state?.status === "failed" && state.error.exitCode === 127) return "install";
  const running = runningPlxd(state);
  return running !== undefined && olderVersion(running, appVersion) ? "update" : undefined;
}

/** The host's plxd version, when it answered or refused the handshake. */
const runningPlxd = (state?: ConnectionState) =>
  state?.status === "connected"
    ? state.plxd
    : state?.status === "failed"
      ? state.error.plxd
      : undefined;

const tone = (state?: ConnectionState) =>
  state?.status === "connected" ? "on" : state?.status === "failed" ? "warn" : "off";

/**
 * Settings > Connections: this computer, renamable, with its plxd and the app's version; then
 * Parallax Connect and its devices (0056); then pairing on the same network (PLX-641); then the
 * SSH hosts, which can be added, edited, and removed.
 */
export function ConnectionSettings() {
  const hosts = useHosts();
  const local = hosts.find((h) => h.id === localId)!;
  const remote = hosts.filter((h) => h.destination);
  // The host whose Add host dialog is open: its id, "new", or none.
  const [editing, setEditing] = useState<string>();
  const [appVersion, setAppVersion] = useState<string>();
  useEffect(() => void window.parallax.version().then(setAppVersion), []);
  const [removeError, setRemoveError] = useState<string>();
  const remove = async (id: string) => setRemoveError(await window.parallax.removeHost(id));

  return (
    <>
      <PageTitle title="Connections">
        Where your agents run: this computer, your other computers through Parallax Connect or on
        the same network, and machines you reach over SSH.
      </PageTitle>
      <LocalHost host={local} />
      <ConnectSettings />
      <LanSettings />

      <Section
        title="SSH hosts"
        action={
          <button
            type="button"
            onClick={() => setEditing("new")}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add host
          </button>
        }
      >
        {removeError && (
          <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
            {removeError}
          </p>
        )}
        {remote.map((h) => (
          <RemoteHost
            key={h.id}
            host={h}
            appVersion={appVersion}
            onEdit={() => setEditing(h.id)}
            onRemove={() => void remove(h.id)}
          />
        ))}
        {editing && (
          <SshHostDialog
            {...(editing !== "new" && { host: remote.find((h) => h.id === editing) })}
            onDone={() => setEditing(undefined)}
          />
        )}
        {!remote.length && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Server aria-hidden className="size-6 text-faint-foreground" />
            <p className="text-[13px] font-medium">No SSH hosts yet</p>
            <p className="max-w-sm text-[12.5px] text-muted-foreground">
              Add a machine you reach over SSH, such as a Mac mini, to run agents there. Parallax
              can install plxd on it.
            </p>
          </div>
        )}
      </Section>
    </>
  );
}

/** This computer: its name, which Rename edits in place, and its plxd. */
function LocalHost({ host }: { host: Host }) {
  const state = useConnection(host.id);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string>();
  const rename = async (name: string) => {
    const failed = await window.parallax.renameLocal(name);
    setError(failed);
    if (!failed) setRenaming(false);
  };

  return (
    <section aria-label="This computer" className="mb-8">
      <div className="mb-2 flex min-h-7 items-center gap-2 text-[13px] text-muted-foreground [&_svg]:size-4">
        <DeviceIcon icon={host.icon ?? "laptop"} />
        {renaming ? (
          <RenameForm
            label="Computer name"
            value={host.name}
            onSave={(name) => void rename(name)}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="font-medium text-foreground">{host.name}</span>
            <IconButton label="Rename this computer" onClick={() => setRenaming(true)}>
              <Pencil aria-hidden />
            </IconButton>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="rounded-xl border border-border bg-surface">
        <Row
          title="Local plxd"
          description="Runs agents on this computer. Parallax starts it and keeps it connected."
        >
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <StatusDot tone={tone(state)} />
            {state ? statusLabel(state) : "Connecting…"}
            {state?.status === "connected" && (
              <span className="font-mono text-[12px]">· {state.plxd}</span>
            )}
          </span>
        </Row>
      </div>
    </section>
  );
}

/**
 * A saved SSH host: its connection, destination, and Edit and Remove. A host that failed for want
 * of a login or a trusted host key (`signInFixes`) has Sign in, which opens the terminal where ssh
 * asks for a password or the key (0007), then connects it. Windows' OpenSSH can't share a login,
 * so it has none. A host without plxd, or with one older than the app, has Install or Update
 * plxd (`plxdFix`), which installs this app's plxd there in one click.
 */
function RemoteHost({
  host,
  appVersion,
  onEdit,
  onRemove,
}: {
  host: Host;
  appVersion: string | undefined;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const state = useConnection(host.id);
  const [signingIn, setSigningIn] = useState(false);
  const fix = plxdFix(state, appVersion);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string>();
  const install = async () => {
    setInstalling(true);
    setInstallError(await window.parallax.installPlxd(host.id));
    setInstalling(false);
  };
  const canSignIn =
    window.parallax.platform !== "win32" && state?.status === "failed" && signInFixes(state.error);
  useEffect(() => {
    if (state?.status === "connected") setSigningIn(false);
  }, [state?.status]);
  return (
    <>
      <div className={settingRow}>
        <div className="min-w-0">
          <span className="flex items-center gap-2 text-[13px] font-medium">
            <StatusDot tone={tone(state)} />
            <span className="truncate">{host.name}</span>
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            <span className="font-mono">{host.destination}</span>
            {state && ` · ${statusLabel(state)}`}
            {state?.status === "connected" && ` · plxd ${state.plxd}`}
          </span>
          {fix && (
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {fix === "install"
                ? `plxd isn't on ${host.name}. `
                : `${host.name} runs plxd ${runningPlxd(state)}, older than this app. `}
              {fix === "install" ? "Install" : "Update"} downloads plxd {appVersion} there from
              GitHub, checks its SHA256, and puts it in ~/.parallax-plxd
              {fix === "update" && ", then restarts plxd, which stops its running agents"}.
            </p>
          )}
          {installError && (
            <p role="alert" className="mt-1 text-[12.5px] text-danger">
              {installError}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {fix && (
            <button
              type="button"
              className={primaryButton}
              disabled={installing}
              onClick={() => void install()}
            >
              {installing ? "Installing…" : fix === "install" ? "Install plxd" : "Update plxd"}
            </button>
          )}
          {canSignIn && !signingIn && (
            <button type="button" className={quietButton} onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          )}
          <button type="button" className={quietButton} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={quietButton} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {signingIn && (
        <Suspense>
          <SignInTerminal
            target={{ hostId: host.id, login: true }}
            name={host.name}
            onExit={() => void window.parallax.retry(host.id)}
            onClose={() => setSigningIn(false)}
          />
        </Suspense>
      )}
    </>
  );
}
