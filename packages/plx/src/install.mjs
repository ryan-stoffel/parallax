// @ts-check
// What the Tailscale commands and `plx connect` share: steps that print a line as they start and
// a ✓ or ✗ line as they end, and finding a computer's OS and the release to install there.

import { parseDetails, parseUname, POSIX_DETAILS, UNAME_COMMAND, WINDOWS_DETAILS } from "./detect.mjs";
import { appName, fetchReleases, pickAsset, pickRelease, withSha256 } from "./releases.mjs";

/** @typedef {import("./releases.mjs").Channel} Channel */
/** @typedef {import("./releases.mjs").Os} Os */
/** @typedef {import("./detect.mjs").Target} Target */
/** @typedef {import("./run.mjs").Runner} Runner */

/** A step failed. Its ✗ line is already printed. */
export class StepFailed extends Error {}

/**
 * Prints `title`, runs `run`, then prints its ✓ line, or ✗ with the error's message.
 * @template T
 * @param {string} title
 * @param {() => Promise<[string, T]>} run Resolves to the ✓ line's text and the step's value.
 * @returns {Promise<T>}
 */
export async function step(title, run) {
  console.log(`→ ${title}`);
  try {
    const [done, value] = await run();
    console.log(`✓ ${done}`);
    return value;
  } catch (error) {
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    throw new StepFailed();
  }
}

/** This computer's OS as releases name it, or undefined where Parallax doesn't run. @returns {Os | undefined} */
export const localOs = () =>
  process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : undefined;

/** The target's OS and details, with the runner's shell. @param {Runner} runner @param {Os} os */
export async function readDetails(runner, os) {
  const windows = os === "windows";
  const { code, stdout } = await runner.script(windows ? "powershell" : "sh", windows ? WINDOWS_DETAILS : POSIX_DETAILS, true);
  if (code !== 0) throw new Error(`Couldn't read the computer's details (exit ${code}).`);
  return parseDetails(os, stdout);
}

/**
 * Connects to `destination` over ssh, then finds its OS and details, as two steps.
 * @param {Runner} runner The ssh runner for `destination`.
 * @param {string} name What to call the computer.
 * @param {string} destination
 * @param {string} instead The command to run there when ssh can't connect.
 */
export async function sshTarget(runner, name, destination, instead) {
  const os = await step(`Connecting to ${name} (${destination}) over SSH`, async () => {
    const { code, stdout } = await runner.command(UNAME_COMMAND);
    if (code === 255) {
      throw new Error(
        `SSH couldn't connect to ${destination}. Turn on Remote Login (macOS), OpenSSH Server (Windows), or sshd (Linux) there, or run ${instead} on it.`,
      );
    }
    return [`Connected to ${name}`, parseUname(stdout, code)];
  });
  return step(`Finding ${name}'s OS`, async () => {
    const target = await readDetails(runner, os);
    return [`${target.label}: ${target.version} (${target.arch})`, target];
  });
}

/** The product a plxd-only install, or else the app, is called. @param {boolean} plxdOnly @param {Channel} channel */
export const product = (plxdOnly, channel) => (plxdOnly ? "plxd" : appName(channel));

/**
 * The newest release's asset for `target`, with the SHA-256 the script checks it against.
 * @param {Target} target
 * @param {Channel} channel
 * @param {boolean} plxdOnly
 */
export function findInstaller(target, channel, plxdOnly) {
  return step(`Finding the newest ${channel} release`, async () => {
    const found = pickAsset(pickRelease(await fetchReleases(), channel), target.os, target.arch, plxdOnly);
    const installer = await withSha256(found);
    return [`${product(plxdOnly, channel)} ${installer.version}: ${installer.name}`, installer];
  });
}
