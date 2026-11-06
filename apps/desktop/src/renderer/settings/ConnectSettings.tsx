import {
  Check,
  ChevronRight,
  Ellipsis,
  Globe,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  DEVICE_ICONS,
  iconFor,
  type ConnectNotice,
  type DeviceHost,
  type DeviceIcon as DeviceIconName,
  type KeyStanding,
} from "../../preload/bridge";
import type { RelayHost } from "../../protocol/generated/protocol";
import { NewComputerDialog } from "../AccountPrompts";
import { CONNECT_NOTICE_TEXT, relayCapOf, setUpAgain } from "../alarms";
import { statusLabel, useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { accessLabel, ConnectWizard, SetupCodeDialog } from "../ConnectWizard";
import { DeviceIcon, deviceIconNames } from "../DeviceIcon";
import { localId, useConnect, useHosts } from "../hosts";
import { notify } from "../notifications";
import { useProfile } from "../profile";
import { menuItem, menuPanel } from "../ui";
import {
  ConfirmRemove,
  primaryButton,
  quietButton,
  RenameForm,
  Row,
  Section,
  Switch,
} from "./parts";
import { RoutesDialog } from "./RoutesDialog";

/** What's wrong with Parallax Connect, at the top of its section, with what to do about it. */
function NoticeRow({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="flex items-center gap-4 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="text-meta text-muted-foreground">{body}</p>
      </div>
      {children}
    </div>
  );
}

const KEY_STANDING_TEXT: Record<KeyStanding, { title: string; body: string }> = {
  removed: {
    title: "This computer was removed",
    body: "Your computers refuse its key for good. To use them from here again, start over with a new key.",
  },
  readOnly: {
    title: "This computer is read-only",
    body: "It reads threads and can't change anything, and its key stays that way. For full access, start over with a new key.",
  },
};

/** What the second click on Start over does, and what it doesn't. */
const START_OVER_CONFIRM =
  "This deletes this computer's key and its sessions on your account's computers, and that key can't return. Nothing connects until you allow this computer on another device, or with plx connect approve on one of your computers. It shows there as a new device, and allowing it gives full access.";

/**
 * A computer whose account key was removed or made read-only starts over with a new key from here
 * (0091). It shows only then, as nothing else needs a new key.
 */
function StartOverRow() {
  const [standing, setStanding] = useState<KeyStanding | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => window.parallax.onKeyStanding(setStanding), []);
  if (!standing) return null;
  const startOver = async () => {
    setConfirming(false);
    const failed = await window.parallax.startOver();
    if (failed) notify({ tone: "error", title: "Couldn't start over", body: failed });
  };
  const { title, body } = KEY_STANDING_TEXT[standing];
  return (
    <NoticeRow title={title} body={confirming ? START_OVER_CONFIRM : body}>
      {confirming ? (
        <ConfirmRemove
          label="Start over"
          onRemove={() => void startOver()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${quietButton} shrink-0`}
        >
          Start over with a new key
        </button>
      )}
    </NoticeRow>
  );
}

/**
 * Settings > Connections' Parallax Connect section (0091): this computer, then every other computer
 * on the Parallax account, each with its health. Signed in, Add computer sets one up, and Show
 * setup code is this computer's side of being added from another. Signed out, Sign in is here.
 * Opening it asks the account for its computers. A device's switch says whether this app uses it,
 * and its menu changes its icon, renames it on the device's own plxd, changes an account computer's
 * routes in this app, or removes it from this app's list.
 */
export function ConnectSettings({ onSettingsChanged }: { onSettingsChanged: () => void }) {
  const connect = useConnect();
  const profile = useProfile();
  const hosts = useHosts();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [adding, setAdding] = useState(false);
  const [showingCode, setShowingCode] = useState(false);
  const [entering, setEntering] = useState<DeviceHost>();
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  useEffect(() => void window.parallax.discoverAccount(), []);
  const [notice, setNotice] = useState<ConnectNotice | null>(null);
  useEffect(() => window.parallax.onConnectNotice(setNotice), []);
  const [relayUsage, setRelayUsage] = useState<RelayHost[]>([]);
  useEffect(() => window.parallax.onRelayUsage(setRelayUsage), []);
  const local = hosts.find((h) => h.id === localId)!;

  const signIn = async () => {
    setSigningIn(true);
    const failed = await window.parallax.signIn(false);
    setSigningIn(false);
    if (failed) notify({ tone: "error", title: "Couldn't sign in", body: failed });
  };

  return (
    <>
      <Section
        title="Parallax Connect"
        action={
          profile && (
            <button
              type="button"
              disabled={!connect}
              onClick={() => setAdding(true)}
              className={`${primaryButton} flex items-center gap-1 [&_svg]:size-3.5`}
            >
              <Plus aria-hidden />
              Add computer
            </button>
          )
        }
      >
        {notice && (
          <NoticeRow {...CONNECT_NOTICE_TEXT[notice]}>
            {notice === "notListed" && (
              <button type="button" onClick={() => void setUpAgain()} className={quietButton}>
                Set up again
              </button>
            )}
          </NoticeRow>
        )}
        <StartOverRow />
        {relayUsage.map((host) => {
          const cap = relayCapOf(host);
          return cap && <NoticeRow key={host.hostId} title={cap.title} body={cap.body} />;
        })}
        <ul aria-label="Computers" className="border-border not-last:border-b">
          <DeviceCard
            device={{
              id: localId,
              name: local.name,
              icon: connect?.icon ?? local.icon ?? "laptop",
            }}
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
        {profile === null && (
          <Row
            title="Connect your other computers"
            description="Sign in to run agents on every computer on your account from here, wherever they are."
          >
            <button
              type="button"
              disabled={signingIn}
              onClick={() => void signIn()}
              className={primaryButton}
            >
              {signingIn ? "Waiting for your browser…" : "Sign in"}
            </button>
          </Row>
        )}
        {profile && (
          <Row
            title="Adding this computer from another?"
            description="Show a one-time code to type there."
          >
            <button
              type="button"
              onClick={() => setShowingCode(true)}
              className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
            >
              <KeyRound aria-hidden />
              Show setup code
            </button>
          </Row>
        )}
      </Section>
      {adding && connect && (
        <ConnectWizard
          channel={connect.channel}
          devices={devices}
          onClose={() => setAdding(false)}
        />
      )}
      {showingCode && (
        <SetupCodeDialog
          name={local.name}
          onReady={onSettingsChanged}
          onClose={() => setShowingCode(false)}
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
  const connectedNow = useConnectedNow(hostId);
  useEffect(() => {
    if (!connected) return setHealth(undefined);
    if (!connectedNow) return;
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
  }, [hostId, connected, connectedNow]);
  return health;
}

/**
 * Whether connected `tailnet:` device `hostId` was kept on Tailscale only, with `relay` or `remote`
 * turned off there, so the account can't reach it once the Tailscale-only path goes (0091).
 */
function useTailnetOnly(hostId: string, connected: boolean) {
  const [only, setOnly] = useState(false);
  const connectedNow = useConnectedNow(hostId);
  useEffect(() => {
    if (!connected || !hostId.startsWith("tailnet:")) return setOnly(false);
    if (!connectedNow) return;
    let live = true;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (live && "result" in answer)
        setOnly(answer.result.relay === false || answer.result.remote === false);
    });
    return () => {
      live = false;
    };
  }, [hostId, connected, connectedNow]);
  return [only, setOnly] as const;
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
 * A Connect device's row, or this computer's with `local`: its icon, name, details, and health;
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
    Partial<Pick<DeviceHost, "ip" | "os" | "access" | "routes" | "addedRoutes" | "route">>;
  /** The icon its host name suggests, marked in the Icon menu. */
  detected: DeviceIconName;
  enabled?: boolean;
  local?: boolean;
  /** Opens the code dialog, for a new account computer. */
  onEnterCode?: () => void;
}) {
  const state = useShownConnection(device.id);
  const connected = enabled && state?.status === "connected";
  const health = useHealth(device.id, connected);
  const [tailnetOnly, setTailnetOnly] = useTailnetOnly(device.id, connected);
  const [reaching, setReaching] = useState(false);
  const reach = async () => {
    setReaching(true);
    const failed = await window.parallax.turnOnReach(device.id);
    setReaching(false);
    if (failed)
      notify({ tone: "error", title: `Couldn't turn on Reach from anywhere`, body: failed });
    else setTailnetOnly(false);
  };
  const [renaming, setRenaming] = useState(false);
  const menuId = useId();
  const iconsId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const icons = useRef<HTMLDivElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const routesDialog = useRef<HTMLDialogElement>(null);

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
  // A computer still joining says where it stands once, in `accessLabel` below.
  const status = !enabled
    ? "Off"
    : access
      ? undefined
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
      data-setting={local ? "this-computer" : undefined}
      className={`flex items-center gap-4 border-border px-4 py-3 not-last:border-b ${enabled ? "" : "opacity-60"}`}
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
        {tailnetOnly && (
          <p className="text-meta text-faint-foreground">
            Only on Tailscale. Turn on Reach from anywhere to keep it in Parallax.
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
      {tailnetOnly && (
        <button
          type="button"
          disabled={reaching}
          title="Parallax Connect is moving off Tailscale-only connections. Reach from anywhere keeps this computer connected through your Parallax account."
          onClick={() => void reach()}
          className={`${primaryButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Globe aria-hidden />
          {reaching ? "Turning on…" : "Reach from anywhere"}
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
      {!local && access?.step !== "needsCode" && (
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
        {device.routes && (
          <button
            type="button"
            role="menuitem"
            className={`${menuItem} [&_svg]:size-4`}
            onClick={choose(() => routesDialog.current?.showModal())}
          >
            <Route aria-hidden />
            Routes
          </button>
        )}
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
              Remove…
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
      {device.routes && <RoutesDialog ref={routesDialog} device={device} connected={connected} />}
      {!local && (
        <dialog
          ref={removeDialog}
          aria-label={`Remove ${device.name}`}
          className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
        >
          <form method="dialog" className="px-5 pt-4 pb-4">
            <h2 className="text-reading font-semibold">Remove {device.name}?</h2>
            <p className="mt-1.5 text-body text-muted-foreground">
              {device.id.startsWith("account:")
                ? "It leaves your account, and none of your computers or devices reach it anymore. Its threads leave your sidebars. To add it again, run the setup on it from Add computer."
                : `Parallax here stops connecting to it, and its threads leave this sidebar. Nothing on ${device.name} changes.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="submit" className={quietButton}>
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-red-600 px-3 py-1 text-body font-medium text-white hover:opacity-90"
                onClick={() =>
                  void window.parallax.removeDevice(device.id).then((failed) => {
                    if (failed)
                      notify({
                        tone: "error",
                        title: `Couldn't remove ${device.name}`,
                        body: failed,
                      });
                  })
                }
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
