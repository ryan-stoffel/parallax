// @ts-check
// `add` and `setup`: install Parallax on a computer and connect it (0056). Each step prints a
// line as it starts, then a ✓ or ✗ line as it ends.

import net from "node:net";

import { parseDetails, parseUname, POSIX_DETAILS, UNAME_COMMAND, WINDOWS_DETAILS } from "./detect.mjs";
import { appName, fetchReleases, pickAsset, pickRelease } from "./releases.mjs";
import { localRunner, sshArgs, sshRunner } from "./run.mjs";
import { installScript } from "./scripts.mjs";
import { findDevice, parseStatus, PLXD_PORT, probe, readStatus, TAGGED } from "./tailscale.mjs";

/** @typedef {import("./releases.mjs").Channel} Channel */
/** @typedef {import("./releases.mjs").Os} Os */
/** @typedef {import("./detect.mjs").Target} Target */
/** @typedef {import("./run.mjs").Runner} Runner */

/**
 * @typedef {object} Options
 * @property {Channel} channel
 * @property {string} [user] The SSH user, else ssh's own default.
 * @property {string} [port] The SSH port.
 * @property {boolean} [dryRun] Print the steps and the install script without running ssh or
 *   installing anything. Only the release list is fetched.
 */

/** A step failed. Its ✗ line is already printed. */
export class StepFailed extends Error {}

/**
 * Prints `title`, runs `run`, then prints its ✓ line, or ✗ with the error's message.
 * @template T
 * @param {string} title
 * @param {() => Promise<[string, T]>} run Resolves to the ✓ line's text and the step's value.
 * @returns {Promise<T>}
 */
async function step(title, run) {
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

/** The target's OS and details, with the runner's shell. @param {Runner} runner @param {Os} os */
async function readDetails(runner, os) {
  const windows = os === "windows";
  const { code, stdout } = await runner.script(windows ? "powershell" : "sh", windows ? WINDOWS_DETAILS : POSIX_DETAILS, true);
  if (code !== 0) throw new Error(`Couldn't read the computer's details (exit ${code}).`);
  return parseDetails(os, stdout);
}

/** The newest release of `channel` for `target`. @param {Channel} channel @param {Target} target */
function findInstaller(channel, target) {
  return step(`Finding the newest ${channel} release`, async () => {
    const installer = pickAsset(pickRelease(await fetchReleases(), channel), target.os, target.arch);
    return [`${appName(channel)} ${installer.version}: ${installer.name}`, installer];
  });
}

/**
 * Installs on `target` through `runner`, prints the script in a dry run, then waits for plxd to
 * answer on `ip`.
 * @param {Runner} runner
 * @param {Target} target
 * @param {string} name
 * @param {string | undefined} ip
 * @param {Options} options
 */
async function install(runner, target, name, ip, options) {
  const installer = await findInstaller(options.channel, target);
  const script = installScript(target.os, installer, options.channel);
  if (options.dryRun) {
    console.log(`→ Installing ${appName(options.channel)} on ${name} with this ${target.os === "windows" ? "PowerShell" : "sh"} script (dry run, not run):`);
    for (const line of script.trimEnd().split("\n")) console.log(`  ${line}`);
    console.log(`→ Would wait up to 60 s for ${ip ?? name}:${PLXD_PORT} to answer.`);
    return;
  }
  await step(`Installing ${appName(options.channel)} on ${name}`, async () => {
    const { code } = await runner.script(target.os === "windows" ? "powershell" : "sh", script, false);
    if (code !== 0) throw new Error(`The install failed on ${name} (exit ${code}).`);
    return [`Installed ${appName(options.channel)} ${installer.version} and turned on Parallax Connect`, undefined];
  });
  await step(`Waiting for ${name} to answer on port ${PLXD_PORT}`, async () => {
    if (!ip) throw new Error("Tailscale gave this computer no IPv4 address to check.");
    if (!(await waitForPort(ip, 60_000))) {
      throw new Error(
        `${name} didn't answer on ${ip}:${PLXD_PORT} within 60 s. Check that Tailscale is on there and that no firewall blocks TCP ${PLXD_PORT}.`,
      );
    }
    return [`${name} is connected to Parallax.`, undefined];
  });
}

/** Whether `ip:7340` accepts a connection before `timeoutMs` passes. @param {string} ip @param {number} timeoutMs */
async function waitForPort(ip, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(ip)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Where `add` connects for `query`: the Tailscale IPv4 of the device it names, or `query` itself
 * when it names none but is an IP. Throws a message for people otherwise.
 * @param {string} query
 */
export async function resolveTarget(query) {
  /** @type {ReturnType<typeof parseStatus> | undefined} */
  let tailnet;
  try {
    tailnet = parseStatus(await readStatus());
  } catch (error) {
    if (!net.isIP(query)) throw error;
  }
  const device = tailnet && findDevice(tailnet.devices, query);
  if (device?.ip) return { name: device.name, ip: device.ip, online: device.online };
  if (tailnet && findDevice([tailnet.self], query)) throw new Error("That's this computer. Run plx-connect setup instead.");
  if (tailnet?.self.tagged) throw new Error(TAGGED);
  if (net.isIP(query)) return { name: query, ip: query, online: true };
  throw new Error(`No device named ${query} in your tailnet. Run plx-connect devices to see them.`);
}

/**
 * `plx-connect add`: installs Parallax on the device `query` names over ssh, turns on Parallax
 * Connect there, and waits for it to answer. Resolves to the exit code.
 * @param {string} query
 * @param {Options} options
 */
export async function add(query, options) {
  /** @type {Awaited<ReturnType<typeof resolveTarget>>} */
  let device;
  try {
    device = await resolveTarget(query);
  } catch (error) {
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { name, ip } = device;
  if (!device.online) console.log(`! Tailscale says ${name} is offline. Trying anyway.`);
  const destination = options.user ? `${options.user}@${ip}` : ip;

  if (options.dryRun) return dryRunAdd(query, name, ip, destination, options);

  const runner = sshRunner(destination, { port: options.port });
  try {
    const os = await step(`Connecting to ${name} (${destination}) over SSH`, async () => {
      const { code, stdout } = await runner.command(UNAME_COMMAND);
      if (code === 255) {
        throw new Error(
          `SSH couldn't connect to ${destination}. Turn on Remote Login (macOS), OpenSSH Server (Windows), or sshd (Linux) there, or run plx-connect setup on it.`,
        );
      }
      return [`Connected to ${name}`, parseUname(stdout, code)];
    });
    const target = await step(`Finding ${name}'s OS`, async () => {
      const target = await readDetails(runner, os);
      return [`${target.label}: ${target.version} (${target.arch})`, target];
    });
    await install(runner, target, name, ip, options);
    return 0;
  } catch (error) {
    if (error instanceof StepFailed) return 1;
    throw error;
  } finally {
    runner.close();
  }
}

/**
 * A dry run of `add`: prints the ssh command and the install script for the OS Tailscale reports,
 * with the arch Parallax builds most for it, since finding the real one takes ssh.
 * @param {string} query
 * @param {string} name
 * @param {string} ip
 * @param {string} destination
 * @param {Options} options
 */
async function dryRunAdd(query, name, ip, destination, options) {
  const reported = await readStatus()
    .then((status) => findDevice(parseStatus(status).devices, query)?.os)
    .catch(() => undefined);
  /** @type {Os} */
  const os = reported === "macOS" ? "macos" : reported === "windows" ? "windows" : "linux";
  /** @type {Target} */
  const target = { os, arch: os === "macos" ? "arm64" : "x64", label: name, version: os };
  const ssh = sshArgs(destination, { port: options.port, controlDir: "<tmp>" }, [UNAME_COMMAND]);
  console.log(`→ Would connect with: ssh ${ssh.map((arg) => (/[\s'"*<>|&;]/.test(arg) ? `'${arg}'` : arg)).join(" ")}`);
  console.log(`→ Assuming ${target.os} ${target.arch} from Tailscale (a real run asks the computer).`);
  try {
    await install(localRunner(), target, name, ip, options);
    return 0;
  } catch (error) {
    if (error instanceof StepFailed) return 1;
    throw error;
  }
}

/**
 * `plx-connect setup`: the same install on this computer, without ssh, for a device that can't
 * take SSH. Resolves to the exit code.
 * @param {Options} options
 */
export async function setup(options) {
  /** @type {Os | undefined} */
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : undefined;
  const runner = localRunner();
  try {
    if (!os) throw new Error(`Parallax doesn't run on ${process.platform}.`);
    const self = await step("Checking Tailscale on this computer", async () => {
      const { self } = parseStatus(await readStatus());
      if (!self.ip) throw new Error("Tailscale has no IPv4 address for this computer. Is it connected?");
      return [`This computer is ${self.name} (${self.ip}) on your tailnet`, self];
    });
    const target = await step("Finding this computer's OS", async () => {
      const target = await readDetails(runner, os);
      return [`${target.label}: ${target.version} (${target.arch})`, target];
    });
    await install(runner, target, self.name, self.ip, options);
    return 0;
  } catch (error) {
    if (error instanceof StepFailed) return 1;
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
