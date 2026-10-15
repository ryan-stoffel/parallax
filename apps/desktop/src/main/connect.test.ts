import { expect, test } from "vite-plus/test";

import { iconFor } from "../preload/bridge";
import type { TailnetDevice } from "../protocol/generated/protocol";
import { addCommand, isDeviceAddress, isSshUser, mergeFound, type SavedDevice } from "./connect";
import { exitError } from "./connection";

test("a host name suggests its icon", () => {
  expect(iconFor("mac-mini")).toBe("mini");
  expect(iconFor("Ryan’s Mac Mini")).toBe("mini");
  expect(iconFor("ryans-gaming-pc")).toBe("desktop");
  expect(iconFor("DESKTOP-4KQ1M2")).toBe("desktop");
  expect(iconFor("thinkpad-server")).toBe("server");
  expect(iconFor("macbook")).toBe("laptop");
  // "pc" only as a word, not inside one.
  expect(iconFor("npc-laptop")).toBe("laptop");
});

const found = (id: string, extra: Partial<TailnetDevice> = {}): TailnetDevice => ({
  id,
  hostName: id,
  dnsName: `${id}.tail.ts.net`,
  os: "macOS",
  ip: "100.64.0.1",
  online: true,
  parallax: true,
  ...extra,
});

test("found devices update known ones and add new ones that answer", () => {
  const saved: SavedDevice[] = [
    { id: "mini", hostName: "mac-mini", ip: "100.64.0.9", os: "macOS", name: "Mac mini" },
  ];
  const { devices, changed } = mergeFound(saved, [
    found("mini", { hostName: "mac-mini", ip: "100.64.0.2" }),
    found("pc", { os: "windows", ip: "100.64.0.3" }),
    found("phone", { parallax: false }),
  ]);
  expect(changed).toBe(true);
  expect(devices).toEqual([
    { id: "mini", hostName: "mac-mini", ip: "100.64.0.2", os: "macOS", name: "Mac mini" },
    { id: "pc", hostName: "pc", ip: "100.64.0.3", os: "windows" },
  ]);
  // An offline device stays, as it was.
  expect(mergeFound(devices, [])).toEqual({ devices, changed: false });
});

test("plx-connect add runs the app's own copy with its Electron as Node, with checked arguments", () => {
  const mac = {
    platform: "darwin" as const,
    env: { SHELL: "/bin/zsh" },
    execPath: "/Applications/Parallax (Nightly).app/Contents/MacOS/Parallax (Nightly)",
    script:
      "/Applications/Parallax (Nightly).app/Contents/Resources/plx-connect/bin/plx-connect.mjs",
  };
  expect(addCommand("100.74.190.83", "ryan", "nightly", false, mac)).toEqual({
    file: "/bin/zsh",
    args: [
      "-lc",
      "ELECTRON_RUN_AS_NODE=1 exec '/Applications/Parallax (Nightly).app/Contents/MacOS/Parallax (Nightly)' '/Applications/Parallax (Nightly).app/Contents/Resources/plx-connect/bin/plx-connect.mjs' add 100.74.190.83 --channel nightly --user ryan",
    ],
  });
  const dev = {
    ...mac,
    env: { PLX_CONNECT_PATH: "/x/y z/plx-connect.mjs" },
    execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  };
  expect(addCommand("mac-mini", undefined, "stable", true, dev).args).toEqual([
    "-lc",
    "ELECTRON_RUN_AS_NODE=1 exec /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron '/x/y z/plx-connect.mjs' add mac-mini --channel stable --headless",
  ]);
  // A profile folder may hold `$`, a backtick, or `'`: literals keep them as they are.
  const windows = {
    platform: "win32" as const,
    env: {},
    execPath: "C:\\Users\\R$yan O'B`x\\AppData\\Local\\Programs\\parallax-desktop\\Parallax.exe",
    script:
      "C:\\Users\\R$yan O'B`x\\AppData\\Local\\Programs\\parallax-desktop\\resources\\plx-connect\\bin\\plx-connect.mjs",
  };
  expect(addCommand("100.1.2.3", undefined, "nightly", true, windows)).toEqual({
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $env:ELECTRON_RUN_AS_NODE = '1'; & 'C:\\Users\\R$yan O''B`x\\AppData\\Local\\Programs\\parallax-desktop\\Parallax.exe' 'C:\\Users\\R$yan O''B`x\\AppData\\Local\\Programs\\parallax-desktop\\resources\\plx-connect\\bin\\plx-connect.mjs' add 100.1.2.3 --channel nightly --headless | Out-Host; exit $LASTEXITCODE",
    ],
  });
  for (const bad of ["", "-oProxyCommand=x", "a b", "a;b", "$(x)"]) {
    expect(isDeviceAddress(bad), bad).toBe(false);
    expect(isSshUser(bad), bad).toBe(false);
  }
});

test("a device's dial failures name it", () => {
  expect(exitError(4, null, "", undefined, "darwin", "Mac mini").message).toBe(
    "Couldn't reach Mac mini over Tailscale. Check that it's on, and that Parallax Connect is on there.",
  );
  expect(exitError(0, null, "", undefined, "darwin", "Mac mini").message).toContain(
    "signed in to your Tailscale account",
  );
});

test("a LAN computer's dial failures name it, and a refusal isn't retried", () => {
  const unreachable = exitError(4, null, "", undefined, "darwin", undefined, "Studio");
  expect(unreachable.message).toContain("Couldn't reach Studio on this network");
  const refused = exitError(5, null, "", undefined, "darwin", undefined, "Studio");
  expect(refused.reason).toBe("refused");
  expect(refused.message).toBe(
    "Studio doesn't know this computer anymore. Remove it, then pair again with a new code.",
  );
});
