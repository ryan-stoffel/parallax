// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { findDevice, parseStatus } from "../src/tailscale.mjs";

// Shaped like `tailscale status --json`, trimmed to the fields plx-connect reads.
const ME = 526036588648688;
const status = {
  Self: {
    ID: "nSelf",
    HostName: "Ryan’s Mac Mini",
    DNSName: "ryans-mac-mini.tail53cf78.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.74.190.83", "fd7a:115c:a1e0::fc2a:be54"],
    Online: true,
    UserID: ME,
  },
  Peer: {
    "nodekey:1": {
      ID: "nBook",
      HostName: "macbook",
      DNSName: "ryans-macbook.tail53cf78.ts.net.",
      OS: "macOS",
      TailscaleIPs: ["100.87.92.42", "fd7a:115c:a1e0::d533:5c2c"],
      Online: true,
      UserID: ME,
    },
    "nodekey:2": {
      ID: "nTagged",
      HostName: "pi-cp",
      DNSName: "pi-cp.tail470a31.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.72.21.18"],
      Online: true,
      UserID: 662125110488743,
      Tags: ["tag:k3s"],
    },
    "nodekey:3": {
      ID: "nShared",
      HostName: "jacobs-pc",
      DNSName: "jacobs-pc.tail999.ts.net.",
      OS: "windows",
      TailscaleIPs: ["100.100.1.1"],
      Online: true,
      UserID: 7312656834859973,
    },
    "nodekey:5": {
      ID: "nTaggedMine",
      HostName: "build-server",
      DNSName: "build-server.tail53cf78.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.90.9.9"],
      Online: true,
      UserID: ME,
      Tags: ["tag:server"],
    },
    "nodekey:4": {
      ID: "nTower",
      HostName: "Tower",
      DNSName: "tower.tail53cf78.ts.net.",
      OS: "windows",
      TailscaleIPs: ["fd7a:115c:a1e0::1", "100.90.1.2"],
      Online: false,
      UserID: ME,
    },
  },
};

test("keeps only this user's untagged devices, sorted, with their first IPv4 and no trailing dot", () => {
  const { self, devices } = parseStatus(status);
  assert.deepEqual(self, {
    id: "nSelf",
    name: "Ryan’s Mac Mini",
    dnsName: "ryans-mac-mini.tail53cf78.ts.net",
    os: "macOS",
    ip: "100.74.190.83",
    online: true,
    parallax: false,
    tagged: false,
  });
  assert.deepEqual(
    devices.map((d) => [d.id, d.ip, d.dnsName, d.online]),
    [
      ["nBook", "100.87.92.42", "ryans-macbook.tail53cf78.ts.net", true],
      ["nTower", "100.90.1.2", "tower.tail53cf78.ts.net", false],
    ],
  );
});

test("a tagged node lists no peers, even ones with its UserID", () => {
  const tagged = { ...status, Self: { ...status.Self, UserID: 662125110488743, Tags: ["tag:k3s"] } };
  const { self, devices } = parseStatus(tagged);
  assert.equal(self.tagged, true);
  assert.deepEqual(devices, []);
});

test("a logged-out Tailscale is an error for people", () => {
  assert.throws(() => parseStatus({ Peer: null }), /isn't logged in/);
});

test("finds a device by host name, MagicDNS name, its first label, or IP", () => {
  const { devices } = parseStatus(status);
  for (const query of ["TOWER", "tower.tail53cf78.ts.net.", "tower", "100.90.1.2"]) {
    assert.equal(findDevice(devices, query)?.id, "nTower", query);
  }
  assert.equal(findDevice(devices, "ryans-macbook")?.id, "nBook");
  assert.equal(findDevice(devices, "pi-cp"), undefined);
});
