import { expect, test } from "vite-plus/test";

import type { ConnectionState } from "../../preload/bridge";
import { plxdFix } from "./ConnectionSettings";
import { computerStatus } from "./ConnectSettings";
import { routeKind } from "./Routes";

const APP = "2610.10903.13317-nightly";
const connected = (plxd: string) => ({ status: "connected", plxd }) as ConnectionState;
const failed = (error: object) =>
  ({
    status: "failed",
    retrying: false,
    error: { reason: "exited", message: "", ...error },
  }) as ConnectionState;

test("offers to install plxd where none was found, and to update an older one", () => {
  expect(plxdFix(failed({ reason: "notFound", exitCode: 127 }), APP)).toBe("install");
  expect(plxdFix(connected("2610.10704.12709-nightly"), APP)).toBe("update");
  expect(plxdFix(connected("2609.13017.14512"), APP)).toBe("update");
  // A cargo build's placeholder.
  expect(plxdFix(connected("0.1.0"), APP)).toBe("update");
  // An older plxd that refused the handshake.
  expect(plxdFix(failed({ reason: "incompatibleProtocol", plxd: "2610.10704.12709" }), APP)).toBe(
    "update",
  );
  // A nightly is older than the standard release of the same commit.
  expect(plxdFix(connected("2610.10903.13317-nightly"), "2610.10903.13317")).toBe("update");
});

test("offers nothing for a plxd as new as the app, another failure, or a development build", () => {
  expect(plxdFix(connected(APP), APP)).toBeUndefined();
  expect(plxdFix(connected("2610.10903.13318-nightly"), APP)).toBeUndefined();
  expect(plxdFix(connected("2610.10903.13317"), APP)).toBeUndefined();
  expect(plxdFix(failed({ exitCode: 255 }), APP)).toBeUndefined();
  expect(plxdFix({ status: "connecting" }, APP)).toBeUndefined();
  expect(plxdFix(failed({ reason: "notFound", exitCode: 127 }), "0.0.0-local")).toBeUndefined();
  expect(plxdFix(connected("0.1.0"), undefined)).toBeUndefined();
});

test("a computer's card says how it's connected, and under that the one thing wrong with it", () => {
  const up = connected(APP);
  const down = failed({ message: "The relay refused the stream." });
  // Connected, with how it's reached.
  expect(computerStatus({ kind: "account", state: up, route: "192.168.1.20:7341" })).toEqual({
    tone: "on",
    text: "Connected · Over your network",
  });
  expect(computerStatus({ kind: "account", state: up, route: "relay:abc" }).text).toBe(
    "Connected · Over Parallax Connect",
  );
  expect(computerStatus({ kind: "lan", state: up }).text).toBe("Connected · Same network");
  expect(computerStatus({ kind: "ssh", state: up, destination: "ryan@devbox" }).text).toBe(
    "Connected · SSH · ryan@devbox",
  );
  // Off in this app, whatever else is true of it.
  expect(computerStatus({ kind: "tailnet", enabled: false, state: up })).toEqual({
    tone: "off",
    text: "Off, with no connection or threads here",
  });
  // An account computer still joining can't be used until its code is in, a code is compared, or
  // a request is sent again: a red line with that one action.
  expect(computerStatus({ kind: "account", access: { step: "needsCode" } })).toEqual({
    tone: "error",
    text: "Not connected",
    problem: "Needs its setup code",
    need: "code",
  });
  expect(
    computerStatus({ kind: "account", access: { step: "compare", code: "482913" } }),
  ).toMatchObject({ tone: "error", problem: "Allow it if it shows 482 913", need: "compare" });
  expect(
    computerStatus({ kind: "account", access: { step: "ask", why: "Denied on studio" } }),
  ).toMatchObject({ tone: "error", problem: "Denied on studio", need: "askAgain" });
  // One that only waits says so quietly, and still takes its code.
  expect(computerStatus({ kind: "account", access: { step: "needsCode", offline: true } })).toEqual(
    { tone: "off", text: "Not connected", problem: "Waiting for it to come online", need: "code" },
  );
  expect(computerStatus({ kind: "account", state: down, access: { step: "offline" } })).toEqual({
    tone: "off",
    text: "Offline",
  });
  // An SSH host: no plxd or a login to give, in red, and an older plxd that still works, in amber.
  const ssh = { kind: "ssh", destination: "ryan@devbox" } as const;
  expect(computerStatus({ ...ssh, state: down, fix: "install" })).toEqual({
    tone: "error",
    text: "Disconnected · SSH · ryan@devbox",
    problem: "plxd isn't installed",
    need: "install",
  });
  expect(computerStatus({ ...ssh, state: up, fix: "update" })).toEqual({
    tone: "warn",
    text: "Connected · SSH · ryan@devbox",
    problem: "plxd needs updating",
    need: "update",
  });
  expect(computerStatus({ ...ssh, state: down, fix: "update" }).tone).toBe("error");
  expect(computerStatus({ ...ssh, state: down, canSignIn: true })).toMatchObject({
    tone: "error",
    problem: "Needs you to sign in",
    need: "signIn",
  });
  // A Tailscale device the account can't reach yet works, and wants attention.
  expect(computerStatus({ kind: "tailnet", state: up, tailnetOnly: true })).toEqual({
    tone: "warn",
    text: "Connected · Tailscale",
    problem: "Only on Tailscale",
    need: "reach",
  });
  // Anything else that failed says why in full, and asks for nothing.
  expect(computerStatus({ ...ssh, state: down })).toEqual({
    tone: "error",
    text: "Disconnected · SSH · ryan@devbox",
    problem: "The relay refused the stream.",
  });
  expect(computerStatus({ kind: "account" })).toEqual({ tone: "off", text: "Connecting…" });
});

test("a route is named for the kind of address it is", () => {
  expect(routeKind("relay:abc")).toBe("Parallax Connect");
  expect(routeKind("192.168.1.20:7341")).toBe("Same network");
  expect(routeKind("10.0.0.12")).toBe("Same network");
  expect(routeKind("studio.local:7341")).toBe("Same network");
  expect(routeKind("100.101.12.9:7341")).toBe("Tailscale");
  expect(routeKind("studio.tail1234.ts.net:7341")).toBe("Tailscale");
  expect(routeKind("[fd7a:115c:a1e0::1]:7341")).toBe("Tailscale");
  // 100.x outside Tailscale's range, a public name, and a private IPv6 address.
  expect(routeKind("100.1.2.3:7341")).toBe("Direct");
  expect(routeKind("box.example.com:7400")).toBe("Direct");
  expect(routeKind("[fd00::12]:7341")).toBe("Same network");
});
