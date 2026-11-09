import { expect, test } from "vite-plus/test";

import type { ConnectionState } from "../../preload/bridge";
import { plxdFix } from "./ConnectionSettings";
import { computerStatus } from "./ConnectSettings";

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

test("a computer's row says one thing, and offers the one thing it needs", () => {
  const up = connected(APP);
  const down = failed({ message: "The relay refused the stream." });
  // Connected, with how it's reached.
  expect(computerStatus({ kind: "account", state: up, route: "192.168.1.20:7341" })).toEqual({
    tone: "on",
    text: "Connected · Over your network",
  });
  expect(computerStatus({ kind: "account", state: up, route: "relay:abc" }).text).toBe(
    "Connected · Over Parallax Relay",
  );
  expect(computerStatus({ kind: "lan", state: up }).text).toBe("Connected · Same network");
  expect(computerStatus({ kind: "ssh", state: up, destination: "ryan@devbox" }).text).toBe(
    "Connected · SSH · ryan@devbox",
  );
  // Off in this app, whatever else is true of it.
  expect(computerStatus({ kind: "tailnet", enabled: false, state: up })).toEqual({
    tone: "off",
    text: "Off",
  });
  // An account computer still joining: its code, a code to compare, or a request to send again.
  expect(computerStatus({ kind: "account", access: { step: "needsCode" } })).toEqual({
    tone: "warn",
    text: "Needs its setup code",
    need: "code",
  });
  expect(computerStatus({ kind: "account", access: { step: "needsCode", offline: true } })).toEqual(
    { tone: "off", text: "Waiting for it to come online", need: "code" },
  );
  expect(
    computerStatus({ kind: "account", access: { step: "compare", code: "482913" } }),
  ).toMatchObject({ text: "Allow it if it shows 482 913", need: "compare" });
  expect(
    computerStatus({ kind: "account", access: { step: "ask", why: "Denied on studio" } }),
  ).toMatchObject({ text: "Denied on studio", need: "askAgain" });
  expect(computerStatus({ kind: "account", state: down, access: { step: "offline" } })).toEqual({
    tone: "off",
    text: "Offline",
  });
  // An SSH host: no plxd, an older one, or a login to give.
  const ssh = { kind: "ssh", destination: "ryan@devbox" } as const;
  expect(computerStatus({ ...ssh, state: down, fix: "install" })).toMatchObject({
    text: "plxd isn't installed · SSH · ryan@devbox",
    need: "install",
  });
  expect(computerStatus({ ...ssh, state: up, fix: "update" })).toMatchObject({
    tone: "warn",
    need: "update",
  });
  expect(computerStatus({ ...ssh, state: down, canSignIn: true })).toMatchObject({
    text: "Needs you to sign in · SSH · ryan@devbox",
    need: "signIn",
  });
  // A Tailscale device the account can't reach yet.
  expect(computerStatus({ kind: "tailnet", state: up, tailnetOnly: true })).toMatchObject({
    need: "reach",
  });
  // Anything else that failed says so, with why at hand, and asks for nothing.
  expect(computerStatus({ ...ssh, state: down })).toEqual({
    tone: "error",
    text: "Disconnected · SSH · ryan@devbox",
    detail: "The relay refused the stream.",
  });
  expect(computerStatus({ kind: "account" })).toEqual({ tone: "off", text: "Connecting…" });
});
