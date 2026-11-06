import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { checkHost, readSettings, writeSettings } from "./settings";

const file = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "parallax-settings-")), "settings.json");

test("a destination that ssh could read as an option, split, or pass to a shell is refused", () => {
  const bad = ["", "  ", "-oProxyCommand=x", "mini plxd", "mini\u0000", "a\tb"];
  // OpenSSH 9.6's set (CVE-2023-51385).
  bad.push(..."'`\"$\\;&<>|(){}".split("").map((c) => `me${c}@mini`));
  for (const destination of bad) {
    expect(checkHost({ name: "x", destination }), destination).toBeTypeOf("string");
  }
  expect(checkHost({ name: "  ", destination: " me@mini.local " })).toEqual({
    name: "me@mini.local",
    destination: "me@mini.local",
  });
  expect(checkHost({ name: "Mac mini", destination: "ssh://me@mini:2222" })).toEqual({
    name: "Mac mini",
    destination: "ssh://me@mini:2222",
  });
});

test("settings round-trip with keys this doesn't know, and a missing file is no hosts", () => {
  const settings = file();
  expect(readSettings(settings)).toEqual({ hosts: [] });
  const hosts = [
    { id: "h1", name: "Mac mini", destination: "mini" },
    { id: "h2", name: "devbox", destination: "devbox", plxdInstalled: true },
  ];
  writeSettings(settings, {
    hosts,
    ssh: "C:\\ssh.exe",
    later: 1,
  } as never);
  expect(readSettings(settings)).toEqual({
    hosts,
    ssh: "C:\\ssh.exe",
    later: 1,
  });
});

// Throwing is what stops a save from overwriting them (hosts.ts).
test("a file this can't use as is throws, so a save can't overwrite what the user wrote", () => {
  const good = { id: "h1", name: "Mac mini", destination: "mini" };
  const device = { id: "n1", hostName: "mac-mini", ip: "100.64.0.1", os: "macOS" };
  const computer = { fingerprint: "ab".repeat(32), name: "Studio", routes: ["192.168.1.20"] };
  const unusable = [
    "{ hosts: ",
    "[]",
    JSON.stringify({ hosts: {} }),
    JSON.stringify({ hosts: [good], ssh: 3 }),
    JSON.stringify({ hosts: [good, null] }),
    JSON.stringify({ hosts: [good, { id: "h2" }] }),
    JSON.stringify({ hosts: [good, { ...good, name: "again" }] }),
    JSON.stringify({ hosts: [{ ...good, id: "local" }] }),
    JSON.stringify({ hosts: [{ ...good, destination: "-oProxyCommand=evil" }] }),
    JSON.stringify({ hosts: [{ ...good, destination: " mini" }] }),
    JSON.stringify({ hosts: [{ ...good, plxdInstalled: "yes" }] }),
    JSON.stringify({ hosts: [], devices: {} }),
    JSON.stringify({ hosts: [], devices: [{ id: "n1", hostName: "mini", ip: "100.64.0.1" }] }),
    JSON.stringify({ hosts: [], devices: [{ ...device, icon: "toaster" }] }),
    JSON.stringify({ hosts: [], devices: [device, device] }),
    JSON.stringify({ hosts: [], lan: [{ ...computer, fingerprint: "AB" }] }),
    JSON.stringify({ hosts: [], lan: [{ ...computer, routes: [] }] }),
    JSON.stringify({ hosts: [], lan: [{ ...computer, routes: ["-oProxyCommand=x"] }] }),
    JSON.stringify({ hosts: [], lan: [computer, computer] }),
  ];
  for (const text of unusable) {
    const settings = file();
    writeFileSync(settings, text);
    expect(() => readSettings(settings), text).toThrow();
  }
  const usable = file();
  writeFileSync(usable, JSON.stringify({ hosts: [], lan: [computer] }));
  expect(readSettings(usable).lan).toEqual([computer]);
});
