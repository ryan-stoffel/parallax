// @ts-check
// `plx-connect doctor`: checks Parallax on this computer, asking the running plxd itself, offers
// the fixes it knows, then hands the rest to the user's own coding agent (claude or codex) with
// a context file and the playbook in `doctor-playbook.md`, as T3 Code's `t3 triage` does. The
// agent asks what went wrong, investigates, and helps file an issue; the agent's own permission
// prompts gate what it runs.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, closeSync, statfsSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { buildContext, buildLaunchPrompt, buildSeedPrompt, MARKS } from "./doctor-prompt.mjs";
import { fetchReleases, pickRelease } from "./releases.mjs";

/**
 * @typedef {object} Fix A command that fixes a failed check.
 * @property {string} title What it does, asked as a question.
 * @property {string} file
 * @property {string[]} args
 * @property {string} [input] Piped to its stdin. Without it, the command runs in the terminal,
 *   for a sign-in that asks questions.
 * @property {boolean} [quiet] Drop its stdout, such as `plxd attach`'s JSON-RPC.
 * @property {Record<string, string>} [env] Added to the doctor's environment.
 */

/**
 * @typedef {object} Result
 * @property {"ok" | "warn" | "fail" | "skip"} state `warn`: works, but worth a look. `skip`: the
 *   check couldn't tell.
 * @property {string} detail
 * @property {Fix} [fix]
 */

/** @typedef {{ name: string, result: Result }} Checked */

/**
 * An agent as `providers/list` reports it. Its env values may hold keys: `loginEnv` is only passed
 * to the agent's own sign-in, as the app does, and none of them reaches the context file.
 * @typedef {object} Provider
 * @property {{ id: string, kind: string, name: string, enabled?: boolean, home?: string }} instance
 * @property {boolean} [installed]
 * @property {boolean} [signedIn]
 * @property {string} [version]
 * @property {string} [account]
 * @property {string} [note]
 * @property {string[]} [login]
 * @property {{ name: string, value?: string }[]} [loginEnv]
 * @property {string} [path] Where plxd found the agent's CLI.
 */

/**
 * What the running plxd answered over `plxd attach`. A method that failed or didn't answer is
 * missing.
 * @typedef {object} Answers
 * @property {{ plxd: string, protocol: number }} [initialize]
 * @property {{ os: string, arch: string, plxd: string }} [hostVersion]
 * @property {{ uptimeSeconds: number, store: string, runningAgents: number, queues?: { store: { queued: number, maxWaitMicros: number } } }} [health]
 * @property {{ providers: Provider[] }} [providers]
 * @property {{ connect?: boolean, remote?: boolean, relay?: boolean, cleanWorktrees?: boolean }} [settings]
 * @property {{ tailscale: string, port: number, listening: boolean, devices: { parallax?: boolean, online?: boolean }[] }} [connect]
 */

/**
 * Everything the checks read, gathered once and again after a fix.
 * @typedef {object} Facts
 * @property {NodeJS.Platform} platform
 * @property {string} dataDir
 * @property {boolean} dataDirExists
 * @property {string | undefined} plxd The plxd binary the doctor found.
 * @property {string | undefined} plxdVersion
 * @property {number | undefined} pid The running `serve`'s pid, from `plxd.lock`. Not on Windows.
 * @property {boolean} running
 * @property {string | undefined} runningExe The running `serve`'s binary, where the OS says.
 * @property {string | undefined} runningExeVersion That binary's version now, which a self-update
 *   may have changed since `serve` started.
 * @property {Answers | undefined} answers
 * @property {{ stable?: string, nightly?: string, error?: string }} newest Release versions.
 * @property {{ path: string, version: string } | undefined} git
 * @property {number | undefined} freeBytes Free space where the data folder is.
 * @property {number | undefined} worktrees How many run worktrees the data folder holds.
 * @property {LogProblems | undefined} log
 * @property {Record<string, string | undefined>} agentClis `claude` and `codex` on PATH.
 */

/** @typedef {{ errors: number, warnings: number, recent: string[] }} LogProblems */

const REPO = "https://github.com/ryan-stoffel/parallax";

/** The agent CLIs the doctor can hand off to, in the order it offers them. */
const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const GiB = 1024 ** 3;

/** The variable that points each agent kind at an instance's own home, as the app's `HOME_VARS`. */
const HOME_VARS = /** @type {Record<string, string>} */ ({
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  antigravity: "GEMINI_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
  hermes: "HERMES_HOME",
});

/**
 * The fix that signs in to `provider`, as the app's `providerSignInCommand` runs it: its `login`
 * argv with its `loginEnv` and its home's variable set, so a second Codex signs in to its own
 * `CODEX_HOME`. A program named like the CLI plxd found runs from where plxd found it.
 * @param {Provider} provider
 * @returns {Fix | undefined}
 */
export function signInFix(provider) {
  const [program, ...args] = provider.login ?? [];
  if (!program) return undefined;
  const { kind, home, name } = provider.instance;
  const homeVar = HOME_VARS[kind];
  const env = Object.fromEntries((provider.loginEnv ?? []).map((v) => [v.name, v.value ?? ""]));
  if (homeVar && home) env[homeVar] = home;
  const own = provider.path && path.basename(provider.path).replace(/\.\w+$/, "") === program;
  return { title: `Sign in to ${name} (${[program, ...args].join(" ")})`, file: own && provider.path ? provider.path : program, args, env };
}

/**
 * Where plxd may be, in the desktop app's `LOCATE_PLXD` order: `~/.parallax-plxd`
 * (`%USERPROFILE%\.parallax-plxd` on Windows), where plx-connect and the app's SSH install put it;
 * inside the app on macOS; `~/.local/bin` and the app's copy in `~/.local/share/parallax/app` on
 * Linux (`command.ts`); and the app's `resources` folder under `%LOCALAPPDATA%\Programs` on
 * Windows. PATH comes after these.
 * @param {NodeJS.Platform} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
export function plxdCandidates(platform, home, env) {
  if (platform === "darwin") {
    return [
      path.join(home, ".parallax-plxd", "plxd"),
      ...["/Applications", path.join(home, "Applications")].flatMap((dir) =>
        ["Parallax", "Parallax (Nightly)"].map((name) => path.join(dir, `${name}.app`, "Contents", "Resources", "plxd")),
      ),
    ];
  }
  if (platform !== "win32") {
    const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    return [
      path.join(home, ".parallax-plxd", "plxd"),
      path.join(home, ".local", "bin", "plxd"),
      path.join(data, "parallax", "app", "plxd"),
    ];
  }
  const own = path.join(home, ".parallax-plxd", "plxd.exe");
  if (!env.LOCALAPPDATA) return [own];
  const programs = path.join(env.LOCALAPPDATA, "Programs");
  try {
    return [own, ...readdirSync(programs).map((dir) => path.join(programs, dir, "resources", "plxd.exe"))];
  } catch {
    return [own];
  }
}

/**
 * `name`'s path on PATH, trying PATHEXT's extensions on Windows, or undefined.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 */
export function findOnPath(name, env, platform) {
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      if (isFile(file)) return file;
    }
  }
  return undefined;
}

/** @param {string} file */
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** @param {string} dir */
const isDir = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * plxd's data folder, as `DataDir::default_location` picks it: `PLXD_DATA_DIR`, else
 * `~/.parallax`, unless that doesn't exist and the folder older versions used does.
 * @param {NodeJS.Platform} platform
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveDataDir(platform, home, env) {
  if (env.PLXD_DATA_DIR) return path.resolve(env.PLXD_DATA_DIR);
  const fallback = path.join(home, ".parallax");
  /** @type {string | undefined} */
  let legacy;
  if (platform === "darwin") legacy = path.join(home, "Library", "Application Support", "parallax");
  else if (platform === "win32") legacy = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "parallax");
  else {
    const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
    legacy = path.join(data, "parallax");
  }
  return !existsSync(fallback) && legacy && isDir(legacy) ? legacy : fallback;
}

/**
 * The WARN and ERROR lines of plxd's log from the 24 hours before `now`. Lines start with an
 * RFC 3339 time and the level, as `tracing`'s formatter writes them.
 * @param {string} text The end of the log.
 * @param {Date} now
 * @returns {LogProblems}
 */
export function parseLogProblems(text, now) {
  const since = now.getTime() - 24 * 3600 * 1000;
  let errors = 0;
  let warnings = 0;
  /** @type {string[]} */
  const recent = [];
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(ERROR|WARN)\s/.exec(line);
    if (!match?.[1] || !(Date.parse(match[1]) >= since)) continue;
    if (match[2] === "ERROR") errors++;
    else warnings++;
    recent.push(line);
  }
  return { errors, warnings, recent: recent.slice(-40) };
}

/** The last `bytes` of `file`, from a line start. @param {string} file @param {number} bytes */
function readTail(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Runs `file` and resolves to its exit code, stdout, and stderr. @param {string} file @param {string[]} args */
function capture(file, args) {
  const run = spawnSync(file, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** `plxd --version`'s version, or undefined. @param {string} plxd */
const versionOf = (plxd) => capture(plxd, ["--version"]).stdout.trim().split(/\s+/)[1];

/**
 * The pid in `plxd.lock` if that process is alive. A `serve` holds the lock and writes its pid
 * there; the file stays after it exits, and the pid may be reused, so `gather` also checks that
 * the process runs plxd.
 * @param {string} dataDir
 */
function lockPid(dataDir) {
  let pid;
  try {
    pid = Number(readFileSync(path.join(dataDir, "plxd.lock"), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Dead, or EPERM: another user's process, which can't be this user's plxd.
    return undefined;
  }
}

/**
 * The binary process `pid` runs: `/proc/<pid>/exe` on Linux, which ends in ` (deleted)` once a
 * self-update replaced it, and `ps -o comm=` on macOS.
 * @param {number} pid
 */
function exeOf(pid) {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "darwin") return undefined;
  return capture("ps", ["-p", String(pid), "-o", "comm="]).stdout.trim() || undefined;
}

/** Whether Windows' plxd answers on its named pipe, `\\.\pipe\plxd-<hash>` (0023). @param {string} dataDir */
function probePipe(dataDir) {
  const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  return new Promise((resolve) => {
    const socket = net.connect(`\\\\.\\pipe\\plxd-${hash}`);
    socket.setTimeout(2000);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
  });
}

/**
 * Asks the running plxd, over `plxd attach`, for its version, health, agents, settings, and
 * Parallax Connect's state. `attach` starts
 * plxd when none runs, so this is only called when one does. Resolves when every request is
 * answered, or after `timeoutMs` with what was.
 * @param {string} plxd
 * @param {string} version plx-connect's, for the `initialize` request.
 * @param {number} timeoutMs
 * @returns {Promise<Answers>}
 */
function askPlxd(plxd, version, timeoutMs = 15_000) {
  /** @type {[keyof Answers, string, object][]} */
  const requests = [
    ["initialize", "initialize", { protocol: { min: 1, max: 1 }, client: { name: "plx-connect doctor", version }, capabilities: {} }],
    ["hostVersion", "host/version", {}],
    ["health", "host/health", {}],
    ["providers", "providers/list", {}],
    ["settings", "host/settings/get", {}],
    ["connect", "connect/devices", {}],
  ];
  return new Promise((resolve) => {
    /** @type {Record<string, unknown>} */
    const answers = {};
    const received = new Set();
    let finished = false;
    const child = spawn(plxd, ["attach"], { stdio: ["pipe", "pipe", "ignore"] });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      resolve(/** @type {Answers} */ (answers));
    };
    const timer = setTimeout(finish, timeoutMs);
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (/** @type {string} */ chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        /** @type {{ id?: unknown, result?: unknown }} */
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const request = typeof message.id === "number" ? requests[message.id - 1] : undefined;
        if (!request || received.has(request[0])) continue;
        // An error reply counts as answered, so a refused request doesn't wait out the timeout.
        received.add(request[0]);
        if (message.result !== undefined) answers[request[0]] = message.result;
      }
      if (received.size === requests.length) finish();
    });
    child.once("error", finish);
    child.once("exit", finish);
    child.stdin?.on("error", () => {});
    requests.forEach(([, method, params], index) => child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params })}\n`));
  });
}

/**
 * Gathers the facts the checks read.
 * @param {string} version plx-connect's.
 * @param {{ stable?: string, nightly?: string, error?: string }} [newest] The release versions
 *   from an earlier gather, so a recheck doesn't fetch them again.
 * @returns {Promise<Facts>}
 */
async function gather(version, newest) {
  const platform = process.platform;
  const env = process.env;
  const home = os.homedir();
  const dataDir = resolveDataDir(platform, home, env);
  const dataDirExists = isDir(dataDir);
  const plxd = plxdCandidates(platform, home, env).find(isFile) ?? findOnPath("plxd", env, platform);
  const plxdVersion = plxd && versionOf(plxd);

  const lockedPid = platform === "win32" ? undefined : lockPid(dataDir);
  const runningExe = lockedPid === undefined ? undefined : exeOf(lockedPid);
  const exeOnDisk = runningExe?.replace(/ \(deleted\)$/, "");
  // A stale lock's pid reused by another program isn't plxd. Where the OS can't say, trust it.
  const pid = exeOnDisk === undefined || /^plxd(\.exe)?$/.test(path.basename(exeOnDisk)) ? lockedPid : undefined;
  const running = platform === "win32" ? await probePipe(dataDir) : pid !== undefined;
  const runningExeVersion = exeOnDisk && exeOnDisk !== plxd && isFile(exeOnDisk) ? versionOf(exeOnDisk) : exeOnDisk === plxd ? plxdVersion : undefined;
  const answers = running && plxd ? await askPlxd(plxd, version) : undefined;

  if (!newest) {
    try {
      const releases = await fetchReleases();
      const tag = (/** @type {"stable" | "nightly"} */ channel) => {
        try {
          return pickRelease(releases, channel).tag_name.replace(/^v/, "");
        } catch {
          return undefined;
        }
      };
      newest = { stable: tag("stable"), nightly: tag("nightly") };
    } catch (error) {
      newest = { error: message(error) };
    }
  }

  const gitPath = findOnPath("git", env, platform);
  const git = gitPath ? { path: gitPath, version: capture(gitPath, ["--version"]).stdout.trim().replace(/^git version /, "") } : undefined;

  let freeBytes;
  try {
    const stats = statfsSync(dataDirExists ? dataDir : home);
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    freeBytes = undefined;
  }
  let worktrees;
  try {
    worktrees = readdirSync(path.join(dataDir, "worktrees")).length;
  } catch {
    worktrees = undefined;
  }
  const logFile = path.join(dataDir, "logs", "plxd.log");
  const log = isFile(logFile) ? parseLogProblems(readTail(logFile, 4 * 1024 * 1024), new Date()) : undefined;

  const agentClis = Object.fromEntries(AGENTS.map(({ id }) => [id, findOnPath(id, env, platform)]));

  return { platform, dataDir, dataDirExists, plxd, plxdVersion, pid, running, runningExe, runningExeVersion, answers, newest, git, freeBytes, worktrees, log, agentClis };
}

/** `seconds` as `2 d 3 h`, `3 h 12 m`, or `12 m`. @param {number} seconds */
export function duration(seconds) {
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  const d = Math.floor(seconds / 86400);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}

/** @param {number} bytes */
const gib = (bytes) => `${(bytes / GiB).toFixed(1)} GB`;

/**
 * The checks' results, in the order they print. Pure, so a recheck after a fix is another call.
 * @param {Facts} facts
 * @returns {Checked[]}
 */
export function evaluate(facts) {
  /** @type {Checked[]} */
  const out = [];
  const add = (/** @type {string} */ name, /** @type {Result} */ result) => out.push({ name, result });
  const { plxd, answers } = facts;

  add(
    "plxd",
    plxd
      ? { state: facts.plxdVersion ? "ok" : "fail", detail: facts.plxdVersion ? `${facts.plxdVersion} at ${plxd}` : `${plxd} --version printed no version` }
      : { state: "fail", detail: `not found. Install Parallax from ${REPO}/releases, or run npx plx-connect setup.` },
  );

  /** @type {Fix | undefined} */
  const start = plxd ? { title: "Start plxd", file: plxd, args: ["attach"], input: "", quiet: true } : undefined;
  const pid = facts.pid === undefined ? "" : `pid ${facts.pid}, `;
  if (!facts.running) add("Running", { state: "fail", detail: "plxd isn't running", fix: start });
  else if (!answers?.initialize) add("Running", { state: "fail", detail: `${pid}but it didn't answer within 15 s` });
  else {
    const health = answers.health;
    const busy = health ? `, ${health.runningAgents} agent${health.runningAgents === 1 ? "" : "s"} running` : "";
    add("Running", { state: "ok", detail: `${pid}${answers.initialize.plxd}, up ${health ? duration(health.uptimeSeconds) : "?"}${busy}` });
  }

  const runningVersion = answers?.initialize?.plxd;
  if (facts.runningExe?.endsWith(" (deleted)") || (runningVersion && facts.runningExeVersion && runningVersion !== facts.runningExeVersion)) {
    add("Restart", {
      state: "fail",
      detail: `${runningVersion ? `plxd ${runningVersion}` : "plxd"} is running, but its binary ${facts.runningExeVersion ? `is now ${facts.runningExeVersion}` : "was replaced"}. Quit and reopen Parallax to restart it.`,
    });
  }

  const version = runningVersion ?? facts.plxdVersion;
  if (version) {
    const channel = version.endsWith("-nightly") ? "nightly" : "stable";
    const newest = facts.newest[channel];
    if (facts.newest.error) add("Up to date", { state: "skip", detail: `couldn't reach GitHub: ${facts.newest.error}` });
    else if (!newest) add("Up to date", { state: "skip", detail: `no ${channel} release found` });
    else if (newest === version) add("Up to date", { state: "ok", detail: `${version} is the newest ${channel}` });
    else add("Up to date", { state: "warn", detail: `${version}; the newest ${channel} is ${newest}. Update from Parallax's menu.` });
  }

  if (answers?.health) {
    const { store, queues } = answers.health;
    const wait = queues ? queues.store.maxWaitMicros / 1e6 : 0;
    if (store !== "ok") add("Project store", { state: "fail", detail: `plxd reports the store as ${store}` });
    else if (wait > 5) add("Project store", { state: "warn", detail: `ok, but a write waited ${wait.toFixed(1)} s in the queue` });
    else add("Project store", { state: "ok", detail: "ok" });
  }

  if (answers?.providers) {
    for (const provider of answers.providers.providers.filter((p) => p.instance.enabled !== false)) {
      const name = provider.instance.name;
      const version = provider.version ? `${provider.version}, ` : "";
      // plxd lists its default agents whether or not the user has any of them.
      if (!provider.installed) add(name, { state: "skip", detail: "not installed" });
      else if (provider.signedIn === false) {
        add(name, {
          state: "fail",
          detail: `${version}isn't signed in`,
          fix: signInFix(provider),
        });
      } else if (provider.note) add(name, { state: "warn", detail: `${version}${provider.note}` });
      else add(name, { state: "ok", detail: `${version}${provider.signedIn ? `signed in${provider.account ? ` (${provider.account})` : ""}` : "ready"}` });
    }
  } else {
    const found = AGENTS.flatMap(({ id }) => (facts.agentClis[id] ? [`${id} (${facts.agentClis[id]})`] : []));
    add("Agent CLIs", found.length ? { state: "ok", detail: `on PATH: ${found.join(", ")}` } : { state: "fail", detail: "neither claude nor codex is on PATH. Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup" });
  }

  if (answers?.settings?.connect && answers.connect) {
    const { tailscale, port, listening, devices } = answers.connect;
    const others = devices.filter((device) => device.parallax).length;
    if (tailscale !== "running") add("Connect", { state: "fail", detail: `on, but Tailscale is ${tailscale === "missing" ? "not installed" : "not connected"}, so other computers can't reach this one` });
    else if (!listening) add("Connect", { state: "fail", detail: `on, but plxd isn't listening on port ${port}. plxd's log says why.` });
    else add("Connect", { state: "ok", detail: `listening on port ${port}; ${others} other computer${others === 1 ? "" : "s"} on Parallax` });
  }

  add("git", facts.git ? { state: "ok", detail: `${facts.git.version} at ${facts.git.path}` } : { state: "fail", detail: "isn't on PATH. Parallax runs agents in git worktrees." });

  if (facts.freeBytes !== undefined) {
    const worktrees = facts.worktrees === undefined ? "" : `; ${facts.worktrees} run worktrees in the data folder`;
    const state = facts.freeBytes < 2 * GiB ? "fail" : facts.freeBytes < 10 * GiB ? "warn" : "ok";
    add("Disk", { state, detail: `${gib(facts.freeBytes)} free${worktrees}` });
  }

  if (facts.log) {
    const { errors, warnings, recent } = facts.log;
    const counts = `${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} in the last 24 h`;
    const lastError = recent.filter((text) => /^\S+\s+ERROR\s/.test(text)).at(-1)?.replace(/^\S+\s+ERROR\s+/, "");
    add("plxd log", errors > 0 ? { state: "warn", detail: `${counts}. Latest error: ${lastError?.slice(0, 160)}` } : { state: "ok", detail: counts });
  }

  return out;
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/** One check as a line, with its name in a column and the home folder as `~`. @param {Checked} checked */
const line = ({ name, result }) => `${MARKS[result.state]} ${name.padEnd(14)} ${result.detail.replaceAll(os.homedir(), "~")}`;

/**
 * Ignores Ctrl+C and Ctrl+\ while a child has the terminal: the terminal sends them to the doctor
 * too, which would exit and leave the child without it. Returns the function that stops ignoring.
 */
function holdSignals() {
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  return () => {
    process.off("SIGINT", ignore);
    process.off("SIGQUIT", ignore);
  };
}

/**
 * Spawns `file`. On Windows, an npm `.cmd` shim, or a bare name that may resolve to one, only
 * runs through cmd.exe, which splits on spaces, so the file and each argument are quoted. No
 * argument the doctor passes holds a `"`.
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 */
function spawnCommand(file, args, options) {
  const shell = process.platform === "win32" && (/\.(cmd|bat)$/i.test(file) || !/[\\/]/.test(file));
  const quote = (/** @type {string} */ arg) => `"${arg}"`;
  return shell ? spawn(quote(file), args.map(quote), { ...options, shell: true }) : spawn(file, args, options);
}

/** Runs `fix` and resolves when it exits. @param {Fix} fix */
function runFix(fix) {
  return new Promise((resolve) => {
    const stdin = fix.input === undefined ? "inherit" : "pipe";
    // `exit`, not `close`: a `serve` that `attach` starts may hold its stdio open.
    const child = spawnCommand(fix.file, fix.args, {
      stdio: [stdin, fix.quiet ? "ignore" : "inherit", "inherit"],
      env: { ...process.env, ...fix.env },
    });
    const release = holdSignals();
    child.once("error", (error) => (release(), console.log(`  ${message(error)}`), resolve(undefined)));
    child.once("exit", () => (release(), resolve(undefined)));
    if (fix.input !== undefined) child.stdin?.end(fix.input);
  });
}

/** Asks a yes-or-no question, with `fallback` for an empty answer. @param {import("node:readline/promises").Interface} prompt @param {string} question @param {boolean} fallback */
async function ask(prompt, question, fallback) {
  const answer = (await prompt.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

/** Asks which agent to use. @param {import("node:readline/promises").Interface} prompt @param {typeof AGENTS} agents */
async function pickAgent(prompt, agents) {
  const menu = agents.map((agent, index) => `  [${index + 1}] ${agent.label}`).join("\n");
  for (;;) {
    const answer = (await prompt.question(`Look into it with:\n${menu}\n> `)).trim().toLowerCase();
    const picked = agents[Number(answer) - 1] ?? agents.find((agent) => agent.id === answer);
    if (picked) return picked;
  }
}

/**
 * The folder for this run's files: `doctor/<time>` in the data folder, beside `doctor/source`
 * where the agent clones Parallax, or in the temp folder when there's no data folder. The doctor
 * never creates the data folder: a new `~/.parallax` would hide a legacy one from plxd.
 * @param {Facts} facts
 * @param {Date} now
 */
function runFolder(facts, now) {
  const base = path.join(facts.dataDirExists ? facts.dataDir : os.tmpdir(), facts.dataDirExists ? "doctor" : "parallax-doctor");
  const dir = path.join(base, now.toISOString().replaceAll(":", "-").replace(".", "-"));
  mkdirSync(dir, { recursive: true });
  return { dir, sourceCache: path.join(base, "source") };
}

/** How this command was run, for the agent to tell the user how to update it. */
const launchedAs = () => (process.env.npm_command === "exec" ? "npx plx-connect doctor" : `${process.argv[1] ?? "plx-connect"} doctor`);

/**
 * `plx-connect doctor`. Prints each check. In a terminal, offers the fix for each failed one and
 * checks again. Then writes the context and prompt files and hands them to claude or codex:
 * asked first, unless `--agent` names one. Resolves to the agent's exit code when it ran, else 1
 * when a check still fails.
 * @param {{ agent?: string, model?: string }} options
 */
export async function doctor(options) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const newPrompt = () => createInterface({ input: process.stdin, output: process.stdout });
  let prompt = interactive ? newPrompt() : undefined;
  try {
    console.log(`Parallax doctor (plx-connect ${pkg.version})\n`);
    let facts = await gather(pkg.version);
    let results = evaluate(facts);
    for (const checked of results) console.log(line(checked));

    const fixes = results.flatMap(({ result }) => (result.state === "fail" && result.fix ? [result.fix] : []));
    if (fixes.length > 0 && prompt) {
      console.log("");
      let fixed = false;
      for (const fix of fixes) {
        if (!(await ask(prompt, `${fix.title}?`, true))) continue;
        // A sign-in asks its own questions, so it gets the terminal to itself.
        if (fix.input === undefined) prompt.close();
        await runFix(fix);
        if (fix.input === undefined) prompt = newPrompt();
        fixed = true;
      }
      if (fixed) {
        facts = await gather(pkg.version, facts.newest);
        const before = new Map(results.map(({ name, result }) => [name, result.state]));
        results = evaluate(facts);
        console.log("\nAfter the fixes:");
        for (const checked of results) if (before.get(checked.name) !== checked.result.state) console.log(line(checked));
      }
    }
    const failed = results.some(({ result }) => result.state === "fail");
    console.log(failed ? "\nSome checks failed." : "\nEvery check passed.");

    const now = new Date();
    const { dir, sourceCache } = runFolder(facts, now);
    const contextFile = path.join(dir, "context.md");
    const promptFile = path.join(dir, "prompt.md");
    writeFileSync(contextFile, buildContext({ generatedAt: now.toISOString(), version: pkg.version, launchedAs: launchedAs(), facts, results, sourceCache }));
    writeFileSync(promptFile, buildSeedPrompt(contextFile, readFileSync(new URL("./doctor-playbook.md", import.meta.url), "utf8")));
    const paths = `The prompt and this computer's context are in:\n  ${promptFile}\n  ${contextFile}\nPaste the prompt file into any coding agent to look into a problem and file an issue.`;

    const installed = AGENTS.filter(({ id }) => facts.agentClis[id]);
    /** @type {(typeof AGENTS)[number] | undefined} */
    let agent;
    if (options.agent) {
      agent = installed.find(({ id }) => id === options.agent);
      if (!agent) {
        console.log(`\n✗ ${options.agent} isn't on PATH.\n${paths}`);
        return 1;
      }
    } else if (installed.length > 0 && prompt && (await ask(prompt, `\nOpen ${installed.length === 1 ? installed[0]?.label : "a coding agent"} to look into a problem and file an issue?`, failed))) {
      agent = installed.length === 1 ? installed[0] : await pickAgent(prompt, installed);
    }
    prompt?.close();
    if (!agent) {
      console.log(`\n${installed.length === 0 ? "Neither claude nor codex is on PATH. " : ""}${paths}`);
      return failed ? 1 : 0;
    }

    console.log(`\nStarting ${agent.label}. It will ask what went wrong.\n`);
    const cli = /** @type {string} */ (facts.agentClis[agent.id]);
    // One line naming the prompt file: cmd.exe, which runs an npm `.cmd` shim, can't carry the
    // multi-line playbook as an argument. It has no `"`, so quoting it for cmd.exe is safe.
    const args = [...(options.model ? ["--model", options.model] : []), buildLaunchPrompt(promptFile)];
    return await new Promise((resolve) => {
      const child = spawnCommand(cli, args, { cwd: dir, stdio: "inherit" });
      const release = holdSignals();
      child.once("error", (error) => (release(), console.log(`✗ Couldn't start ${agent.label}: ${message(error)}\n${paths}`), resolve(1)));
      // A signal has no exit code: report it as a failure, not success.
      child.once("exit", (code, signal) => (release(), resolve(code ?? (signal === null ? 0 : 1))));
    });
  } finally {
    prompt?.close();
  }
}
