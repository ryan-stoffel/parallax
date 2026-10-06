import { Check, Network, Pencil, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  DEVICE_ICONS,
  type ConnectState,
  type DeviceIcon as DeviceIconName,
} from "../../preload/bridge";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { ConnectWizard } from "../ConnectWizard";
import { DeviceIcon, deviceIconNames } from "../DeviceIcon";
import { localId, useConnect, useHosts, type Host } from "../hosts";
import { IconButton, menuItem, menuPanel } from "../ui";
import { primaryButton, quietButton, Row, Section, settingRow, StatusDot, Switch } from "./parts";

/**
 * Settings > Connections' Parallax Connect section (0056): Install puts plx-connect on this
 * computer, then a switch turns Connect on, which opens Add computer. While it's on, this
 * computer and every device found on the tailnet are listed with their health, and each one's
 * name and icon can be changed, on that device's own plxd.
 */
export function ConnectSettings() {
  const connect = useConnect();
  const hosts = useHosts();
  const [adding, setAdding] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const devices = hosts.filter((h) => h.device);
  const local = hosts.find((h) => h.id === localId)!;

  const install = async () => {
    setInstalling(true);
    setError(await window.parallax.installConnect());
    setInstalling(false);
  };
  const toggle = async (on: boolean) => {
    const failed = await window.parallax.setConnect(on);
    setError(failed);
    if (!failed && on) setAdding(true);
  };

  return (
    <Section
      title="Parallax Connect"
      action={
        connect?.on && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add computer
          </button>
        )
      }
    >
      <Row
        title="Parallax Connect"
        description="Set up your other computers over Tailscale, and see every computer's threads live from any of them."
      >
        <ConnectControl
          connect={connect}
          installing={installing}
          onInstall={() => void install()}
          onToggle={(on) => void toggle(on)}
        />
      </Row>
      {error && (
        <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
          {error}
        </p>
      )}
      {connect?.on && (
        <>
          <DeviceRow host={{ ...local, icon: connect.icon }} local />
          {devices.map((h) => (
            <DeviceRow key={h.id} host={h} />
          ))}
          {!devices.length && (
            <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
              <Network aria-hidden className="size-6 text-faint-foreground" />
              <p className="text-[13px] font-medium">No other computers yet</p>
              <p className="max-w-sm text-[12.5px] text-muted-foreground">
                Add a computer on your tailnet. Parallax installs itself there over SSH.
              </p>
              <button type="button" className={primaryButton} onClick={() => setAdding(true)}>
                Add computer
              </button>
            </div>
          )}
        </>
      )}
      {adding && connect && (
        <ConnectWizard channel={connect.channel} onClose={() => setAdding(false)} />
      )}
    </Section>
  );
}

/** Install, while plx-connect isn't here; then the switch. */
function ConnectControl({
  connect,
  installing,
  onInstall,
  onToggle,
}: {
  connect?: ConnectState;
  installing: boolean;
  onInstall: () => void;
  onToggle: (on: boolean) => void;
}) {
  if (!connect || connect.installed === undefined)
    return <span className="text-[12.5px] text-muted-foreground">Checking…</span>;
  if (!connect.installed)
    return (
      <button
        type="button"
        className={primaryButton}
        disabled={installing}
        onClick={onInstall}
        title={
          window.parallax.platform === "win32"
            ? "npm install -g plx-connect"
            : 'npm install -g --prefix "$HOME/.local" plx-connect'
        }
      >
        {installing ? "Installing…" : "Install"}
      </button>
    );
  return (
    <Switch
      label="Parallax Connect"
      checked={!!connect.on}
      disabled={connect.on === undefined}
      onChange={onToggle}
    />
  );
}

/** What a device's plxd says about itself, asked every 15 s while it's connected. */
type Health = {
  os: string;
  arch: string;
  uptimeSeconds: number;
  runningAgents: number;
  store: string;
  /** How long `host/health` took, in ms. */
  latency: number;
};

function useHealth(hostId: string, connected: boolean): Health | undefined {
  const [health, setHealth] = useState<Health>();
  useEffect(() => {
    if (!connected) return setHealth(undefined);
    let live = true;
    const check = async () => {
      const started = performance.now();
      const answer = await window.parallax.request(hostId, "host/health", {});
      const latency = Math.round(performance.now() - started);
      const version = await window.parallax.request(hostId, "host/version", {});
      if (!live || "error" in answer || "error" in version) return;
      const { uptimeSeconds, runningAgents, store } = answer.result;
      const { os, arch } = version.result;
      setHealth({ os, arch, uptimeSeconds, runningAgents, store, latency });
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [hostId, connected]);
  return health;
}

/** 7260 → "2h 1m": how long plxd has run. */
export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * A Connect device, or this computer with `local`: its icon, which a menu changes, its name,
 * which Rename edits in place, and its health.
 */
function DeviceRow({ host, local }: { host: Host; local?: boolean }) {
  const state = useConnection(host.id);
  const connected = state?.status === "connected";
  const health = useHealth(host.id, connected);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string>();
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);

  const save = async (look: { name?: string; icon?: DeviceIconName }) => {
    const failed =
      local && look.name !== undefined
        ? await window.parallax.renameLocal(look.name)
        : await window.parallax.saveDevice(host.id, look);
    setError(failed);
    if (!failed) setRenaming(false);
  };
  const icon = host.icon ?? "laptop";
  const details = [
    health?.os ?? host.device?.os,
    health?.arch,
    host.device?.ip,
    connected && state.plxd && `plxd ${state.plxd}`,
  ].filter(Boolean);

  return (
    <div className={`${settingRow} items-start`} data-device={host.id}>
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          popoverTarget={menuId}
          aria-label={`Icon: ${deviceIconNames[icon]}`}
          title="Change icon"
          className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4.5"
        >
          <DeviceIcon icon={icon} />
        </button>
        <div
          ref={menu}
          id={menuId}
          popover="auto"
          role="menu"
          aria-label={`${host.name}'s icon`}
          className={menuPanel()}
        >
          {DEVICE_ICONS.map((each) => (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={each === icon}
              className={`${menuItem} [&_svg]:size-4`}
              onClick={() => {
                menu.current?.hidePopover();
                void save({ icon: each });
              }}
            >
              <DeviceIcon icon={each} />
              <span className="flex-1">{deviceIconNames[each]}</span>
              {each === icon && <Check aria-hidden />}
            </button>
          ))}
        </div>
        <div className="min-w-0">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save({ name: new FormData(e.currentTarget).get("name") as string });
              }}
            >
              <input
                name="name"
                aria-label="Device name"
                defaultValue={host.name}
                autoFocus
                maxLength={64}
                onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                className="w-48 rounded-md border border-border bg-background px-2 py-0.5 text-[13px]"
              />
              <button type="submit" className={primaryButton}>
                Save
              </button>
              <button type="button" className={quietButton} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <span className="truncate">{host.name}</span>
              {local && <span className="font-normal text-faint-foreground">This computer</span>}
              <IconButton label={`Rename ${host.name}`} onClick={() => setRenaming(true)}>
                <Pencil aria-hidden />
              </IconButton>
            </span>
          )}
          <span className="block truncate text-[12.5px] text-muted-foreground">
            {details.join(" · ")}
          </span>
          {health && (
            <span className="block text-[12px] text-faint-foreground">
              {health.latency} ms · up {uptime(health.uptimeSeconds)} ·{" "}
              {health.runningAgents === 1 ? "1 agent" : `${health.runningAgents} agents`} running
              {health.store !== "ok" && ` · store ${health.store}`}
            </span>
          )}
          {state?.status === "failed" && (
            <span title={state.error.stderr} className="block text-[12px] text-faint-foreground">
              {state.error.message}
            </span>
          )}
          {error && (
            <span role="alert" className="block text-[12.5px] text-danger">
              {error}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <StatusDot tone={connected ? "on" : state?.status === "failed" ? "warn" : "off"} />
          {state ? (connected ? "Connected" : statusLabel(state)) : "Connecting…"}
        </span>
        {!local && !connected && (
          <button
            type="button"
            className={quietButton}
            onClick={() => void window.parallax.forgetDevice(host.id)}
          >
            Forget
          </button>
        )}
      </div>
    </div>
  );
}
