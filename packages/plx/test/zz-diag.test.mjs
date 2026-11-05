// @ts-check
// TEMPORARY, PLX-1382: finds why powershell.exe exits 0 with no console. It fails on purpose with
// one line of findings, since a failed job's log is all CI shows. Removed before merge.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("DIAG", { skip: process.platform !== "win32", timeout: 170_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "plx-diag-"));
  /** @type {string[]} */
  const results = [];
  /**
   * @param {string} label
   * @param {string} file
   * @param {string[]} args
   * @param {import("node:child_process").SpawnOptions} options
   */
  const variant = async (label, file, args, options) => {
    const marker = path.join(root, label);
    const started = Date.now();
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DIAG_MARKER: marker }, ...options });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.once("close", resolve));
    const ms = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    results.push(`${label}:code=${code},ms=${ms},ran=${existsSync(marker) ? readFileSync(marker, "utf8") : "no"},out=${output.slice(-60).replace(/\s+/g, " ")}`);
  };
  const ps = ["-NoProfile", "-NonInteractive", "-Command"];
  const body = "[IO.File]::WriteAllText($env:DIAG_MARKER, 'yes'); exit 7";
  const write = `require('node:fs').writeFileSync(process.env.DIAG_MARKER,'yes');process.exit(7)`;

  await variant("exit-only", "powershell.exe", [...ps, "exit 7"], { detached: true });
  await variant("marker", "powershell.exe", [...ps, body], { detached: true });
  await variant("all-ignored", "powershell.exe", [...ps, body], { detached: true, stdio: "ignore" });
  await variant("stdin-pipe", "powershell.exe", [...ps, body], { detached: true, stdio: "pipe" });
  await variant("cmd-direct", "cmd.exe", ["/c", "exit 7"], { detached: true });
  await variant("node-direct", process.execPath, ["-e", write], { detached: true });
  await variant("via-cmd", `powershell.exe -NoProfile -NonInteractive -Command "${body}"`, [], { detached: true, shell: true });
  await variant("hidden-console", "powershell.exe", [...ps, body], { windowsHide: true });
  await variant("detached-and-hidden", "powershell.exe", [...ps, body], { detached: true, windowsHide: true });
  await variant("control", "powershell.exe", [...ps, body], {});

  const where = spawnSync("where", ["powershell.exe"], { encoding: "utf8" }).stdout.trim().replace(/\s+/g, " ");
  rmSync(root, { recursive: true, force: true });
  assert.fail(`DIAGSUMMARY where=${where} || ${results.join(" || ")}`);
});
