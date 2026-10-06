// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { parseDetails, parseUname } from "../src/detect.mjs";

test("uname output names macOS and Linux", () => {
  assert.equal(parseUname("Darwin arm64\n", 0), "macos");
  assert.equal(parseUname("Linux aarch64\n", 0), "linux");
});

test("a Windows shell's answer to uname means Windows", () => {
  const cmd = "'uname' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
  assert.equal(parseUname(cmd, 1), "windows");
  const powershell = "uname : The term 'uname' is not recognized as the name of a cmdlet ...\r\n    + FullyQualifiedErrorId : CommandNotFoundException\r\n";
  assert.equal(parseUname(powershell, 1), "windows");
  assert.equal(parseUname("MINGW64_NT-10.0-26100 x86_64\n", 0), "windows");
});

test("an OS Parallax doesn't run on is an error", () => {
  assert.throws(() => parseUname("FreeBSD amd64\n", 0), /doesn't run on FreeBSD/);
});

test("reads each OS's details", () => {
  assert.deepEqual(parseDetails("macos", "arch=arm64\nname=mac-mini.local\nversion=macOS 26.0\nmodel=Mac mini\n"), {
    os: "macos",
    arch: "arm64",
    label: "Mac mini",
    version: "macOS 26.0",
  });
  assert.deepEqual(parseDetails("linux", "arch=x86_64\nname=box\nversion=Ubuntu 24.04.1 LTS\n"), {
    os: "linux",
    arch: "x64",
    label: "box",
    version: "Ubuntu 24.04.1 LTS",
  });
  assert.deepEqual(parseDetails("windows", "arch=ARM64\r\nname=TOWER\r\nversion=Microsoft Windows 11 Pro\r\n"), {
    os: "windows",
    arch: "arm64",
    label: "TOWER",
    version: "Windows 11 Pro",
  });
  assert.equal(parseDetails("windows", "arch=AMD64\r\nname=PC\r\n").arch, "x64");
});

test("an arch Parallax isn't built for is an error", () => {
  assert.throws(() => parseDetails("linux", "arch=armv7l\nname=pi\n"), /isn't built for armv7l/);
});
