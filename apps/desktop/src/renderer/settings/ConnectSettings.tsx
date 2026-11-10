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
import { ParallaxMark } from "../logos";
import { notify } from "../notifications";
import { hostIcon } from "../RunTargetMenu";
import { ConfirmDialog, IconButton, Menu, menuItem } from "../ui";
import { AgentWorkRow, reachOf } from "./AgentsAcrossComputers";
import { AccessRow, card, NoticeRow } from "./connectionParts";
import { PairDialog } from "./LanSettings";
import {
  ConfirmRemove,
  outlineButton,
  PageTitle,
  primaryButton,
  quietButton,
  RenameForm,
  StatusDot,
  Switch,
} from "./parts";
import { AccountRoutes, FixedRoutes, routeKind } from "./Routes";
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

/** The one thing a computer needs from the user, which its card offers as a button. */
export type Need = "code" | "compare" | "askAgain" | "reach" | "install" | "update" | "signIn";

/** A computer's card in two lines: its connection, and what's wrong or what it needs, if anything. */
export interface ComputerStatus {
  /**
   * Its dot, and the colour of `problem`: `error` while it can't be used until the user acts or it
   * failed, `warn` while it works but wants attention, `off` while it only waits.
   */
  tone: "on" | "off" | "warn" | "error";
  /** Its connection and how it's reached: "Connected · Over your network". */
  text: string;
  /** What's wrong, or what it's waiting on, on its own line. */
  problem?: string;
  need?: Need;
}

/** What a computer still joining the account needs. */
const ACCESS_NEEDS: Partial<Record<AccountAccess["step"], Need>> = {
  needsCode: "code",
  compare: "compare",
  ask: "askAgain",
};

/**
 * A computer's summary, its problem and its one next action (PLX-1492), from what the app knows of
 * it: off in this app; an account computer's sign-in while it needs the user (0091); an SSH host
 * without plxd, with an older one, or wanting a login (PLX-642); a Tailscale device the account
 * can't reach yet; and otherwise its connection, with how it's reached, and why it failed.
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
  if (c.enabled === false) return { tone: "off", text: "Off, with no connection or threads here" };
  const connected = c.state?.status === "connected";
  if (c.access && !connected) {
    const { step } = c.access;
    const label = accessLabel(c) ?? "Connecting…";
    // Under way with nothing for the user to do, it's only a state.
    if (step === "pairing" || step === "signingIn" || step === "offline")
      return { tone: "off", text: label };
    const need = ACCESS_NEEDS[step];
    const waits =
      step === "confirm" || (step === "needsCode" && (c.access.offline || c.access.quiet));
    return {
      tone: waits ? "off" : "error",
      text: "Not connected",
      problem: label,
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
  const label = c.state ? statusLabel(c.state) : "Connecting…";
  // An account computer or a Tailscale device has no route to name until it connects.
  const text = connected || c.kind === "ssh" || c.kind === "lan" ? `${label} · ${how}` : label;
  if (c.fix === "install")
    return { tone: "error", text, problem: "plxd isn't installed", need: "install" };
  if (c.fix === "update")
    return {
      tone: connected ? "warn" : "error",
      text,
      problem: "plxd needs updating",
      need: "update",
    };
  if (connected)
    return c.tailnetOnly
      ? { tone: "warn", text, problem: "Only on Tailscale", need: "reach" }
      : { tone: "on", text };
  if (c.state?.status === "failed" && !c.state.updating) {
    if (c.canSignIn)
      return { tone: "error", text, problem: "Needs you to sign in", need: "signIn" };
    return {
      tone: c.state.retrying ? "warn" : "error",
      text,
      ...(c.state.error.message && { problem: c.state.error.message }),
    };
  }
  return { tone: "off", text };
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

/** What a computer's health says, in order. `here` leaves out how long it took to answer. */
const healthFacts = (health: Health | undefined, here = false) => [
  health && !here && `${health.latency} ms`,
  health && `up ${uptime(health.uptimeSeconds)}`,
  health && `${health.runningAgents === 1 ? "1 agent" : `${health.runningAgents} agents`} running`,
  health && health.store !== "ok" && `store ${health.store}`,
];

/** A computer's facts on one line: `lead`, then its plxd and what its health says. */
function factsOf(
  lead: (string | undefined)[],
  state: ConnectionState | undefined,
  health: Health | undefined,
): string {
  return [
    ...lead,
    // Also the plxd that refused the handshake for being too old.
    runningPlxd(state) && `plxd ${runningPlxd(state)}`,
    ...healthFacts(health),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A card's options menu: its trigger's props, and `choose`, which closes it before an item acts. */
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

/** The colour of a card's problem line, by its status's tone. */
const problemTone = { error: "text-danger", warn: "text-warning", off: "", on: "" };

/**
 * A computer's card in Settings > Computers (PLX-1492). Its header: its icon, its name, and a
 * summary line of `status.text` and `routes`, its route count, which is the button that opens the
 * card. Under those, `status.problem` in its tone with `action`, the one thing to do about it, on
 * the same line. At the end, `toggle`, its switch, and its options `menu`. Opened, `children`: its
 * routes and facts. `dim` greys a computer this app doesn't use.
 */
function ComputerCard({
  id,
  name,
  icon,
  status,
  alert,
  dim,
  renaming,
  routes,
  open,
  onToggle,
  action,
  toggle,
  menu,
  children,
  after,
}: {
  id: string;
  name: string;
  icon: ReactNode;
  status: Pick<ComputerStatus, "tone" | "text" | "problem">;
  /** Reads `status.problem` out as it appears: a warning that took the problem's place. */
  alert?: boolean;
  dim?: boolean;
  /** The form that renames it, in its name's place. */
  renaming?: ReactNode;
  /** How many routes it has. Without it, the card has nothing to open. */
  routes?: number;
  open?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
  toggle?: ReactNode;
  /** Its options menu's items, with the menu they close. */
  menu: { state: ReturnType<typeof useRowMenu>; items: ReactNode };
  children?: ReactNode;
  /** What follows the header at full width, such as a sign-in terminal, and its dialogs. */
  after?: ReactNode;
}) {
  const detailsId = useId();
  // A computer with no route to list still opens, for its facts.
  const count =
    routes === undefined
      ? undefined
      : routes === 0
        ? "Details"
        : routes === 1
          ? "1 route"
          : `${routes} routes`;
  return (
    <li data-device={id} className={card}>
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="flex min-w-[min(14rem,100%)] flex-1 items-start gap-3">
          <span
            className={`mt-2 shrink-0 text-muted-foreground [&_svg]:size-5 ${dim ? "opacity-60" : ""}`}
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            {renaming ?? (
              <p className={`truncate text-body font-medium ${dim ? "opacity-60" : ""}`}>{name}</p>
            )}
            {/* One run of text, so a narrow card wraps it between words, with its dot on the first line. */}
            <p className="mt-0.5 text-meta text-muted-foreground">
              <span className="mr-1.5 inline-flex h-4 items-center align-top">
                <StatusDot tone={status.tone} />
              </span>
              {status.text}
              {count && (
                <>
                  <span aria-hidden> · </span>
                  <button
                    type="button"
                    aria-label={routes ? `${count} to ${name}` : `${name} details`}
                    aria-expanded={!!open}
                    // Its routes are only there while open.
                    aria-controls={open ? detailsId : undefined}
                    onClick={onToggle}
                    className="-mx-1 inline-flex items-center gap-0.5 rounded-sm px-1 align-top whitespace-nowrap hover:bg-hover hover:text-foreground"
                  >
                    {count}
                    <ChevronDown
                      aria-hidden
                      className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                </>
              )}
            </p>
            {(status.problem || action) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {status.problem && (
                  // Never cut short: it can hold a code to compare. Remounted as an alert, so it's read.
                  <p
                    key={alert ? "alert" : "problem"}
                    role={alert ? "alert" : undefined}
                    className={`min-w-0 text-meta ${problemTone[status.tone]}`}
                  >
                    {status.problem}
                  </p>
                )}
                {action}
              </div>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {toggle}
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
        </div>
      </div>
      {count && open && (
        <div id={detailsId} className="mr-4 ml-12 border-t border-border/40 py-2">
          {children}
        </div>
      )}
      {after}
    </li>
  );
}

/** A computer's facts on one line, under its routes, and anything else to say of it there. */
function Facts({ facts, children }: { facts: string; children?: ReactNode }) {
  if (!facts && !children) return null;
  return (
    <div className="mt-2 text-meta text-muted-foreground">
      {facts && <p>{facts}</p>}
      {children}
    </div>
  );
}

/** A menu's item that removes, in red, after a rule when other items come first. */
function RemoveItem({ onClick }: { onClick: () => void }) {
  return (
    <>
      <div role="separator" className="my-1 border-t border-border first:hidden" />
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
 * A device's name and icon, as its card edits them: Icon and Rename for its menu, the form that
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
 * This computer as Sharing & access heads its card: its icon and name, and a menu that changes its
 * icon and renames it.
 */
export function ThisComputerHeading({
  host,
  connect,
}: {
  host: Host;
  connect: ConnectState | undefined;
}) {
  const menu = useRowMenu();
  const device = { id: localId, name: host.name, icon: connect?.icon ?? host.icon ?? "laptop" };
  const look = useLook({ device, detected: iconFor(host.name), local: true, editable: true, menu });
  return (
    <div data-setting="this-computer" className="mb-3 flex min-h-7 items-center gap-2">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">
        <DeviceIcon icon={device.icon} />
      </span>
      <div className="min-w-0 flex-1">
        {look.form ?? <h2 className="truncate text-reading font-semibold">{host.name}</h2>}
      </div>
      <IconButton label={`${host.name} options`} popoverTarget={menu.id}>
        <Ellipsis aria-hidden />
      </IconButton>
      <Menu
        ref={menu.ref}
        id={menu.id}
        label={`${host.name} options`}
        align="end"
        className="min-w-52 p-1"
      >
        {look.items}
      </Menu>
      {look.icons}
    </div>
  );
}

/**
 * Sharing & access' last card: the installed Parallax version, which this computer's plxd comes
 * with, and why that plxd failed, if it did.
 */
export function VersionRow() {
  const state = useShownConnection(localId);
  const [version, setVersion] = useState<string>();
  useEffect(() => void window.parallax.version().then(setVersion), []);
  return (
    <div className={`${card} mb-10`}>
      <AccessRow
        title="Version"
        description={version ? `Parallax ${version}` : "Parallax"}
        status={
          state?.status === "failed" &&
          state.error.message && (
            <span role="alert" className="mt-1 block text-meta text-danger">
              {state.error.message}
            </span>
          )
        }
      />
    </div>
  );
}

/**
 * An account computer or a Tailscale device in Settings > Computers: whether this app uses it; its
 * sign-in while it needs the user (0091), with Enter code or Ask again; a Tailscale-only device's
 * Reach from anywhere; and, opened, its routes, which an account computer's can be moved, added to
 * and removed in this app, and its facts. Its menu changes its icon, renames it on its own plxd, or
 * removes it.
 */
function DeviceCard({
  device,
  onEnterCode,
  onRemove,
}: {
  device: DeviceHost;
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
    if (failed) notify({ tone: "error", title: `Couldn't turn on Parallax Connect`, body: failed });
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
  const status = computerStatus({
    kind,
    enabled,
    state,
    ...(access && { access }),
    ...(device.route !== undefined && { route: device.route }),
    tailnetOnly,
  });

  return (
    <ComputerCard
      id={device.id}
      name={device.name}
      icon={<DeviceIcon icon={device.icon} />}
      dim={!enabled}
      renaming={look.form}
      status={status}
      routes={device.routes?.length ?? (device.ip ? 1 : 0)}
      open={open}
      onToggle={() => setOpen((o) => !o)}
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
            title="Parallax is moving off Tailscale-only connections. Parallax Connect keeps this computer connected through your Parallax account."
            onClick={() => void reach()}
            className={outlineButton}
          >
            <Globe aria-hidden />
            {reaching ? "Turning on…" : "Turn on Parallax Connect"}
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
      toggle={
        <Switch
          label={`Use ${device.name} in Parallax`}
          checked={enabled}
          onChange={(on) => void window.parallax.setDeviceEnabled(device.id, on)}
        />
      }
      menu={{
        state: menu,
        items: (
          <>
            {look.items}
            <RemoveItem onClick={menu.choose(() => removeDialog.current?.showModal())} />
          </>
        ),
      }}
      after={
        <>
          {look.icons}
          <RemoveDialog ref={removeDialog} name={device.name} remove={onRemove}>
            {kind === "account" ? REMOVED_FROM_ACCOUNT : removedHere(device.name)}
          </RemoveDialog>
        </>
      }
    >
      {device.routes ? (
        <AccountRoutes device={device} connected={connected} />
      ) : (
        <FixedRoutes
          name={device.name}
          routes={device.ip ? [{ kind: "Tailscale", address: device.ip, connected }] : []}
        />
      )}
      {kind === "account" && <AgentWorkRow host={device} device={device} />}
      <Facts facts={factsOf([health?.os ?? device.os, health?.arch], state, health)} />
    </ComputerCard>
  );
}

/**
 * An SSH host or a computer paired on the network in Settings > Computers. An SSH host that failed
 * for want of a login or a trusted host key (`signInFixes`) has Sign in, which opens the terminal
 * where ssh asks for a password or the key (0007), then connects it. Windows' OpenSSH can't share a
 * login, so it has none. One without plxd, or with one older than the app, has Install or Update
 * plxd (`plxdFix`), which installs this app's plxd there. Update asks first, since it stops that
 * computer's agents. Its menu edits an SSH host, or removes either.
 */
function SavedHostCard({
  host,
  appVersion,
  onEdit,
}: {
  host: Host;
  appVersion: string | undefined;
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
  const addresses = host.routes ?? [];

  return (
    <ComputerCard
      id={host.id}
      name={host.name}
      icon={hostIcon(host)}
      status={
        confirming
          ? {
              tone: "warn",
              text: status.text,
              problem: "Updating restarts plxd there, which stops its running agents.",
            }
          : status
      }
      alert={confirming}
      routes={host.destination ? 1 : addresses.length}
      open={open}
      onToggle={() => setOpen((o) => !o)}
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
      <FixedRoutes
        name={host.name}
        routes={
          host.destination
            ? [{ kind: "SSH", address: host.destination, connected }]
            : addresses.map((address) => ({
                kind: routeKind(address),
                address,
                // Which of several it's connected over isn't known here.
                connected: connected && addresses.length === 1,
              }))
        }
      />
      <Facts facts={factsOf([health?.os, health?.arch], state, health)}>
        {fix && (
          <p>
            {fix === "install" ? "Install" : "Update"} downloads plxd {appVersion} there from
            GitHub, checks its SHA256, and puts it in ~/.parallax-plxd.
          </p>
        )}
      </Facts>
    </ComputerCard>
  );
}

/**
 * A computer on the account that this app can't list as a device, such as one registered with an
 * id it doesn't know how to dial: its name, whether it's on the relay, and Remove, which takes it
 * off the account (PLX-652).
 */
function AccountOnlyCard({
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
    <ComputerCard
      id={`relay:${computer.hostId}`}
      name={name}
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
 * This computer's account key was removed or made read-only on the user's computers, so it starts
 * over with a new key from here (0091). It's on Computers, since it's those computers this app can
 * no longer use, and their cards then show the code to allow.
 */
function StartOverRow({ standing }: { standing: KeyStanding }) {
  const [confirming, setConfirming] = useState(false);
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
 * What's wrong with how this computer is reached, in a card at the top of Sharing & access: it
 * isn't on the account's list, with Set up again, or it's near its relay's daily cap (PLX-1357).
 */
export function ThisComputerNotices() {
  const { notice, usage } = useNotices();
  const capped = usage.filter((h) => h.thisComputer && relayCapOf(h));
  if (notice !== "notListed" && !capped.length) return null;
  return (
    <div className={`${card} mb-6`}>
      {notice === "notListed" && (
        <NoticeRow {...CONNECT_NOTICE_TEXT.notListed}>
          <button type="button" onClick={() => void setUpAgain()} className={quietButton}>
            Set up again
          </button>
        </NoticeRow>
      )}
      <CapNotices hosts={capped} />
    </div>
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
 * Settings > Computers (PLX-1492): its title with Add computer, which offers each way to add one,
 * then every other computer as a card, by name, however it was added: on the Parallax account
 * (0091), found on Tailscale (0056), paired on the same network (PLX-641), or reached over SSH.
 * Above them, what's wrong that isn't one computer's alone: this computer's key refused by them
 * all, with Start over, the relay or the sign-in service out of reach, and a daily cap. Opening it
 * asks the account for its computers. `accountOnly` are the account's computers this app can't list as devices.
 */
export function Computers({
  hosts,
  devices,
  connect,
  signedOut,
  signingIn,
  onSignIn,
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
  appVersion: string | undefined;
  accountOnly: RelayHost[];
  removeAccountOnly: (hostId: string) => Promise<string | undefined>;
  /** Removes a device by its id, and keeps the account's list in step. Resolves to why not. */
  removeDevice: (deviceId: string) => Promise<string | undefined>;
}) {
  const { notice, usage } = useNotices();
  const [standing, setStanding] = useState<KeyStanding | null>(null);
  useEffect(() => window.parallax.onKeyStanding(setStanding), []);
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
  const cards = [
    ...devices.map((d) => ({
      name: d.name,
      card: (
        <DeviceCard
          key={d.id}
          device={d}
          onEnterCode={() => setEnteringId(d.id)}
          onRemove={() => removeDevice(d.id)}
        />
      ),
    })),
    ...saved.map((h) => ({
      name: h.name,
      card: (
        <SavedHostCard
          key={h.id}
          host={h}
          appVersion={appVersion}
          onEdit={() => setAdding({ edit: h.id })}
        />
      ),
    })),
    ...accountOnly.map((c) => ({
      name: c.name,
      card: <AccountOnlyCard key={`relay:${c.hostId}`} computer={c} remove={removeAccountOnly} />,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const editing = typeof adding === "object" ? saved.find((h) => h.id === adding.edit) : undefined;
  const outage = notice && notice !== "notListed" ? notice : undefined;
  const capped = usage.filter((h) => !h.thisComputer && relayCapOf(h));

  return (
    <>
      <PageTitle
        title="Computers"
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
              className="w-80 p-1"
            >
              {signedOut ? (
                <AddItem
                  icon={<ParallaxMark className="size-4" />}
                  title={signingIn ? "Waiting for your browser…" : "Sign in to Parallax Connect"}
                  description="Then add any computer on your account, from anywhere."
                  disabled={signingIn}
                  onClick={addMenu.choose(onSignIn)}
                />
              ) : (
                <AddItem
                  icon={<ParallaxMark className="size-4" />}
                  title="Parallax Connect"
                  description="For a computer signed in to your Parallax account. Works from anywhere."
                  disabled={!connect}
                  onClick={addMenu.choose(() => setAdding("account"))}
                />
              )}
              <AddItem
                icon={<Wifi aria-hidden />}
                title="On this network"
                description="For a computer on the same network, with no account. You pair it with a one-time code."
                onClick={addMenu.choose(() => setAdding("lan"))}
              />
              <AddItem
                icon={<Terminal aria-hidden />}
                title="Over SSH"
                description="For a server or VM you already reach with ssh. Parallax can install what it needs there."
                onClick={addMenu.choose(() => setAdding("ssh"))}
              />
            </Menu>
          </>
        }
      >
        The other computers your agents run on from this app.
      </PageTitle>
      {(standing || outage || capped.length > 0) && (
        <div className={`${card} mb-3`}>
          {standing && <StartOverRow standing={standing} />}
          {outage && <NoticeRow {...CONNECT_NOTICE_TEXT[outage]} />}
          <CapNotices hosts={capped} />
        </div>
      )}
      {cards.length ? (
        <ul aria-label="Computers" data-setting="computers" className="mb-10 flex flex-col gap-3">
          {cards.map((c) => c.card)}
        </ul>
      ) : (
        <p
          data-setting="computers"
          className={`${card} mb-10 px-4 py-3 text-body text-muted-foreground`}
        >
          No other computers yet. Add one to run agents on it from here.
        </p>
      )}
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
