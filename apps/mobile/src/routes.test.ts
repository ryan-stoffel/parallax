import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { COOL_DOWN_MS, editOnPhone, ordered, race, usable, worthChecking, WrongHost } from "./routes";

const ID = "tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

test("routes go LAN, then the relay, each once, and never Tailscale", () => {
  expect(
    ordered(ID, { routes: ["100.101.2.3", "192.168.1.20", `relay:${ID}`, "10.0.0.5:7400", "192.168.1.20:7341", "relay:other"] }),
  ).toEqual(["192.168.1.20:7341", "10.0.0.5:7400", `relay:${ID}`]);
  expect(ordered(ID, { routes: [] })).toEqual([`relay:${ID}`]);
});

test("added routes come after the LAN ones, stay when the host stops reporting, and take the user's order", () => {
  const added = "studio.example.com:7400";
  expect(ordered(ID, { routes: ["192.168.1.20"], addedRoutes: [added] })).toEqual([
    "192.168.1.20:7341",
    added,
    `relay:${ID}`,
  ]);
  expect(ordered(ID, { routes: [], addedRoutes: [added] })).toEqual([added, `relay:${ID}`]);
  // The phone drops a Tailscale address a host reports, but one the user added is theirs to try.
  expect(ordered(ID, { routes: ["100.101.2.3"], addedRoutes: ["100.101.2.3:7341"] })).toEqual([
    "100.101.2.3:7341",
    `relay:${ID}`,
  ]);
  expect(
    ordered(ID, {
      routes: ["192.168.1.20"],
      addedRoutes: [added],
      routeOrder: [`relay:${ID}`, added, "192.168.1.20:7341"],
    }),
  ).toEqual([`relay:${ID}`, added, "192.168.1.20:7341"]);
});

test("the phone takes IP addresses and .local names, and refuses other names when they're added", () => {
  const add = (text: string) => editOnPhone(ID, { routes: [] }, { add: text });
  expect(add("192.168.1.20:7400")).toMatchObject({ addedRoutes: ["192.168.1.20:7400"] });
  expect(add("203.0.113.7")).toMatchObject({ addedRoutes: ["203.0.113.7:7341"] });
  expect(add("fd00::1")).toMatchObject({ addedRoutes: ["[fd00::1]:7341"] });
  expect(add("Studio.local:7400")).toMatchObject({ addedRoutes: ["studio.local:7400"] });
  for (const name of ["studio.example.com", "studio.example.com:7400", "studio", "local"])
    expect(add(name)).toEqual({ error: expect.stringMatching(/IP address or a \.local name/) });
  // Other bad input keeps its own reason.
  expect(add("https://x")).toEqual({ error: expect.stringMatching(/no https/) });
});

test("in the user's order, each route starts 200 ms after the one above it", async () => {
  const added = "studio.example.com:7400";
  const lan = "192.168.1.20:7341";
  // The first wins while it answers within 200 ms, though a later one would be faster.
  const first = attempts({ [added]: { ms: 150, ok: true }, [lan]: { ms: 0, ok: true }, [relay]: { ms: 0, ok: true } });
  const won = race([added, lan, relay], first.attempt, undefined, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe(added);
  expect(first.started).toEqual({ [added]: 0 });

  // One that hangs holds the next back for 200 ms, and the relay can go first.
  const hung = attempts({ [relay]: { ms: 5000, ok: true }, [added]: { ms: 5000, ok: true }, [lan]: { ms: 40, ok: true } });
  const late = race([relay, added, lan], hung.attempt, undefined, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await late).route).toBe(lan);
  expect(hung.started).toEqual({ [relay]: 1000, [added]: 1200, [lan]: 1400 });
  await vi.advanceTimersByTimeAsync(10_000);

  // One that failed starts the next at once.
  const failed = attempts({ [lan]: { ms: 10, ok: false }, [relay]: { ms: 20, ok: true } });
  const next = race([lan, relay], failed.attempt, undefined, true);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await next).route).toBe(relay);
  expect(failed.started[relay]! - failed.started[lan]!).toBe(10);
});

test("a LAN route that failed after answering waits out its cool-down", () => {
  const routes = ordered(ID, { routes: ["192.168.1.20"] });
  expect(usable(routes, { "192.168.1.20:7341": 0 }, COOL_DOWN_MS - 1)).toEqual([`relay:${ID}`]);
  expect(usable(routes, { "192.168.1.20:7341": 0 }, COOL_DOWN_MS)).toEqual(routes);
  // The relay that failed a move stays in a dial, but no re-check goes back to it for a while.
  const relayFailed = { [`relay:${ID}`]: 0 };
  expect(usable(routes, relayFailed, 1)).toEqual(routes);
  expect(worthChecking(routes, relayFailed, 1)).toEqual(["192.168.1.20:7341"]);
  expect(worthChecking(routes, relayFailed, COOL_DOWN_MS)).toEqual(routes);
});

/** An attempt per route that answers or fails after `ms`, recording when each started. */
function attempts(plan: Record<string, { ms: number; ok: boolean }>) {
  const started: Record<string, number> = {};
  const attempt = (route: string) => {
    started[route] = Date.now();
    const { ms, ok } = plan[route]!;
    return new Promise<string>((resolve, reject) =>
      setTimeout(() => (ok ? resolve(route) : reject(new Error(route))), ms),
    );
  };
  return { started, attempt };
}

const relay = `relay:${ID}`;

test("LAN routes start together, and the fastest wins without the relay", async () => {
  const { started, attempt } = attempts({
    "192.168.1.20:7341": { ms: 150, ok: true },
    "10.0.0.5:7341": { ms: 50, ok: true },
    [relay]: { ms: 10, ok: true },
  });
  const released: string[] = [];
  const won = race(ordered(ID, { routes: ["192.168.1.20", "10.0.0.5"] }), attempt, (r) => released.push(r));
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe("10.0.0.5:7341");
  expect(started).toEqual({ "192.168.1.20:7341": 0, "10.0.0.5:7341": 0 });
  expect(released).toEqual(["192.168.1.20:7341"]);
});

test("the relay starts 200 ms in while LAN routes hang, and wins", async () => {
  const { started, attempt } = attempts({
    "192.168.1.20:7341": { ms: 10_000, ok: false },
    [relay]: { ms: 30, ok: true },
  });
  const won = race(ordered(ID, { routes: ["192.168.1.20"] }), attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe(relay);
  expect(started[relay]).toBe(200);
});

test("the relay starts at once when every LAN route already failed", async () => {
  const { started, attempt } = attempts({
    "192.168.1.20:7341": { ms: 20, ok: false },
    [relay]: { ms: 30, ok: true },
  });
  const won = race(ordered(ID, { routes: ["192.168.1.20"] }), attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe(relay);
  expect(started[relay]).toBe(20);
});

test("all failing rejects, with a wrong host over any other error", async () => {
  const attempt = (route: string) =>
    Promise.reject(route.startsWith("relay:") ? new Error("offline") : new WrongHost("another key"));
  const lost = race(ordered(ID, { routes: ["192.168.1.20"] }), attempt).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await lost).toBeInstanceOf(WrongHost);
});
