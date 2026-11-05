// @ts-check
// `plx connect` and its subcommands (0091): set up a computer for Parallax Connect over Parallax
// Relay with one sign-in, and manage it after. Everything plxd does here goes over `plxd attach`,
// its trusted local connection, or over ssh for `connect add`.

import https from "node:https";

import { localOs, sshTarget, step, StepFailed } from "./install.mjs";
import { fetchReleases, pickAsset, pickRelease, supportsRelay, withSha256 } from "./releases.mjs";
import { localRunner, sshRunner } from "./run.mjs";
import { installScript, REMOTE_PORT } from "./scripts.mjs";

/** @typedef {import("./plxd.mjs").Plxd} Plxd */
/** @typedef {import("./releases.mjs").Channel} Channel */
/** @typedef {import("./releases.mjs").Release} Release */
/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./releases.mjs").Os} Os */
/** @typedef {import("./detect.mjs").Target} Target */

/**
 * What the commands reach outside this process, so tests can fake each.
 * @typedef {object} Deps
 * @property {(channel: Channel) => Promise<Release>} release Finds the release to install.
 * @property {boolean} terminal Whether stdin is a terminal. Without one, nobody is there to answer
 *   or to wait, so setup ends at a printed code, and approves no device from input.
 * @property {() => Promise<string>} signIn Signs in and resolves to a Clerk access token.
 * @property {(runner: Runner, os: Os) => Promise<Target>} details Finds the OS details of the
 *   computer `runner` reaches.
 * @property {(runner: Runner, target: Target, name: string, release: Release, channel: Channel) => Promise<void>} install
 *   Installs `release`'s plxd with its login service on `target` through `runner`.
 * @property {(runner: Runner, os: Os) => Promise<Plxd>} plxd Opens `plxd attach` through
 *   `runner` on an `os` computer.
 * @property {(question: string, signal?: AbortSignal) => Promise<string>} prompt Asks the user for
 *   a line, until `signal` aborts the question.
 * @property {() => Promise<string[]>} routes This computer's routes, from its listener.
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * @typedef {object} Options
 * @property {Channel} channel
 * @property {string} [user] The SSH user for `add`.
 * @property {string} [port] The SSH port for `add`.
 * @property {string} [device] The `DPoP` key thumbprint of the device whose Allow is enough, from
 *   its Add computer's command, which never crosses the relay (0091).
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
 * The sign-in step, resolving to the access token. A failure goes to stderr, so a script that reads
 * stderr sees why it stopped.
 * @param {Deps} deps
 * @param {string} done The ✓ line's text.
 * @returns {Promise<string>}
 */
const signInStep = (deps, done) => step("Signing in to Parallax", async () => [done, await deps.signIn()], console.error);

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
 * `plx connect`: finds the release, signs in, installs plxd with its login service here, and links
 * it. Resolves to the exit code.
 * @param {Options} options
 * @param {Deps} deps
 */
export function connect(options, deps) {
  const runner = localRunner();
  return exitCode(async () => {
    const os = localOs();
    if (!os) throw new Error(`Parallax doesn't run on ${process.platform}.`);
    const release = await deps.release(options.channel);
    const token = await signInStep(deps, "Signed in to Parallax Connect");
    const target = await step("Finding this computer's OS", async () => {
      const target = await deps.details(runner, os);
      return [`${target.label}: ${target.version} (${target.arch})`, target];
    });
    await deps.install(runner, target, "this computer", release, options.channel);
    await withPlxd(
      deps,
      async (plxd) => {
        const others = await link(plxd, token, deps);
        await approveNewDevice(plxd, deps, others, options.device);
      },
      runner,
      os,
    );
  });
}

/**
 * `plx connect add <ssh destination>`: the same setup on another computer over ssh, with the
 * sign-in shown here. The only path that uses ssh, and only once. ssh comes after the sign-in so a
 * slow one doesn't outlast its shared connection and ask for the password again.
 * @param {string} destination `[user@]host`, as ssh takes it.
 * @param {Options} options
 * @param {Deps} deps
 */
export function add(destination, options, deps) {
  const target = options.user ? `${options.user}@${destination}` : destination;
  const runner = sshRunner(target, { port: options.port });
  return exitCode(async () => {
    const release = await deps.release(options.channel);
    const token = await signInStep(deps, "Signed in to Parallax Connect");
    const details = await sshTarget(runner, destination, target, `npx plx-cli connect --channel ${options.channel}`);
    await deps.install(runner, details, destination, release, options.channel);
    await withPlxd(
      deps,
      async (plxd) => {
        const others = await link(plxd, token, deps);
        await approveNewDevice(plxd, deps, others, options.device);
      },
      runner,
      details.os,
    );
  }).finally(() => runner.close());
}

/**
 * The newest release of `channel`, or a failed step that names the fix when there's none or it's
 * older than the relay. Runs before sign-in, so nobody signs in to a setup that can't finish.
 * @param {Channel} channel
 * @param {() => Promise<Release[]>} [releases]
 * @returns {Promise<Release>}
 */
export function findRelease(channel, releases = fetchReleases) {
  return step(`Finding the newest ${channel} release`, async () => {
    const release = pickRelease(await releases(), channel);
    if (!supportsRelay(release.tag_name)) {
      const fix = channel === "stable" ? "Run again with --channel nightly." : "Try again once a newer nightly is out.";
      throw new Error(`The newest ${channel} release, ${release.tag_name}, is too old for Parallax Relay. ${fix}`);
    }
    return [`Parallax ${release.tag_name.replace(/^v/, "")} supports Parallax Relay`, release];
  });
}

/**
 * Installs `release`'s plxd alone, with its login service, through `runner` (0072).
 * @param {Runner} runner
 * @param {Target} target
 * @param {string} name
 * @param {Release} release
 * @param {Channel} channel
 */
export async function install(runner, target, name, release, channel) {
  await step(`Installing plxd on ${name}`, async () => {
    const installer = await withSha256(pickAsset(release, target.os, target.arch, true));
    const script = installScript(target.os, installer, channel, true, false);
    const { code, stdout } = await runner.script(target.os === "windows" ? "powershell" : "sh", script, true);
    // Its steps only matter when it fails, or when it warns.
    for (const line of stdout.split(/\r?\n/))
      if (line && (code !== 0 || line.startsWith("warning:"))) console.log(`  ${line}`);
    if (code !== 0) throw new Error(`The install failed on ${name} (exit ${code}).`);
    return [`Installed plxd ${installer.version}`, undefined];
  });
}

/**
 * Registers the host with the relay under the token's account, turns on `relay` and `remote`,
 * and waits until plxd is connected to the relay and listening. Prints its name as the relay
 * lists it, and resolves to the names of the account's other computers.
 * @param {Plxd} plxd
 * @param {string} token
 * @param {Deps} deps
 * @returns {Promise<string[]>}
 */
async function link(plxd, token, deps) {
  await step("Registering this computer with Parallax Relay", async () => {
    await plxd.call("relay/register", { token });
    await plxd.call("host/settings/set", { relay: true, remote: true });
    return ["Registered, with Reach from anywhere on", undefined];
  });
  return step("Waiting for it to come online", async () => {
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
    /** @type {{ name: string, thisComputer: boolean }[]} */
    const hosts = listed?.hosts ?? [];
    const self = hosts.find((host) => host.thisComputer);
    const others = hosts.filter((host) => !host.thisComputer && host.name).map((host) => host.name);
    return [`${self?.name ?? "This computer"} is online on Parallax Connect`, others];
  });
}

/** 6 digits as every screen shows them. @param {string} code */
const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * Waits until a signed-in device joins, a new setup code each time one lapses, and prints its
 * name. A device that asks shows its code here and there. The device named by `device` needs only
 * its own Allow. Any other also needs Enter here, since nothing it holds tells it from a client
 * with a caught token. With no terminal, it prints one setup code and ends, so with no device
 * named, the code has to be typed.
 * @param {Plxd} plxd
 * @param {Deps} deps
 * @param {string[]} [others] The account's other computers, to say where to look.
 * @param {string} [device] The thumbprint of the device whose Allow is enough.
 */
async function approveNewDevice(plxd, deps, others = [], device) {
  // plxd keeps the code and the device it names after plx exits, so a script ends here rather than
  // waiting on a person.
  if (!deps.terminal) {
    const { code, expiresAt } = await plxd.call("access/setupCode", device ? { device } : {});
    const how = device ? "Allow it on the device that gave this command, or type it" : "Type it";
    console.log(`Setup code: ${code} (works until ${expiresAt}). ${how} in Parallax on a signed-in device. plx connect approve shows a new one.`);
    return;
  }
  const where = others.length === 1 ? others[0] : "your other computer";
  console.log(`\nParallax on ${where} shows a code to compare when you go back to it.`);
  for (;;) {
    const { code, expiresAt } = await plxd.call("access/setupCode", device ? { device } : {});
    console.log(`\nNo device at hand? Type ${spaced(code)} in Parallax on any signed-in device.`);
    console.log("Waiting for a device (Ctrl-C to stop; plx connect approve picks this up later).");
    const lapses = deps.sleep(Math.max(0, Date.parse(expiresAt) - Date.now())).then(() => undefined);
    const name = await waitForDevice(plxd, deps, device, lapses);
    if (name) {
      console.log(`✓ Added to Parallax from ${name}. You're done, and you can close this terminal.`);
      return;
    }
    console.log("The code lapsed. Here's a new one.");
  }
}

/**
 * Follows `access/get` until a device joins, and resolves to its name, or to undefined once
 * `lapses` does. Shows each request that waits, by the name it gave and its code.
 * @param {Plxd} plxd
 * @param {Deps} deps
 * @param {string | undefined} device
 * @param {Promise<undefined>} lapses
 * @returns {Promise<string | undefined>}
 */
async function waitForDevice(plxd, deps, device, lapses) {
  let state = await plxd.call("access/get");
  /** @type {string | undefined} The request shown. */
  let shown;
  /** @type {{ name: string, thumbprint: string } | undefined} Whose request was shown last. */
  let asker;
  /** @type {AbortController | undefined} */
  let asking;
  /** @type {Promise<{ answer: string }> | undefined} */
  let answered;
  try {
    for (;;) {
      if (state.setupApproved) return state.setupApproved;
      // An approved device, or this computer's own app, allowed it.
      if (asker && state.approvedClients.includes(asker.thumbprint)) return asker.name;
      const pending = state.pending?.code ? state.pending : undefined;
      if (pending?.id !== shown) {
        asking?.abort();
        asking = answered = undefined;
        shown = pending?.id;
        if (pending) {
          asker = pending;
          console.log(`\n${pending.name} asks to use this computer. It should show ${spaced(pending.code)}.`);
          if (device) console.log("Allow it there if it shows the same code.");
          else {
            asking = new AbortController();
            const question = "If it does, Allow it there and press Enter here. n denies: ";
            // An abort leaves the question unanswered, which approves nothing.
            answered = deps.prompt(question, asking.signal).then((answer) => ({ answer }), () => new Promise(() => {}));
          }
        }
      }
      const next = await Promise.race([plxd.call("access/get", { after: state.version }), lapses, ...(answered ? [answered] : [])]);
      if (!next) return undefined;
      if (!("answer" in next)) {
        state = next;
        continue;
      }
      asking = answered = undefined;
      const request = shown;
      if (["n", "no"].includes(next.answer.trim().toLowerCase())) {
        await plxd.call("access/deny", { request });
        console.log("✓ Denied it.");
        state = await plxd.call("access/get");
        continue;
      }
      await plxd.call("access/approve", { request });
      return asker?.name;
    }
  } finally {
    asking?.abort();
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
      const token = await signInStep(deps, "Signed in");
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
 * What `plx connect status` reports. `--json` prints this object, so its field names stay stable
 * (see the README).
 * @param {Plxd} plxd
 * @param {Deps} deps
 */
async function readStatus(plxd, deps) {
  const [{ hostId }, access, settings, sessions] = await Promise.all([
    plxd.call("relay/id"),
    plxd.call("access/get"),
    plxd.call("host/settings/get"),
    plxd.call("remote/sessions"),
  ]);
  return {
    /** @type {string | null} */
    account: access.account ?? null,
    /** @type {string} */
    hostId,
    relay: {
      on: settings.relay === true,
      connected: sessions.relay?.connected === true,
      /** @type {string | null} */
      problem: sessions.relay?.problem ?? null,
    },
    remote: {
      on: settings.remote === true,
      listening: sessions.listening === true,
      /** @type {string | null} */
      problem: sessions.problem ?? null,
    },
    /** @type {string[]} */
    routes: sessions.listening ? await deps.routes().catch(() => []) : [],
    /** @type {number} */
    approvedDevices: access.approvedClients.length,
    /** @type {string | null} */
    waitingDevice: access.pending?.name ?? null,
  };
}

/**
 * `plx connect status`: the account, host id, relay state, and routes. With `json`, stdout gets
 * only that object, and a failure goes to stderr.
 * @param {Deps} deps
 * @param {boolean} [json]
 */
export function status(deps, json = false) {
  const read = () => withPlxd(deps, (plxd) => readStatus(plxd, deps));
  if (json)
    return read().then(
      (report) => (console.log(JSON.stringify(report, null, 2)), 0),
      (error) => (console.error(`✗ ${error instanceof Error ? error.message : String(error)}`), 1),
    );
  return exitCode(async () => {
    const { account, hostId, relay, remote, routes, approvedDevices, waitingDevice } = await read();
    const rows = [
      ["Account", account ?? "not signed in (run plx connect)"],
      ["Host id", hostId],
      ["Relay", !relay.on ? "off" : relay.connected ? "on, connected" : `on, not connected${relay.problem ? `: ${relay.problem}` : ""}`],
      ["Reach from anywhere", !remote.on ? "off" : remote.listening ? "on, listening" : `on, not listening${remote.problem ? `: ${remote.problem}` : ""}`],
      ["Routes", routes.length ? routes.join(", ") : "none"],
      ["Approved devices", String(approvedDevices)],
    ];
    const width = Math.max(...rows.map(([label]) => label?.length ?? 0));
    for (const [label, value] of rows) console.log(`${(label ?? "").padEnd(width)}  ${value}`);
    if (waitingDevice) console.log(`\n${waitingDevice} is waiting for approval. Run plx connect approve.`);
  });
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
