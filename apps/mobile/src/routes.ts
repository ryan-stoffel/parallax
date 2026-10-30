// How the phone reaches an account's host (0091 "Routes" and "Speed"), as `plxd dial` does in
// daemon/src/remote.rs: its LAN addresses first, then its Tailscale address, then the relay. The
// direct routes start together and the relay 200 ms later, unless every direct one already failed,
// and the first to answer wins. Pure, so it's tested without React Native.

/** A route through Parallax Relay: `relay:<hostId>`. */
export const RELAY = "relay:";
/** plxd's remote listener's port (0065). */
export const PORT = 7341;
/** How long the direct routes have before the relay starts too. */
export const HEAD_START_MS = 200;
/** How often a connection on the relay checks whether a direct route answers again. */
export const RECHECK_MS = 60_000;
/** How long a route that failed after it answered waits before it's tried again. */
export const COOL_DOWN_MS = 5 * 60_000;

export const isRelay = (route: string) => route.startsWith(RELAY);

/** `route` with plxd's port when it has none: `10.0.0.2` is `10.0.0.2:7341`. */
export const withPort = (route: string) => (route.includes(":") ? route : `${route}:${PORT}`);

/** Whether `route` is a Tailscale address: in 100.64.0.0/10. */
export function isTailnet(route: string): boolean {
  const [a, b] = withPort(route).split(":")[0]!.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b < 128;
}

/**
 * The routes to try for host `hostId`, best first: the LAN ones `learned` lists, then its
 * Tailscale ones, then the relay, each once. Another host's relay route is dropped.
 */
export function ordered(hostId: string, learned: string[]): string[] {
  // plxd reports IPv4 addresses, with a port only when it isn't 7341.
  const ipv4 = (r: string) => !isRelay(r) && r.split(":").length <= 2;
  const direct = [...new Set(learned.filter(ipv4).map(withPort))];
  return [
    ...direct.filter((r) => !isTailnet(r)),
    ...direct.filter(isTailnet),
    `${RELAY}${hostId}`,
  ];
}

/** The routes worth trying at `now`: none of those that failed after answering within `COOL_DOWN_MS`. */
export const usable = (routes: string[], failedAt: Record<string, number>, now: number) =>
  routes.filter((r) => isRelay(r) || !(now - (failedAt[r] ?? -Infinity) < COOL_DOWN_MS));

/** A route's attempt that failed because another key answered: no route after it is better. */
export class WrongHost extends Error {}

/**
 * Tries `routes` with `attempt`: the direct ones at once, the relay ones `headStart` ms later, or
 * as soon as every direct one failed. Resolves to the first that succeeds; a later success is
 * given to `release`, since only the winner is used. Rejects with a `WrongHost` if one was thrown,
 * else the last error, when all fail.
 */
export function race<T>(
  routes: string[],
  attempt: (route: string) => Promise<T>,
  release: (value: T) => void = () => {},
  headStart = HEAD_START_MS,
): Promise<{ route: string; value: T }> {
  return new Promise((resolve, reject) => {
    const direct = routes.filter((r) => !isRelay(r));
    const relayed = routes.filter(isRelay);
    let won = false;
    let left = routes.length;
    let directLeft = direct.length;
    let relayStarted = false;
    let error: unknown = new Error("no routes");
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = (route: string) =>
      attempt(route).then(
        (value) => {
          if (won) return release(value);
          won = true;
          clearTimeout(timer);
          resolve({ route, value });
        },
        (e: unknown) => {
          if (!(error instanceof WrongHost)) error = e;
          if (!isRelay(route) && --directLeft === 0) startRelay();
          if (--left === 0 && !won) reject(error);
        },
      );
    const startRelay = () => {
      if (relayStarted || won) return;
      relayStarted = true;
      clearTimeout(timer);
      for (const r of relayed) void start(r);
    };

    if (!routes.length) return reject(error);
    for (const r of direct) void start(r);
    if (!direct.length) startRelay();
    else timer = setTimeout(startRelay, headStart);
  });
}
