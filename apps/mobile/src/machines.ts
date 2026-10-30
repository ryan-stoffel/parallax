// The user's computers. The account's, which Parallax Relay lists (0091, accountHosts.ts), are
// `account:<hostId>`, reached over their LAN, Tailscale, or relay routes. Until they all run it,
// computers reached with Parallax Connect over Tailscale (0056) stay too: plxd listens on port
// 7340 on its tailnet address and serves the phone because Tailscale says it's the same user's
// untagged node, and one computer, typed in once, lists the rest (`connect/devices`). Each moves to
// its `account:` connection once that one connects. A computer paired on the LAN (0065, host.ts)
// joins the list too.
//
// Each computer gets a `WebHost`, the web client's connection, and `window.parallax` routes the
// desktop's shared hooks to it by the computer's id, as the desktop's bridge routes by host.

import { File } from "expo-file-system";

import type { ConnectionState, ParallaxBridge } from "../../desktop/src/preload/bridge";
import type { ConnectDevicesResult, TailnetDevice } from "../../desktop/src/protocol/generated/protocol";
import { WebHost } from "../../desktop/src/renderer/webBridge";
import { PinnedSocket, privateFile } from "../modules/pinned-tls";
import type { AccountHosts, Gate, Listed } from "./accountHosts";
import { loadSaved, pairedSocket, type Saved } from "./host";
import { isRelay, RECHECK_MS } from "./routes";

const CONNECT_PORT = 7340;

/** A computer the phone uses: its tailnet node's id, name, OS, and address. */
export interface Machine {
  id: string;
  name: string;
  /** `macOS`, `windows`, or `linux`, as Tailscale names it. */
  os: string;
  /** Its Tailscale IP, or a MagicDNS name. */
  address: string;
  /** A LAN-paired computer's session, which it's reached with instead of Connect. */
  paired?: Saved;
  /** An account's computer: its host id, and the LAN and Tailscale routes it last reported. */
  account?: { hostId: string; routes: string[] };
}

/** What the phone keeps: its computers, the one new threads start on, and whether onboarding is done. */
export interface Setup {
  machines: Machine[];
  defaultId?: string;
  /** Onboarding finished, with or without a computer: skipping Find computers finishes it too. */
  onboarded: boolean;
  /** The account's computers removed from this phone, which discovery leaves out. */
  hidden?: string[];
}

/** An account's computer's id. */
export const accountId = (hostId: string) => `account:${hostId}`;

/**
 * `known` with the account's computers the relay `listed` that it lacks, unless removed from this
 * phone. A known one keeps the name it reports itself, and one the relay no longer lists stays,
 * as an offline one does.
 */
export function withListed(known: Machine[], listed: Listed[], hidden: string[] = []): Machine[] {
  const added = listed
    .filter((l) => !hidden.includes(accountId(l.hostId)) && !known.some((m) => m.id === accountId(l.hostId)))
    .map((l) => ({
      id: accountId(l.hostId),
      name: l.name || "Computer",
      os: "",
      address: "",
      account: { hostId: l.hostId, routes: [] },
    }));
  return added.length ? [...known, ...added] : known;
}

const setupFile = new File(privateFile("machines.json"));

/** A LAN-paired computer's id, from its certificate's fingerprint. */
export const pairedId = (saved: Saved) => `paired-${saved.fingerprint.slice(0, 16)}`;

/**
 * The saved setup, with a LAN-paired computer's session put back from the Keychain, where
 * `saveSetup` leaves it. A paired computer whose session is gone, as after a revoke, drops out.
 */
export async function loadSetup(): Promise<Setup> {
  let setup: Setup = { machines: [], onboarded: false };
  try {
    if (setupFile.exists) {
      const read = JSON.parse(setupFile.textSync()) as Omit<Setup, "onboarded"> & { onboarded?: boolean };
      // A setup saved before `onboarded` finished onboarding if it has a computer.
      setup = { ...read, onboarded: read.onboarded ?? read.machines.length > 0 };
    }
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

/** The computers among `devices` that run Parallax with Connect on, phones and tablets aside. */
export const computers = (devices: TailnetDevice[]): Machine[] =>
  devices
    .filter((d) => d.parallax && d.os !== "iOS" && d.os !== "android")
    .map((d) => ({ id: d.id, name: d.hostName, os: d.os, address: d.ip }));

/**
 * `known` with what `devices` says now: new computers added, and names and addresses kept
 * current. A computer missing from `devices` stays, since an offline one may not answer.
 */
export function merge(known: Machine[], found: Machine[]): Machine[] {
  const next = known.map((m) => {
    const now = found.find((f) => f.id === m.id);
    return now && !m.paired ? { ...m, name: now.name, os: now.os, address: now.address } : m;
  });
  for (const f of found) if (!next.some((m) => m.id === f.id)) next.push(f);
  return next;
}

/**
 * Asks the plxd at `address` for the tailnet's Parallax computers, itself included, once. Rejects
 * with an error for people when it can't reach one.
 */
export function probe(address: string): Promise<Machine[]> {
  return new Promise((resolve, reject) => {
    const socket = new PinnedSocket({ host: address.trim(), port: CONNECT_PORT });
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.onclose = undefined;
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`${address} didn't answer. Check that Tailscale is on and Parallax is open there.`),
      12_000,
    );
    socket.onclose = () =>
      fail(
        `Couldn't reach Parallax at ${address}. Check the name, and that Parallax Connect is on ` +
          "in its Settings > Connections.",
      );
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocol: { min: 1, max: 1 },
            client: { name: "parallax-mobile", version: "mobile" },
            capabilities: {},
          },
        }),
      );
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.error) return fail(message.error.message);
      if (message.id === 1)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "connect/devices", params: {} }));
      if (message.id !== 2) return;
      const { devices, self } = message.result as ConnectDevicesResult;
      clearTimeout(timer);
      socket.onclose = undefined;
      socket.close();
      resolve(computers(self ? [self, ...devices] : devices));
    };
  });
}

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
    const open = m.account
      ? () => this.openAccount(m.id)
      : m.paired
        ? () => pairedSocket(m.paired!)
        : async () => new PinnedSocket({ host: m.address, port: CONNECT_PORT }) as unknown as WebSocket;
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
    // On the relay, check every minute whether a direct route answers again.
    if (isRelay(route)) link.recheck = setInterval(() => void this.recheck(id), RECHECK_MS);
    return socket as unknown as WebSocket;
  }

  /**
   * Moves the account computer `id` off the relay when one of its direct routes answers with its
   * key: its connection ends and opens again, and the race then picks the direct route.
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
   * now, and moves those on the relay to a direct route that answers.
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
