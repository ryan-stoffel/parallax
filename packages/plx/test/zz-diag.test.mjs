// @ts-check
// TEMPORARY, PLX-1382: finds why connect.ps1 exits 0 with no console. Each test fails on purpose
// with one line of findings, since a failed job's log is all CI shows. Removed before merge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skip = process.platform !== "win32";
const SCRIPT = fileURLToPath(new URL("../../../scripts/connect.ps1", import.meta.url));
const read = (/** @type {string} */ file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : null);

/**
 * @param {string} label
 * @param {(root: string) => string[]} args powershell.exe's arguments.
 * @param {boolean} detached
 */
function variant(label, args, detached = true) {
  test(`DIAG ${label}`, { skip, timeout: 120_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plx-diag-"));
    writeFileSync(path.join(root, "npx.cmd"), `@echo off\r\necho npm warn 1>&2\r\necho %*> "${path.join(root, "recorded")}"\r\nexit /b 7\r\n`);
    writeFileSync(
      path.join(root, "instrumented.ps1"),
      readFileSync(SCRIPT, "utf8")
        .replace("function Connect-Parallax {", `function Connect-Parallax {\n  [IO.File]::WriteAllText('${root}\\entered', 'test-node=' + (Test-Node) + ' host=' + $Host.Name + ' stdin-redirected=' + [Console]::IsInputRedirected)`)
        .replace("  exit $LASTEXITCODE", `  [IO.File]::WriteAllText('${root}\\after', 'last=' + $LASTEXITCODE + ' ok=' + $? + ' npx=' + $npx + ' plx=' + $plx)\n  exit $LASTEXITCODE`),
    );
    const started = Date.now();
    const child = spawn("powershell.exe", args(root), {
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${root};${process.env["PATH"]}`, USERPROFILE: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.once("close", resolve));
    // A stub that was started but not waited for needs a moment to write.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const found = {
      code,
      ms: Date.now() - started - 3000,
      out: stdout.slice(-300),
      err: stderr.slice(-300),
      marker: read(path.join(root, "marker")),
      entered: read(path.join(root, "entered")),
      after: read(path.join(root, "after")),
      recorded: read(path.join(root, "recorded")),
    };
    rmSync(root, { recursive: true, force: true });
    assert.fail(`DIAG ${label}: ${JSON.stringify(found)}`);
  });
}

const base = ["-NoProfile", "-NonInteractive", "-Command"];
const mark = (/** @type {string} */ root) => `[IO.File]::WriteAllText('${root}\\marker', 'last=' + $LASTEXITCODE + ' ok=' + $?)`;

variant("A exit 7", () => [...base, "exit 7"]);
variant("B exit in a function", () => [...base, "function f { exit 7 }; f"]);
variant("C marker then exit 7", (root) => [...base, `${mark(root)}; exit 7`]);
variant("D stub .cmd, then marker, then exit", (root) => [...base, `& '${root}\\npx.cmd' a; ${mark(root)}; exit $LASTEXITCODE`]);
variant("E cmd.exe /c exit 7, then marker", (root) => [...base, `& cmd.exe /c exit 7; ${mark(root)}; exit $LASTEXITCODE`]);
variant("F node.exe exits 7, then marker", (root) => [...base, `& node.exe -e 'process.exit(7)'; ${mark(root)}; exit $LASTEXITCODE`]);
variant("G instrumented connect.ps1 by iex", (root) => [...base, `Get-Content -Raw -LiteralPath '${root}\\instrumented.ps1' | Invoke-Expression; Connect-Parallax --channel stable`]);
variant("H instrumented connect.ps1, dot-sourced by -File", (root) => {
  writeFileSync(path.join(root, "wrapper.ps1"), `. '${root}\\instrumented.ps1'\r\nConnect-Parallax --channel stable\r\n`);
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "wrapper.ps1")];
});
variant("I control, with a console", (root) => [...base, `Get-Content -Raw -LiteralPath '${root}\\instrumented.ps1' | Invoke-Expression; Connect-Parallax --channel stable`], false);
