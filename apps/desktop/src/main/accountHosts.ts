import { t } from "i18next";

import type { DeviceIcon, KeyStanding, Outage } from "../preload/bridge";
import type {
  AccessState,
  RelayHost,
  RelayHostsResult,
  RemoteSessionsResult,
} from "../protocol/generated/protocol";
import { inOrder, isRelay, routeList, routesAhead, type RouteChoices } from "../preload/routeList";
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
  /** Direct addresses the user added, kept whatever it reports. */
  addedRoutes?: string[];
  /** The user's order of all its routes, the relay included, once they move one. */
  routeOrder?: string[];
  /** Routes it reports that the user removed in this app, which it never tries. */
  hiddenRoutes?: string[];
  icon?: DeviceIcon;
  /** Turned off in this app: listed, with no connection. */
  off?: true;
  /** From before Remove left the account (PLX-1312): discovery finishes removing it. */
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

/**
 * A Clerk token's user id, its JWT's `sub`, read without checking the signature: main got the
 * token from Clerk itself, and only passes the id to a plxd it trusts (`relay/sign`). Undefined
 * for anything that isn't a JWT with one.
 */
export function tokenSubject(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/** Routes worth keeping from a host's answer: direct ones `plxd dial` takes, in its order. */
export const directRoutes = (routes: unknown): string[] =>
  Array.isArray(routes)
    ? [...new Set(routes.filter((r): r is string => isRoute(r) && !r.startsWith("relay:")))]
    : [];

/** Checks `settings.json`'s `accounts`. Throws for people when an entry isn't one. */
export function checkAccounts(accounts: unknown, ids: Set<string>): void {
  if (!Array.isArray(accounts)) throw new Error(t("`accounts` isn't a list"));
  for (const entry of accounts as unknown[]) {
    const {
      hostId,
      name,
      routes,
      addedRoutes,
      routeOrder,
      hiddenRoutes,
      icon,
      off,
      removed,
      pairRuns,
    } = (entry ?? {}) as Record<string, unknown>;
    const where = t("account computer {{entry}}", { entry: JSON.stringify(entry) });
    if (!isRelayId(hostId) || ids.has(accountId(hostId)))
      throw new Error(t("{{where}} has a bad id", { where }));
    ids.add(accountId(hostId));
    if (typeof name !== "string" || !Array.isArray(routes) || !routes.every(isRoute))
      throw new Error(t("{{where}} needs a name and routes", { where }));
    if (
      addedRoutes !== undefined &&
      !(Array.isArray(addedRoutes) && addedRoutes.every((r) => isRoute(r) && !isRelay(r)))
    )
      throw new Error(t("{{where}} has bad addedRoutes", { where }));
    if (routeOrder !== undefined && !(Array.isArray(routeOrder) && routeOrder.every(isRoute)))
      throw new Error(t("{{where}} has a bad routeOrder", { where }));
    if (
      hiddenRoutes !== undefined &&
      !(Array.isArray(hiddenRoutes) && hiddenRoutes.every((r) => isRoute(r) && !isRelay(r)))
    )
      throw new Error(t("{{where}} has bad hiddenRoutes", { where }));
    if (icon !== undefined && !isDeviceIcon(icon))
      throw new Error(t("{{where}} has a bad icon", { where }));
    if ((off !== undefined && off !== true) || (removed !== undefined && removed !== true))
      throw new Error(t("{{where}} has a bad off or removed", { where }));
    if (
      pairRuns !== undefined &&
      !(Array.isArray(pairRuns) && pairRuns.every((at) => Number.isSafeInteger(at)))
    )
      throw new Error(t("{{where}} has bad pairRuns", { where }));
  }
}

/**
 * `saved` after `relay/hosts` answered `listed` and `removed`: each computer kept, with its own
 * name and routes, and a new one added. Only `removed` drops one (PLX-1351): a list without it may
 * come from a relay that lost its data, and dropping it would close a working LAN connection.
 */
export function mergeListed(
  saved: SavedAccount[],
  listed: RelayHost[],
  removed: string[] = [],
): { accounts: SavedAccount[]; changed: boolean } {
  const own = listed.find((h) => h.thisComputer)?.hostId;
  const kept = saved.filter((s) => s.hostId !== own && !removed.includes(s.hostId));
  const added = listed
    .filter((h) => !h.thisComputer && isRelayId(h.hostId))
    .filter((h) => !saved.some((s) => s.hostId === h.hostId))
    .map((h) => ({ hostId: h.hostId, name: h.name, routes: [] }));
  const accounts = [...kept, ...added];
  return { accounts, changed: added.length > 0 || kept.length !== saved.length };
}

/** What a failed `relay/hosts` says is down, from plxd's error kind. Undefined for anything else. */
export function outageOf(error: { data?: unknown }): Outage | undefined {
  const { kind } = (error.data ?? {}) as { kind?: unknown };
  return kind === "relayUnreachable" ? "relay" : kind === "clerkUnreachable" ? "clerk" : undefined;
}

/**
 * Whether `plxd dial`'s stderr says Parallax Relay refused its stream with 503, which on a stream
 * is only `host_offline`: that computer's plxd isn't connected to the relay. Clerk being down
 * refuses a stream with 401, and shows as the account list's `clerkUnreachable` (`outageOf`).
 */
export const relayOffline = (stderr: string) =>
  /the relay's WebSocket failed: HTTP 503\b/.test(stderr);

/** Reads of the account's list that must fail in a row before the app says so, so a blip doesn't. */
const OUTAGE_READS = 2;

/**
 * Follows each read of the account's list, and calls `changed` when the notice to show changes. A
 * read that found a problem counts toward `OUTAGE_READS`, and one that didn't ends it.
 */
export class NoticeWatch<T extends string> {
  /** The notice to show, if any. */
  current?: T;
  private failed = 0;

  constructor(private readonly changed: () => void) {}

  /** One read: the problem it found, if any. */
  read(found: T | undefined): void {
    this.failed = found ? this.failed + 1 : 0;
    const next = this.failed >= OUTAGE_READS ? found : undefined;
    if (next === this.current) return;
    this.current = next;
    this.changed();
  }
}

/**
 * Whether the key and account that joined the relay are missing from `list`, with no mark that it
 * was removed. The relay may have lost its data, or it was removed before the relay kept marks.
 */
export const joinedNotListed = (
  { hosts, removed }: RelayHostsResult,
  joined: { hostId: string; user: string } | undefined,
  user: string | undefined,
): boolean =>
  !!joined &&
  joined.user === user &&
  !hosts.some((host) => host.hostId === joined.hostId) &&
  !removed?.includes(joined.hostId);

/** Which computers the account lists, which are online, and which it marks removed. */
export const listedKey = ({ hosts, removed }: RelayHostsResult): string =>
  [
    ...hosts.map((host) => `${host.hostId} ${host.online}`).sort(),
    ...(removed ?? []).map((hostId) => `removed ${hostId}`).sort(),
  ].join("\n");

/** A typed setup code's runs allowed per host an hour (0091), since a fake host sets no limit. */
export const MAX_PAIR_RUNS = 5;
const HOUR_MS = 60 * 60_000;

/** `runs` with one more at `now`, or undefined when `MAX_PAIR_RUNS` ran within the hour. */
export function countPairRun(runs: number[] | undefined, now: number): number[] | undefined {
  const recent = (runs ?? []).filter((at) => now - at < HOUR_MS);
  return recent.length >= MAX_PAIR_RUNS ? undefined : [...recent, now];
}

/** How long `waitForListener` waits for plxd to listen and reach the relay. */
const LISTENER_WAIT_MS = 15_000;

/**
 * Waits until plxd is listening and connected to the relay, as `plx connect` does before it shows
 * a code. Past `waitMs`, listening alone is enough, since the code still works on this network.
 * Resolves to why it isn't listening, for people, or undefined. `read` answers plxd's
 * `remote/sessions`, or an error for people.
 */
export async function waitForListener(
  read: () => Promise<Pick<RemoteSessionsResult, "listening" | "problem" | "relay"> | string>,
  waitMs = LISTENER_WAIT_MS,
  pollMs = 500,
): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const status = await read();
    if (typeof status === "string") return status;
    if (status.listening && status.relay?.connected) return undefined;
    if (Date.now() >= deadline)
      return status.listening
        ? undefined
        : (status.problem ?? t("This computer didn't start listening in time. Try again."));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** How often a connection on a later route checks the better ones again (0091). */
export const RECHECK_MS = 60_000;
/**
 * How long a direct route waits after it failed having answered (0091), as T3's supervisor does.
 */
export const BENCH_MS = 5 * 60_000;

/**
 * One account computer's routes: what its dial tries, and moving to a better one. A dial tries the
 * routes not waiting out a failure: `plxd dial` races the direct ones with the relay 200 ms after
 * them, or takes the user's order, once they've set one (`--in-order`). While the connection is on
 * a route with better ones, `recheck` probes those, every `RECHECK_MS` and when hosts.ts calls it
 * on a network change or focus, and `move` reconnects, over that route alone, once one answers with
 * the pinned key.
 *
 * A route that answered, a probe's or the dial's, but whose connection then never came up over it
 * waits `BENCH_MS`, so a flaky network can't bounce the connection. A connection that came up and
 * later ended, as on sleep, a network change, or the host restarting, holds nothing back.
 */
export class Routes {
  /** The route the current attempt went over, from `plxd dial`'s stderr. */
  route?: string;
  private connected = false;
  /** The route a re-check found answering, until the connection it moved to comes up. */
  private probed?: string;
  private readonly benched = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private editedWhileChecking = false;

  constructor(
    private readonly options: {
      hostId: string;
      /** What this device keeps of the computer's routes. */
      choices: () => RouteChoices;
      /** The first of `routes` to present the pinned key, with nothing sent; undefined for none. */
      probe: (routes: string[], inOrder: boolean) => Promise<string | undefined>;
      /** Reconnects, so the dial races the routes again. */
      move: () => void;
      now?: () => number;
    },
  ) {}

  /**
   * The routes a dial tries, in order: only the route a re-check found, for the move to it, so a
   * slower route above a working one can't lose the dial and be moved to again at every re-check.
   * Otherwise every route not waiting out a failure, and always the relay.
   */
  dial(): string[] {
    if (this.probed) return [this.probed];
    const list = this.list();
    const usable = this.usable(list);
    return list.filter((r) => isRelay(r) || usable.includes(r));
  }

  /** Whether a dial takes the routes in the user's order. */
  get inOrder(): boolean {
    return inOrder(this.options.choices());
  }

  private list(): string[] {
    return routeList(this.options.hostId, this.options.choices());
  }

  /** `routes` less those waiting out a failure. */
  private usable(routes: string[]): string[] {
    const now = (this.options.now ?? Date.now)();
    return routes.filter((r) => !((this.benched.get(r) ?? 0) > now));
  }

  /** The routes better than the one the connection is on. */
  private ahead(): string[] {
    if (!this.connected || !this.route) return [];
    return routesAhead(this.list(), this.route, this.inOrder);
  }

  /** The connection's status changed. */
  onStatus(status: "connecting" | "connected" | "failed"): void {
    if (status === "connected") {
      this.probed = undefined;
      this.connected = true;
      this.keepChecking();
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

  /** While on a route with better ones, probes those, and moves the connection when one answers. */
  async recheck(): Promise<void> {
    if (this.checking) return;
    const from = this.route;
    const routes = this.usable(this.ahead());
    if (!routes.length) return;
    this.checking = true;
    try {
      const answered = await this.options.probe(routes, this.inOrder);
      if (answered && this.connected && this.route === from) {
        this.probed = answered;
        this.options.move();
      }
    } finally {
      this.checking = false;
      if (this.editedWhileChecking) {
        this.editedWhileChecking = false;
        void this.recheck();
      }
    }
  }

  /**
   * The user changed the routes, so each may be tried again. A connection not up, or over a route
   * that's gone, dials again. Any other checks now whether a route is ahead of it.
   */
  edited(): void {
    this.benched.clear();
    this.probed = undefined;
    if (!this.connected || !this.route || !this.list().includes(this.route)) {
      this.options.move();
      return;
    }
    this.keepChecking();
    if (this.checking) this.editedWhileChecking = true;
    else void this.recheck();
  }

  /** Probes every `RECHECK_MS` while the connection has a better route. */
  private keepChecking(): void {
    if (this.ahead().length) this.timer ??= setInterval(() => void this.recheck(), RECHECK_MS);
    else this.stop();
  }

  /** Holds `route` back for `BENCH_MS`. A dial still tries the relay, but no re-check moves to it. */
  private bench(route: string): void {
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
  | { status: "pending"; request: string; code: string }
  /** The user clicked Allow, and the computer waits for its own screen to confirm too. */
  | { status: "confirm" };

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
  if (value["status"] === "confirm") return { status: "confirm" };
  return undefined;
}

/**
 * A host's approved, removed, and read-only keys and approved host ids, as `access/merge` takes
 * them. A plxd from before read-only devices leaves out the read-only keys.
 */
export type Lists = Pick<
  AccessState,
  "approvedClients" | "removedClients" | "approvedHosts" | "allowedHosts" | "readOnlyClients"
>;

/** `plxd dial` exits with this when no route answered. */
export const EXIT_UNAVAILABLE = 4;
/** `plxd dial --sign-in` exits with this when the computer says this one's key was removed. */
export const EXIT_REMOVED = 6;

/** What `lists` say of `key`, this computer's own, if they say it needs replacing (0091). */
export function keyStandingIn(
  key: string | undefined,
  lists: Pick<Lists, "removedClients" | "readOnlyClients">,
): KeyStanding | undefined {
  if (!key) return undefined;
  if (lists.removedClients.includes(key)) return "removed";
  return lists.readOnlyClients?.includes(key) ? "readOnly" : undefined;
}

/**
 * Which of `known` this app takes lists from (0091), `own` being this computer's plxd, which it
 * always trusts. A computer added with Allow alone may be a fake one the user clicked through, so
 * it gets lists but gives none: nothing it says reaches the user's other computers. Marks count
 * only from a computer that isn't marked itself, so a fake one can't demote the real ones. Each
 * `relayId` must be what the connection pins, never what the computer says of itself.
 */
export function listSources<T extends { relayId: string; state: Lists }>(
  known: T[],
  own: T | undefined,
): T[] {
  const allowed = allowedAmong(known, own);
  return known.filter((each) => each === own || !allowed.has(each.relayId));
}

/** The computers `own`'s list and those it leads to mark as added with Allow alone (0091). */
export function allowedAmong<T extends { relayId: string; state: Lists }>(
  known: T[],
  own: T | undefined,
): Set<string> {
  const allowed = new Set(own?.state.allowedHosts ?? []);
  for (let size = -1; size !== allowed.size;) {
    size = allowed.size;
    for (const each of known)
      if (!allowed.has(each.relayId))
        for (const id of each.state.allowedHosts ?? []) allowed.add(id);
  }
  return allowed;
}

/**
 * Every list in `states` together, with `hostIds`, the connected hosts' own relay ids, approved
 * too. A key removed anywhere is removed, and not approved, everywhere. A key read-only anywhere
 * is read-only everywhere. A computer added with Allow alone stays out of `approvedHosts`, the only list an older client or plxd reads, so neither ever
 * takes it for a computer the user verified.
 */
export function unionLists(states: Lists[], hostIds: string[]): Lists {
  const removed = new Set(states.flatMap((s) => s.removedClients));
  const approved = new Set(states.flatMap((s) => s.approvedClients).filter((k) => !removed.has(k)));
  const allowed = new Set(states.flatMap((s) => s.allowedHosts ?? []));
  const hosts = new Set(
    [...states.flatMap((s) => s.approvedHosts), ...hostIds].filter((id) => !allowed.has(id)),
  );
  const readOnly = new Set(states.flatMap((s) => s.readOnlyClients ?? []));
  return {
    approvedClients: [...approved].sort(),
    removedClients: [...removed].sort(),
    approvedHosts: [...hosts].sort(),
    ...(allowed.size > 0 && { allowedHosts: [...allowed].sort() }),
    ...(readOnly.size > 0 && { readOnlyClients: [...readOnly].sort() }),
  };
}

/** Whether `state` lacks anything in `union`, so the host needs an `access/merge`. */
export function lacks(state: Lists, union: Lists): boolean {
  const has = (list: string[], want: string[]) => want.every((each) => list.includes(each));
  return (
    !has(state.approvedClients, union.approvedClients) ||
    !has(state.removedClients, union.removedClients) ||
    !has(state.approvedHosts, union.approvedHosts) ||
    !has(state.allowedHosts ?? [], union.allowedHosts ?? []) ||
    !has(state.readOnlyClients ?? [], union.readOnlyClients ?? [])
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
