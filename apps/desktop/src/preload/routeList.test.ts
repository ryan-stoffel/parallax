import { expect, test } from "vite-plus/test";

import { editRoutes, parseRoute, routeList, routesAhead, type RouteChoices } from "./routeList";

const id = "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o";
const relay = `relay:${id}`;
const lan = "192.168.1.20:7341";
const tailnet = "100.74.190.83:7341";
const name = "studio.example.com:7400";

test.each([
  ["studio.example.com", "studio.example.com:7341"],
  ["  Studio.Example.com:7400 ", name],
  ["203.0.113.7:8443", "203.0.113.7:8443"],
  ["localhost", "localhost:7341"],
  ["fd00::1", "[fd00::1]:7341"],
  ["[fd00::1]:7400", "[fd00::1]:7400"],
])("%s is a route", (typed, route) => {
  expect(parseRoute(typed)).toEqual({ route });
});

test.each([
  ["", /Enter an address/],
  ["   ", /Enter an address/],
  ["https://studio.example.com", /no https:\/\/ or path/],
  ["ssh://studio.example.com:22", /no https:\/\/ or path/],
  ["studio.example.com/path", /no https:\/\/ or path/],
  ["https:studio", /port must be/],
  ["studio:0", /port must be/],
  ["studio:65536", /port must be/],
  ["999.1.1.1", /valid IP address/],
  ["1.2.3", /valid IP address/],
  ["--probe", /isn't an address/],
  ["a b", /isn't an address/],
  ["user@studio", /isn't an address/],
  ["fe80::1%en0", /isn't an address/],
  ["1:2:3", /isn't an address/],
  ["[studio]", /isn't an address/],
  [relay, /already a route/],
])("%j is refused", (typed, why) => {
  const parsed = parseRoute(typed);
  expect("error" in parsed && parsed.error).toMatch(why);
});

test("with no order, reported routes come first, then added ones, then the relay", () => {
  expect(routeList(id, { routes: [lan, tailnet], addedRoutes: [name] })).toEqual([
    lan,
    tailnet,
    name,
    relay,
  ]);
  expect(routeList(id, { routes: [] })).toEqual([relay]);
});

test("a learned route that's dropped doesn't take an added one with it", () => {
  const choices = { addedRoutes: [lan], routeOrder: [relay, lan, tailnet] };
  expect(routeList(id, { routes: [lan, tailnet], ...choices })).toEqual([relay, lan, tailnet]);
  // The computer stops reporting both. The address the user added stays, in its place.
  expect(routeList(id, { routes: [], ...choices })).toEqual([relay, lan]);
  // And the learned one takes its place back if it returns.
  expect(routeList(id, { routes: [tailnet], ...choices })).toEqual([relay, lan, tailnet]);
});

test("a route the order doesn't know goes after its last direct one", () => {
  const routeOrder = [lan, relay];
  expect(routeList(id, { routes: [lan, tailnet], routeOrder })).toEqual([lan, tailnet, relay]);
  // The user chose the relay first, and a new address can't jump ahead of it.
  expect(routeList(id, { routes: [lan, tailnet], routeOrder: [relay, lan] })).toEqual([
    relay,
    lan,
    tailnet,
  ]);
});

const applied = (choices: RouteChoices, ...edits: Parameters<typeof editRoutes>[2][]) =>
  edits.reduce((now, edit) => {
    const next = editRoutes(id, now, edit);
    if ("error" in next) throw new Error(next.error);
    return { ...now, ...next };
  }, choices);

test("adding keeps the routes racing, and refuses what's listed or isn't an address", () => {
  const choices = { routes: [lan] };
  expect(applied(choices, { add: "Studio.example.com:7400" })).toEqual({
    routes: [lan],
    addedRoutes: [name],
  });
  expect(editRoutes(id, choices, { add: "192.168.1.20" })).toEqual({
    error: "That route is already in the list.",
  });
  expect(editRoutes(id, choices, { add: "https://x" })).toHaveProperty("error");
});

test("moving saves the order, and moving back to the default clears it", () => {
  const choices = { routes: [lan, tailnet] };
  const moved = applied(choices, { move: tailnet, by: -1 });
  expect(moved.routeOrder).toEqual([tailnet, lan, relay]);
  expect(applied(moved, { move: tailnet, by: 1 }).routeOrder).toBeUndefined();
  // The relay moves like any other, and nothing moves off either end.
  expect(applied(choices, { move: relay, by: -1 }).routeOrder).toEqual([lan, relay, tailnet]);
  expect(editRoutes(id, choices, { move: lan, by: -1 })).toHaveProperty("error");
  expect(editRoutes(id, choices, { move: relay, by: 1 })).toHaveProperty("error");
  expect(editRoutes(id, choices, { move: "nope:1", by: 1 })).toHaveProperty("error");
});

test("only an added route can be removed: not the relay, and not one the computer reports", () => {
  const choices = { routes: [lan], addedRoutes: [name], routeOrder: [name, lan, relay] };
  const removed = applied(choices, { remove: name });
  expect(removed.addedRoutes).toEqual([]);
  expect(removed.routeOrder).toEqual([lan, relay]);
  expect(editRoutes(id, choices, { remove: relay })).toHaveProperty("error");
  expect(editRoutes(id, choices, { remove: lan })).toHaveProperty("error");
});

test("re-checks look at the relay's direct routes, or in the user's order at those above", () => {
  const list = [lan, tailnet, relay];
  expect(routesAhead(list, relay, false)).toEqual([lan, tailnet]);
  expect(routesAhead(list, tailnet, false)).toEqual([]);
  expect(routesAhead(list, tailnet, true)).toEqual([lan]);
  expect(routesAhead([relay, lan], relay, true)).toEqual([]);
  expect(routesAhead([relay, lan], lan, true)).toEqual([relay]);
  expect(routesAhead(list, "gone:1", true)).toEqual([]);
});
