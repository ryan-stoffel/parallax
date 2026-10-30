import { afterEach, expect, test, vi } from "vite-plus/test";

import {
  BENCH_MS,
  coalesced,
  countPairRun,
  lacks,
  mergeListed,
  parseSignIn,
  RECHECK_MS,
  Routes,
  unionLists,
  type SavedAccount,
} from "./accountHosts";

const studio = "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o";

afterEach(() => vi.useRealTimers());

/** Routes for `studio` with a LAN and a Tailscale route, a probe answering `answer`, and moves counted. */
function routes(answer?: string) {
  const probe = vi.fn(async (_routes: string[]) => answer);
  const move = vi.fn();
  const kept = new Routes({
    hostId: studio,
    learned: () => ["192.168.1.20:7341", "100.74.190.83:7341"],
    probe,
    move,
  });
  return { kept, probe, move };
}

test("a dial tries the LAN, then Tailscale, then the relay", () => {
  expect(routes().kept.dial()).toEqual([
    "192.168.1.20:7341",
    "100.74.190.83:7341",
    `relay:${studio}`,
  ]);
});

test("on the relay, direct routes are checked every minute and the connection moves once one answers", async () => {
  vi.useFakeTimers();
  const { kept, probe, move } = routes();
  kept.route = `relay:${studio}`;
  kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(RECHECK_MS - 1);
  expect(probe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(probe).toHaveBeenCalledWith(["192.168.1.20:7341", "100.74.190.83:7341"]);
  expect(move).not.toHaveBeenCalled();

  // A network change or focus checks now; this time the LAN answers.
  probe.mockResolvedValue("192.168.1.20:7341");
  await kept.recheck();
  expect(move).toHaveBeenCalledTimes(1);
  kept.dispose();
});

test("a direct connection is never re-checked", async () => {
  vi.useFakeTimers();
  const { kept, probe } = routes();
  kept.route = "192.168.1.20:7341";
  kept.onStatus("connected");
  await kept.recheck();
  await vi.advanceTimersByTimeAsync(5 * RECHECK_MS);
  expect(probe).not.toHaveBeenCalled();
});

test("a direct route whose connection ended waits 5 minutes, and the relay never does", () => {
  let now = 1_000_000;
  const kept = new Routes({
    hostId: studio,
    learned: () => ["192.168.1.20:7341", "100.74.190.83:7341"],
    probe: async () => undefined,
    move: () => {},
    now: () => now,
  });
  kept.route = "192.168.1.20:7341";
  kept.onStatus("connected");
  kept.onStatus("failed");
  expect(kept.dial()).toEqual(["100.74.190.83:7341", `relay:${studio}`]);
  now += BENCH_MS - 1;
  expect(kept.dial()).toHaveLength(2);
  now += 1;
  expect(kept.dial()).toHaveLength(3);

  // Ending a relay connection, as moving off it does, benches nothing.
  kept.route = `relay:${studio}`;
  kept.onStatus("connected");
  kept.onStatus("connecting");
  expect(kept.dial()).toHaveLength(3);
});

test("the account's list adds and drops computers, keeping what this app learned of each", () => {
  const kept: SavedAccount = { hostId: studio, name: "Studio", routes: ["192.168.1.20:7341"] };
  const other = "Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR";
  const gone = "tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE";
  const { accounts, changed } = mergeListed(
    [kept, { hostId: gone, name: "old", routes: [] }],
    [
      { hostId: studio, name: "studio", online: true, thisComputer: false },
      { hostId: other, name: "build-box", online: false, thisComputer: false },
      { hostId: "me", name: "macbook", online: true, thisComputer: true },
    ],
  );
  expect(changed).toBe(true);
  expect(accounts).toEqual([kept, { hostId: other, name: "build-box", routes: [] }]);
  expect(
    mergeListed(accounts, [
      { hostId: studio, name: "studio", online: true, thisComputer: false },
      { hostId: other, name: "build-box", online: true, thisComputer: false },
    ]).changed,
  ).toBe(false);
});

test("a computer takes 5 typed codes an hour", () => {
  let runs: number[] | undefined;
  for (let i = 0; i < 5; i++) runs = countPairRun(runs, 1000 * i);
  expect(runs).toHaveLength(5);
  expect(countPairRun(runs, 60 * 60_000 - 1)).toBeUndefined();
  expect(countPairRun(runs, 60 * 60_000)).toHaveLength(5);
});

test("a sign-in's lines read as pending with its code, then approved with direct routes", () => {
  expect(parseSignIn('{"status":"pending","request":"r1","code":"482913"}')).toEqual({
    status: "pending",
    request: "r1",
    code: "482913",
  });
  expect(
    parseSignIn(
      `{"status":"approved","name":"studio","routes":["192.168.1.20:7341","relay:${studio}","-x"]}`,
    ),
  ).toEqual({ status: "approved", name: "studio", routes: ["192.168.1.20:7341"] });
  expect(parseSignIn('{"status":"pending","request":"r1","code":"12"}')).toBeUndefined();
  expect(parseSignIn("plxd dial: connected over relay")).toBeUndefined();
});

test("lists merge with removal winning, and only a host that lacks something is merged into", () => {
  const a = { approvedClients: ["k1", "k2"], removedClients: [], approvedHosts: ["h1"] };
  const b = { approvedClients: ["k3"], removedClients: ["k2"], approvedHosts: [] };
  const union = unionLists([a, b], ["h1", "h2"]);
  expect(union).toEqual({
    approvedClients: ["k1", "k3"],
    removedClients: ["k2"],
    approvedHosts: ["h1", "h2"],
  });
  expect(lacks(a, union)).toBe(true);
  expect(lacks({ ...union, approvedClients: [...union.approvedClients, "k9"] }, union)).toBe(false);
});

test("a run asked for while one runs runs once more after, not once per ask", async () => {
  let release = () => {};
  let runs = 0;
  const run = coalesced(async () => {
    runs++;
    await new Promise<void>((resolve) => (release = resolve));
  });
  const first = run();
  void run();
  void run();
  release();
  await vi.waitFor(() => expect(runs).toBe(2));
  release();
  await first;
  expect(runs).toBe(2);
});
