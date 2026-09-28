import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { checkHost, readSettings, writeSettings } from "./settings";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "wisp-settings-")), "settings.json");

test("a destination that ssh could read as an option, split, or pass to a shell is refused", () => {
  const bad = ["", "  ", "-oProxyCommand=x", "mini wispd", "mini\u0000", "a\tb"];
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
  const hosts = [{ id: "h1", name: "Mac mini", destination: "mini" }];
  writeSettings(settings, { hosts, ssh: "C:\\ssh.exe", later: 1 } as never);
  expect(readSettings(settings)).toEqual({ hosts, ssh: "C:\\ssh.exe", later: 1 });
});

// Throwing is what stops a save from overwriting them (hosts.ts).
test("a file this can't use as is throws, so a save can't overwrite what the user wrote", () => {
  const good = { id: "h1", name: "Mac mini", destination: "mini" };
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
  ];
  for (const text of unusable) {
    const settings = file();
    writeFileSync(settings, text);
    expect(() => readSettings(settings), text).toThrow();
  }
});
