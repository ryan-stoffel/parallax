import { afterEach, expect, test, vi } from "vite-plus/test";

import type { RouteChoices } from "../preload/routeList";
import {
  BENCH_MS,
  checkAccounts,
  coalesced,
  countPairRun,
  lacks,
  listSources,
  mergeListed,
  outageOf,
  joinedNotListed,
  listedKey,
  NoticeWatch,
  parseSignIn,
  relayOffline,
  RECHECK_MS,
  Routes,
  tokenSubject,
  unionLists,
  waitForListener,
  type SavedAccount,
} from "./accountHosts";

const studio = "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o";

afterEach(() => vi.useRealTimers());

/** Routes for `studio` with a LAN and a Tailscale route, a probe answering `answer`, and moves counted. */
function routes(answer?: string) {
  const probe = vi.fn(async (_routes: string[], _inOrder: boolean) => answer);
  const move = vi.fn();
  const kept = new Routes({
    hostId: studio,
    choices: () => ({ routes: ["192.168.1.20:7341", "100.74.190.83:7341"] }),
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
  expect(probe).toHaveBeenCalledWith(["192.168.1.20:7341", "100.74.190.83:7341"], false);
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

/** `studio`'s routes on a clock the test moves, with a probe answering `answer`. */
function clocked(answer?: string) {
  const clock = { now: 1_000_000 };
  const kept = new Routes({
    hostId: studio,
    choices: () => ({ routes: ["192.168.1.20:7341", "100.74.190.83:7341"] }),
    probe: async () => answer,
    move: () => {},
    now: () => clock.now,
  });
  return { kept, clock };
}

test("a direct route that answered but never came up waits 5 minutes, and the relay never does", () => {
  const { kept, clock } = clocked();
  // The dial reached the LAN, then the handshake over it failed.
  kept.onStatus("connecting");
  kept.route = "192.168.1.20:7341";
  kept.onStatus("failed");
  expect(kept.dial()).toEqual(["100.74.190.83:7341", `relay:${studio}`]);
  clock.now += BENCH_MS - 1;
  expect(kept.dial()).toHaveLength(2);
  clock.now += 1;
  expect(kept.dial()).toHaveLength(3);

  // The relay failing the same way holds nothing back.
  kept.route = `relay:${studio}`;
  kept.onStatus("failed");
  expect(kept.dial()).toHaveLength(3);
});

test("a direct connection that came up and later ended holds no route back", () => {
  const { kept } = clocked();
  // Sleep, a network change, or the host restarting: up over the LAN, then gone.
  kept.route = "192.168.1.20:7341";
  kept.onStatus("connected");
  kept.onStatus("failed");
  kept.onStatus("connecting");
  expect(kept.dial()).toEqual(["192.168.1.20:7341", "100.74.190.83:7341", `relay:${studio}`]);
});

/** `studio`'s routes as `choices` says, with a probe answering `answer` and moves counted. */
function chosen(choices: RouteChoices, answer?: string) {
  const probe = vi.fn(async (_routes: string[], _inOrder: boolean) => answer);
  const move = vi.fn();
  const state = { choices };
  const kept = new Routes({ hostId: studio, choices: () => state.choices, probe, move });
  return { kept, probe, move, state };
}

const lan = "192.168.1.20:7341";
const added = "studio.example.com:7400";
const relay = `relay:${studio}`;

test("an added route is dialed with the direct ones, and with no order nothing is re-checked over it", async () => {
  vi.useFakeTimers();
  const { kept, probe } = chosen({ routes: [lan], addedRoutes: [added] });
  expect(kept.dial()).toEqual([lan, added, relay]);
  expect(kept.inOrder).toBe(false);
  kept.route = added;
  kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(5 * RECHECK_MS);
  expect(probe).not.toHaveBeenCalled();

  // On the relay, an added route is checked with the rest.
  kept.route = relay;
  kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(RECHECK_MS);
  expect(probe).toHaveBeenCalledWith([lan, added], false);
  kept.dispose();
});

test("in the user's order, a connection re-checks only the routes above it, even direct ones", async () => {
  vi.useFakeTimers();
  const { kept, probe, move } = chosen(
    { routes: [lan], addedRoutes: [added], routeOrder: [added, relay, lan] },
    added,
  );
  expect(kept.dial()).toEqual([added, relay, lan]);
  expect(kept.inOrder).toBe(true);
  kept.route = lan;
  kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(RECHECK_MS);
  expect(probe).toHaveBeenCalledWith([added, relay], true);
  expect(move).toHaveBeenCalledTimes(1);

  // The relay at the top has nothing above it, so it stays.
  const top = chosen({ routes: [lan], routeOrder: [relay, lan] }, lan);
  top.kept.route = relay;
  top.kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(5 * RECHECK_MS);
  expect(top.probe).not.toHaveBeenCalled();
  kept.dispose();
  top.kept.dispose();
});

test("an edit tries a held-back route again, moves off a removed one, and checks one now ahead", async () => {
  const { kept, probe, move, state } = chosen({ routes: [lan], addedRoutes: [added] }, added);
  // Not up: it dials again, with the added route's failure forgotten.
  kept.route = added;
  kept.onStatus("failed");
  expect(kept.dial()).toEqual([lan, relay]);
  kept.edited();
  expect(kept.dial()).toEqual([lan, added, relay]);
  expect(move).toHaveBeenCalledTimes(1);

  // Up over a route now moved below another: that one is checked at once.
  kept.route = lan;
  kept.onStatus("connected");
  state.choices = { ...state.choices, routeOrder: [added, lan, relay] };
  kept.edited();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledWith([added], true));
  await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(2));

  // Up over a route the user removed: it dials again.
  kept.route = added;
  kept.onStatus("connected");
  state.choices = { routes: [lan] };
  kept.edited();
  expect(move).toHaveBeenCalledTimes(3);
  kept.dispose();
});

test("a slow route above a working one is moved to once, not every re-check", async () => {
  const { kept, probe, move } = chosen({ routes: [lan], routeOrder: [relay, lan] }, relay);
  // As a real dial races them: the LAN starts 200 ms in, and beats a relay still opening its
  // stream, unless the relay is all there is to dial.
  const dialed = () => (kept.dial().includes(lan) ? lan : kept.dial()[0]);
  kept.route = lan;
  kept.onStatus("connected");
  move.mockImplementation(() => {
    kept.onStatus("connecting");
    kept.route = dialed();
    kept.onStatus("connected");
  });
  for (let i = 0; i < 3; i++) await kept.recheck();
  expect(kept.route).toBe(relay);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledTimes(1);
  kept.dispose();
});

test("a move that fails goes back to every route, and that route waits 5 minutes", async () => {
  const clock = { now: 1_000_000 };
  const probe = vi.fn(async () => relay);
  const kept = new Routes({
    hostId: studio,
    choices: () => ({ routes: [lan], routeOrder: [relay, lan] }),
    probe,
    move: () => {},
    now: () => clock.now,
  });
  kept.route = lan;
  kept.onStatus("connected");
  await kept.recheck();
  expect(kept.dial()).toEqual([relay]);

  kept.onStatus("connecting");
  kept.onStatus("failed");
  // The relay stays in a dial, but no re-check moves to it for the 5 minutes.
  expect(kept.dial()).toEqual([relay, lan]);
  kept.route = lan;
  kept.onStatus("connected");
  await kept.recheck();
  expect(probe).toHaveBeenCalledTimes(1);
  clock.now += BENCH_MS;
  await kept.recheck();
  expect(probe).toHaveBeenCalledTimes(2);
  kept.dispose();
});

test("settings.json's added routes and order are checked, and the relay can't be added", () => {
  const check = (entry: object) =>
    checkAccounts([{ hostId: studio, name: "Studio", routes: [], ...entry }], new Set());
  expect(() => check({ addedRoutes: [added], routeOrder: [added, relay] })).not.toThrow();
  expect(() => check({ addedRoutes: [relay] })).toThrow(/bad addedRoutes/);
  expect(() => check({ addedRoutes: ["https://x"] })).toThrow(/bad addedRoutes/);
  expect(() => check({ routeOrder: "x" })).toThrow(/bad routeOrder/);
  expect(() => check({ hiddenRoutes: [lan] })).not.toThrow();
  expect(() => check({ hiddenRoutes: [relay] })).toThrow(/bad hiddenRoutes/);
  expect(() => check({ hiddenRoutes: "x" })).toThrow(/bad hiddenRoutes/);
  // A file from before hidden routes loads as it is.
  expect(() =>
    check({ routes: [lan], addedRoutes: [added], routeOrder: [lan, relay] }),
  ).not.toThrow();
});

test("a hidden route is never dialed or re-checked, and an edit that hides the one in use moves off it", async () => {
  vi.useFakeTimers();
  const tailnet = "100.74.190.83:7341";
  const { kept, probe, move, state } = chosen({ routes: [lan, tailnet], hiddenRoutes: [tailnet] });
  expect(kept.dial()).toEqual([lan, relay]);
  kept.route = relay;
  kept.onStatus("connected");
  await vi.advanceTimersByTimeAsync(RECHECK_MS);
  expect(probe).toHaveBeenCalledWith([lan], false);
  // Connected over a route that's then hidden, the connection moves.
  kept.route = lan;
  state.choices = { routes: [lan, tailnet], hiddenRoutes: [tailnet, lan] };
  kept.edited();
  expect(kept.dial()).toEqual([relay]);
  expect(move).toHaveBeenCalled();
  kept.dispose();
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
    [gone],
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

test("a list missing a saved computer keeps it, whole, as only `removed` drops one", () => {
  const saved = [{ hostId: studio, name: "studio", routes: ["192.168.1.20:7341"] }];
  for (const removed of [undefined, [], ["tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE"]])
    expect(mergeListed(saved, [], removed)).toEqual({ accounts: saved, changed: false });
  expect(mergeListed(saved, [], [studio])).toEqual({ accounts: [], changed: true });
});

test("an outage shows after two failed reads, follows what's down, and ends on the next answer", () => {
  const shown: unknown[] = [];
  const watch: NoticeWatch<"relay" | "clerk"> = new NoticeWatch(() => shown.push(watch.current));
  watch.read("relay");
  expect(shown).toEqual([]);
  watch.read(undefined);
  watch.read("relay");
  expect(shown).toEqual([]);
  watch.read("relay");
  expect(shown).toEqual(["relay"]);
  watch.read("relay");
  watch.read("clerk");
  expect(shown).toEqual(["relay", "clerk"]);
  watch.read(undefined);
  expect(shown).toEqual(["relay", "clerk", undefined]);
  expect(watch.current).toBeUndefined();
});

test("the list's key changes when only `removed` does", () => {
  const hosts = [{ hostId: studio, name: "studio", online: true, thisComputer: false }];
  expect(listedKey({ hosts, removed: [] })).toBe(listedKey({ hosts }));
  expect(listedKey({ hosts, removed: ["gone"] })).not.toBe(listedKey({ hosts, removed: [] }));
});

test("only the key and account that joined can be missing from the list, unless marked", () => {
  const joined = { hostId: studio, user: "user_1" };
  const listed = [{ hostId: studio, name: "studio", online: true, thisComputer: true }];
  expect(joinedNotListed({ hosts: [] }, joined, "user_1")).toBe(true);
  expect(joinedNotListed({ hosts: [], removed: [] }, joined, "user_1")).toBe(true);
  expect(joinedNotListed({ hosts: [], removed: [studio] }, joined, "user_1")).toBe(false);
  expect(joinedNotListed({ hosts: listed }, joined, "user_1")).toBe(false);
  expect(joinedNotListed({ hosts: [] }, joined, "user_2")).toBe(false);
  expect(joinedNotListed({ hosts: [] }, undefined, "user_1")).toBe(false);
});

test("only plxd's outage kinds count as an outage", () => {
  expect(outageOf({ data: { kind: "relayUnreachable" } })).toBe("relay");
  expect(outageOf({ data: { kind: "clerkUnreachable" } })).toBe("clerk");
  expect(outageOf({ data: { kind: "idConflict" } })).toBeUndefined();
  expect(outageOf({})).toBeUndefined();
});

test("the relay's 503 on a stream reads as offline, and Clerk being down as its own outage", () => {
  expect(
    relayOffline("plxd dial: could not sign in: the relay's WebSocket failed: HTTP 503\n"),
  ).toBe(true);
  // Clerk being down refuses the stream with 401, and the list's 503 `clerk_unreachable` is the
  // sign-in service's outage.
  expect(relayOffline("plxd dial: could not sign in: the relay refused this host's proof")).toBe(
    false,
  );
  expect(outageOf({ data: { kind: "clerkUnreachable" } })).toBe("clerk");
  expect(relayOffline("plxd dial: could not sign in: the relay's WebSocket failed: HTTP 502")).toBe(
    false,
  );
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
  expect(parseSignIn('{"status":"confirm"}')).toEqual({ status: "confirm" });
  expect(parseSignIn('{"status":"pending","request":"r1","code":"12"}')).toBeUndefined();
  expect(parseSignIn("plxd dial: connected over relay")).toBeUndefined();
});

test("a computer added with Allow alone gives no lists, and can't demote a real one", () => {
  const lists = (allowedHosts: string[] = [], approvedClients: string[] = []) => ({
    approvedClients,
    removedClients: [],
    approvedHosts: [],
    allowedHosts,
  });
  const own = { relayId: "own", state: lists(["fake"]) };
  const real = { relayId: "real", state: lists() };
  // It tries to add its attacker's key, and to mark the real computer as added with Allow.
  const fake = { relayId: "fake", state: lists(["real", "own"], ["attacker"]) };
  const sources = listSources([own, real, fake], own);
  expect(sources).toEqual([own, real]);
  expect(
    unionLists(
      sources.map((s) => s.state),
      ["own", "real", "fake"],
    ),
  ).toEqual({
    approvedClients: [],
    removedClients: [],
    approvedHosts: ["own", "real"],
    allowedHosts: ["fake"],
  });
  // Another device allowed it: a mark from a real computer counts here too.
  const marked = { relayId: "real", state: lists(["fake"]) };
  const here = { relayId: "own", state: lists() };
  expect(listSources([here, marked, fake], here)).toEqual([here, marked]);
  // This computer's own plxd is always read, though another device may have allowed it.
  const self = { relayId: "own", state: lists(["own"]) };
  expect(listSources([self], self)).toEqual([self]);
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

test("a key read-only anywhere is read-only everywhere, and a host without the mark gets it", () => {
  const lists = { approvedClients: ["k1"], removedClients: [], approvedHosts: [] };
  const marked = { ...lists, readOnlyClients: ["k1"] };
  // A host that never heard of the mark, or a plxd from before it, can't take it off.
  const union = unionLists([lists, marked], []);
  expect(union.readOnlyClients).toEqual(["k1"]);
  expect(unionLists([marked, lists], []).readOnlyClients).toEqual(["k1"]);
  expect(lacks(lists, union)).toBe(true);
  expect(lacks(marked, union)).toBe(false);
  // A removal doesn't touch the mark, and the mark doesn't touch a removal.
  const removed = { ...lists, approvedClients: [], removedClients: ["k1"] };
  expect(unionLists([marked, removed], [])).toMatchObject({
    readOnlyClients: ["k1"],
    removedClients: ["k1"],
  });
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

test("a Clerk token's user id is its JWT's sub, and anything else has none", () => {
  const jwt = (payload: object) =>
    ["{}", JSON.stringify(payload), "sig"]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".");
  expect(tokenSubject(jwt({ sub: "user_2abc", sid: "sess_1" }))).toBe("user_2abc");
  expect(tokenSubject(jwt({ sid: "sess_1" }))).toBeUndefined();
  expect(tokenSubject("not-a-jwt")).toBeUndefined();
});

test("a setup code waits for the listener and the relay, and a listener alone is enough in the end", async () => {
  const answers = [{ listening: false }, { listening: true, relay: { connected: true } }];
  expect(await waitForListener(async () => answers.shift()!, 1_000, 1)).toBeUndefined();
  expect(answers).toEqual([]);
  // The relay never answers, but the code still works on this network.
  expect(await waitForListener(async () => ({ listening: true }), 5, 1)).toBeUndefined();
  // Nothing is listening: the code would be refused, so it says why.
  expect(
    await waitForListener(async () => ({ listening: false, problem: "port in use" }), 5, 1),
  ).toBe("port in use");
  expect(await waitForListener(async () => "plxd went away", 5, 1)).toBe("plxd went away");
});
