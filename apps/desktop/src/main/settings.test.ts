import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { checkHost, readSettings, writeSettings } from "./settings";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "wisp-settings-")), "settings.json");

test("a destination that ssh could read as an option or split is refused (0007)", () => {
  for (const destination of ["", "  ", "-oProxyCommand=x", "mini wispd", "mini\u0000", "a\tb"]) {
    expect(checkHost({ name: "x", destination })).toBeTypeOf("string");
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

test("settings round-trip, and a missing file is no hosts", () => {
  const settings = file();
  expect(readSettings(settings)).toEqual({ hosts: [] });
  const hosts = [{ id: "h1", name: "Mac mini", destination: "mini" }];
  writeSettings(settings, { hosts, ssh: "C:\\ssh.exe" });
  expect(readSettings(settings)).toEqual({ hosts, ssh: "C:\\ssh.exe" });
});

test("hosts edited by hand into something unsafe are dropped", () => {
  const settings = file();
  const good = { id: "h1", name: "Mac mini", destination: "mini" };
  const hosts = [
    good,
    { id: "local", name: "x", destination: "y" },
    { id: "h2" },
    null,
    { id: "h3", name: "x", destination: "-oProxyCommand=evil" },
  ];
  writeFileSync(settings, JSON.stringify({ hosts, ssh: 3 }));
  expect(readSettings(settings)).toEqual({ hosts: [good] });
});

test("a file that isn't JSON throws, so a save can't overwrite the user's hosts", () => {
  const settings = file();
  writeFileSync(settings, "{ hosts: ");
  expect(() => readSettings(settings)).toThrow();
});
