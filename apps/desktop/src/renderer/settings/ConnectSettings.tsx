import {
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Globe,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Terminal,
  Trash2,
  Wifi,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import {
  DEVICE_ICONS,
  iconFor,
  olderVersion,
  type AccountAccess,
  type ConnectionError,
  type ConnectionState,
  type ConnectNotice,
  type ConnectState,
  type DeviceHost,
  type DeviceIcon as DeviceIconName,
  type KeyStanding,
} from "../../preload/bridge";
import type { RelayHost } from "../../protocol/generated/protocol";
import { NewComputerDialog } from "../AccountPrompts";
import { CONNECT_NOTICE_TEXT, relayCapOf, setUpAgain } from "../alarms";
import { statusLabel, useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { accessLabel, ConnectWizard } from "../ConnectWizard";
import { DeviceIcon, deviceIconNames } from "../DeviceIcon";
import { localId, type Host } from "../hosts";
import { notify } from "../notifications";
import { hostIcon } from "../RunTargetMenu";
import { ConfirmDialog, IconButton, Menu, menuItem } from "../ui";
import {
  AgentWorkSetting,
  balancerBadge,
  BalancerSetting,
  reachOf,
  type Balancer,
} from "./AgentsAcrossComputers";
import { ComputerSetting, NoticeRow } from "./connectionParts";
import { PairDialog } from "./LanSettings";
import {
  ConfirmRemove,
  outlineButton,
  primaryButton,
  quietButton,
  RenameForm,
  Section,
  StatusDot,
  Switch,
} from "./parts";
import { RoutesDialog } from "./RoutesDialog";
import { SshHostDialog } from "./SshHostDialog";

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

/** How a computer got on the list: the account, Tailscale, pairing on the network, or SSH. */
type Kind = "account" | "tailnet" | "lan" | "ssh";

/** The one thing a computer needs from the user, which its row offers as a button. */
export type Need = "code" | "compare" | "askAgain" | "reach" | "install" | "update" | "signIn";

/** A computer's row in a line: its dot, what it says, and what it needs, if anything. */
export interface ComputerStatus {
  tone: "on" | "off" | "warn" | "error";
  text: string;
  /** The whole error behind `text`, for a tooltip and the opened row. */
  detail?: string;
  need?: Need;
  /** Read out as it appears: a warning that took the status's place. */
  alert?: boolean;
}

/** What a computer still joining the account needs, and how loudly its dot says so. */
const ACCESS_NEEDS: Partial<Record<AccountAccess["step"], Need>> = {
  needsCode: "code",
  compare: "compare",
  ask: "askAgain",
};

/**
 * A computer's status line and its one next action (PLX-1492), from what the app knows of it: off
 * in this app; an account computer's sign-in while it needs the user (0091); an SSH host without
 * plxd, with an older one, or wanting a login (PLX-642); a Tailscale device the account can't
 * reach yet; and otherwise its connection, with how it's reached.
 */
export function computerStatus(c: {
  kind: Kind;
  /** Whether this app uses it. Only a device can be off. */
  enabled?: boolean;
  state?: ConnectionState;
  access?: AccountAccess;
  /** The route an account computer's connection last went over. */
  route?: string;
  /** An SSH host's destination. */
  destination?: string;
  fix?: "install" | "update";
  canSignIn?: boolean;
  tailnetOnly?: boolean;
}): ComputerStatus {
  if (c.enabled === false) return { tone: "off", text: "Off" };
  const connected = c.state?.status === "connected";
  if (c.access && !connected) {
    const need = ACCESS_NEEDS[c.access.step];
    const waits = c.access.step === "needsCode" && (c.access.offline || c.access.quiet);
    return {
      tone: (need && !waits) || c.access.step === "pending" ? "warn" : "off",
      text: accessLabel(c) ?? "Connecting…",
      ...(need && { need }),
    };
  }
  const how =
    c.kind === "ssh"
      ? `SSH · ${c.destination}`
      : c.kind === "lan"
        ? "Same network"
        : c.kind === "tailnet"
          ? "Tailscale"
          : reachOf(c.route);
  if (c.fix === "install")
    return { tone: "warn", text: `plxd isn't installed · ${how}`, need: "install" };
  if (c.fix === "update")
    return { tone: "warn", text: `plxd needs updating · ${how}`, need: "update" };
  if (connected)
    return c.tailnetOnly
      ? { tone: "warn", text: "Connected · Only on Tailscale", need: "reach" }
      : { tone: "on", text: `Connected · ${how}` };
  if (c.state?.status === "failed" && !c.state.updating) {
    if (c.canSignIn) return { tone: "warn", text: `Needs you to sign in · ${how}`, need: "signIn" };
    const text = statusLabel(c.state);
    return {
      tone: c.state.retrying ? "warn" : "error",
      // An account computer has no route to name until it connects.
      text: c.kind === "ssh" || c.kind === "lan" ? `${text} · ${how}` : text,
      detail: c.state.error.message,
    };
  }
  return { tone: "off", text: c.state ? statusLabel(c.state) : "Connecting…" };
}

/** What a computer's plxd says about itself, asked every 15 s while it's connected. */
type Health = {
  os: string;
  arch: string;
  uptimeSeconds: number;
  runningAgents: number;
  store: string;
  /** How long `host/health` took, in ms. */
  latency: number;
};

/** `hostId`'s health while `asked` and connected, and nothing otherwise. */
function useHealth(hostId: string, asked: boolean): Health | undefined {
  const [health, setHealth] = useState<Health>();
  const connectedNow = useConnectedNow(hostId);
  useEffect(() => {
    if (!asked) return setHealth(undefined);
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
  }, [hostId, asked, connectedNow]);
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
 * A computer's facts on one line: `lead`, then its plxd and what its health says. `here` leaves
 * out how long it took to answer, which says nothing of the computer the app is on.
 */
function factsOf(
  lead: (string | undefined)[],
  state: ConnectionState | undefined,
  health: Health | undefined,
  here = false,
): string {
  return [
    ...lead,
    // Also the plxd that refused the handshake for being too old.
    runningPlxd(state) && `plxd ${runningPlxd(state)}`,
    health && !here && `${health.latency} ms`,
    health && `up ${uptime(health.uptimeSeconds)}`,
    health &&
      `${health.runningAgents === 1 ? "1 agent" : `${health.runningAgents} agents`} running`,
    health && health.store !== "ok" && `store ${health.store}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A row's options menu: its trigger's props, and `choose`, which closes it before an item acts. */
function useRowMenu() {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  return {
    id,
    ref,
    choose: (action: () => void) => () => {
      ref.current?.hidePopover();
      action();
    },
  };
}

/**
 * A computer in Settings > Connections (PLX-1492): its own icon, its name with `badges` after it,
 * one status line, then `action`, the one thing it needs, its options `menu`, and a chevron that
 * opens `children`, its settings, under it. `dim` greys a computer this app doesn't use.
 */
function ComputerRow({
  id,
  name,
  icon,
  badges,
  status,
  error,
  dim,
  renaming,
  action,
  menu,
  open,
  onToggle,
  list,
  children,
  after,
}: {
  id: string;
  name: string;
  icon: ReactNode;
  badges?: ReactNode;
  status: Pick<ComputerStatus, "tone" | "text" | "detail" | "alert">;
  /** What went wrong, printed under the status, for a row that can't open to say it. */
  error?: string;
  dim?: boolean;
  /** The form that renames it, in its name's place. */
  renaming?: ReactNode;
  action?: ReactNode;
  /** Its options menu's items, with the menu they close. */
  menu?: { state: ReturnType<typeof useRowMenu>; items: ReactNode };
  open?: boolean;
  /** Opens and closes its settings. Without it, the row has none. */
  onToggle?: () => void;
  /** Whether it's one of a list whose other rows may have settings. */
  list?: boolean;
  children?: ReactNode;
  /** What follows the row at full width, such as a sign-in terminal, and its dialogs. */
  after?: ReactNode;
}) {
  const settingsId = useId();
  return (
    <li data-device={id} className="border-border/40 not-last:border-b">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div
          className={`flex min-w-[min(12rem,100%)] flex-1 items-center gap-3 ${dim ? "opacity-60" : ""}`}
        >
          <span className="shrink-0 text-muted-foreground [&_svg]:size-5">{icon}</span>
          <div className="min-w-0 flex-1">
            {renaming ?? (
              <p className="flex items-center gap-2 text-body font-medium">
                <span className="truncate">{name}</span>
                {badges}
              </p>
            )}
            <p
              title={status.detail}
              className="mt-0.5 flex items-start gap-1.5 text-meta text-muted-foreground"
            >
              {/* One line tall, so the dot stays beside the first line of a status that wraps. */}
              <span className="flex h-4 shrink-0 items-center">
                <StatusDot tone={status.tone} />
              </span>
              {/* Never cut short: it can hold a code to compare. Remounted as an alert, so it's read. */}
              <span
                key={status.alert ? "alert" : "status"}
                role={status.alert ? "alert" : undefined}
                className="min-w-0"
              >
                {status.text}
              </span>
            </p>
            {error && <p className="mt-0.5 text-meta text-danger">{error}</p>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {action}
          {menu && (
            <>
              <IconButton label={`${name} options`} popoverTarget={menu.state.id}>
                <Ellipsis aria-hidden />
              </IconButton>
              <Menu
                ref={menu.state.ref}
                id={menu.state.id}
                label={`${name} options`}
                align="end"
                className="min-w-52 p-1"
                // Icon and Rename are off for a computer out of reach, and can't take the focus.
                focus='[role="menuitem"]:not(:disabled)'
              >
                {menu.items}
              </Menu>
            </>
          )}
          {onToggle ? (
            <IconButton
              label={`${name} settings`}
              aria-expanded={!!open}
              // Its settings are only there while open.
              aria-controls={open ? settingsId : undefined}
              onClick={onToggle}
            >
              <ChevronDown
                aria-hidden
                className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              />
            </IconButton>
          ) : (
            // Keeps every row's menu in one column.
            list && <span aria-hidden className="size-7" />
          )}
        </div>
      </div>
      {onToggle && open && (
        <div id={settingsId} className="pr-4 pb-3 pl-12">
          {children}
        </div>
      )}
      {after}
    </li>
  );
}

/** A computer's facts and the whole of what went wrong, at the top of its opened row. */
function Facts({
  facts,
  error,
  children,
}: {
  facts: string;
  error?: string;
  children?: ReactNode;
}) {
  if (!facts && !error && !children) return null;
  return (
    <div className="pb-1.5 text-meta text-muted-foreground">
      {facts && <p>{facts}</p>}
      {error && <p className="text-danger">{error}</p>}
      {children}
    </div>
  );
}

/** A menu's item that removes, in red after a rule. */
function RemoveItem({ onClick }: { onClick: () => void }) {
  return (
    <>
      <div role="separator" className="my-1 border-t border-border" />
      <button type="button" role="menuitem" className={`${menuItem} text-danger`} onClick={onClick}>
        <Trash2 aria-hidden />
        Remove…
      </button>
    </>
  );
}

/** Asks before `remove` takes `name` off the list, and says why it couldn't. */
function RemoveDialog({
  ref,
  name,
  remove,
  children,
}: {
  ref: RefObject<HTMLDialogElement | null>;
  name: string;
  /** Resolves to why not, for people. */
  remove: () => Promise<string | undefined>;
  children: ReactNode;
}) {
  return (
    <ConfirmDialog
      ref={ref}
      title={`Remove ${name}?`}
      action="Remove"
      onConfirm={() => {
        ref.current?.close();
        void remove().then((failed) => {
          if (failed) notify({ tone: "error", title: `Couldn't remove ${name}`, body: failed });
        });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}

/** What removing a computer from this app alone does. */
const removedHere = (name: string) =>
  `Parallax here stops connecting to it, and its threads leave this sidebar. Nothing on ${name} changes.`;

/** What removing a computer from the account does. */
const REMOVED_FROM_ACCOUNT =
  "It leaves your account, and none of your computers or devices reach it anymore. Its threads leave your sidebars. To add it again, run the setup on it from Add computer.";

/**
 * A device's name and icon, as its row edits them: Icon and Rename for its menu, the form that
 * replaces its name, and the icons' own menu. Both are saved on the device's own plxd, so they need
 * a connection, and `unreachable` says so on the items while there's none. This computer's name is
 * the app's own.
 */
function useLook({
  device,
  detected,
  local,
  editable,
  unreachable,
  menu,
}: {
  device: Pick<DeviceHost, "id" | "name" | "icon">;
  /** The icon its host name suggests, marked in the Icon menu. */
  detected: DeviceIconName;
  local?: boolean;
  editable: boolean;
  unreachable?: string;
  menu: ReturnType<typeof useRowMenu>;
}) {
  const [renaming, setRenaming] = useState(false);
  const iconsId = useId();
  const icons = useRef<HTMLDivElement>(null);
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
  const choose = (action: () => void) =>
    menu.choose(() => {
      icons.current?.hidePopover();
      action();
    });
  return {
    form: renaming ? (
      <RenameForm
        label="Device name"
        value={device.name}
        onSave={(name) => void save({ name })}
        onCancel={() => setRenaming(false)}
      />
    ) : undefined,
    items: (
      <>
        <button
          type="button"
          role="menuitem"
          popoverTarget={iconsId}
          disabled={!editable}
          title={editable ? undefined : unreachable}
          className={`${menuItem} disabled:opacity-50`}
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
          className={`${menuItem} disabled:opacity-50`}
          onClick={choose(() => setRenaming(true))}
        >
          <Pencil aria-hidden />
          Rename
        </button>
      </>
    ),
    icons: (
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
            className={`${menuItem} ${each === device.icon ? "bg-hover" : ""}`}
            onClick={choose(() => void save({ icon: each }))}
          >
            <DeviceIcon icon={each} />
            <span className="flex-1">{deviceIconNames[each]}</span>
            {each === detected && <span className="text-meta text-faint-foreground">detected</span>}
            {each === device.icon && <Check aria-hidden />}
          </button>
        ))}
      </div>
    ),
  };
}

/**
 * This computer, at the top of its card: its icon, name, and what its plxd says of itself. Its menu
 * changes its icon and renames it.
 */
export function ThisComputerRow({
  host,
  connect,
  balancer,
}: {
  host: Host;
  connect: ConnectState | undefined;
  balancer: Balancer;
}) {
  const state = useShownConnection(localId);
  const connected = state?.status === "connected";
  const health = useHealth(localId, connected);
  const menu = useRowMenu();
  const device = { id: localId, name: host.name, icon: connect?.icon ?? host.icon ?? "laptop" };
  const look = useLook({ device, detected: iconFor(host.name), local: true, editable: true, menu });
  return (
    <ComputerRow
      id={localId}
      name={host.name}
      icon={<DeviceIcon icon={device.icon} />}
      badges={balancerBadge(balancer, localId)}
      renaming={look.form}
      status={
        connected
          ? {
              tone: "on",
              text: factsOf([health?.os, health?.arch], state, health, true) || "Connected",
            }
          : {
              tone: state?.status === "failed" ? "error" : "off",
              text: state ? statusLabel(state) : "Connecting…",
            }
      }
      {...(state?.status === "failed" && { error: state.error.message })}
      menu={{ state: menu, items: look.items }}
      after={look.icons}
    />
  );
}

/**
 * An account computer or a Tailscale device in Your computers: its sign-in while it needs the user
 * (0091), with Enter code or Ask again; a Tailscale-only device's Reach from anywhere; and, opened,
 * its facts, whether this app uses it, whether agents can work on it, and its place in the Load
 * Balancer. Its menu changes its icon, renames it on its own plxd, changes an account computer's
 * routes in this app, or removes it. `host` is its entry among the hosts, once it has one.
 */
function DeviceRow({
  device,
  host,
  balancer,
  onEnterCode,
  onRemove,
}: {
  device: DeviceHost;
  host?: Host;
  balancer: Balancer;
  /** Opens the code dialog, for a new account computer. */
  onEnterCode: () => void;
  /** Removes it: off the account, or off this app's list. Resolves to why not. */
  onRemove: () => Promise<string | undefined>;
}) {
  const { enabled, access } = device;
  const kind: Kind = device.id.startsWith("account:") ? "account" : "tailnet";
  const state = useShownConnection(device.id);
  const connected = enabled && state?.status === "connected";
  const [open, setOpen] = useState(false);
  const health = useHealth(device.id, connected && open);
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
  const menu = useRowMenu();
  const look = useLook({
    device,
    detected: device.detected,
    editable: connected,
    unreachable: enabled
      ? `Parallax can't reach ${device.name} right now.`
      : `Turn ${device.name} on to change it.`,
    menu,
  });
  const removeDialog = useRef<HTMLDialogElement>(null);
  const routesDialog = useRef<HTMLDialogElement>(null);
  const status = computerStatus({
    kind,
    enabled,
    state,
    ...(access && { access }),
    ...(device.route !== undefined && { route: device.route }),
    tailnetOnly,
  });
  // A new computer has nothing to set until its code is in.
  const settled = access?.step !== "needsCode";

  return (
    <ComputerRow
      id={device.id}
      name={device.name}
      icon={<DeviceIcon icon={device.icon} />}
      badges={host && balancerBadge(balancer, host.id)}
      dim={!enabled}
      renaming={look.form}
      status={status}
      action={
        status.need === "code" || status.need === "compare" ? (
          <button type="button" onClick={onEnterCode} className={outlineButton}>
            <KeyRound aria-hidden />
            {status.need === "code" ? "Enter code" : "Compare code"}
          </button>
        ) : status.need === "reach" ? (
          <button
            type="button"
            disabled={reaching}
            title="Parallax Connect is moving off Tailscale-only connections. Reach from anywhere keeps this computer connected through your Parallax account."
            onClick={() => void reach()}
            className={outlineButton}
          >
            <Globe aria-hidden />
            {reaching ? "Turning on…" : "Reach from anywhere"}
          </button>
        ) : status.need === "askAgain" ? (
          <button
            type="button"
            onClick={() => void window.parallax.askAgain(device.id)}
            className={outlineButton}
          >
            <RefreshCw aria-hidden />
            Ask again
          </button>
        ) : undefined
      }
      menu={{
        state: menu,
        items: (
          <>
            {look.items}
            {device.routes && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={menu.choose(() => routesDialog.current?.showModal())}
              >
                <Route aria-hidden />
                Routes
              </button>
            )}
            <RemoveItem onClick={menu.choose(() => removeDialog.current?.showModal())} />
          </>
        ),
      }}
      open={open}
      list
      {...(settled && { onToggle: () => setOpen((o) => !o) })}
      after={
        <>
          {look.icons}
          {device.routes && (
            <RoutesDialog ref={routesDialog} device={device} connected={connected} />
          )}
          <RemoveDialog ref={removeDialog} name={device.name} remove={onRemove}>
            {kind === "account" ? REMOVED_FROM_ACCOUNT : removedHere(device.name)}
          </RemoveDialog>
        </>
      }
    >
      <Facts
        facts={factsOf([health?.os ?? device.os, health?.arch, device.ip], state, health)}
        {...(enabled && status.detail && { error: status.detail })}
      />
      <ComputerSetting
        title="Use in Parallax"
        note={enabled ? undefined : "Off, it has no connection or threads here."}
      >
        <Switch
          label={`Use ${device.name} in Parallax`}
          checked={enabled}
          onChange={(on) => void window.parallax.setDeviceEnabled(device.id, on)}
        />
      </ComputerSetting>
      {host && kind === "account" && <AgentWorkSetting host={host} device={device} />}
      {host && <BalancerSetting host={host} balancer={balancer} />}
    </ComputerRow>
  );
}

/**
 * An SSH host or a computer paired on the network in Your computers. An SSH host that failed for
 * want of a login or a trusted host key (`signInFixes`) has Sign in, which opens the terminal where
 * ssh asks for a password or the key (0007), then connects it. Windows' OpenSSH can't share a
 * login, so it has none. One without plxd, or with one older than the app, has Install or Update
 * plxd (`plxdFix`), which installs this app's plxd there. Update asks first, since it stops that
 * computer's agents. Its menu edits an SSH host, or removes either.
 */
function SavedHostRow({
  host,
  appVersion,
  balancer,
  onEdit,
}: {
  host: Host;
  appVersion: string | undefined;
  balancer: Balancer;
  /** Opens an SSH host's dialog. */
  onEdit: () => void;
}) {
  const kind: Kind = host.destination ? "ssh" : "lan";
  const state = useShownConnection(host.id);
  const connected = state?.status === "connected";
  const [open, setOpen] = useState(false);
  const health = useHealth(host.id, connected && open);
  const fix = kind === "ssh" ? plxdFix(state, appVersion) : undefined;
  const [installing, setInstalling] = useState(false);
  // Update plxd, waiting for its second click.
  const [confirming, setConfirming] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const install = async () => {
    setConfirming(false);
    setInstalling(true);
    const failed = await window.parallax.installPlxd(host.id);
    setInstalling(false);
    if (failed)
      notify({
        tone: "error",
        title: `Couldn't ${fix === "update" ? "update" : "install"} plxd on ${host.name}`,
        body: failed,
      });
  };
  const canSignIn =
    kind === "ssh" &&
    window.parallax.platform !== "win32" &&
    state?.status === "failed" &&
    signInFixes(state.error);
  if (signingIn && connected) setSigningIn(false);
  const menu = useRowMenu();
  const removeDialog = useRef<HTMLDialogElement>(null);
  const status = computerStatus({
    kind,
    state,
    ...(host.destination && { destination: host.destination }),
    ...(fix && { fix }),
    canSignIn,
  });
  // The question goes with what it asked about: a host that no longer needs an update isn't asked.
  if (confirming && status.need !== "update") setConfirming(false);

  return (
    <ComputerRow
      id={host.id}
      name={host.name}
      icon={hostIcon(host)}
      badges={balancerBadge(balancer, host.id)}
      status={
        confirming
          ? {
              tone: "warn",
              text: "Updating restarts plxd there, which stops its running agents.",
              alert: true,
            }
          : status
      }
      action={
        confirming ? (
          <>
            <button type="button" className={primaryButton} onClick={() => void install()}>
              Update plxd
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
        ) : status.need === "install" || status.need === "update" ? (
          <button
            type="button"
            className={outlineButton}
            disabled={installing}
            onClick={() => (status.need === "update" ? setConfirming(true) : void install())}
          >
            {installing
              ? status.need === "update"
                ? "Updating…"
                : "Installing…"
              : status.need === "install"
                ? "Install plxd"
                : "Update plxd"}
          </button>
        ) : status.need === "signIn" && !signingIn ? (
          <button type="button" className={outlineButton} onClick={() => setSigningIn(true)}>
            Sign in
          </button>
        ) : undefined
      }
      menu={{
        state: menu,
        items: (
          <>
            {kind === "ssh" && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={menu.choose(onEdit)}
              >
                <Pencil aria-hidden />
                Edit
              </button>
            )}
            <RemoveItem onClick={menu.choose(() => removeDialog.current?.showModal())} />
          </>
        ),
      }}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      after={
        <>
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
          <RemoveDialog
            ref={removeDialog}
            name={host.name}
            remove={() => window.parallax.removeHost(host.id)}
          >
            {removedHere(host.name)}
          </RemoveDialog>
        </>
      }
    >
      <Facts
        facts={factsOf([host.routes?.join(", "), health?.os, health?.arch], state, health)}
        {...(status.detail && { error: status.detail })}
      >
        {fix && (
          <p>
            {fix === "install" ? "Install" : "Update"} downloads plxd {appVersion} there from
            GitHub, checks its SHA256, and puts it in ~/.parallax-plxd.
          </p>
        )}
        {!connected && !fix && !status.detail && !host.routes && <p>Not connected yet.</p>}
      </Facts>
      <BalancerSetting host={host} balancer={balancer} />
    </ComputerRow>
  );
}

/**
 * A computer on the account that this app can't list as a device, such as one registered with an
 * id it doesn't know how to dial: its name, whether it's on the relay, and Remove, which takes it
 * off the account (PLX-652).
 */
function AccountOnlyRow({
  computer,
  remove,
}: {
  computer: RelayHost;
  remove: (hostId: string) => Promise<string | undefined>;
}) {
  const name = computer.name || "Unnamed computer";
  const menu = useRowMenu();
  const removeDialog = useRef<HTMLDialogElement>(null);
  return (
    <ComputerRow
      id={`relay:${computer.hostId}`}
      name={name}
      list
      icon={<DeviceIcon icon={iconFor(computer.name)} />}
      status={{
        tone: computer.online ? "on" : "off",
        text: `On your account · ${computer.online ? "On the relay" : "Not connected"}`,
      }}
      menu={{
        state: menu,
        items: <RemoveItem onClick={menu.choose(() => removeDialog.current?.showModal())} />,
      }}
      after={
        <RemoveDialog ref={removeDialog} name={name} remove={() => remove(computer.hostId)}>
          {REMOVED_FROM_ACCOUNT}
        </RemoveDialog>
      }
    />
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
        <button type="button" onClick={() => setConfirming(true)} className={quietButton}>
          Start over with a new key
        </button>
      )}
    </NoticeRow>
  );
}

/** What Parallax Connect says is wrong (PLX-1351), and each computer near its relay's daily cap. */
function useNotices() {
  const [notice, setNotice] = useState<ConnectNotice | null>(null);
  useEffect(() => window.parallax.onConnectNotice(setNotice), []);
  const [usage, setUsage] = useState<RelayHost[]>([]);
  useEffect(() => window.parallax.onRelayUsage(setUsage), []);
  return { notice, usage };
}

/** The daily cap notices for `hosts`. */
function CapNotices({ hosts }: { hosts: RelayHost[] }) {
  return hosts.map((host) => {
    const cap = relayCapOf(host);
    return cap && <NoticeRow key={host.hostId} title={cap.title} body={cap.body} />;
  });
}

/**
 * What's wrong with this computer on the account, at the top of its card: it isn't on the account's
 * list, with Set up again; its key was removed or made read-only, with Start over; or it's near its
 * relay's daily cap (PLX-1357).
 */
export function ThisComputerNotices() {
  const { notice, usage } = useNotices();
  return (
    <>
      {notice === "notListed" && (
        <NoticeRow {...CONNECT_NOTICE_TEXT.notListed}>
          <button type="button" onClick={() => void setUpAgain()} className={quietButton}>
            Set up again
          </button>
        </NoticeRow>
      )}
      <StartOverRow />
      <CapNotices hosts={usage.filter((h) => h.thisComputer)} />
    </>
  );
}

/** One way to add a computer, in Add computer's menu. */
function AddItem({
  icon,
  title,
  description,
  ...props
}: {
  icon: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`${menuItem} items-start py-2 disabled:opacity-50`}
      {...props}
    >
      <span className="grid h-5 place-items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block leading-5">{title}</span>
        <span className="mt-0.5 block text-meta leading-snug text-faint-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

/**
 * Settings > Connections' Your computers (PLX-1492): every other computer once, by name, however it
 * was added: on the Parallax account (0091), found on Tailscale (0056), paired on the same network
 * (PLX-641), or reached over SSH. Add computer offers each way. Opening it asks the account for its
 * computers. `accountOnly` are the account's computers this app can't list as devices.
 */
export function Computers({
  hosts,
  devices,
  connect,
  signedOut,
  signingIn,
  onSignIn,
  balancer,
  appVersion,
  accountOnly,
  removeAccountOnly,
  removeDevice,
}: {
  hosts: Host[];
  devices: DeviceHost[];
  connect: ConnectState | undefined;
  signedOut: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  balancer: Balancer;
  appVersion: string | undefined;
  accountOnly: RelayHost[];
  removeAccountOnly: (hostId: string) => Promise<string | undefined>;
  /** Removes a device by its id, and keeps the account's list in step. Resolves to why not. */
  removeDevice: (deviceId: string) => Promise<string | undefined>;
}) {
  const { notice, usage } = useNotices();
  // The way to add a computer that's open, or the SSH host being edited, by id.
  const [adding, setAdding] = useState<"account" | "lan" | "ssh" | { edit: string }>();
  // The computer whose code dialog is open, by id, so the dialog follows what the app learns of it.
  const [enteringId, setEnteringId] = useState<string>();
  const entering = devices.find((d) => d.id === enteringId);
  // A computer that's gone, or in some other way, has no code to take: its dialog closes for good.
  if (enteringId && !entering?.access) setEnteringId(undefined);
  useEffect(() => void window.parallax.discoverAccount(), []);
  const addMenu = useRowMenu();
  const saved = hosts.filter((h) => h.destination || h.routes);
  const rows = [
    ...devices.map((d) => ({
      name: d.name,
      row: (
        <DeviceRow
          key={d.id}
          device={d}
          {...(hosts.some((h) => h.id === d.id) && { host: hosts.find((h) => h.id === d.id)! })}
          balancer={balancer}
          onEnterCode={() => setEnteringId(d.id)}
          onRemove={() => removeDevice(d.id)}
        />
      ),
    })),
    ...saved.map((h) => ({
      name: h.name,
      row: (
        <SavedHostRow
          key={h.id}
          host={h}
          appVersion={appVersion}
          balancer={balancer}
          onEdit={() => setAdding({ edit: h.id })}
        />
      ),
    })),
    ...accountOnly.map((c) => ({
      name: c.name,
      row: <AccountOnlyRow key={`relay:${c.hostId}`} computer={c} remove={removeAccountOnly} />,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const editing = typeof adding === "object" ? saved.find((h) => h.id === adding.edit) : undefined;

  return (
    <>
      <Section
        title="Your computers"
        action={
          <>
            <button
              type="button"
              popoverTarget={addMenu.id}
              aria-haspopup="menu"
              className={`${primaryButton} flex items-center gap-1 whitespace-nowrap [&_svg]:size-3.5`}
            >
              <Plus aria-hidden />
              Add computer
            </button>
            <Menu
              ref={addMenu.ref}
              id={addMenu.id}
              label="Add computer"
              align="end"
              className="w-72 p-1"
            >
              {signedOut ? (
                <AddItem
                  icon={<Globe aria-hidden />}
                  title={signingIn ? "Waiting for your browser…" : "Sign in to Parallax"}
                  description="Reach every computer on your account, wherever it is."
                  disabled={signingIn}
                  onClick={addMenu.choose(onSignIn)}
                />
              ) : (
                <AddItem
                  icon={<Globe aria-hidden />}
                  title="With your Parallax account"
                  description="Anywhere, through Parallax Relay."
                  disabled={!connect}
                  onClick={addMenu.choose(() => setAdding("account"))}
                />
              )}
              <AddItem
                icon={<Wifi aria-hidden />}
                title="On this network"
                description="Pair with a one-time code."
                onClick={addMenu.choose(() => setAdding("lan"))}
              />
              <AddItem
                icon={<Terminal aria-hidden />}
                title="Over SSH"
                description="A machine you reach with ssh."
                onClick={addMenu.choose(() => setAdding("ssh"))}
              />
            </Menu>
          </>
        }
      >
        {notice && notice !== "notListed" && <NoticeRow {...CONNECT_NOTICE_TEXT[notice]} />}
        <CapNotices hosts={usage.filter((h) => !h.thisComputer)} />
        {rows.length ? (
          <ul aria-label="Your computers">{rows.map((r) => r.row)}</ul>
        ) : (
          <p className="px-4 py-3 text-body text-muted-foreground">
            No other computers yet. Add one to run agents on it from here.
          </p>
        )}
      </Section>
      {adding === "account" && connect && (
        <ConnectWizard
          channel={connect.channel}
          devices={devices}
          onClose={() => setAdding(undefined)}
        />
      )}
      {adding === "lan" && <PairDialog onDone={() => setAdding(undefined)} />}
      {(adding === "ssh" || editing) && (
        <SshHostDialog {...(editing && { host: editing })} onDone={() => setAdding(undefined)} />
      )}
      {entering && (
        <NewComputerDialog
          key={entering.id}
          computer={entering}
          onClose={() => setEnteringId(undefined)}
        />
      )}
    </>
  );
}
