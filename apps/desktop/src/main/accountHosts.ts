import type { DeviceIcon } from "../preload/bridge";
import type { AccessState, RelayHost } from "../protocol/generated/protocol";
import { isDeviceIcon } from "./connect";
import { isRoute } from "./settings";

// Parallax Connect over the relay (0091), the parts in main that need no Electron: what
// settings.json keeps of each computer on the account, the routes a dial tries and when it moves
// off the relay, the typed-code limit, and the lists copied between hosts. hosts.ts runs them.

/** A computer on the signed-in account, as `settings.json` keeps it, listed while it's offline. */
export type SavedAccount = {
  /** Its relay id: the JWK thumbprint of its host key, which `plxd dial --account` pins. */
  hostId: string;
  /** Its plxd's `deviceName`, else the name it registered with the relay. */
  name: string;
  /** Its direct routes as it last reported them, LAN first, then Tailscale. Never the relay. */
  routes: string[];
  icon?: DeviceIcon;
  /** Turned off in this app: listed, with no connection. */
  off?: true;
  /** Removed from this app's list. Kept, so the account listing it again doesn't add it back. */
  removed?: true;
  /** When a typed setup code ran against it, in ms since the epoch, within the last hour. */
  pairRuns?: number[];
};

/** An account computer's host id in the app. */
export const accountId = (hostId: string) => `account:${hostId}`;

/** The relay id in an `account:` host id, else undefined. */
export const relayIdOf = (id: string): string | undefined =>
  id.startsWith("account:") ? id.slice("account:".length) : undefined;

/** A relay id: a base64url SHA-256, as plxd's `is_host_id` takes. */
export const isRelayId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Routes worth keeping from a host's answer: direct ones `plxd dial` takes, in its order. */
export const directRoutes = (routes: unknown): string[] =>
  Array.isArray(routes)
    ? [...new Set(routes.filter((r): r is string => isRoute(r) && !r.startsWith("relay:")))]
    : [];

/** Checks `settings.json`'s `accounts`. Throws for people when an entry isn't one. */
export function checkAccounts(accounts: unknown, ids: Set<string>): void {
  if (!Array.isArray(accounts)) throw new Error("`accounts` isn't a list");
  for (const entry of accounts as unknown[]) {
    const { hostId, name, routes, icon, off, removed, pairRuns } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    const where = `account computer ${JSON.stringify(entry)}`;
    if (!isRelayId(hostId) || ids.has(accountId(hostId))) throw new Error(`${where} has a bad id`);
    ids.add(accountId(hostId));
    if (typeof name !== "string" || !Array.isArray(routes) || !routes.every(isRoute))
      throw new Error(`${where} needs a name and routes`);
    if (icon !== undefined && !isDeviceIcon(icon)) throw new Error(`${where} has a bad icon`);
    if ((off !== undefined && off !== true) || (removed !== undefined && removed !== true))
      throw new Error(`${where} has a bad off or removed`);
    if (
      pairRuns !== undefined &&
      !(Array.isArray(pairRuns) && pairRuns.every((at) => Number.isSafeInteger(at)))
    )
      throw new Error(`${where} has bad pairRuns`);
  }
}

/**
 * `saved` after `relay/hosts` answered `listed`: each other computer kept, with its own name and
 * routes once known, a new one added, and one the account no longer has dropped.
 */
export function mergeListed(
  saved: SavedAccount[],
  listed: RelayHost[],
): { accounts: SavedAccount[]; changed: boolean } {
  const others = listed.filter((h) => !h.thisComputer && isRelayId(h.hostId));
  const accounts = others.map(
    (h) =>
      saved.find((s) => s.hostId === h.hostId) ?? { hostId: h.hostId, name: h.name, routes: [] },
  );
  const changed = accounts.length !== saved.length || accounts.some((each, i) => each !== saved[i]);
  return { accounts, changed };
}

/** A typed setup code's runs allowed per host an hour (0091), since a fake host sets no limit. */
export const MAX_PAIR_RUNS = 5;
const HOUR_MS = 60 * 60_000;

/** `runs` with one more at `now`, or undefined when `MAX_PAIR_RUNS` ran within the hour. */
export function countPairRun(runs: number[] | undefined, now: number): number[] | undefined {
  const recent = (runs ?? []).filter((at) => now - at < HOUR_MS);
  return recent.length >= MAX_PAIR_RUNS ? undefined : [...recent, now];
}

/** How often a connection on the relay checks its direct routes again (0091). */
export const RECHECK_MS = 60_000;
/**
 * How long a direct route waits after it failed having answered (0091), as T3's supervisor does.
 */
export const BENCH_MS = 5 * 60_000;

/**
 * One account computer's routes: what its dial tries, and moving off the relay. A dial tries the
 * learned direct routes not waiting out a failure, then the relay; `plxd dial` races them, the
 * relay 200 ms after the direct ones. While the connection is on the relay, `recheck` probes the
 * direct routes, every `RECHECK_MS` and when hosts.ts calls it on a network change or focus, and
 * `move` reconnects once one answers with the pinned key.
 *
 * A direct route that answered, a probe's or the dial's, but whose connection then never came up
 * over it waits `BENCH_MS`, so a flaky network can't bounce the connection. A connection that came
 * up and later ended, as on sleep, a network change, or the host restarting, holds nothing back.
 */
export class Routes {
  /** The route the current attempt went over, from `plxd dial`'s stderr. */
  route?: string;
  private connected = false;
  /** The direct route a re-check found answering, until the connection it moved to comes up. */
  private probed?: string;
  private readonly benched = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;

  constructor(
    private readonly options: {
      hostId: string;
      learned: () => string[];
      /** The first of `routes` to present the pinned key, with nothing sent; undefined for none. */
      probe: (routes: string[]) => Promise<string | undefined>;
      /** Reconnects, so the dial races the routes again. */
      move: () => void;
      now?: () => number;
    },
  ) {}

  /** The routes a dial tries, in order. */
  dial(): string[] {
    return [...this.direct(), `relay:${this.options.hostId}`];
  }

  /** The learned direct routes, less those waiting out a failure. */
  direct(): string[] {
    const now = (this.options.now ?? Date.now)();
    return this.options.learned().filter((r) => !((this.benched.get(r) ?? 0) > now));
  }

  /** Whether the current connection is on the relay. */
  get onRelay(): boolean {
    return this.connected && !!this.route?.startsWith("relay:");
  }

  /** The connection's status changed. */
  onStatus(status: "connecting" | "connected" | "failed"): void {
    if (status === "connected") {
      // Moved for a route that answered a probe, but came up over another.
      if (this.probed && this.route !== this.probed) this.bench(this.probed);
      this.probed = undefined;
      this.connected = true;
      if (this.onRelay) this.timer ??= setInterval(() => void this.recheck(), RECHECK_MS);
      else this.stop();
      return;
    }
    if (!this.connected) {
      // The dial reached this route, then the connection failed before it came up.
      if (status === "failed" && this.route) this.bench(this.route);
      // The dial after a move failed altogether.
      if (status === "failed" && this.probed) this.bench(this.probed);
      if (status === "failed") this.probed = undefined;
    }
    this.connected = false;
    this.route = undefined;
    this.stop();
  }

  /** While on the relay, probes the direct routes, and moves the connection when one answers. */
  async recheck(): Promise<void> {
    if (!this.onRelay || this.checking) return;
    const routes = this.direct();
    if (!routes.length) return;
    this.checking = true;
    try {
      const answered = await this.options.probe(routes);
      if (answered && this.onRelay) {
        this.probed = answered;
        this.options.move();
      }
    } finally {
      this.checking = false;
    }
  }

  /** Holds direct route `route` back for `BENCH_MS`. The relay is never held back. */
  private bench(route: string): void {
    if (!route.startsWith("relay:"))
      this.benched.set(route, (this.options.now ?? Date.now)() + BENCH_MS);
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** What `plxd dial --account --sign-in` prints, a line each. */
export type SignInAnswer =
  | { status: "approved"; name: string; routes: string[] }
  | { status: "pending"; request: string; code: string };

/** One line of `plxd dial --account --sign-in`'s output, or undefined for anything else. */
export function parseSignIn(line: string): SignInAnswer | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (value["status"] === "approved")
    return {
      status: "approved",
      name: typeof value["name"] === "string" ? value["name"] : "",
      routes: directRoutes(value["routes"]),
    };
  if (
    value["status"] === "pending" &&
    typeof value["request"] === "string" &&
    typeof value["code"] === "string" &&
    /^\d{6}$/.test(value["code"])
  )
    return { status: "pending", request: value["request"], code: value["code"] };
  return undefined;
}

/** A host's approved and removed keys and approved host ids, as `access/merge` takes them. */
export type Lists = Pick<AccessState, "approvedClients" | "removedClients" | "approvedHosts">;

/**
 * Every list in `states` together, with `hostIds`, the connected hosts' own relay ids, approved
 * too. A key removed anywhere is removed, and not approved, everywhere.
 */
export function unionLists(states: Lists[], hostIds: string[]): Lists {
  const removed = new Set(states.flatMap((s) => s.removedClients));
  const approved = new Set(states.flatMap((s) => s.approvedClients).filter((k) => !removed.has(k)));
  const hosts = new Set([...states.flatMap((s) => s.approvedHosts), ...hostIds]);
  return {
    approvedClients: [...approved].sort(),
    removedClients: [...removed].sort(),
    approvedHosts: [...hosts].sort(),
  };
}

/** Whether `state` lacks anything in `union`, so the host needs an `access/merge`. */
export function lacks(state: Lists, union: Lists): boolean {
  const has = (list: string[], want: string[]) => want.every((each) => list.includes(each));
  return (
    !has(state.approvedClients, union.approvedClients) ||
    !has(state.removedClients, union.removedClients) ||
    !has(state.approvedHosts, union.approvedHosts)
  );
}

/**
 * `run`, called as often as anything asks, never twice at once: a call while it runs makes it run
 * once more after, so a trigger that came mid-run isn't lost.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
