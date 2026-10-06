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

test("plx-connect add runs in the login shell, or PowerShell, with checked arguments", () => {
  const mac = { platform: "darwin" as const, env: { SHELL: "/bin/zsh" } };
  expect(addCommand("100.74.190.83", "ryan", "nightly", mac)).toEqual({
    file: "/bin/zsh",
    args: [
      "-lc",
      'PATH="$HOME/.local/bin:$PATH" exec plx-connect add 100.74.190.83 --channel nightly --user ryan',
    ],
  });
  const dev = { platform: "darwin" as const, env: { PLX_CONNECT_PATH: "/x/y z/plx-connect.mjs" } };
  expect(addCommand("mac-mini", undefined, "stable", dev).args).toEqual([
    "-lc",
    `PATH="$HOME/.local/bin:$PATH" exec node '/x/y z/plx-connect.mjs' add mac-mini --channel stable`,
  ]);
  expect(addCommand("100.1.2.3", undefined, "nightly", { platform: "win32", env: {} })).toEqual({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command", "plx-connect add 100.1.2.3 --channel nightly"],
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
