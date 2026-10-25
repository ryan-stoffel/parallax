// The user's computers, reached with Parallax Connect over Tailscale (0056): plxd listens on
// port 7340 on its tailnet address and serves the phone because Tailscale says it's the same
// user's untagged node, so there is nothing to pair. One computer, typed in once, lists the rest
// (`connect/devices`). A computer paired on the LAN (0065, host.ts) joins the list too.
//
// Each computer gets a `WebHost`, the web client's connection, and `window.parallax` routes the
// desktop's shared hooks to it by the computer's id, as the desktop's bridge routes by host.

import { File } from "expo-file-system";

import type { ConnectionState, ParallaxBridge } from "../../desktop/src/preload/bridge";
import type { ConnectDevicesResult, TailnetDevice } from "../../desktop/src/protocol/generated/protocol";
import { WebHost } from "../../desktop/src/renderer/webBridge";
import { PinnedSocket, privateFile } from "../modules/pinned-tls";
import { loadSaved, pairedSocket, type Saved } from "./host";

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
}

/** What the phone keeps: its computers, and the one new threads start on. */
export interface Setup {
  machines: Machine[];
  defaultId?: string;
}

const setupFile = new File(privateFile("machines.json"));

/** A LAN-paired computer's id, from its certificate's fingerprint. */
export const pairedId = (saved: Saved) => `paired-${saved.fingerprint.slice(0, 16)}`;

/**
 * The saved setup, with a LAN-paired computer's session put back from the Keychain, where
 * `saveSetup` leaves it. A paired computer whose session is gone, as after a revoke, drops out.
 */
export async function loadSetup(): Promise<Setup> {
  let setup: Setup = { machines: [] };
  try {
    if (setupFile.exists) setup = JSON.parse(setupFile.textSync()) as Setup;
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

/** The phone's connections, one `WebHost` per computer, and the bridge the shared hooks use. */
export class Fleet {
  readonly hosts = new Map<string, WebHost>();
  private readonly listeners = new Set<(hostId: string, state: ConnectionState) => void>();

  constructor(
    private readonly signedOut: (machine: Machine) => Promise<void>,
    machines: Machine[],
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

  /** Connects to `m`, unless it's connected already. */
  add(m: Machine): void {
    if (this.hosts.has(m.id)) return;
    const open = m.paired
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
  }

  /** Ends every connection, as when the app signs out. */
  close(): void {
    for (const id of [...this.hosts.keys()]) this.remove(id);
  }

  /** After the phone wakes: checks each connection, and retries the failed ones now. */
  wake(): void {
    for (const host of this.hosts.values()) {
      host.heartbeat();
      host.retry();
    }
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
