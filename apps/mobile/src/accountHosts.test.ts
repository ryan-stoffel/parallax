import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { commitment, lacks, REQUEST_LIFETIME_MS } from "./access";
import { AccountHosts, Denied, listHosts, relayProblem } from "./accountHosts";
import { allowThisPhone } from "./accountPrompts";
import { base64url } from "./pairing";
import { keeper } from "./setup";

/** Each host's bridge port, and how it answers a path. A rejected answer is a lost connection. */
type Answer = { status: number; json?: object } | Error;
const net = vi.hoisted(() => ({
  ports: [] as string[],
  answers: {} as Record<string, (path: string, body: Record<string, unknown>) => unknown>,
  store: new Map<string, string>(),
  /** Every request: where it went, its pin, and whether it carried anything but its path. */
  sent: [] as { hostname: string; pathname: string; pin: string; credential: boolean }[],
  /** Hosts whose TLS presents a key the pin refuses, as `pinned-tls` reports it. */
  wrongKey: new Set<string>(),
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => net.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void net.store.set(key, value),
  deleteItemAsync: async (key: string) => void net.store.delete(key),
}));
vi.mock("react-native", () => ({}));
vi.mock("./push", () => ({ RELAY_URL: "https://relay.test" }));
vi.mock("./host", async (original) => ({
  ...(await original<typeof import("./host")>()),
  spakePair: async () => ({ accessToken: "session" }),
}));
vi.mock("../modules/pinned-tls", () => ({
  PinnedSocket: class {},
  randomBytes: (count: number) => crypto.getRandomValues(new Uint8Array(count)),
  openRelay: async (url: string) => {
    const hostId = url.split("/").at(-2)!;
    net.ports.push(hostId);
    return {
      port: net.ports.length - 1,
      close: () => {},
      refused: () => undefined,
      closedWith: () => undefined,
    };
  },
  request: async (url: string, _method: string, headers: object, body: object | undefined, pin: string) => {
    const { hostname, port, pathname } = new URL(url);
    net.sent.push({ hostname, pathname, pin, credential: !!body || Object.keys(headers).length > 0 });
    if (net.wrongKey.has(hostname)) throw Object.assign(new Error("key"), { code: "ERR_WRONG_HOST" });
    const hostId = net.ports[Number(port)]!;
    const answer = (await (pathname === "/.well-known/parallax"
      ? { status: 200, json: { name: hostId, routes: [] } }
      : net.answers[hostId]!(pathname, (body ?? {}) as Record<string, unknown>))) as Answer;
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
/** The sessions the phone keeps, whatever it trusts. */
const savedSessions = () => (JSON.parse(net.store.get("account-hosts")!) as { sessions: object }).sessions;

test("starting over makes a new key that asks again, keeping trust, the hour's count, and the old key out", async () => {
  const hosts = await load();
  net.answers["h"] = holding(() => session);
  await hosts.ask("h", { routes: [] }, () => {});
  expect(hosts.sessions).toEqual(["h"]);
  const old = hosts.thumbprint;
  await hosts.absorb([{ id: "h", paired: true, lists: none }]);

  net.answers["h"] = () => ({ status: 403, json: { error_description: "this device was removed" } });
  await expect(hosts.ask("h", { routes: [] }, () => {})).rejects.toThrow("this device was removed");
  expect(hosts.standing).toBe("removed");

  await hosts.startOver();
  expect(hosts.thumbprint).not.toBe(old);
  expect(hosts.standing).toBeUndefined();
  expect(savedSessions()).toEqual({});
  expect(hosts.usesAny).toBe(false);
  expect(hosts.trusts("h")).toBe(true);
  expect((await load()).thumbprint).toBe(hosts.thumbprint);
  // It asks only computers it trusted, whatever the relay lists now.
  expect(hosts.askable([{ hostId: "h" }, { hostId: "new" }])).toEqual([{ hostId: "h" }]);

  // It asks as a new device, and has no session until another device allows it.
  let code = "";
  net.answers["h"] = holding(() => session);
  await hosts.ask("h", { routes: [] }, (shown) => (code = shown));
  expect(code).toMatch(/^\d{6}$/);
  expect(hosts.sessions).toEqual(["h"]);

  // The old key goes in the removed lists, and the mark on it isn't this key's.
  const [absorbed] = await hosts.absorb([
    {
      id: "h",
      lists: { approvedClients: [old], removedClients: [], approvedHosts: ["h"], readOnlyClients: [old] },
    },
  ]);
  expect(absorbed!.union.removedClients).toEqual([old]);
  expect(absorbed!.union.approvedClients).toEqual([]);
  expect(hosts.standing).toBeUndefined();

  // Each new key counts against the same 5 an hour.
  const startOverAgain = async () => {
    await hosts.absorb([{ id: "h", lists: { ...none, removedClients: [hosts.thumbprint] } }]);
    expect(await hosts.startOver()).toBe(true);
  };
  net.answers["h"] = holding(() => ({ status: 403 }));
  await expect(hosts.ask("h", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);
  await startOverAgain();
  await expect(hosts.ask("h", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);
  await startOverAgain();
  await expect(hosts.ask("h", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);
  await startOverAgain();
  await expect(hosts.ask("h", { routes: [] }, () => {})).rejects.toThrow("5 times this hour");
});

test("a computer the phone's own record doesn't prove can't lead it to start over, and isn't asked after it", async () => {
  // "fake" answered the phone's own request with no tap, and another device added "other" with
  // Allow alone. Neither is in the phone's `allowed`, and both are trusted.
  const hosts = await load();
  net.answers["fake"] = holding(() => session);
  await hosts.ask("fake", { routes: [] }, () => {});
  await hosts.absorb([{ id: "fake", lists: { ...none, approvedHosts: ["fake", "other"] } }]);
  expect(hosts.allowed).toEqual([]);
  expect(hosts.trusts("other")).toBe(true);
  const key = hosts.thumbprint;

  for (const id of ["fake", "other"]) {
    net.answers[id] = () => ({ status: 403, json: { error_description: "this device was removed" } });
    await expect(hosts.ask(id, { routes: [] }, () => {})).rejects.toThrow("this device was removed");
  }
  await hosts.absorb([{ id: "fake", lists: { ...none, removedClients: [key], readOnlyClients: [key] } }]);
  expect(hosts.standing).toBeUndefined();
  expect(await hosts.startOver()).toBe(false);
  expect(hosts.thumbprint).toBe(key);

  // A computer paired on the LAN is proved, and so is what it approves, by pinned id, unless marked.
  await hosts.absorb([
    {
      id: "paired",
      paired: true,
      lists: { ...none, approvedHosts: ["real", "marked"], allowedHosts: ["marked"] },
    },
    { id: "real", lists: { ...none, readOnlyClients: [key], approvedHosts: ["paired"] } },
  ]);
  expect(hosts.standing).toBe("readOnly");
  expect(await hosts.startOver()).toBe(true);
  expect(hosts.trusts("fake")).toBe(false);
  expect(hosts.trusts("other")).toBe(false);
  const listed = ["fake", "other", "marked", "new", "real"].map((hostId) => ({ hostId }));
  expect(hosts.askable(listed)).toEqual([{ hostId: "real" }]);
  // That record outlives a relaunch, when nothing is connected to say it again.
  expect((await load()).askable(listed)).toEqual([{ hostId: "real" }]);
});

test("while a new key has no session, a computer another one lists gets no connection, and so no token", async () => {
  const hosts = await load();
  net.answers["real"] = holding(() => session);
  await hosts.ask("real", { routes: [] }, () => {});
  const key = hosts.thumbprint;
  await hosts.absorb([{ id: "real", paired: true, lists: { ...none, readOnlyClients: [key] } }]);
  expect(await hosts.startOver()).toBe(true);

  // A LAN-paired computer, still connected, lists one added with Allow alone. The phone trusts it.
  await hosts.absorb([{ id: "lan", paired: true, lists: { ...none, allowedHosts: ["allowed"] } }]);
  await hosts.absorb([{ id: "unproved", lists: { ...none, approvedHosts: ["named"] } }]);
  expect(hosts.trusts("named")).toBe(true);
  expect(hosts.mayConnect("named")).toBe(false);
  expect(hosts.mayConnect("allowed")).toBe(false);
  expect(hosts.mayConnect("real")).toBe(true);

  // Once a verified computer lets the new key in, connections go by trust as usual.
  net.answers["real"] = holding(() => session);
  await hosts.ask("real", { routes: [] }, () => {});
  expect(hosts.usesAny).toBe(true);
  expect(hosts.mayConnect("named")).toBe(true);
});

/** A phone that started over with `real` proved, and trusts `named`, which nothing proves. */
async function startedOver(token: (fresh?: boolean) => Promise<string | undefined>) {
  const hosts = await AccountHosts.load(token, "iPhone");
  net.answers["real"] = holding(() => session);
  await hosts.ask("real", { routes: [] }, () => {});
  const readOnly = { ...none, readOnlyClients: [hosts.thumbprint] };
  await hosts.absorb([{ id: "real", paired: true, lists: readOnly }]);
  await hosts.absorb([{ id: "unproved", lists: { ...none, approvedHosts: ["named"] } }]);
  return hosts;
}

test("a computer past its descriptor when the phone starts over asks for no token, on any path", async () => {
  const fresh: string[] = [];
  const posted: string[] = [];
  const hosts = await startedOver(async (isFresh) => {
    if (isFresh) fresh.push("token");
    return "token";
  });
  await hosts.absorb([{ id: "unproved2", lists: { ...none, approvedHosts: ["held"] } }]);
  expect(await hosts.startOver()).toBe(true);
  fresh.length = 0;

  // `ask` and `compare` go straight to a sign-in, whatever the caller checked before.
  const answers = holding(() => session);
  net.answers["held"] = (path: string, body: Record<string, unknown>) => {
    posted.push(path);
    return answers(path, body);
  };
  await expect(hosts.ask("held", { routes: [] }, () => {})).rejects.toThrow("hasn't been allowed");
  await expect(hosts.compare("held", { routes: [] }, async () => true)).rejects.toThrow("hasn't been allowed");
  expect(fresh).toEqual([]);
  expect(posted).toEqual([]);

  // Once a verified computer lets the new key in, it goes by trust as usual.
  net.answers["real"] = holding(() => session);
  await hosts.ask("real", { routes: [] }, () => {});
  expect(fresh).toHaveLength(1);
  await hosts.ask("held", { routes: [] }, () => {});
  expect(posted).toContain("/api/auth/account");
});

test("first run's asking goes through the same gate as Settings' after starting over", async () => {
  const hosts = await startedOver(async () => "token");
  expect(await hosts.startOver()).toBe(true);
  const posted: string[] = [];
  net.answers["named"] = (path: string) => {
    posted.push(path);
    return session;
  };
  net.answers["real"] = holding(() => session);
  const listed = (hostId: string) => ({ hostId, name: hostId, online: true });
  expect(await allowThisPhone(hosts, [listed("named"), listed("real")], () => {})).toBe("allowed");
  expect(posted).toEqual([]);
  expect(hosts.sessions).toEqual(["real"]);
});

test("a refusal for the old key that lands after starting over doesn't mark the new one", async () => {
  const hosts = await startedOver(async () => "token");
  net.answers["real"] = async () => {
    await hosts.startOver();
    return { status: 403, json: { error_description: "this device was removed" } };
  };
  await expect(hosts.ask("real", { routes: [] }, () => {})).rejects.toThrow("started over");
  expect(hosts.standing).toBeUndefined();
});

test("a request a computer holds forever ends after its 10 minutes", async () => {
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const waiting = () => {
      now += 60_000;
      return { status: 202, json: { value: base64url(hostValue) } };
    };
    const hosts = await load();
    net.answers["held"] = holding(waiting);
    await expect(hosts.ask("held", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);
    expect(now - 1_000_000).toBeLessThanOrEqual(REQUEST_LIFETIME_MS + 60_000);
    expect(hosts.asked("held")).toBe(false);

    now = 2_000_000;
    net.answers["held2"] = holding(waiting);
    await expect(hosts.compare("held2", { routes: [] }, async () => true)).rejects.toBeInstanceOf(Denied);
    expect(now - 2_000_000).toBeLessThanOrEqual(REQUEST_LIFETIME_MS + 60_000);
  } finally {
    clock.mockRestore();
  }
});

test("a computer added with Allow alone can't lead the phone to start over, and isn't asked after it", async () => {
  const hosts = await load();
  net.answers["real"] = holding(() => session);
  await hosts.ask("real", { routes: [] }, () => {});
  net.answers["fake"] = holding(() => session);
  await hosts.compare("fake", { routes: [] }, async () => true);
  expect(hosts.allowed).toEqual(["fake"]);
  const key = hosts.thumbprint;

  // It says the phone is removed and read-only, both ways it can. Nothing counts, or changes.
  net.answers["fake"] = () => ({ status: 403, json: { error_description: "this device was removed" } });
  await expect(hosts.ask("fake", { routes: [] }, () => {})).rejects.toThrow("this device was removed");
  const claim = { ...none, removedClients: [key], readOnlyClients: [key] };
  await hosts.absorb([{ id: "fake", lists: claim }]);
  expect(hosts.standing).toBeUndefined();
  expect(await hosts.startOver()).toBe(false);
  expect(hosts.thumbprint).toBe(key);

  // A verified computer's mark does count. Starting over then asks only verified computers.
  await hosts.absorb([{ id: "real", paired: true, lists: { ...none, readOnlyClients: [key] } }]);
  expect(hosts.standing).toBe("readOnly");
  expect(await hosts.startOver()).toBe(true);
  expect(hosts.thumbprint).not.toBe(key);
  expect(hosts.trusts("fake")).toBe(false);
  expect(hosts.askable([{ hostId: "fake" }, { hostId: "real" }])).toEqual([{ hostId: "real" }]);

  // A second tap, with no mark left, doesn't replace the new key.
  const second = hosts.thumbprint;
  expect(await hosts.startOver()).toBe(false);
  expect(hosts.thumbprint).toBe(second);
});

test("each computer gets its fresh token alone, and a sign-in waiting on one when the phone starts over sends nothing", async () => {
  const asked: string[] = [];
  let release = () => {};
  const hosts = await AccountHosts.load(async (fresh) => {
    if (!fresh) return "relay token";
    asked.push("token");
    await new Promise<void>((resolve) => (release = resolve));
    return "token";
  }, "iPhone");
  const posted: string[] = [];
  const answer = (hostId: string) => (path: string) => {
    if (path === "/api/auth/account") posted.push(hostId);
    return session;
  };
  net.answers["a"] = answer("a");
  net.answers["b"] = answer("b");

  const first = hosts.ask("a", { routes: [] }, () => {}).catch(() => {});
  const second = hosts.ask("b", { routes: [] }, () => {}).catch(() => {});
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(asked).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(asked).toHaveLength(2));

  // The second is waiting on its token as the phone starts over.
  await hosts.absorb([{ id: "a", paired: true, lists: { ...none, readOnlyClients: [hosts.thumbprint] } }]);
  expect(await hosts.startOver()).toBe(true);
  release();
  await Promise.all([first, second]);
  expect(posted).toEqual(["a"]);
});

test("a read-only mark on this phone's key is noticed, and a removal from a computer it doesn't use isn't", async () => {
  const hosts = await load();
  net.answers["fake"] = () => ({ status: 403, json: { error_description: "this device was removed" } });
  await expect(hosts.ask("fake", { routes: [] }, () => {})).rejects.toThrow("this device was removed");
  expect(hosts.standing).toBeUndefined();

  await hosts.absorb([
    {
      id: "h",
      paired: true,
      lists: {
        approvedClients: [hosts.thumbprint],
        removedClients: [],
        approvedHosts: ["h"],
        readOnlyClients: [hosts.thumbprint],
      },
    },
  ]);
  expect(hosts.standing).toBe("readOnly");
});

beforeEach(() => {
  net.ports.length = 0;
  net.store.clear();
  net.answers = {};
  net.sent.length = 0;
  net.wrongKey.clear();
  vi.useRealTimers();
});

afterEach(() => vi.unstubAllGlobals());

const none = { approvedClients: [], removedClients: [], approvedHosts: [] };
/** The entry for `id` in what `absorb` answers. */
const of = <T extends { id: string }>(all: T[], id: string) => all.find((each) => each.id === id)!;
/** A fake computer's lists: an attacker's key and host, the user's desktop removed, and `hosts`. */
const fakeLists = (...hosts: string[]) => ({
  ...none,
  approvedClients: ["attacker"],
  removedClients: ["desktop"],
  approvedHosts: ["attacker-host", ...hosts],
});

test("a fake computer the phone trusts with no tap adds nothing to a real one", async () => {
  // The relay lists "fake", which answers the phone's own request as if allowed: no tap, no prompt.
  net.answers["fake"] = holding(() => session);
  const accounts = await load();
  await accounts.ask("fake", { routes: [] }, () => {});
  expect(accounts.trusts("fake")).toBe(true);

  const fake = { id: "fake", lists: fakeLists("real") };
  await accounts.absorb([fake]);
  expect(accounts.trusts("real")).toBe(true);

  // The phone's request at the real computer is allowed on the user's desktop: it's approved there.
  net.answers["real"] = () => session;
  await accounts.ask("real", { routes: [] }, () => {});
  expect(accounts.sessions).toContain("real");

  const real = { id: "real", lists: { ...none, approvedClients: ["desktop"], approvedHosts: ["real"] } };
  const { union } = of(await accounts.absorb([real, fake]), "real");
  expect(union).toEqual(real.lists);
  expect(lacks(real.lists, union)).toBe(false);
});

test("a phone from before this kept no proof, so a fake computer it trusts adds nothing either", async () => {
  net.store.set(
    "account-hosts",
    JSON.stringify({
      key: base64url(new Uint8Array(32).fill(1)),
      sessions: { real: "sr", fake: "sf" },
      trusted: ["real", "fake"],
      books: {},
    }),
  );
  const accounts = await load();
  const real = { id: "real", lists: { ...none, approvedHosts: ["real"] } };
  const { union } = of(await accounts.absorb([real, { id: "fake", lists: fakeLists("real") }]), "real");
  expect(lacks(real.lists, union)).toBe(false);
});

test("two fakes that list each other, and a real one, still add nothing to it", async () => {
  const accounts = await load();
  const real = { id: "real", lists: { ...none, approvedHosts: ["real"] } };
  const known = await accounts.absorb([
    real,
    { id: "fake1", lists: fakeLists("fake1", "fake2", "real") },
    { id: "fake2", lists: { ...fakeLists("fake1", "fake2", "real"), approvedClients: ["attacker2"] } },
  ]);
  expect(lacks(real.lists, of(known, "real").union)).toBe(false);
  // What's copied among them stays among them.
  expect(of(known, "fake1").union.approvedClients).toContain("attacker2");
});

test("a fake computer can't restrict a real one, here or on any other device", async () => {
  net.answers["fake"] = holding(() => session);
  const accounts = await load();
  await accounts.ask("fake", { routes: [] }, () => {});
  const real = { id: "real", lists: { ...none, approvedHosts: ["real", "other"] } };
  const other = { id: "other", lists: { ...none, approvedClients: ["desktop"], approvedHosts: ["real", "other"] } };
  const known = await accounts.absorb([real, other, { id: "fake", lists: { ...none, allowedHosts: ["real"] } }]);

  expect(accounts.allowed).toEqual([]);
  expect(of(known, "real").union.allowedHosts).toBeUndefined();
  expect(of(known, "other").union.allowedHosts).toBeUndefined();
  // And it doesn't stop the real one's lists reaching the other.
  expect(of(known, "real").union.approvedClients).toEqual(["desktop"]);
});

test("real computers approved from another device still sync, with no tap and nothing marked", async () => {
  // Allowed on the desktop, whose merge put the phone's key and both ids on both computers.
  net.answers["a"] = holding(() => session);
  net.answers["b"] = () => session;
  const accounts = await load();
  await accounts.ask("a", { routes: [] }, () => {});

  const hosts = ["a", "b"];
  const a = { id: "a", lists: { ...none, approvedClients: ["phone", "desktop", "new"], approvedHosts: hosts } };
  await accounts.absorb([a]);
  expect(accounts.trusts("b")).toBe(true);
  await accounts.ask("b", { routes: [] }, () => {});

  const b = {
    id: "b",
    lists: { approvedClients: ["phone", "desktop"], removedClients: ["gone"], approvedHosts: hosts },
  };
  const known = await accounts.absorb([a, b]);
  expect(of(known, "b").union.approvedClients).toEqual(["desktop", "new", "phone"]);
  expect(of(known, "a").union.removedClients).toEqual(["gone"]);
  expect(lacks(b.lists, of(known, "b").union)).toBe(true);
  expect(lacks(a.lists, of(known, "a").union)).toBe(true);
  expect(accounts.allowed).toEqual([]);
  expect(of(known, "a").union.allowedHosts).toBeUndefined();
});

test("a computer set up with a typed code gives lists to every computer, and vouches for those it lists", async () => {
  net.answers["typed"] = () => session;
  const accounts = await load();
  await accounts.setup("typed", { routes: [] }, "123456");

  const typed = { id: "typed", lists: { ...none, approvedClients: ["phone"], approvedHosts: ["listed"] } };
  const listed = { id: "listed", lists: { ...none, approvedClients: ["desktop"] } };
  const known = await accounts.absorb([
    typed,
    listed,
    { id: "fake", lists: fakeLists("typed") },
    { id: "other", lists: none },
  ]);

  // The other computer takes the typed one's lists, its id, and those of the computer it lists.
  const { union } = of(known, "other");
  expect(union.approvedClients).toEqual(["desktop", "phone"]);
  expect(union.approvedHosts).toEqual(["listed", "typed"]);
  // A computer that lists the typed one doesn't get to add to it.
  expect(of(known, "typed").union.approvedClients).not.toContain("attacker");
  expect(of(known, "typed").union.approvedHosts).not.toContain("fake");
});

test("a typed code on a computer that first signed in with no tap counts from then on", async () => {
  net.answers["a"] = holding(() => session);
  const accounts = await load();
  await accounts.ask("a", { routes: [] }, () => {});
  const a = { id: "a", lists: { ...none, approvedClients: ["k"] } };
  const other = { id: "other", lists: none };
  expect(of(await accounts.absorb([a, other]), "other").union.approvedClients).toEqual([]);

  await accounts.setup("a", { routes: [] }, "123456");
  expect(of(await accounts.absorb([a, other]), "other").union.approvedClients).toEqual(["k"]);
});

test("a computer paired on the LAN gives lists to every computer, and isn't named as a host", async () => {
  const accounts = await load();
  const paired = { id: "paired-abc", paired: true, lists: { ...none, approvedClients: ["k"], allowedHosts: ["tapped"] } };
  const { union } = of(await accounts.absorb([paired, { id: "other", lists: none }]), "other");
  expect(union.approvedClients).toEqual(["k"]);
  expect(union.approvedHosts).toEqual([]);
  expect(accounts.allowed).toEqual(["tapped"]);
});

test("a fake computer whose id starts with paired- proves nothing, even with a real pairing's id", async () => {
  const accounts = await load();
  const machines = [
    { id: "paired-abc", name: "paired", paired: {} as never },
    { id: "account:paired-abc", name: "fake", account: { hostId: "paired-abc", routes: [] } },
    { id: "account:paired-fake", name: "fake", account: { hostId: "paired-fake", routes: [] } },
    { id: "account:real", name: "real", account: { hostId: "real", routes: [] } },
  ];
  const real = { ...none, approvedHosts: ["real"] };
  const known = await accounts.absorb([
    ...keeper(machines, "account:real", real),
    ...keeper(machines, "paired-abc", { ...none, approvedClients: ["k"] }),
    ...keeper(machines, "account:paired-abc", { ...fakeLists("real"), allowedHosts: ["real"] }),
    ...keeper(machines, "account:paired-fake", { ...fakeLists("real"), allowedHosts: ["real"] }),
  ]);
  const { union } = of(known, "real");
  // The real pairing's list counts, and neither fake's does.
  expect(union).toEqual({ ...real, approvedClients: ["k"] });
  expect(accounts.allowed).toEqual([]);
});

test("a malformed answer to access/get is no list, and the others still count", async () => {
  const accounts = await load();
  const machines = [{ id: "account:real", name: "real", account: { hostId: "real", routes: [] } }];
  for (const malformed of [{}, null, [], "lists", { ...none, approvedHosts: [1] }, { ...none, allowedHosts: "real" }])
    expect(keeper(machines, "account:fake", malformed)).toEqual([]);

  const known = await accounts.absorb([
    ...keeper(machines, "account:fake", {}),
    ...keeper(machines, "account:real", { ...none, approvedHosts: ["new"] }),
  ]);
  expect(known.map((each) => each.id)).toEqual(["real"]);
  expect(accounts.trusts("new")).toBe(true);
});

test("a restriction a proved computer states outlives it going offline, and a relaunch", async () => {
  const accounts = await load();
  await accounts.setup("real", { routes: [] }, "123456");
  // The real computer is online, and says "fake" was added with Allow on another device.
  await accounts.absorb([
    { id: "real", lists: { ...none, allowedHosts: ["fake"] } },
    { id: "fake", lists: none },
  ]);
  expect(accounts.trusts("fake")).toBe(true);
  expect(accounts.allowed).toEqual(["fake"]);

  // Relaunched, with it offline: the fake one's key and host go nowhere, even on a computer that
  // an older client told of it.
  const later = await load();
  const known = await later.absorb([
    { id: "other", lists: { ...none, approvedHosts: ["fake"] } },
    { id: "fake", lists: { ...none, approvedClients: ["attacker"], approvedHosts: ["attacker-host"] } },
  ]);
  const { union } = of(known, "other");
  expect(union.approvedClients).not.toContain("attacker");
  expect(union.approvedHosts).not.toContain("attacker-host");
  expect(union.allowedHosts).toEqual(["fake"]);
  expect(later.trusts("attacker-host")).toBe(false);
});

test("a restriction another computer states counts for that computer, and isn't kept", async () => {
  const accounts = await load();
  const real = { id: "real", lists: { ...none, approvedHosts: ["clicked"], allowedHosts: ["clicked"] } };
  const clicked = { id: "clicked", lists: { ...none, approvedClients: ["attacker"] } };
  const { union } = of(await accounts.absorb([real, clicked]), "real");
  expect(union.approvedClients).toEqual([]);
  expect(accounts.allowed).toEqual([]);
});

test("comparing takes no session before Allow, even from a host that offers one", async () => {
  const polled: unknown[] = [];
  net.answers["fake"] = holding(() => (polled.push(1), session));
  const accounts = await load();

  let allow = (_allowed: boolean) => {};
  const decided = new Promise<boolean>((resolve) => (allow = resolve));
  const running = accounts.compare("fake", { routes: [] }, () => decided);
  await vi.waitFor(() => expect(net.ports.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Nothing tapped: it asked nothing more of the host, and trusts it with nothing.
  expect(polled).toEqual([]);
  expect(accounts.trusts("fake")).toBe(false);
  expect(accounts.sessions).toEqual([]);

  allow(false);
  await expect(running).rejects.toBeInstanceOf(Denied);
  expect(accounts.trusts("fake")).toBe(false);
  expect(savedSessions()).toEqual({});
});

test("a host that answers a compare with a session at once showed no code, so nothing is kept", async () => {
  net.answers["signin"] = () => session;
  net.answers["value"] = (path) =>
    path === "/api/auth/account" ? { status: 202, json: held } : session;
  const accounts = await load();
  const decide = vi.fn(async () => true);
  for (const host of ["signin", "value"]) {
    await expect(accounts.compare(host, { routes: [] }, decide)).rejects.toThrow(/no code to compare/);
    expect(accounts.trusts(host)).toBe(false);
  }
  expect(decide).not.toHaveBeenCalled();
  expect(savedSessions()).toEqual({});
});

test("a computer allowed by comparing is used, and marked so no lists come from it", async () => {
  const bodies: Record<string, unknown>[] = [];
  net.answers["a"] = (path, body) => {
    bodies.push(body);
    if (path === "/api/auth/account") return { status: 202, json: held };
    return body["allow"] ? session : { status: 202, json: { value: base64url(hostValue) } };
  };
  const accounts = await load();
  await accounts.compare("a", { routes: [] }, async () => true);
  expect(bodies.at(-1)).toMatchObject({ request: "r1", allow: true });
  expect(accounts.trusts("a")).toBe(true);
  expect(accounts.allowed).toEqual(["a"]);
});

test("a bare setup's computer takes Allow here and then its own confirmation", async () => {
  let confirmed = false;
  net.answers["a"] = (path, body) => {
    if (path === "/api/auth/account") return { status: 202, json: held };
    if (body["allow"]) return { status: 202, json: { value: base64url(hostValue), needsHost: true } };
    if (body["wait"]) return confirmed ? session : { status: 202, json: {} };
    return { status: 202, json: { value: base64url(hostValue) } };
  };
  const accounts = await load();
  const onConfirm = vi.fn(() => void (confirmed = true));
  await accounts.compare("a", { routes: [] }, async () => true, onConfirm);
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(accounts.allowed).toEqual(["a"]);
});

test("a tap on a new phone's own request marks the computer", async () => {
  net.answers["a"] = (path, body) => {
    if (path === "/api/auth/account") return { status: 202, json: held };
    if (body["allow"]) return session;
    return { status: 202, json: { value: base64url(hostValue) } };
  };
  const accounts = await load();
  await accounts.ask("a", { routes: [] }, (_code, allow) => allow());
  expect(accounts.allowed).toEqual(["a"]);
});

test("an added route is pinned to the host, and one with another key gets no credential", async () => {
  net.wrongKey.add("stale.example.com");
  net.answers["a"] = holding(() => session);
  const accounts = await load();
  const added = { routes: [], addedRoutes: ["stale.example.com:7400"] };

  // The relay after it carries the sign-in.
  await accounts.ask("a", added, () => {});
  const stale = net.sent.filter((call) => call.hostname === "stale.example.com");
  expect(stale.length).toBeGreaterThan(0);
  expect(stale.every((call) => call.pathname === "/.well-known/parallax" && !call.credential)).toBe(true);
  expect(net.sent.every((call) => call.pin === "key:a")).toBe(true);
  expect(net.sent.some((call) => call.pathname === "/api/auth/account" && call.hostname === "127.0.0.1")).toBe(true);

  // In the user's order, with the relay below it, the same.
  net.sent.length = 0;
  await accounts.ask("a", { ...added, routeOrder: ["stale.example.com:7400", "relay:a"] }, () => {});
  expect(net.sent.filter((call) => call.hostname === "stale.example.com" && call.credential)).toEqual([]);
});

test("a re-check looks only at the routes ahead and sends no credential", async () => {
  net.wrongKey.add("stale.example.com");
  const accounts = await load();
  const choices = { routes: [], addedRoutes: ["stale.example.com:7400"] };
  expect(await accounts.recheck("a", choices, "relay:a", {})).toBeUndefined();
  expect(net.sent.map((call) => [call.hostname, call.credential])).toEqual([["stale.example.com", false]]);

  // With the relay at the top, nothing is ahead of it.
  net.sent.length = 0;
  const top = { ...choices, routeOrder: ["relay:a", "stale.example.com:7400"] };
  expect(await accounts.recheck("a", top, "relay:a", {})).toBeUndefined();
  expect(net.sent).toEqual([]);
  // And from the added route, the relay is, and it answers.
  expect(await accounts.recheck("a", top, "stale.example.com:7400", {})).toBe("relay:a");
});

test("a tap during a wait keeps the request the host still holds", async () => {
  const values: unknown[] = [];
  let poll: () => Answer = () => new Error("lost");
  net.answers["a"] = holding(() => poll(), values);
  const accounts = await load();

  await expect(accounts.ask("a", { routes: [] }, () => {})).rejects.toThrow();
  await accounts.resumeAsking();
  poll = () => session;
  await accounts.ask("a", { routes: [] }, () => {});

  expect(new Set(values).size).toBe(1);
  expect(accounts.trusts("a")).toBe(true);
});

test("once it asked, a sign-in another computer takes counts as the Allow", async () => {
  net.answers["a"] = holding(() => new Error("lost"));
  net.answers["b"] = () => session;
  const accounts = await load();

  await expect(accounts.ask("a", { routes: [] }, () => {})).rejects.toThrow();
  await accounts.ask("b", { routes: [] }, () => {});

  expect(accounts.trusts("b")).toBe(true);
  expect(accounts.usesAny).toBe(true);
  expect(accounts.asked("a")).toBe(false);
});

test("a sign-in it never asked for grants no trust, and stops asking", async () => {
  net.answers["a"] = () => session;
  const accounts = await load();

  await expect(accounts.ask("a", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);

  expect(accounts.trusts("a")).toBe(false);
  expect(accounts.usesAny).toBe(false);
});

test("a denied request is forgotten, so the next ask starts a new one", async () => {
  net.answers["a"] = holding(() => ({ status: 401 }));
  const accounts = await load();

  await expect(accounts.ask("a", { routes: [] }, () => {})).rejects.toBeInstanceOf(Denied);

  expect(accounts.asked("a")).toBe(false);
});

test("an Allow ends a stop that a losing poll left", async () => {
  net.answers["a"] = holding(() => session);
  const accounts = await load();
  await accounts.stopAsking("That request wasn't allowed.");

  await accounts.ask("a", { routes: [] }, () => {});

  expect(accounts.askingStopped).toBeUndefined();
});

test("a request past its lifetime is no longer worth waiting for, but still counts as asked", async () => {
  net.answers["a"] = holding(() => new Error("lost"));
  const accounts = await load();
  await expect(accounts.ask("a", { routes: [] }, () => {})).rejects.toThrow();
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
      proved: ["a", "b"],
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
  expect(saved.proved).toEqual(["b"]);
  expect(saved.books).toEqual({ a: { requests: [1], setupRuns: [2] }, b: other });
});

test("a 429 says the cap once the account's list shows it spent, and a busy minute otherwise", () => {
  const limit = 2 * 1024 ** 3;
  const resetsAt = Date.UTC(2026, 10, 5);
  const busy = "Too many connections to that computer this minute. Try again shortly.";
  expect(relayProblem(429)).toBe(busy);
  expect(relayProblem(429, { bytes: limit, limit, resetsAt })).toBe(busy);
  const spent = relayProblem(429, { bytes: limit + 1, limit, resetsAt });
  expect(spent).toMatch(/resets at .*still works over the LAN/);
});
