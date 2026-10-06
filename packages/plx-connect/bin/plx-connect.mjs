#!/usr/bin/env node
// @ts-check
// plx-connect: set up Parallax and Parallax Connect on your Tailscale devices (0056).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { add, setup } from "../src/connect.mjs";
import { listDevices, TAGGED } from "../src/tailscale.mjs";

const HELP = `plx-connect: set up Parallax and Parallax Connect on your Tailscale devices.

Usage:
  plx-connect                    Pick an online device that isn't on Parallax yet, and add it
  plx-connect devices [--json]   List your devices on your tailnet
  plx-connect add <device>       Install Parallax on a device over SSH and connect it
  plx-connect setup              Install Parallax on this computer and connect it

<device> is a host name, MagicDNS name, or Tailscale IP.

Options:
  --channel stable|nightly   Which release to install (default: stable)
  --user <user>              The SSH user for add (default: ssh's own)
  --port <port>              The SSH port for add
  --dry-run                  Print the steps and install script without installing anything
  --json                     Print devices as JSON
  -h, --help                 Show this help
  -v, --version              Show plx-connect's version

Needs Tailscale on both computers, and SSH on the device for add.`;

/** @typedef {import("../src/tailscale.mjs").Device} Device */

/** Runs the command line and resolves to the exit code. @param {string[]} argv */
async function main(argv) {
  /** @type {ReturnType<typeof parse>} */
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help) return print(HELP);
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return print(pkg.version);
  }
  const channel = values.channel ?? "stable";
  if (channel !== "stable" && channel !== "nightly") return usage(`--channel is stable or nightly, not ${channel}.`);
  if (values.port !== undefined && !/^\d+$/.test(values.port)) return usage(`--port is a number, not ${values.port}.`);
  /** @type {import("../src/connect.mjs").Options} */
  const options = { channel, user: values.user, port: values.port, dryRun: values["dry-run"] };

  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      if (!process.stdin.isTTY) return print(HELP);
      return pick(options);
    case "devices":
      return devices(values.json === true);
    case "add":
      if (rest.length !== 1 || !rest[0]) return usage("add takes one device.");
      return add(rest[0], options);
    case "setup":
      return setup(options);
    default:
      return usage(`Unknown command: ${command}`);
  }
}

/** @param {string[]} argv */
function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channel: { type: "string" },
      user: { type: "string" },
      port: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/** @param {string} text */
function print(text) {
  console.log(text);
  return 0;
}

/** @param {string} message */
function usage(message) {
  console.error(`${message}\n\n${HELP}`);
  return 2;
}

/** `plx-connect devices`: a table, or `{ self, devices }` as JSON. @param {boolean} json */
async function devices(json) {
  const tailnet = await listDevices();
  if (json) return print(JSON.stringify(tailnet, null, 2));
  const rows = [
    ["NAME", "DNS NAME", "OS", "IP", "ONLINE", "PARALLAX"],
    ...[{ ...tailnet.self, name: `${tailnet.self.name} (this computer)` }, ...tailnet.devices].map((d) => [
      d.name,
      d.dnsName,
      d.os,
      d.ip ?? "-",
      d.online ? "yes" : "no",
      d.parallax ? "yes" : "no",
    ]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
  if (tailnet.self.tagged) console.log(`\n${TAGGED}`);
  return 0;
}

/**
 * `plx-connect` alone: lists the online devices not on Parallax yet, asks for one, and adds it.
 * @param {import("../src/connect.mjs").Options} options
 */
async function pick(options) {
  const tailnet = await listDevices();
  if (tailnet.self.tagged) return print(TAGGED);
  const candidates = tailnet.devices.filter((d) => d.online && !d.parallax);
  if (candidates.length === 0) return print("Every online device on your tailnet is already on Parallax.");
  console.log("Online devices not on Parallax yet:");
  candidates.forEach((d, index) => console.log(`  ${index + 1}. ${d.name} (${d.os}, ${d.ip ?? d.dnsName})`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("Add which one? (number) ")).trim();
  prompt.close();
  const device = candidates[Number(answer) - 1];
  if (!/^\d+$/.test(answer) || !device) return usage(`${answer || "Nothing"} isn't one of the numbers.`);
  return add(device.ip ?? device.dnsName, options);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
