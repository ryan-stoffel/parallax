// The user's computers: the account's, which Parallax Relay lists (0091, accountHosts.ts), as
// `account:<hostId>`, reached over their LAN or relay routes, and one paired on the LAN with a code
// (0065, host.ts).
//
// Each computer gets a `WebHost`, the web client's connection, and `window.parallax` routes the
// desktop's shared hooks to it by the computer's id, as the desktop's bridge routes by host.

import { File } from "expo-file-system";

import type { ConnectionState, ParallaxBridge } from "../../desktop/src/preload/bridge";
import { WebHost } from "../../desktop/src/renderer/webBridge";
import { privateFile, type PinnedSocket } from "../modules/pinned-tls";
import type { AccountHosts, Gate } from "./accountHosts";
import { loadSaved, pairedSocket } from "./host";
import { isRelay, RECHECK_MS } from "./routes";
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
    if (m.account && !this.account?.hosts.trusts(m.account.hostId))
      return this.account?.gated(m.id, { kind: "setup" });
    if (!m.account && !m.paired) return;
    const open = m.account ? () => this.openAccount(m.id) : () => pairedSocket(m.paired!);
    const host = new WebHost(open, () => this.signedOut(m));
    // WebHost names its one host `local`; here each is its computer's id.
    host.stateListeners.add((_, state) => {
      for (const listener of this.listeners) listener(m.id, state);
    });
    this.hosts.set(m.id, host);
    void host.connect();
  }

  /** Drops `id`'s connection. Its WebHost keeps no timers once its socket is gone. */
  remove(id: string): void {
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
  private async openAccount(id: string): Promise<WebSocket | { error: string }> {
    const m = this.machines.get(id)!;
    const account = this.account!;
    const link = this.links.get(id) ?? { failedAt: {} };
    this.links.set(id, link);
    const opened = await account.hosts.open(m.account!.hostId, m.account!.routes, link.failedAt, (routes, name) => {
      this.learn(id, routes, name);
      account.learned(id, routes, name);
    });
    if ("error" in opened) return opened;
    if ("gate" in opened) {
      account.gated(id, opened.gate);
      // WebHost hands a revoked connection to `signedOut`, which lets it go.
      return { error: "revoked" };
    }
    const { socket, route } = opened;
    link.route = route;
    link.socket = socket;
    clearInterval(link.recheck);
    // On the relay, check every minute whether a LAN route answers again.
    if (isRelay(route)) link.recheck = setInterval(() => void this.recheck(id), RECHECK_MS);
    return socket as unknown as WebSocket;
  }

  /**
   * Moves the account computer `id` off the relay when one of its LAN routes answers with its key:
   * its connection ends and opens again, and the race then picks the LAN route.
   */
  async recheck(id: string): Promise<void> {
    const link = this.links.get(id);
    const m = this.machines.get(id);
    if (!link?.socket || !link.route || !isRelay(link.route) || !m?.account || !this.account) return;
    const direct = await this.account.hosts.recheck(m.account.hostId, m.account.routes, link.failedAt);
    const socket = link.socket;
    if (!direct || link.socket !== socket) return;
    link.socket = undefined;
    clearInterval(link.recheck);
    socket.close();
    socket.onclose?.();
    this.hosts.get(id)?.retry();
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
