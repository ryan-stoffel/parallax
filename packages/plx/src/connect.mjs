// @ts-check
// `plx connect` and its subcommands (0091): set up a computer for Parallax Connect over Parallax
// Relay with one sign-in, and manage it after. Everything plxd does here goes over `plxd attach`,
// its trusted local connection, or over ssh for `connect add`.

import https from "node:https";

import { findInstaller, localOs, sshTarget, step, StepFailed } from "./install.mjs";
import { localRunner, sshRunner } from "./run.mjs";
import { installScript, REMOTE_PORT } from "./scripts.mjs";

/** @typedef {import("./plxd.mjs").Plxd} Plxd */
/** @typedef {import("./releases.mjs").Channel} Channel */
/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./releases.mjs").Os} Os */
/** @typedef {import("./detect.mjs").Target} Target */

/**
 * What the commands reach outside this process, so tests can fake each.
 * @typedef {object} Deps
 * @property {() => Promise<string>} signIn Signs in and resolves to a Clerk access token.
 * @property {(runner: Runner, os: Os) => Promise<Target>} details Finds the OS details of the
 *   computer `runner` reaches.
 * @property {(runner: Runner, target: Target, name: string, channel: Channel) => Promise<void>} install
 *   Installs plxd with its login service on `target` through `runner`.
 * @property {(runner: Runner, os: Os) => Promise<Plxd>} plxd Opens `plxd attach` through
 *   `runner` on an `os` computer.
 * @property {(question: string) => Promise<string>} prompt Asks the user for a line.
 * @property {() => Promise<string[]>} routes This computer's routes, from its listener.
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * @typedef {object} Options
 * @property {Channel} channel
 * @property {string} [user] The SSH user for `add`.
 * @property {string} [port] The SSH port for `add`.
 */

/** How long setup waits for plxd to reach the relay and listen. */
const ONLINE_TIMEOUT_MS = 60_000;

/**
 * Runs `body` with a step failure's ✗ already printed as exit 1, and any other error printed.
 * @param {() => Promise<number | void>} body
 * @returns {Promise<number>}
 */
async function exitCode(body) {
  try {
    return (await body()) ?? 0;
  } catch (error) {
    if (!(error instanceof StepFailed)) console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * Runs `body` with plxd open through `runner` on an `os` computer, this one by default, closing
 * it after.
 * @template T
 * @param {Deps} deps
 * @param {(plxd: Plxd) => Promise<T>} body
 * @param {Runner} [runner]
 * @param {Os} [os]
 */
async function withPlxd(deps, body, runner = localRunner(), os = localOs() ?? "linux") {
  const plxd = await deps.plxd(runner, os);
  try {
    return await body(plxd);
  } finally {
    plxd.close();
  }
}

/**
 * `plx connect`: signs in, installs plxd with its login service here, and links it. Resolves to
 * the exit code.
 * @param {Options} options
 * @param {Deps} deps
 */
export function connect(options, deps) {
  const runner = localRunner();
  return exitCode(async () => {
    const os = localOs();
    if (!os) throw new Error(`Parallax doesn't run on ${process.platform}.`);
    const token = await step("Signing in to Parallax", async () => [`Signed in to Parallax Connect`, await deps.signIn()]);
    const target = await step("Finding this computer's OS", async () => {
      const target = await deps.details(runner, os);
      return [`${target.label}: ${target.version} (${target.arch})`, target];
    });
    await deps.install(runner, target, "this computer", options.channel);
    await withPlxd(
      deps,
      async (plxd) => {
        await link(plxd, token, deps);
        await approveNewDevice(plxd, deps);
      },
      runner,
      os,
    );
  });
}

/**
 * `plx connect add <ssh destination>`: the same setup on another computer over ssh, with the
 * sign-in shown here. The only path that uses ssh, and only once.
 * @param {string} destination `[user@]host`, as ssh takes it.
 * @param {Options} options
 * @param {Deps} deps
 */
export function add(destination, options, deps) {
  const target = options.user ? `${options.user}@${destination}` : destination;
  const runner = sshRunner(target, { port: options.port });
  return exitCode(async () => {
    const token = await step("Signing in to Parallax", async () => [`Signed in to Parallax Connect`, await deps.signIn()]);
    const details = await sshTarget(runner, destination, target, "npx plx-cli connect");
    await deps.install(runner, details, destination, options.channel);
    await withPlxd(
      deps,
      async (plxd) => {
        await link(plxd, token, deps);
        await approveNewDevice(plxd, deps);
      },
      runner,
      details.os,
    );
  }).finally(() => runner.close());
}

/**
 * Installs plxd alone, with its login service, through `runner` (0072).
 * @param {Runner} runner
 * @param {Target} target
 * @param {string} name
 * @param {Channel} channel
 */
export async function install(runner, target, name, channel) {
  const installer = await findInstaller(target, channel, true);
  await step(`Installing plxd on ${name}`, async () => {
    const script = installScript(target.os, installer, channel, true, false);
    const { code } = await runner.script(target.os === "windows" ? "powershell" : "sh", script, false);
    if (code !== 0) throw new Error(`The install failed on ${name} (exit ${code}).`);
    return [`Installed plxd ${installer.version} with its login service`, undefined];
  });
}

/**
 * Registers the host with the relay under the token's account, turns on `relay` and `remote`,
 * and waits until plxd is connected to the relay and listening. Prints its name as the relay
 * lists it.
 * @param {Plxd} plxd
 * @param {string} token
 * @param {Deps} deps
 */
async function link(plxd, token, deps) {
  await step("Registering this computer with Parallax Relay", async () => {
    await plxd.call("relay/register", { token });
    await plxd.call("host/settings/set", { relay: true, remote: true });
    return ["Registered, with Reach from anywhere on", undefined];
  });
  await step("Waiting for it to come online", async () => {
    for (let waited = 0; ; waited += 1000) {
      const status = await plxd.call("remote/sessions");
      if (status.relay?.connected && status.listening) break;
      if (waited >= ONLINE_TIMEOUT_MS) {
        const why = status.relay?.problem ?? status.problem ?? "it didn't connect in time";
        throw new Error(`It isn't online: ${why}`);
      }
      await deps.sleep(1000);
    }
    const listed = await plxd.call("relay/hosts", { token }).catch(() => undefined);
    const self = listed?.hosts?.find((/** @type {{ thisComputer: boolean }} */ host) => host.thisComputer);
    return [`${self?.name ?? "This computer"} is online on Parallax Connect`, undefined];
  });
}

/**
 * Shows a setup code for a signed-in device to type, a new one each time one lapses, and waits
 * until a device pairs with it. Prints the device's name.
 * @param {Plxd} plxd
 * @param {Deps} deps
 */
async function approveNewDevice(plxd, deps) {
  console.log("\nOn a device signed in to Parallax, open this computer and type its code there.");
  for (;;) {
    const { code, expiresAt } = await plxd.call("access/setupCode");
    console.log(`\n  ${code}\n\nWaiting for a device (Ctrl-C to stop; plx connect approve shows a new code later).`);
    let state = await plxd.call("access/get");
    const lapses = deps.sleep(Math.max(0, Date.parse(expiresAt) - Date.now())).then(() => undefined);
    while (!state.setupApproved) {
      const changed = await Promise.race([plxd.call("access/get", { after: state.version }), lapses]);
      if (!changed) break;
      state = changed;
    }
    if (state.setupApproved) {
      console.log(`✓ Approved ${state.setupApproved}. It can reach this computer now, and so can your other devices.`);
      return;
    }
    console.log("The code lapsed. Here's a new one.");
  }
}

/**
 * `plx connect approve`: approves a new device's waiting request after its code shows, with
 * Enter, or denies it with `n`. With none waiting, shows a code to type on a device, as setup
 * ends.
 * @param {Deps} deps
 */
export function approve(deps) {
  return exitCode(() =>
    withPlxd(deps, async (plxd) => {
      let state = await plxd.call("access/get");
      if (!state.pending) return approveNewDevice(plxd, deps);
      if (!state.pending.code) console.log(`${state.pending.name} asked to sign in. Waiting for it to show its code…`);
      while (state.pending && !state.pending.code) state = await plxd.call("access/get", { after: state.version });
      const pending = state.pending;
      if (!pending) throw new Error("The request went away before it showed a code.");
      console.log(`${pending.name} asks to sign in to this computer, with the code ${pending.code}.`);
      const answer = (await deps.prompt("Approve it if that device shows the same code. Enter approves, n denies: ")).trim().toLowerCase();
      if (answer === "n" || answer === "no") {
        await plxd.call("access/deny", { request: pending.id });
        console.log(`✓ Denied ${pending.name}.`);
      } else {
        await plxd.call("access/approve", { request: pending.id });
        console.log(`✓ Approved ${pending.name}.`);
      }
    }),
  );
}

/**
 * `plx connect unlink`: turns `relay` off and keeps the registration, so the host id and webhook
 * URLs stay. New account sign-ins stop; sessions already issued stay until revoked in Settings.
 * @param {Deps} deps
 */
export function unlink(deps) {
  return exitCode(() =>
    withPlxd(deps, async (plxd) => {
      await plxd.call("host/settings/set", { relay: false });
      console.log("✓ This computer is off Parallax Relay. It stays registered, so plx connect brings it back with the same id.");
      console.log("  Devices already signed in keep their sessions until you remove them in Settings.");
    }),
  );
}

/**
 * `plx connect remove`: signs in again, since nothing kept the token, removes this host from the
 * account on the relay, and turns `relay` off so plxd stops reconnecting.
 * @param {Deps} deps
 */
export function remove(deps) {
  return exitCode(() =>
    withPlxd(deps, async (plxd) => {
      const token = await step("Signing in to Parallax", async () => [`Signed in`, await deps.signIn()]);
      await step("Removing this computer from your account", async () => {
        const { hostId } = await plxd.call("relay/id");
        await plxd.call("relay/remove", { token, hostId });
        await plxd.call("host/settings/set", { relay: false });
        return [`Removed ${hostId} from Parallax Relay`, undefined];
      });
    }),
  );
}

/**
 * `plx connect status`: the account, host id, relay state, and routes.
 * @param {Deps} deps
 */
export function status(deps) {
  return exitCode(() =>
    withPlxd(deps, async (plxd) => {
      const [{ hostId }, access, settings, sessions] = await Promise.all([
        plxd.call("relay/id"),
        plxd.call("access/get"),
        plxd.call("host/settings/get"),
        plxd.call("remote/sessions"),
      ]);
      const relay = !settings.relay
        ? "off"
        : sessions.relay?.connected
          ? "on, connected"
          : `on, not connected${sessions.relay?.problem ? `: ${sessions.relay.problem}` : ""}`;
      const remote = !settings.remote ? "off" : sessions.listening ? "on, listening" : `on, not listening${sessions.problem ? `: ${sessions.problem}` : ""}`;
      const routes = sessions.listening ? await deps.routes().catch(() => []) : [];
      const rows = [
        ["Account", access.account ?? "not signed in (run plx connect)"],
        ["Host id", hostId],
        ["Relay", relay],
        ["Reach from anywhere", remote],
        ["Routes", routes.length ? routes.join(", ") : "none"],
        ["Approved devices", String(access.approvedClients.length)],
      ];
      const width = Math.max(...rows.map(([label]) => label?.length ?? 0));
      for (const [label, value] of rows) console.log(`${(label ?? "").padEnd(width)}  ${value}`);
      if (access.pending) console.log(`\n${access.pending.name} is waiting for approval. Run plx connect approve.`);
    }),
  );
}

/**
 * This computer's routes, best first, as its remote listener's public descriptor reports them
 * (0065). The listener's certificate is self-signed and this only reads the routes, so it isn't
 * checked.
 * @param {number} [port]
 * @returns {Promise<string[]>}
 */
export function localRoutes(port = REMOTE_PORT) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port, path: "/.well-known/parallax", rejectUnauthorized: false, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const routes = JSON.parse(body).routes;
          resolve(Array.isArray(routes) ? routes.filter((route) => typeof route === "string") : []);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once("timeout", () => req.destroy(new Error("The listener didn't answer.")));
    req.once("error", reject);
  });
}
