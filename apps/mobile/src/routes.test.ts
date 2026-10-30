import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { COOL_DOWN_MS, ordered, race, usable, WrongHost } from "./routes";

const ID = "tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

test("routes go LAN, then the relay, each once, and never Tailscale", () => {
  expect(
    ordered(ID, ["100.101.2.3", "192.168.1.20", `relay:${ID}`, "10.0.0.5:7400", "192.168.1.20:7341", "relay:other"]),
  ).toEqual(["192.168.1.20:7341", "10.0.0.5:7400", `relay:${ID}`]);
  expect(ordered(ID, [])).toEqual([`relay:${ID}`]);
});

test("a LAN route that failed after answering waits out its cool-down", () => {
  const routes = ordered(ID, ["192.168.1.20"]);
  expect(usable(routes, { "192.168.1.20:7341": 0 }, COOL_DOWN_MS - 1)).toEqual([`relay:${ID}`]);
  expect(usable(routes, { "192.168.1.20:7341": 0 }, COOL_DOWN_MS)).toEqual(routes);
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
  const won = race(ordered(ID, ["192.168.1.20", "10.0.0.5"]), attempt, (r) => released.push(r));
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
  const won = race(ordered(ID, ["192.168.1.20"]), attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe(relay);
  expect(started[relay]).toBe(200);
});

test("the relay starts at once when every LAN route already failed", async () => {
  const { started, attempt } = attempts({
    "192.168.1.20:7341": { ms: 20, ok: false },
    [relay]: { ms: 30, ok: true },
  });
  const won = race(ordered(ID, ["192.168.1.20"]), attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await won).route).toBe(relay);
  expect(started[relay]).toBe(20);
});

test("all failing rejects, with a wrong host over any other error", async () => {
  const attempt = (route: string) =>
    Promise.reject(route.startsWith("relay:") ? new Error("offline") : new WrongHost("another key"));
  const lost = race(ordered(ID, ["192.168.1.20"]), attempt).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await lost).toBeInstanceOf(WrongHost);
});
