import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { commitment, REQUEST_LIFETIME_MS } from "./access";
import { AccountHosts, Denied, listHosts } from "./accountHosts";
import { base64url } from "./pairing";

/** Each host's bridge port, and how it answers a path. A rejected answer is a lost connection. */
type Answer = { status: number; json?: object } | Error;
const net = vi.hoisted(() => ({
  ports: [] as string[],
  answers: {} as Record<string, (path: string, body: Record<string, unknown>) => unknown>,
  store: new Map<string, string>(),
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => net.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void net.store.set(key, value),
  deleteItemAsync: async (key: string) => void net.store.delete(key),
}));
vi.mock("./push", () => ({ RELAY_URL: "https://relay.test" }));
vi.mock("../modules/pinned-tls", () => ({
  PinnedSocket: class {},
  randomBytes: (count: number) => crypto.getRandomValues(new Uint8Array(count)),
  openRelay: async (url: string) => {
    const hostId = url.split("/").at(-2)!;
    net.ports.push(hostId);
    return { port: net.ports.length - 1, close: () => {}, refused: () => undefined };
  },
  request: async (url: string, _method: string, _headers: object, body?: Record<string, unknown>) => {
    const { port, pathname } = new URL(url);
    const hostId = net.ports[Number(port)]!;
    const answer = (pathname === "/.well-known/parallax"
      ? { status: 200, json: { name: hostId, routes: [] } }
      : net.answers[hostId]!(pathname, body ?? {})) as Answer;
    if (answer instanceof Error) throw answer;
    return { status: answer.status, body: JSON.stringify(answer.json ?? {}), fingerprint: "fp" };
  },
}));

const hostValue = new Uint8Array(32).fill(7);
const held = { request: "r1", commitment: commitment(hostValue) };

/** A host holding request `r1`, whose long poll answers `poll`. Records the values it was sent. */
function holding(poll: () => Answer, values: unknown[] = []) {
  return (path: string, body: Record<string, unknown>): Answer => {
    if (path === "/api/auth/account") return { status: 202, json: held };
    if (body["value"]) values.push(body["value"]);
    if (body["wait"]) return poll();
    return { status: 202, json: { value: base64url(hostValue) } };
  };
}

const session = { status: 200, json: { accessToken: "session" } };
const load = () => AccountHosts.load(async () => "token", "iPhone");

beforeEach(() => {
  net.ports.length = 0;
  net.store.clear();
  net.answers = {};
  vi.useRealTimers();
});

afterEach(() => vi.unstubAllGlobals());

test("a tap during a wait keeps the request the host still holds", async () => {
  const values: unknown[] = [];
  let poll: () => Answer = () => new Error("lost");
  net.answers["a"] = holding(() => poll(), values);
  const accounts = await load();

  await expect(accounts.ask("a", [], () => {})).rejects.toThrow();
  await accounts.resumeAsking();
  poll = () => session;
  await accounts.ask("a", [], () => {});

  expect(new Set(values).size).toBe(1);
  expect(accounts.trusts("a")).toBe(true);
});

test("once it asked, a sign-in another computer takes counts as the Allow", async () => {
  net.answers["a"] = holding(() => new Error("lost"));
  net.answers["b"] = () => session;
  const accounts = await load();

  await expect(accounts.ask("a", [], () => {})).rejects.toThrow();
  await accounts.ask("b", [], () => {});

  expect(accounts.trusts("b")).toBe(true);
  expect(accounts.usesAny).toBe(true);
  expect(accounts.asked("a")).toBe(false);
});

test("a sign-in it never asked for grants no trust, and stops asking", async () => {
  net.answers["a"] = () => session;
  const accounts = await load();

  await expect(accounts.ask("a", [], () => {})).rejects.toBeInstanceOf(Denied);

  expect(accounts.trusts("a")).toBe(false);
  expect(accounts.usesAny).toBe(false);
});

test("a denied request is forgotten, so the next ask starts a new one", async () => {
  net.answers["a"] = holding(() => ({ status: 401 }));
  const accounts = await load();

  await expect(accounts.ask("a", [], () => {})).rejects.toBeInstanceOf(Denied);

  expect(accounts.asked("a")).toBe(false);
});

test("an Allow ends a stop that a losing poll left", async () => {
  net.answers["a"] = holding(() => session);
  const accounts = await load();
  await accounts.stopAsking("That request wasn't allowed.");

  await accounts.ask("a", [], () => {});

  expect(accounts.askingStopped).toBeUndefined();
});

test("a request past its lifetime is no longer worth waiting for, but still counts as asked", async () => {
  net.answers["a"] = holding(() => new Error("lost"));
  const accounts = await load();
  await expect(accounts.ask("a", [], () => {})).rejects.toThrow();
  expect(accounts.waiting("a")).toBe(true);

  vi.useFakeTimers({ now: Date.now() + REQUEST_LIFETIME_MS + 1 });

  expect(accounts.waiting("a")).toBe(false);
  expect(accounts.asked("a")).toBe(true);
});

const answering =(response: Response | Error) =>
  vi.stubGlobal("fetch", async () => {
    if (response instanceof Error) throw response;
    return response;
  });

test("the list says who left, and a failed read is no list at all", async () => {
  const host = (hostId: string) => ({ hostId, name: hostId, online: true });

  answering(Response.json({ hosts: [host("a"), host("b")], removed: ["b", "c"] }));
  expect(await listHosts("token")).toEqual({ hosts: [host("a")], removed: ["b", "c"] });

  // A relay from before `removed` marks nothing.
  answering(Response.json({ hosts: [host("a")] }));
  expect(await listHosts("token")).toEqual({ hosts: [host("a")], removed: [] });

  for (const failed of [
    new Error("offline"),
    Response.json({ error: "clerk_unreachable" }, { status: 503 }),
    new Response("<html>"),
    Response.json({ removed: ["a"] }),
  ]) {
    answering(failed);
    expect(await listHosts("token")).toBeUndefined();
  }
});

test("forgetting a computer ends its session, trust, and request, and keeps its counts", async () => {
  const kept = { kept: { request: "r1", commitment: "c", value: "v", until: Date.now() + 1000 }, requests: [1], setupRuns: [2] };
  const other = { requests: [3], setupRuns: [] };
  net.store.set(
    "account-hosts",
    JSON.stringify({
      key: base64url(new Uint8Array(32).fill(1)),
      sessions: { a: "sa", b: "sb" },
      trusted: ["a", "b"],
      books: { a: kept, b: other },
    }),
  );
  const accounts = await load();

  await accounts.forget(["a", "never-here"]);

  expect(accounts.sessions).toEqual(["b"]);
  expect(accounts.trusts("a")).toBe(false);
  expect(accounts.asked("a")).toBe(false);
  const saved = JSON.parse(net.store.get("account-hosts")!);
  expect(saved.sessions).toEqual({ b: "sb" });
  expect(saved.books).toEqual({ a: { requests: [1], setupRuns: [2] }, b: other });
});
