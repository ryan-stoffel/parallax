// The user's computers: the account's, which Parallax Relay lists (0091, accountHosts.ts), as
// `account:<hostId>`, reached over their LAN, added, or relay routes, and one paired on the LAN with a code
// (0065, host.ts).
//
// Each computer gets a `WebHost`, the web client's connection, and `window.parallax` routes the
// desktop's shared hooks to it by the computer's id, as the desktop's bridge routes by host.

import { File } from "expo-file-system";

import type { ConnectionState, ParallaxBridge } from "../../desktop/src/preload/bridge";
import { inOrder, routesAhead, type RouteChoices } from "../../desktop/src/preload/routeList";
import { ConnectionLog, routeKind } from "../../desktop/src/protocol/connectionLog";
import { forgetConnection } from "../../desktop/src/renderer/ConnectionStatus";
import { WebHost } from "../../desktop/src/renderer/webBridge";
import { privateFile, type PinnedSocket } from "../modules/pinned-tls";
import type { AccountHosts, Gate } from "./accountHosts";
import { writeConnectionLine } from "./connectionLog";
import { loadSaved, pairedSocket } from "./host";
import { ordered, RECHECK_MS } from "./routes";
import { pairedId, upgraded, type Machine, type Setup } from "./setup";

export { accountId, pairedId, withListed, type Machine, type Setup } from "./setup";

const setupFile = new File(privateFile("machines.json"));

/**
 * The saved setup, as `upgraded` moves an older one to the account, with a LAN-paired computer's
 * session put back from the Keychain, where `saveSetup` leaves it. A paired computer whose session
 * is gone, as after a revoke, drops out.
 */
export async function loadSetup(): Promise<Setup> {
  let setup: Setup = { machines: [], onboarded: false };
  try {
    if (setupFile.exists) setup = upgraded(JSON.parse(setupFile.textSync()) as Parameters<typeof upgraded>[0]);
  } catch {}
  const saved = await loadSaved().catch(() => null);
  const machines = setup.machines.flatMap((m) =>
    !m.id.startsWith("paired-") ? [m] : saved && m.id === pairedId(saved) ? [{ ...m, paired: saved }] : [],
  );
  return { ...setup, machines };
}

// A paired computer's session lives in the Keychain (host.ts), never in this file.
export const saveSetup = (setup: Setup) =>
  setupFile.write(
    JSON.stringify({ ...setup, machines: setup.machines.map(({ paired, ...m }) => m) }),
  );

/** What the fleet hears about an account's computer as it connects. */
export interface AccountEvents {
  hosts: AccountHosts;
  /** It reported its name and routes. */
  learned: (id: string, routes: string[], name: string) => void;
  /** It needs setting up, or waits on another device, so it isn't connected. */
  gated: (id: string, gate: Gate) => void;
}

/** An account computer's connection: the route it's on, its socket, and its routes' failures. */
interface Link {
  route?: string;
  socket?: PinnedSocket;
  failedAt: Record<string, number>;
  recheck?: ReturnType<typeof setInterval>;
  /** The route a re-check found, which the next open dials alone. */
  moveTo?: string;
  log: ConnectionLog;
}

/** The phone's connections, one `WebHost` per computer, and the bridge the shared hooks use. */
export class Fleet {
  readonly hosts = new Map<string, WebHost>();
  private readonly listeners = new Set<(hostId: string, state: ConnectionState) => void>();
  /** The computers added, with the routes they last reported. */
  private readonly machines = new Map<string, Machine>();
  private readonly links = new Map<string, Link>();

  constructor(
    private readonly signedOut: (machine: Machine) => Promise<void>,
    machines: Machine[],
    private readonly account?: AccountEvents,
  ) {
    for (const m of machines) this.add(m);
    const unknown = { error: { code: -32602, message: "unknown computer" } };
    const none = () => () => {};
    window.parallax = {
      request: (id: string, method: string, params: unknown) =>
        this.hosts.get(id)?.request(method, params) ?? Promise.resolve(unknown),
      subscribe: (id, params, listener) => this.hosts.get(id)?.subscribe(params, listener) ?? none(),
      watch: (id: string, params: never, listener: never) =>
        this.hosts.get(id)?.watch(params, listener) ?? none(),
      connectionState: async (id) => this.hosts.get(id)?.state ?? { status: "connecting" },
      onConnectionState: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      retry: async (id) => this.hosts.get(id)?.retry(),
    } as Partial<ParallaxBridge> as ParallaxBridge;
  }

  /**
   * Connects to `m`, unless it's connected already. An account's computer this phone doesn't use
   * yet stays unconnected, gated, until it's set up or approved.
   */
  add(m: Machine): void {
    this.machines.set(m.id, m);
    if (this.hosts.has(m.id)) return;
    if (m.account && !this.account?.hosts.mayConnect(m.account.hostId))
      return this.account?.gated(m.id, { kind: "setup" });
    if (!m.account && !m.paired) return;
    const log = new ConnectionLog(writeConnectionLine, m.name);
    const open = m.account
      ? () => this.openAccount(m.id, log)
      : () => pairedSocket(m.paired!, (route) => (log.route = routeKind(route)));
    const host = new WebHost(open, () => this.signedOut(m), log);
    // WebHost names its one host `local`; here each is its computer's id.
    host.stateListeners.add((_, state) => {
      for (const listener of this.listeners) listener(m.id, state);
    });
    this.hosts.set(m.id, host);
    void host.connect();
  }

  /** Drops `id`'s connection. Its WebHost keeps no timers once its socket is gone. */
  remove(id: string): void {
    // First, so a close that says something shows at once, and a close that says nothing leaves no
    // grace running for the next connection.
    forgetConnection(id);
    const host = this.hosts.get(id);
    this.hosts.delete(id);
    host?.close();
    clearInterval(this.links.get(id)?.recheck);
    this.links.delete(id);
  }

  /** The routes the account's computer `id` reports, kept as it reports them. */
  learn(id: string, routes: string[], name: string) {
    const m = this.machines.get(id);
    if (m?.account) this.machines.set(id, { ...m, name: name || m.name, account: { ...m.account, routes } });
  }

  /** Opens the account computer `id`'s socket, racing its routes (accountHosts.ts). */
  private async openAccount(id: string, log: ConnectionLog): Promise<WebSocket | { error: string }> {
    const m = this.machines.get(id)!;
    const account = this.account!;
    const link = this.links.get(id) ?? { failedAt: {}, log };
    this.links.set(id, link);
    const only = link.moveTo;
    link.moveTo = undefined;
    const learn = (routes: string[], name: string) => {
      this.learn(id, routes, name);
      account.learned(id, routes, name);
    };
    const opened = await account.hosts.open(m.account!.hostId, m.account!, link.failedAt, learn, only);
    if ("error" in opened) {
      // The move failed: no re-check goes back to that route for a while, and the retry dials them all.
      if (only) link.failedAt[only] = Date.now();
      return opened;
    }
    if ("gate" in opened) {
      account.gated(id, opened.gate);
      // WebHost hands a revoked connection to `signedOut`, which lets it go.
      return { error: "revoked" };
    }
    const { socket, route } = opened;
    link.route = route;
    link.socket = socket;
    log.route = routeKind(route);
    log.detail = () => socket.relayEnd ?? {};
    this.keepChecking(id, link);
    return socket as unknown as WebSocket;
  }

  /** While `link` has a better route than the one it's on, checks it every minute. */
  private keepChecking(id: string, link: Link): void {
    clearInterval(link.recheck);
    const account = this.machines.get(id)?.account;
    if (!account || !link.route) return;
    const list = ordered(account.hostId, account);
    if (routesAhead(list, link.route, inOrder(account)).length)
      link.recheck = setInterval(() => void this.recheck(id), RECHECK_MS);
  }

  /**
   * Moves the account computer `id` to a better route when one answers with its key: its connection
   * ends and opens again over that route alone.
   */
  async recheck(id: string): Promise<void> {
    const link = this.links.get(id);
    const m = this.machines.get(id);
    const socket = link?.socket;
    if (!link || !socket || !link.route || !m?.account || !this.account) return;
    const better = await this.account.hosts.recheck(m.account.hostId, m.account, link.route, link.failedAt);
    if (better && link.socket === socket) {
      link.moveTo = better;
      link.log.expect("better_route");
      this.reopen(id, link, socket);
    }
  }

  private reopen(id: string, link: Link, socket: PinnedSocket): void {
    link.socket = undefined;
    clearInterval(link.recheck);
    socket.close();
    socket.onclose?.();
    this.hosts.get(id)?.retry();
  }

  /** The route computer `id`'s connection is on. */
  route(id: string): string | undefined {
    const link = this.links.get(id);
    return link?.socket && link.route;
  }

  /**
   * The user changed the account computer `id`'s routes to `choices`. Every route may be tried
   * again. A computer not connected tries now, one whose route is gone reopens, and any other
   * checks whether a route is now ahead of it.
   */
  routesEdited(id: string, choices: RouteChoices): void {
    const m = this.machines.get(id);
    if (!m?.account) return;
    const account = { ...m.account, ...choices };
    this.machines.set(id, { ...m, account });
    const link = this.links.get(id);
    if (link) {
      link.failedAt = {};
      link.moveTo = undefined;
    }
    if (!link?.socket || !link.route) return void this.hosts.get(id)?.retry();
    if (!ordered(account.hostId, account).includes(link.route)) {
      link.log.expect("route_removed");
      return this.reopen(id, link, link.socket);
    }
    this.keepChecking(id, link);
    void this.recheck(id);
  }

  /** Ends every connection, as when the app signs out. */
  close(): void {
    for (const id of [...this.hosts.keys()]) this.remove(id);
  }

  /**
   * After the phone wakes or its network changes: checks each connection, retries the failed ones
   * now, and moves those on the relay to a LAN route that answers.
   */
  wake(): void {
    for (const host of this.hosts.values()) {
      host.heartbeat();
      host.retry();
    }
    for (const id of this.links.keys()) void this.recheck(id);
  }
}

/**
 * A computer's icon, from its name as the desktop's DeviceIcon derives one when none is set
 * (0056): a mini PC, a PC, a server, or else a laptop.
 */
export function deviceKind(name: string): "laptop" | "desktop" | "mini" | "server" {
  const n = name.toLowerCase();
  if (n.includes("mini")) return "mini";
  if (/desktop|pc|tower/.test(n)) return "desktop";
  return n.includes("server") ? "server" : "laptop";
}
