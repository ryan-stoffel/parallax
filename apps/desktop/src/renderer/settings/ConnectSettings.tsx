import { Check, ChevronRight, Ellipsis, Network, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  DEVICE_ICONS,
  iconFor,
  type ConnectState,
  type DeviceHost,
  type DeviceIcon as DeviceIconName,
} from "../../preload/bridge";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { ConnectWizard } from "../ConnectWizard";
import { DeviceIcon, deviceIconNames } from "../DeviceIcon";
import { localId, useConnect, useHosts } from "../hosts";
import { menuItem, menuPanel } from "../ui";
import { primaryButton, quietButton, Row, Section, settingRow, Switch } from "./parts";

/**
 * Settings > Connections' Parallax Connect section (0056): Install puts plx-connect on this
 * computer, then a switch turns Connect on, which opens Add computer. While it's on, this
 * computer and every device found on the tailnet are listed as cards with their health. A
 * device's switch says whether this app uses it, and its menu changes its icon, renames it on
 * the device's own plxd, or removes it from this app's list.
 */
export function ConnectSettings() {
  const connect = useConnect();
  const hosts = useHosts();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [adding, setAdding] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => window.parallax.onDevices(setDevices), []);
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
    <>
      <Section title="Parallax Connect">
        <Row
          title="Connect your computers"
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
      </Section>
      {connect?.on && (
        <section aria-label="Computers" className="mb-8">
          <div className="mb-2 flex min-h-7 items-center justify-between gap-4">
            <h2 className="text-[12.5px] font-medium text-muted-foreground">Computers</h2>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
            >
              <Plus aria-hidden />
              Add computer
            </button>
          </div>
          <ul className="flex flex-col gap-2">
            <DeviceCard
              device={{ id: localId, name: local.name, icon: connect.icon }}
              detected={iconFor(local.name)}
              local
            />
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} detected={d.detected} enabled={d.enabled} />
            ))}
          </ul>
          {!devices.length && (
            <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center">
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
        </section>
      )}
      {adding && connect && (
        <ConnectWizard
          channel={connect.channel}
          devices={devices}
          onClose={() => setAdding(false)}
        />
      )}
    </>
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
 * A Connect device's card, or this computer's with `local`: its icon, name, details, and health;
 * then, for a device, whether this app uses it; then its menu.
 */
function DeviceCard({
  device,
  detected,
  enabled = true,
  local,
}: {
  device: Pick<DeviceHost, "id" | "name" | "icon"> & Partial<Pick<DeviceHost, "ip" | "os">>;
  /** The icon its host name suggests, marked in the Icon menu. */
  detected: DeviceIconName;
  enabled?: boolean;
  local?: boolean;
}) {
  const state = useConnection(device.id);
  const connected = enabled && state?.status === "connected";
  const health = useHealth(device.id, connected);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string>();
  const menuId = useId();
  const iconsId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const icons = useRef<HTMLDivElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);

  const save = async (look: { name?: string; icon?: DeviceIconName }) => {
    const failed =
      local && look.name !== undefined
        ? await window.parallax.renameLocal(look.name)
        : await window.parallax.saveDevice(device.id, look);
    setError(failed);
    if (!failed) setRenaming(false);
  };
  const choose = (action: () => void) => () => {
    icons.current?.hidePopover();
    menu.current?.hidePopover();
    action();
  };
  // A name or icon is saved on the device's own plxd, so it needs a connection. This computer's
  // name is the app's own, and its plxd is always local.
  const editable = local || connected;
  const unreachable = enabled
    ? `Parallax can't reach ${device.name} right now.`
    : `Turn ${device.name} on to change it.`;
  const status = !enabled
    ? "Off"
    : state
      ? connected
        ? "Connected"
        : statusLabel(state)
      : "Connecting…";
  const details = [
    health?.os ?? device.os,
    health?.arch,
    device.ip,
    status,
    connected && state.plxd && `plxd ${state.plxd}`,
  ].filter(Boolean);

  return (
    <li
      data-device={device.id}
      className={`flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3 ${enabled ? "" : "opacity-60"}`}
    >
      <DeviceIcon icon={device.icon} className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
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
              defaultValue={device.name}
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
          <p className="flex items-baseline gap-2 truncate text-[14px] font-medium">
            {device.name}
            {local && (
              <span className="text-[12.5px] font-normal text-faint-foreground">This computer</span>
            )}
          </p>
        )}
        <p
          title={state?.status === "failed" ? state.error.message : undefined}
          className="truncate text-[12.5px] text-muted-foreground"
        >
          {details.join(" · ")}
        </p>
        {health && (
          <p className="text-[12px] text-faint-foreground">
            {health.latency} ms · up {uptime(health.uptimeSeconds)} ·{" "}
            {health.runningAgents === 1 ? "1 agent" : `${health.runningAgents} agents`} running
            {health.store !== "ok" && ` · store ${health.store}`}
          </p>
        )}
        {enabled && state?.status === "failed" && (
          <p className="text-[12px] text-faint-foreground">{state.error.message}</p>
        )}
        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
      {!local && (
        <Switch
          label={`Use ${device.name} in Parallax`}
          checked={enabled}
          onChange={(on) => void window.parallax.setDeviceEnabled(device.id, on)}
        />
      )}
      <button
        type="button"
        popoverTarget={menuId}
        aria-label={`${device.name} options`}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
      >
        <Ellipsis aria-hidden />
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={`${device.name} options`}
        className={`${menuPanel("end")} min-w-52 p-1`}
      >
        <button
          type="button"
          role="menuitem"
          popoverTarget={iconsId}
          disabled={!editable}
          title={editable ? undefined : unreachable}
          className={`${menuItem} disabled:opacity-50 [&_svg]:size-4`}
        >
          <DeviceIcon icon={device.icon} />
          <span className="flex-1">Icon</span>
          <ChevronRight aria-hidden className="text-faint-foreground" />
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!editable}
          title={editable ? undefined : unreachable}
          className={`${menuItem} disabled:opacity-50 [&_svg]:size-4`}
          onClick={choose(() => setRenaming(true))}
        >
          <Pencil aria-hidden />
          Rename
        </button>
        {!local && (
          <>
            <div role="separator" className="my-1 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              className={`${menuItem} text-danger [&_svg]:size-4`}
              onClick={choose(() => removeDialog.current?.showModal())}
            >
              <Trash2 aria-hidden />
              Remove from this device…
            </button>
          </>
        )}
      </div>
      <div
        ref={icons}
        id={iconsId}
        popover="auto"
        role="menu"
        aria-label={`${device.name}'s icon`}
        className="inset-auto m-0 ml-1 min-w-48 rounded-lg border border-border bg-surface p-1 text-foreground shadow-composer [position-area:right_span-bottom] [position-try-fallbacks:flip-inline,flip-block]"
      >
        {DEVICE_ICONS.map((each) => (
          <button
            key={each}
            type="button"
            role="menuitemradio"
            aria-checked={each === device.icon}
            className={`${menuItem} [&_svg]:size-4 ${each === device.icon ? "bg-hover" : ""}`}
            onClick={choose(() => void save({ icon: each }))}
          >
            <DeviceIcon icon={each} />
            <span className="flex-1">{deviceIconNames[each]}</span>
            {each === detected && (
              <span className="text-[12px] text-faint-foreground">detected</span>
            )}
            {each === device.icon && <Check aria-hidden />}
          </button>
        ))}
      </div>
      {!local && (
        <dialog
          ref={removeDialog}
          aria-label={`Remove ${device.name}`}
          className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
        >
          <form method="dialog" className="px-5 pt-4 pb-4">
            <h2 className="text-[15px] font-semibold">Remove {device.name} from this device?</h2>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Parallax here stops connecting to it, and its threads leave this sidebar. Nothing on{" "}
              {device.name} changes, and your other computers still reach it. Add it again from Add
              computer.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="submit" className={quietButton}>
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-red-600 px-3 py-1 text-[12.5px] font-medium text-white hover:opacity-90"
                onClick={() => void window.parallax.removeDevice(device.id)}
              >
                Remove
              </button>
            </div>
          </form>
        </dialog>
      )}
    </li>
  );
}
