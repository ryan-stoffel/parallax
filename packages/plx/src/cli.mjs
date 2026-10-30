// @ts-check
// plx: Parallax's command line. `plx connect` sets a computer up for Parallax Connect over
// Parallax Relay with one sign-in (0091), `plx doctor` checks Parallax on this computer, and
// `devices`, `add`, and `setup` keep the Tailscale path (0056) for the release that migrates it.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import * as connect from "./connect.mjs";
import { doctor } from "./doctor.mjs";
import { attach, VERSION } from "./plxd.mjs";
import { canOpenBrowser, clerkOf, codePage, openBrowser, signIn } from "./signin.mjs";
import { add, setup } from "./tailscale-setup.mjs";
import { listDevices, TAGGED } from "./tailscale.mjs";

const HELP = `plx: Parallax's command line.

Usage:
  plx connect                        Sign in, install plxd here, and connect this computer to
                                     your Parallax account
  plx connect add <ssh destination>  The same on another computer over SSH, signing in here
  plx connect approve                Approve a device waiting to sign in, or show a new code
                                     for one to type
  plx connect status                 Show the account, host id, relay state, and routes
  plx connect unlink                 Turn Parallax Relay off here, keeping the registration
  plx connect remove                 Sign in again and remove this computer from your account
  plx doctor                         Check Parallax on this computer, fix what it can, and hand
                                     the rest to claude or codex to look into and file an issue

Tailscale (until the release after this one):
  plx devices [--json]               List your devices on your tailnet
  plx add <device>                   Install Parallax on a device over SSH and connect it
  plx setup                          Install Parallax on this computer and connect it

Options:
  --channel stable|nightly   Which release to install (default: stable)
  --no-browser               Sign in on any device and paste the code here, rather than in a
                             browser on this computer. Automatic over SSH and without a display
  --user <user>              The SSH user for add (default: ssh's own)
  --port <port>              The SSH port for add
  --headless                 Install plxd alone, without the app, for the Tailscale add and setup
                             (Linux always gets plxd alone; connect always installs plxd alone)
  --dry-run                  Print the Tailscale steps and install script without installing
  --json                     Print devices as JSON
  --agent claude|codex       The agent doctor hands off to, without asking
  --model <model>            The model doctor's agent uses (default: the agent's own)
  -h, --help                 Show this help
  -v, --version              Show plx's version`;

const CONNECT_COMMANDS = new Set(["add", "approve", "status", "unlink", "remove"]);

/** Asks for a line on the terminal. @param {string} question */
async function prompt(question) {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

/**
 * What `plx connect` reaches: Clerk through the browser or a pasted code, plxd over `plxd
 * attach`, and the terminal.
 * @param {boolean} noBrowser
 * @returns {import("./connect.mjs").Deps}
 */
const realDeps = (noBrowser) => ({
  signIn: () =>
    signIn({
      clerk: clerkOf(process.env),
      browser: canOpenBrowser(process.env, process.platform, noBrowser),
      codePage: codePage(process.env),
      open: openBrowser,
      prompt,
    }),
  install: connect.install,
  plxd: (runner, os) => attach(runner.attach(os)),
  prompt,
  routes: () => connect.localRoutes(),
  // Unref'd: a wait for a setup code to lapse never keeps plx running after it's done.
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
});

/**
 * Runs the command line and resolves to the exit code.
 * @param {string[]} argv
 * @param {(noBrowser: boolean) => import("./connect.mjs").Deps} [deps] What `connect` reaches;
 *   tests pass fakes.
 */
export async function main(argv, deps = realDeps) {
  /** @type {ReturnType<typeof parse>} */
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = args;
  if (values.help) return print(HELP);
  if (values.version) return print(VERSION);
  const channel = values.channel ?? "stable";
  if (channel !== "stable" && channel !== "nightly") return usage(`--channel is stable or nightly, not ${channel}.`);
  if (values.port !== undefined && !/^\d+$/.test(values.port)) return usage(`--port is a number, not ${values.port}.`);
  /** @type {import("./tailscale-setup.mjs").Options} */
  const options = { channel, user: values.user, port: values.port, headless: values.headless, dryRun: values["dry-run"] };

  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      return print(HELP);
    case "connect": {
      const [sub, ...more] = rest;
      if (sub !== undefined && !CONNECT_COMMANDS.has(sub)) return usage(`Unknown connect command: ${sub}`);
      if (sub !== "add" && more.length > 0) return usage(`connect${sub ? ` ${sub}` : ""} takes no arguments.`);
      const [destination] = more;
      if (sub === "add" && (more.length !== 1 || !destination)) return usage("connect add takes one ssh destination.");
      // ssh would read a destination starting with - as an option.
      if (sub === "add" && !/^[^\s-]\S*$/.test(destination ?? "")) return usage(`${destination} isn't an ssh destination.`);
      const connectDeps = deps(values["no-browser"] === true);
      switch (sub) {
        case undefined:
          return connect.connect(options, connectDeps);
        case "add":
          return connect.add(destination ?? "", options, connectDeps);
        case "approve":
          return connect.approve(connectDeps);
        case "status":
          return connect.status(connectDeps);
        case "unlink":
          return connect.unlink(connectDeps);
        default:
          return connect.remove(connectDeps);
      }
    }
    case "devices":
      return devices(values.json === true);
    case "add":
      if (rest.length !== 1 || !rest[0]) return usage("add takes one device.");
      return add(rest[0], options);
    case "setup":
      return setup(options);
    case "doctor":
      if (values.agent !== undefined && values.agent !== "claude" && values.agent !== "codex") return usage(`--agent is claude or codex, not ${values.agent}.`);
      return doctor({ agent: values.agent, model: values.model });
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
      "no-browser": { type: "boolean" },
      user: { type: "string" },
      port: { type: "string" },
      headless: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      agent: { type: "string" },
      model: { type: "string" },
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

/** `plx devices`: a table, or `{ self, devices }` as JSON. @param {boolean} json */
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
