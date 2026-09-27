// `pnpm dev`: serves the renderer with hot reload, rebuilds main and preload
// on change, and runs Electron on the dev server, restarting it whenever those
// bundles change. Quitting the app or Ctrl-C stops everything.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, watch } from "node:fs";
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
  const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
  // Quitting the app ends the dev session; a restart's kill doesn't.
  child.on("exit", () => app === child && stop());
  app = child;
  previous?.kill();
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
