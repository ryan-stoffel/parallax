// One computer's routes as a device keeps them (0091): those the computer reports, the addresses
// the user added, and the user's order. Pure, and shared by the desktop's main process and the phone.

/** A route through Parallax Relay: `relay:<hostId>`. */
export const RELAY = "relay:";
/** plxd's remote listener's port (0065). */
const PORT = 7341;

export const isRelay = (route: string) => route.startsWith(RELAY);

/** `route` with plxd's port when it has none: `10.0.0.2` is `10.0.0.2:7341`. */
export const withPort = (route: string) => (route.includes(":") ? route : `${route}:${PORT}`);

/** What a device keeps of a computer's routes. Each device has its own: nothing here syncs. */
export type RouteChoices = {
  /** Its direct routes as it last reports them. Never the relay. */
  routes: string[];
  /** Addresses the user added, which stay whatever it reports. */
  addedRoutes?: string[];
  /** The user's order, the relay included. Without one, direct routes race as equals. */
  routeOrder?: string[];
  /** Reported routes the user removed: never tried from this device, until a reset or an add. */
  hiddenRoutes?: string[];
};

/** A change the user makes to a computer's routes. `reset` brings back hidden routes and the default order. */
export type RouteEdit =
  | { add: string }
  | { remove: string }
  | { move: string; by: -1 | 1 }
  | { reset: true };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const NAME =
  /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/i;
const NOT_AN_ADDRESS = "That isn't an address. Add a port only if it isn't 7341.";

/**
 * What the user typed as a route, as `host:port` with plxd's port when it has none, or why it isn't
 * one, for people. `plxd dial` and the phone take the result as is, so nothing here can read as an
 * option or leave the host part of a URL.
 */
export function parseRoute(typed: string): { route: string } | { error: string } {
  const text = typed.trim();
  if (!text) return { error: "Enter an address, with a port if it isn't 7341." };
  if (text.includes("/"))
    return { error: "Enter only the address and port, with no https:// or path." };
  if (text.toLowerCase().startsWith(RELAY))
    return { error: "Parallax Connect is already a route." };
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(text);
  const parts = text.split(":");
  const [host, port] = bracketed
    ? [bracketed[1]!, bracketed[2]]
    : parts.length > 2
      ? [text, undefined]
      : [parts[0]!, parts[1]];
  if (port !== undefined && !(/^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535))
    return { error: "The port must be a number from 1 to 65535." };
  const at = port ?? String(PORT);
  if (host.includes(":"))
    return isIpv6(host) ? { route: `[${host.toLowerCase()}]:${at}` } : { error: NOT_AN_ADDRESS };
  if (bracketed) return { error: NOT_AN_ADDRESS };
  if (/^[\d.]+$/.test(host) && !(IPV4.test(host) && host.split(".").every((n) => +n <= 255)))
    return { error: "That isn't a valid IP address." };
  return NAME.test(host) ? { route: `${host.toLowerCase()}:${at}` } : { error: NOT_AN_ADDRESS };
}

/** Whether `host` is an IPv6 address without a zone: hex groups, with one `::` at most. */
function isIpv6(host: string): boolean {
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  const count = halves.length === 2 ? groups.length < 8 : groups.length === 8;
  return count && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group));
}

/**
 * The routes to try for computer `hostId`, best first, each once: those it reports then those added,
 * then the relay, or the user's order. A route that order doesn't know goes after its last direct
 * one, so a new address can't jump ahead of what the user chose, and one it knows that's gone just
 * isn't listed, and takes its place back if it returns. A hidden route is never listed.
 */
export function routeList(
  hostId: string,
  { routes, addedRoutes, routeOrder, hiddenRoutes }: RouteChoices,
): string[] {
  const relay = `${RELAY}${hostId}`;
  const direct = [...new Set([...routes, ...(addedRoutes ?? [])])].filter(
    (route) => !hiddenRoutes?.includes(route),
  );
  const order = [...new Set(routeOrder ?? [])];
  if (!order.includes(relay)) order.push(relay);
  const fresh = direct.filter((route) => !order.includes(route));
  order.splice(order.map(isRelay).lastIndexOf(false) + 1, 0, ...fresh);
  return order.filter((route) => route === relay || direct.includes(route));
}

/** Whether a dial takes these routes in the user's order: each 200 ms after the one above it. */
export const inOrder = ({ routeOrder }: RouteChoices) => !!routeOrder?.length;

/**
 * The routes a connection on `route` moves to when one answers with the pinned key. In the user's
 * order, those above it. Otherwise direct routes race as equals, so only the relay has better ones.
 */
export function routesAhead(list: string[], route: string, ordered: boolean): string[] {
  if (!ordered) return isRelay(route) ? list.filter((each) => !isRelay(each)) : [];
  const at = list.indexOf(route);
  return at < 0 ? [] : list.slice(0, at);
}

/**
 * `choices`' added routes, order and hidden routes after `edit` of computer `hostId`, or why it
 * can't be done, for people. Removing an added route forgets it. Removing one the computer reports
 * hides it on this device, since it would report it again, and adding it back unhides it. The relay
 * can't be removed: it's what reaches the computer from anywhere. Reset brings back every hidden
 * route and the default order. An order that's back to the default isn't kept, so direct routes
 * race as equals again.
 */
export function editRoutes(
  hostId: string,
  choices: RouteChoices,
  edit: RouteEdit,
): Pick<RouteChoices, "addedRoutes" | "routeOrder" | "hiddenRoutes"> | { error: string } {
  const added = choices.addedRoutes ?? [];
  const hidden = choices.hiddenRoutes ?? [];
  const list = routeList(hostId, choices);
  const kept = { addedRoutes: choices.addedRoutes, hiddenRoutes: choices.hiddenRoutes };
  if ("reset" in edit)
    return { addedRoutes: choices.addedRoutes, routeOrder: undefined, hiddenRoutes: undefined };
  if ("add" in edit) {
    const parsed = parseRoute(edit.add);
    if ("error" in parsed) return parsed;
    if (list.some((route) => withPort(route) === parsed.route))
      return { error: "That route is already in the list." };
    const back = hidden.find((route) => withPort(route) === parsed.route);
    if (back)
      return {
        ...kept,
        hiddenRoutes: few(hidden.filter((route) => route !== back)),
        routeOrder: choices.routeOrder,
      };
    return { ...kept, addedRoutes: [...added, parsed.route], routeOrder: choices.routeOrder };
  }
  if ("remove" in edit) {
    const routeOrder = few(choices.routeOrder?.filter((route) => route !== edit.remove));
    if (added.includes(edit.remove))
      return { ...kept, addedRoutes: added.filter((route) => route !== edit.remove), routeOrder };
    if (isRelay(edit.remove)) return { error: "Parallax Connect can't be removed." };
    if (!list.includes(edit.remove)) return { error: "That route isn't in the list." };
    return { ...kept, hiddenRoutes: [...hidden, edit.remove], routeOrder };
  }
  const from = list.indexOf(edit.move);
  const to = from + edit.by;
  if (from < 0 || to < 0 || to >= list.length) return { error: "That route can't move there." };
  [list[from], list[to]] = [list[to]!, list[from]!];
  const usual = routeList(hostId, {
    routes: choices.routes,
    addedRoutes: added,
    hiddenRoutes: hidden,
  });
  return {
    ...kept,
    routeOrder: list.join("\n") === usual.join("\n") ? undefined : list,
  };
}

/** `list`, or undefined once it's empty, so nothing empty is kept. */
const few = (list: string[] | undefined) => (list?.length ? list : undefined);
