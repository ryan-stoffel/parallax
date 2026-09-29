// `pnpm dev`: serves the renderer with hot reload, rebuilds main and preload
// on change, and runs Electron on the dev server, restarting it whenever those
// bundles change. Quitting the app or Ctrl-C stops everything. The sidebar's
// Update button asks this script, over Electron's IPC channel, to pull develop.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";
import { createServer } from "vite-plus";

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
  child.on("message", (message) => {
    if (message !== "update") return;
    updating ??= update().finally(() => (updating = undefined));
    void updating.then((text) => child.connected && child.send({ update: text }));
  });
  // Quitting the app ends the dev session; a restart's kill doesn't.
  child.on("exit", () => app === child && stop());
  app = child;
  previous?.kill();
}

// The update in flight, shared by clicks that land while it runs.
let updating;

/**
 * Fast-forwards this checkout to origin/develop, then installs and rebuilds what changed. The
 * watchers reload the renderer and restart Electron; a new wispd starts on the app's reconnect.
 * Resolves to one line for the sidebar. A change to this script or the Vite config needs a
 * manual restart of `pnpm dev`.
 */
async function update() {
  const branch = (await run("git", ["branch", "--show-current"])).out;
  if (branch !== "develop")
    return `Update follows develop, and this checkout is on ${branch || "a detached HEAD"}.`;
  const before = (await run("git", ["rev-parse", "HEAD"])).out;
  const pull = await run("git", ["pull", "--ff-only", "origin", "develop"]);
  if (pull.code !== 0) return `git pull failed: ${lastLine(pull.out)}`;
  const after = (await run("git", ["rev-parse", "HEAD"])).out;
  if (after === before) return "Up to date";

  const changed = (await run("git", ["diff", "--name-only", before, after])).out.split("\n");
  if (changed.includes("apps/desktop/pnpm-lock.yaml")) {
    // pnpm sets npm_execpath to itself for the scripts it runs.
    const pnpm = process.env["npm_execpath"] ?? "pnpm";
    const install = await run(process.execPath, [pnpm, "install", "--frozen-lockfile"], ".");
    if (install.code !== 0) return `pnpm install failed: ${lastLine(install.out)}`;
  }
  if (changed.some((file) => /^(daemon|crates)\/|^Cargo\.(toml|lock)$/.test(file))) {
    const build = await run("cargo", ["build", "-p", "wispd"]);
    if (build.code !== 0) return `cargo build failed: ${lastLine(build.out)}`;
    stopWispd();
  }
  return `Updated to ${after.slice(0, 7)}`;
}

/** Runs a command in the repo root (or `cwd`), echoing its output. Never rejects. */
function run(command, args, cwd = "../..") {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, args, { cwd });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        out += chunk;
        process.stdout.write(chunk);
      });
    child.on("error", (error) => resolve({ code: -1, out: error.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

const lastLine = (text) => text.split("\n").at(-1) ?? "";

// Asks the running `wispd serve` to shut down, by the pid in its lock file (daemon/src/paths.rs).
// ponytail: stops runs in flight, so it's only called when Rust changed; POSIX only, so on
// Windows the new build waits for wispd's next start.
function stopWispd() {
  if (windows) return;
  const dataDir =
    process.env["WISPD_DATA_DIR"] ??
    (process.platform === "darwin"
      ? path.join(homedir(), "Library/Application Support/wisp")
      : path.join(process.env["XDG_DATA_HOME"] || path.join(homedir(), ".local/share"), "wisp"));
  try {
    const pid = Number.parseInt(readFileSync(path.join(dataDir, "wispd.lock"), "utf8"));
    // A crashed serve leaves its pid behind, which another process may have by now.
    const name = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    if (name.trim().endsWith("wispd")) process.kill(pid);
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
