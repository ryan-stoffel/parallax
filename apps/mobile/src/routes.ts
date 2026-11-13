
// How the phone reaches an account's host (0091 "Routes" and "Speed"), as `plxd dial` does in
// daemon/src/remote.rs: its LAN addresses and any address the user added, then the relay. The direct routes
// start together and the relay 200 ms later, unless every direct one already failed, and the first
// to answer wins. Once the user orders them, each starts 200 ms after the one above it instead. The
// phone doesn't use the Tailscale address a host reports. Pure, so it's tested without React Native.

import { t } from "i18next";

import {
  editRoutes,
  isRelay,
  parseRoute,
  routeList,
  withPort,
  type RouteChoices,
  type RouteEdit,
} from "../../desktop/src/preload/routeList";

export { isRelay, withPort } from "../../desktop/src/preload/routeList";

/** How long a route has before the next starts too. */
export const HEAD_START_MS = 200;
/** How often a connection on a later route checks whether an earlier one answers again. */
export const RECHECK_MS = 60_000;
/** How long a route that failed after it answered waits before it's tried again. */
export const COOL_DOWN_MS = 5 * 60_000;

/** Whether `route` is a LAN address: IPv4, as plxd reports them, and not in 100.64.0.0/10, the
 *  range plxd's Tailscale address comes from. */
function isLan(route: string): boolean {
  if (isRelay(route) || route.split(":").length > 2) return false;
  const [a, b] = route.split(":")[0]!.split(".").map(Number);
  return !(a === 100 && b !== undefined && b >= 64 && b < 128);
}

/** `choices` with what the host reports narrowed to what this phone uses: its LAN routes. */
export const onPhone = (choices: RouteChoices): RouteChoices => ({
  ...choices,
  routes: choices.routes.filter(isLan).map(withPort),
});

/**
 * The routes to try for host `hostId`, best first, each once: the LAN ones it reports and those the
 * user added, then the relay, or the user's order. Another host's relay route and any other address
 * it reports are dropped.
 */
export const ordered = (hostId: string, choices: RouteChoices): string[] =>
  routeList(hostId, onPhone(choices));

/** Whether `route` failed after answering within `COOL_DOWN_MS` of `now`. */
const cooling = (route: string, failedAt: Record<string, number>, now: number) =>
  now - (failedAt[route] ?? -Infinity) < COOL_DOWN_MS;

/** The routes a dial tries at `now`: none of those cooling down, and always the relay. */
export const usable = (routes: string[], failedAt: Record<string, number>, now: number) =>
  routes.filter((r) => isRelay(r) || !cooling(r, failedAt, now));

/** The routes a re-check may move to at `now`: none cooling down, the relay included. */
export const worthChecking = (routes: string[], failedAt: Record<string, number>, now: number) =>
  routes.filter((r) => !cooling(r, failedAt, now));

/**
 * `editRoutes` as the phone takes it. It refuses a public DNS name when it's added: the pinned
 * requests use URLSession, and App Transport Security's only exception in app.json is local
 * networking, which covers IP addresses and `.local` names. plxd's certificate is self-signed, so a
 * public name would fail before the pin decides, with no reason to show. Inferred from the code and
 * Apple's guidance, not a device test (0091).
 */
export function editOnPhone(hostId: string, choices: RouteChoices, edit: RouteEdit) {
  if ("add" in edit) {
    const parsed = parseRoute(edit.add);
    if ("route" in parsed && !worksOnPhone(parsed.route))
      return {
        error: t(
          "On iPhone, a route must be an IP address or a .local name. iOS blocks other names for a computer with its own certificate.",
        ),
      };
  }
  return editRoutes(hostId, onPhone(choices), edit);
}

/** Whether `route`, as `parseRoute` gives it, is an IP address or a `.local` name. */
function worksOnPhone(route: string): boolean {
  const host = route.slice(0, route.lastIndexOf(":"));
  return host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || host.endsWith(".local");
}

/** A route's attempt that failed because another key answered: no route after it is better. */
export class WrongHost extends Error {}

/**
 * Tries `routes` with `attempt`: the direct ones at once, the relay ones `headStart` ms later, or
 * as soon as every direct one failed. With `inOrder`, each route `headStart` ms after the one above
 * it, or as soon as those above it failed. Resolves to the first that succeeds; a later success is
 * given to `release`, since only the winner is used. Rejects with a `WrongHost` if one was thrown,
 * else the last error, when all fail.
 */
export function race<T>(
  routes: string[],
  attempt: (route: string) => Promise<T>,
  release: (value: T) => void = () => {},
  inOrder = false,
  headStart = HEAD_START_MS,
): Promise<{ route: string; value: T }> {
  return new Promise((resolve, reject) => {
    // The routes that start together, each group after the one before it.
    const groups = inOrder
      ? routes.map((r) => [r])
      : [routes.filter((r) => !isRelay(r)), routes.filter(isRelay)].filter((g) => g.length);
    let won = false;
    let running = 0;
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
          if (--running > 0) return;
          if (groups.length) startNext();
          else if (!won) reject(error);
        },
      );
    const startNext = () => {
      clearTimeout(timer);
      const group = groups.shift();
      if (won || !group) return;
      running += group.length;
      for (const r of group) void start(r);
      if (groups.length) timer = setTimeout(startNext, headStart);
    };

    if (!routes.length) return reject(error);
    startNext();
  });
}
