import {
  Check,
  ChevronRight,
  Ellipsis,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  DEVICE_ICONS,
  iconFor,
  type DeviceHost,
  type DeviceIcon as DeviceIconName,
} from "../../preload/bridge";
import { NewComputerDialog } from "../AccountPrompts";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { accessLabel, ConnectWizard } from "../ConnectWizard";
import { DeviceIcon, deviceIconNames } from "../DeviceIcon";
import { localId, useConnect, useHosts } from "../hosts";
import { notify } from "../notifications";
import { useProfile } from "../profile";
import { menuItem, menuPanel } from "../ui";
import { primaryButton, quietButton, RenameForm, Row, Section, Switch } from "./parts";

/**
 * Settings > Connections' Parallax Connect section (0091): signed in, every other computer on the
 * Parallax account is listed as a card with its health, beside this computer, and Add computer
 * shows the command that adds one. Opening it asks the account for its computers. A switch still
 * turns on the tailnet's devices (0056), until Tailscale is only a route. A device's switch says
 * whether this app uses it, and its menu changes its icon, renames it on the device's own plxd,
 * or removes it from this app's list.
 */
export function ConnectSettings() {
  const connect = useConnect();
  const profile = useProfile();
  const hosts = useHosts();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [adding, setAdding] = useState(false);
  const [entering, setEntering] = useState<DeviceHost>();
  useEffect(() => window.parallax.onDevices(setDevices), []);
  useEffect(() => void window.parallax.discoverAccount(), []);
  const local = hosts.find((h) => h.id === localId)!;
  const listed = !!profile || !!connect?.on || devices.length > 0;

  const toggle = async (on: boolean) => {
    const failed = await window.parallax.setConnect(on);
    if (failed)
      notify({
        tone: "error",
        title: `Couldn't turn Tailscale ${on ? "on" : "off"}`,
        body: failed,
      });
  };

  return (
    <>
      <Section title="Parallax Connect">
        <Row
          title="Connect your computers"
          description={
            profile === null
              ? "Sign in to Parallax from Profile in the sidebar, then add your other computers."
              : "Every computer signed in to your Parallax account, over your network or Parallax Relay."
          }
        >
          <button
            type="button"
            disabled={!profile}
            onClick={() => setAdding(true)}
            className={`${primaryButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add computer
          </button>
        </Row>
        <Row
          title="Tailscale"
          description="Also find the computers on your tailnet that run Parallax Connect."
        >
          {connect ? (
            <Switch
              label="Tailscale"
              checked={!!connect.on}
              disabled={connect.on === undefined}
              onChange={(on) => void toggle(on)}
            />
          ) : (
            <span className="text-body text-muted-foreground">Checking…</span>
          )}
        </Row>
      </Section>
      {listed && connect && (
        <section aria-label="Computers" className="mb-8">
          <h2 className="mb-2 flex min-h-7 items-center text-reading font-semibold">Computers</h2>
          <ul className="flex flex-col gap-2">
            <DeviceCard
              device={{ id: localId, name: local.name, icon: connect.icon }}
              detected={iconFor(local.name)}
              local
            />
            {devices.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                detected={d.detected}
                enabled={d.enabled}
                onEnterCode={() => setEntering(d)}
              />
            ))}
          </ul>
          {!devices.length && (
            <p className="mt-2 text-body text-muted-foreground">
              No other computers yet. Add one with Add computer.
            </p>
          )}
        </section>
      )}
      {adding && connect && (
        <ConnectWizard
          channel={connect.channel}
          devices={devices}
          onClose={() => setAdding(false)}
          onEnterCode={setEntering}
        />
      )}
      {entering && (
        <NewComputerDialog
          key={entering.id}
          computer={entering}
          onClose={() => setEntering(undefined)}
        />
      )}
    </>
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
 * an account computer's sign-in while it needs the user (0091), with Enter code or Ask again;
 * then, for a device, whether this app uses it; then its menu.
 */
function DeviceCard({
  device,
  detected,
  enabled = true,
  local,
  onEnterCode,
}: {
  device: Pick<DeviceHost, "id" | "name" | "icon"> &
    Partial<Pick<DeviceHost, "ip" | "os" | "access">>;
  /** The icon its host name suggests, marked in the Icon menu. */
  detected: DeviceIconName;
  enabled?: boolean;
  local?: boolean;
  /** Opens the code dialog, for a new account computer. */
  onEnterCode?: () => void;
}) {
  const state = useConnection(device.id);
  const connected = enabled && state?.status === "connected";
  const health = useHealth(device.id, connected);
  const [renaming, setRenaming] = useState(false);
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
    if (failed)
      notify({
        tone: "error",
        title: `Couldn't ${look.name === undefined ? "change" : "rename"} ${device.name}`,
        body: failed,
      });
    else setRenaming(false);
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
  const access = enabled && !connected ? device.access : undefined;
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
          <RenameForm
            label="Device name"
            value={device.name}
            onSave={(name) => void save({ name })}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <p className="flex items-baseline gap-2 truncate text-reading font-medium">
            {device.name}
            {local && (
              <span className="text-body font-normal text-faint-foreground">This computer</span>
            )}
          </p>
        )}
        <p
          title={state?.status === "failed" ? state.error.message : undefined}
          className="truncate text-body text-muted-foreground"
        >
          {details.join(" · ")}
        </p>
        {health && (
          <p className="text-meta text-faint-foreground">
            {health.latency} ms · up {uptime(health.uptimeSeconds)} ·{" "}
            {health.runningAgents === 1 ? "1 agent" : `${health.runningAgents} agents`} running
            {health.store !== "ok" && ` · store ${health.store}`}
          </p>
        )}
        {access ? (
          <p className="text-meta text-faint-foreground">{accessLabel({ access })}</p>
        ) : (
          enabled &&
          state?.status === "failed" && (
            <p className="text-meta text-faint-foreground">{state.error.message}</p>
          )
        )}
      </div>
      {access?.step === "needsCode" && (
        <button
          type="button"
          onClick={onEnterCode}
          className={`${primaryButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <KeyRound aria-hidden />
          Enter code
        </button>
      )}
      {access?.step === "ask" && (
        <button
          type="button"
          onClick={() => void window.parallax.askAgain(device.id)}
          className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <RefreshCw aria-hidden />
          Ask again
        </button>
      )}
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
            {each === detected && <span className="text-meta text-faint-foreground">detected</span>}
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
            <h2 className="text-reading font-semibold">Remove {device.name} from this device?</h2>
            <p className="mt-1.5 text-body text-muted-foreground">
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
                className="rounded-md bg-red-600 px-3 py-1 text-body font-medium text-white hover:opacity-90"
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
