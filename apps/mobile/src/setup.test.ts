import { expect, test } from "vitest";

import { upgraded, withListed } from "./setup";

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
