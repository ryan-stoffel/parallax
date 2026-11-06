import { expect, test } from "vite-plus/test";

import type { ConnectionState } from "../../preload/bridge";
import { plxdFix } from "./ConnectionSettings";

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
