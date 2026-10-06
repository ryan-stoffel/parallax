// @ts-check
// This user's tailnet devices, from `tailscale status --json` (0056).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

/** Why no devices are listed when this node is tagged. */
export const TAGGED =
  "This computer is tagged in Tailscale, so it belongs to no user and has no devices of yours to list. Untag it to use Parallax Connect.";

/** The port plxd listens on, on its Tailscale address, while Parallax Connect is on (0056). */
export const PLXD_PORT = 7340;

/** Where the Tailscale CLI is when it isn't on PATH. */
const TAILSCALE_PATHS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

/**
 * @typedef {object} Device
 * @property {string} id Tailscale's stable node ID.
 * @property {string} name The device's host name.
 * @property {string} dnsName Its MagicDNS name, without the trailing dot.
 * @property {string} os As Tailscale reports it: `macOS`, `linux`, `windows`, ...
 * @property {string | undefined} ip Its first Tailscale IPv4 address.
 * @property {boolean} online
 * @property {boolean} parallax plxd answers on its port 7340. Probed only while online.
 * @property {boolean} tagged It has Tailscale tags. Only this node can be: tagged peers are left out.
 */

/**
 * @typedef {object} TailnetNode The fields plx-connect reads from a node in `tailscale status --json`.
 * @property {string} [ID]
 * @property {string} [HostName]
 * @property {string} [DNSName]
 * @property {string} [OS]
 * @property {string[] | null} [TailscaleIPs]
 * @property {boolean} [Online]
 * @property {number} [UserID]
 * @property {string[] | null} [Tags]
 */

/**
 * @typedef {object} Status
 * @property {TailnetNode} [Self]
 * @property {Record<string, TailnetNode> | null} [Peer]
 */

/**
 * This node and the peers that belong to its own Tailscale user, from `tailscale status --json`.
 * Nodes shared from another tailnet have another `UserID`, so they're left out. Tagged nodes are
 * left out too: they all share one "tagged-devices" user, so their `UserID` can match. A tagged
 * node has no user of its own, so when this node is tagged, no peer is listed.
 * `parallax` is false here; {@link listDevices} probes it.
 * @param {Status} status
 * @returns {{ self: Device, devices: Device[] }}
 */
export function parseStatus(status) {
  const self = status.Self;
  if (!self || self.UserID === undefined) throw new Error("Tailscale isn't logged in on this computer.");
  const devices = Object.values(status.Peer ?? {})
    .filter((peer) => !isTagged(self) && !isTagged(peer) && peer.UserID === self.UserID)
    .map(toDevice)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { self: { ...toDevice(self), online: true }, devices };
}

/** @param {TailnetNode} node */
const isTagged = (node) => (node.Tags ?? []).length > 0;

/** @param {TailnetNode} node @returns {Device} */
function toDevice(node) {
  return {
    id: node.ID ?? "",
    name: node.HostName ?? "",
    dnsName: (node.DNSName ?? "").replace(/\.$/, ""),
    os: node.OS ?? "",
    ip: (node.TailscaleIPs ?? []).find((ip) => net.isIPv4(ip)),
    online: node.Online === true,
    parallax: false,
    tagged: isTagged(node),
  };
}

/** The Tailscale CLI: `tailscale` on PATH, else the first of the usual install paths that exists. */
export async function findTailscale() {
  const name = process.platform === "win32" ? "tailscale.exe" : "tailscale";
  const ok = await new Promise((resolve) =>
    execFile(name, ["version"], { timeout: 5000 }, (error) => resolve(!error)),
  );
  if (ok) return name;
  const found = TAILSCALE_PATHS.find((path) => existsSync(path));
  if (!found) throw new Error("Tailscale isn't installed on this computer. Get it at https://tailscale.com/download.");
  return found;
}

/** Runs `tailscale status --json` and parses its answer. */
export async function readStatus() {
  const tailscale = await findTailscale();
  /** @type {string} */
  const stdout = await new Promise((resolve, reject) =>
    execFile(tailscale, ["status", "--json"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (error, out, err) => {
      // `status` exits 1 while Tailscale is stopped or logged out, but still prints the JSON.
      if (out.trim().startsWith("{")) resolve(out);
      else reject(new Error(`tailscale status failed: ${(err || error?.message || "").trim()}`));
    }),
  );
  return /** @type {Status} */ (JSON.parse(stdout));
}

/**
 * Whether `host:port` accepts a TCP connection within `timeoutMs`.
 * @param {string} host
 * @param {number} [port]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probe(host, port = PLXD_PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (/** @type {boolean} */ answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** This node and its user's other devices, with `parallax` probed on each that's online. */
export async function listDevices() {
  const { self, devices } = parseStatus(await readStatus());
  await Promise.all(
    [self, ...devices].map(async (device) => {
      if (device.online && device.ip) device.parallax = await probe(device.ip);
    }),
  );
  return { self, devices };
}

/**
 * The device `query` names: its host name, MagicDNS name (whole or first label), or a Tailscale
 * IP, case-insensitively. Undefined when none matches.
 * @param {Device[]} devices
 * @param {string} query
 */
export function findDevice(devices, query) {
  const want = query.toLowerCase().replace(/\.$/, "");
  return devices.find(
    (device) =>
      device.name.toLowerCase() === want ||
      device.dnsName.toLowerCase() === want ||
      device.dnsName.split(".")[0]?.toLowerCase() === want ||
      device.ip === want,
  );
}
