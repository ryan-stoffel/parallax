import { expect, test } from "vitest";

import { askEach, toAsk, upgraded, withListed } from "./setup";

const listed = (hostId: string, name: string) => ({ hostId, name, online: true });

test("a phone set up over Tailscale drops those computers and goes through onboarding again", () => {
  const read = {
    machines: [
      { id: "nodeA1", name: "mac-mini", os: "macOS", address: "100.101.2.3" },
      { id: "nodeB2", name: "studio", os: "linux", address: "100.101.2.4" },
    ],
    defaultId: "nodeA1",
    onboarded: true,
  };
  expect(upgraded(read)).toEqual({ machines: [], defaultId: undefined, onboarded: false });
});

test("account and paired computers stay, with the default and what was removed", () => {
  const account = { id: "account:h1", name: "studio", account: { hostId: "h1", routes: ["192.168.1.20"] } };
  const read = {
    machines: [account, { id: "paired-abc", name: "laptop" }, { id: "nodeA1", name: "old", os: "macOS", address: "100.1.1.1" }],
    defaultId: "account:h1",
    onboarded: true,
    hidden: ["account:h2"],
  };
  expect(upgraded(read)).toEqual({
    machines: [account, { id: "paired-abc", name: "laptop" }],
    defaultId: "account:h1",
    onboarded: true,
    hidden: ["account:h2"],
  });
});

test("onboarding lists the account's computers, leaving out those removed from this phone", () => {
  const known = withListed([], [listed("h1", "studio"), listed("h2", "")]);
  expect(known).toEqual([
    { id: "account:h1", name: "studio", account: { hostId: "h1", routes: [] } },
    { id: "account:h2", name: "Computer", account: { hostId: "h2", routes: [] } },
  ]);
  // Known ones keep their own name; nothing new leaves the list as it was.
  const renamed = [{ ...known[0]!, name: "Studio Mac" }];
  expect(withListed(renamed, [listed("h1", "studio")])).toBe(renamed);
  expect(withListed([], [listed("h1", "studio")], ["account:h1"])).toEqual([]);
});

test("a new phone asks the computers that are online, and none once it uses one", () => {
  const off = { hostId: "off", name: "off", online: false };
  const hosts = [off, listed("a", "a"), listed("b", "b")];
  expect(toAsk(hosts, false).map((h) => h.hostId)).toEqual(["a", "b"]);
  expect(toAsk(hosts, true)).toEqual([]);
  expect(toAsk(hosts, false, ["account:a"]).map((h) => h.hostId)).toEqual(["b"]);
});

test("asking passes over a computer it can't reach, and a denial ends it", async () => {
  const hosts = [listed("a", "a"), listed("b", "b"), listed("c", "c")];
  const denied = new Error("denied");
  const asked: string[] = [];
  const ask = (answers: Record<string, Error | undefined>) => async (host: { hostId: string }) => {
    asked.push(host.hostId);
    if (answers[host.hostId]) throw answers[host.hostId];
  };
  const stops = (e: unknown) => e === denied;
  const stopped: unknown[] = [];
  const note = (e: unknown) => void stopped.push(e);

  expect(await askEach(hosts, ask({ a: new Error("offline") }), stops, note)).toBe("allowed");
  expect(asked).toEqual(["a", "b"]);

  asked.length = 0;
  expect(await askEach(hosts, ask({ a: denied }), stops, note)).toBe("stopped");
  expect(asked).toEqual(["a"]);
  expect(stopped).toEqual([denied]);

  const offline = new Error("offline");
  expect(await askEach(hosts, ask({ a: offline, b: offline, c: offline }), stops, note)).toBe("unreachable");
});

test("asking stays on a computer that still holds the request, and passes one that doesn't", async () => {
  const hosts = [listed("a", "studio"), listed("b", "laptop")];
  const asked: string[] = [];
  const ask = async ({ hostId }: { hostId: string }) => {
    asked.push(hostId);
    if (hostId === "a") throw new Error("offline");
  };
  const none = () => {};

  expect(await askEach(hosts, ask, (_, host) => host.hostId === "a", none)).toBe("stopped");
  expect(asked).toEqual(["a"]);

  asked.length = 0;
  expect(await askEach(hosts, ask, () => false, none)).toBe("allowed");
  expect(asked).toEqual(["a", "b"]);
});
