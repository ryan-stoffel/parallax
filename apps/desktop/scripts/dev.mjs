// `pnpm dev`: serves the renderer with hot reload, rebuilds main and preload
// on change, and runs Electron on the dev server, restarting it whenever those
// bundles change. Quitting the app or Ctrl-C stops everything. The sidebar's
// Update button asks this script, over Electron's IPC channel, to pull develop,
// and this script tells the app, over the same channel, when develop has commits
// to pull: it checks on start, every five minutes, and after each update.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";
import { createServer } from "vite-plus";

import { commitsBehind } from "./behind.mjs";

const bundles = ["dist/main/main.cjs", "dist/preload/preload.cjs"];

const server = await createServer();
await server.listen();
server.printUrls();
const url = server.resolvedUrls.local[0];

// Start clean so Electron never launches on a stale bundle.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

// Run Vite+'s CLI with this Node, not the `vp` shim, so Windows needs no shell.
// `vp` runs the watcher as its own child without forwarding signals, so the exit
// handler kills the whole tree: a process group on POSIX, taskkill /T on Windows.
const windows = process.platform === "win32";
const vp = fileURLToPath(import.meta.resolve("vite-plus/bin"));
const pack = spawn(process.execPath, [vp, "pack", "--watch"], {
  stdio: "inherit",
  detached: !windows,
});
pack.on("exit", () => stop());

function killPackTree() {
  const { pid } = pack;
  if (pid === undefined) return; // It never started.
  if (windows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid);
    } catch {
      // The group already exited.
    }
  }
}

// Terminals inside Electron apps (VS Code, Cursor) set ELECTRON_RUN_AS_NODE,
// which would start Electron as plain Node.
const env = { ...process.env, WISP_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;

let app;
function restartApp() {
  if (!bundles.every((file) => existsSync(file))) return;
  const previous = app;
  // Extra args go to Electron, e.g. `pnpm dev --remote-debugging-port=9222`.
  const child = spawn(electron, [".", ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env,
  });
  child.send({ behind });
  child.on("message", (message) => {
    if (message !== "update") return;
    if (!updating) {
      // Those commits are being pulled, so nothing is on offer until the check after it.
      offer(0);
      // After a check in flight, whose fetch would race the pull for git's locks.
      updating = Promise.resolve(checking)
        .then(update)
        .finally(() => {
          updating = undefined;
          check();
        });
    }
    void updating.then((text) => child.connected && child.send({ update: text }));
  });
  // Quitting the app ends the dev session; a restart's kill doesn't.
  child.on("exit", () => app === child && stop());
  app = child;
  previous?.kill();
}

// The update in flight, shared by clicks that land while it runs.
let updating;
// The commit before a pull whose install or build hasn't succeeded yet, so the next click
// retries them rather than finding nothing new.
let base;

/**
 * Fast-forwards this checkout to origin/develop, then installs and rebuilds what changed. The
 * watchers reload the renderer and restart Electron; a new wispd starts on the app's reconnect.
 * Resolves to one line for the sidebar. New packages, and a change to this script, to
 * scripts/behind.mjs, or to the Vite config, need a manual restart of `pnpm dev`.
 */
async function update() {
  // Another branch is someone's work, which Update leaves alone. A detached HEAD fast-forwards.
  const branch = (await run("git", ["branch", "--show-current"])).out;
  if (branch && branch !== "develop")
    return `Update follows develop, and this checkout is on ${branch}.`;
  base ??= (await run("git", ["rev-parse", "HEAD"])).out;
  const pull = await run("git", ["pull", "--ff-only", "origin", "develop"]);
  if (pull.code !== 0) return `git pull failed: ${errorLine(pull.out)}`;
  const after = (await run("git", ["rev-parse", "HEAD"])).out;
  const changed = (await run("git", ["diff", "--name-only", base, after])).out
    .split("\n")
    .filter(Boolean);
  const updated = `Updated to ${after.slice(0, 7)}`;

  const packages = changed.includes("apps/desktop/pnpm-lock.yaml");
  if (packages) {
    // pnpm sets npm_execpath to itself for the scripts it runs: a JS file, or a native binary.
    const pnpm = process.env["npm_execpath"] ?? "pnpm";
    const args = ["install", "--frozen-lockfile"];
    const install = /\.[cm]?js$/.test(pnpm)
      ? await run(process.execPath, [pnpm, ...args], ".")
      : await run(pnpm, args, ".");
    if (install.code !== 0) return `pnpm install failed: ${errorLine(install.out)}`;
  }
  const rust = changed.some((file) => /^(daemon|crates)\/|^Cargo\.(toml|lock)$/.test(file));
  // Windows won't replace the wispd.exe that the app's wispd is running from.
  if (rust && windows) {
    base = undefined;
    return `${updated}. Quit wisp and stop wispd, then run cargo build -p wispd.`;
  }
  if (rust) {
    const build = await run("cargo", ["build", "-p", "wispd"]);
    if (build.code !== 0) return `cargo build failed: ${errorLine(build.out)}`;
    stopWispd();
  }
  base = undefined;
  if (packages) return `${updated}. Restart pnpm dev to load the new packages.`;
  return changed.length ? updated : "Up to date";
}

// What the Update button offers: the commits origin/develop has that this checkout lacks.
let behind = 0;
// The check in flight.
let checking;

/** Counts them (scripts/behind.mjs) in the background, unless a check or an update is running. */
function check() {
  if (updating || checking) return;
  checking = commitsBehind((args) => run("git", args, "../..", true)).then((count) => {
    checking = undefined;
    // An update that started meanwhile is pulling them.
    if (!updating) offer(count);
  });
}

/** Records what the Update button offers, and tells the app when it changes. */
function offer(count) {
  if (count === behind) return;
  behind = count;
  if (app?.connected) app.send({ behind });
}

check();
setInterval(check, 5 * 60_000);

/**
 * Runs a command in the repo root (or `cwd`), echoing its output. Never rejects. A background run
 * doesn't echo and gives up after a minute, since a fetch can stall (sleep, a network change) and
 * Update waits for it; its remote helper outlives a killed git and holds the pipes open, so it
 * resolves without waiting for them.
 */
function run(command, args, cwd = "../..", background = false) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, args, { cwd });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        out += chunk;
        if (!background) process.stdout.write(chunk);
      });
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    if (background)
      setTimeout(() => {
        child.kill();
        resolve({ code: -1, out: "timed out" });
      }, 60_000);
  });
}

/** The first `fatal:` or `error:` line of git's or cargo's output, else its last line. */
const errorLine = (text) => {
  const lines = text.split("\n");
  return lines.find((line) => /^(fatal|error)\b/.test(line)) ?? lines.at(-1) ?? "";
};

// Asks the running `wispd serve` to shut down, by the pid in its lock file (daemon/src/paths.rs).
// ponytail: stops runs in flight, so it's only called when Rust changed.
function stopWispd() {
  const dataDir =
    process.env["WISPD_DATA_DIR"] ??
    (process.platform === "darwin"
      ? path.join(homedir(), "Library/Application Support/wisp")
      : path.join(process.env["XDG_DATA_HOME"] || path.join(homedir(), ".local/share"), "wisp"));
  try {
    const pid = Number.parseInt(readFileSync(path.join(dataDir, "wispd.lock"), "utf8"));
    // A crashed serve leaves its pid behind, which another process may have by now.
    const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    if (/wispd serve\b/.test(args)) process.kill(pid);
  } catch {
    // Not running.
  }
}

let timer;
watch("dist", { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(restartApp, 200);
});

// Clean up on every way out, including an uncaught error.
process.on("exit", () => {
  app?.kill();
  killPackTree();
});
function stop() {
  process.exit();
}
// SIGHUP: a closed terminal signals our group, which no longer holds `vp`.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
