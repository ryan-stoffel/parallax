// @ts-check
// scripts/connect.sh and connect.ps1 with no terminal, up to the npx they hand over to, which is a
// recording stub. Neither script's real npx, plx, or Node.js download runs here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = (/** @type {string} */ name) => fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url));

/**
 * Runs `file` with `args` with no terminal, and `input` on stdin, or none. On macOS and Linux that
 * takes a new session. On Windows, `detached` means no console at all, which only a test that asks
 * for it gets. Resolves to its exit code, stdout, and stderr.
 * @param {string} file
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [input]
 * @param {boolean} [detached]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(file, args, env, input, detached = process.platform !== "win32") {
  const child = spawn(file, args, { env, detached, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  child.stdin?.end(input);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
}

// Refuses to go on unless HOME is the test's throwaway folder and each program the script could
// reach is the test's stub, so a broken test can't touch this computer or open a real sign-in.
const GUARD = `case "$HOME" in "$PLX_TEST_ROOT"/*) ;; *) echo "HOME isn't throwaway" >&2; exit 99 ;; esac
for tool in node npx tailscale open xdg-open; do
  [ "$(command -v "$tool")" = "$PLX_TEST_ROOT/bin/$tool" ] || { echo "$tool isn't a stub" >&2; exit 99; }
done
`;

/**
 * Runs `command` through sh after the guard, with stubs first on a PATH of the system's folders.
 * Resolves to the result and what the npx stub recorded: its arguments, and all of its stdin.
 * @param {string} command
 * @param {string} [input]
 */
async function posix(command, input) {
  const root = mkdtempSync(path.join(tmpdir(), "plx-scripts-"));
  const bin = path.join(root, "bin");
  try {
    const stubs = {
      node: "echo 22",
      npx: `{ printf '%s\\n' "$*"; cat; } > "$PLX_TEST_ROOT/recorded"; echo "plx ran"; exit 7`,
      tailscale: "exit 98",
      open: "exit 98",
      "xdg-open": "exit 98",
    };
    mkdirSync(bin);
    mkdirSync(path.join(root, "home"));
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home"), PLX_TEST_ROOT: root, CONNECT_SH: script("connect.sh") };
    const result = await run("/bin/sh", ["-c", GUARD + command], env, input);
    assert.notEqual(result.code, 99, result.stderr);
    return { ...result, recorded: readFileSync(path.join(root, "recorded"), "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("connect.sh from curl | sh with no terminal runs plx with nothing on stdin, and passes on its exit code", { skip: process.platform === "win32" }, async () => {
  const { code, stdout, recorded } = await posix(`cat "$CONNECT_SH" | sh -s -- --channel stable`);
  assert.equal(code, 7);
  assert.equal(stdout, "plx ran\n");
  // Nothing of the script itself reaches plx's prompt, and only a plx that fails at end of input runs.
  assert.equal(recorded, "-y plx-cli@>=0.7.0 connect --channel nightly --channel stable\n");
});

test("connect.sh as a file with no terminal leaves plx the script's stdin for a piped code", { skip: process.platform === "win32" }, async () => {
  const { code, recorded } = await posix(`sh "$CONNECT_SH"`, "the-code\n");
  assert.equal(code, 7);
  assert.equal(recorded, "-y plx-cli@>=0.7.0 connect --channel nightly\nthe-code\n");
});

for (const [launch, detached] of /** @type {[string, boolean][]} */ ([["piped output", false], ["no console", true]])) {
  test(`connect.ps1 with ${launch} runs plx, outlasts npm's stderr, and passes on its exit code`, { skip: process.platform !== "win32", timeout: 180_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plx-scripts-"));
    try {
      const recorded = path.join(root, "recorded");
      writeFileSync(path.join(root, "npx.cmd"), `@echo off\r\necho npm warn something 1>&2\r\necho %*> "${recorded}"\r\nexit /b 7\r\n`);
      // Node.js stays the real one, which the script only asks for its version. npx is the stub.
      const env = { ...process.env, PATH: `${root};${process.env["PATH"]}`, USERPROFILE: root };
      const command = `Get-Content -Raw -LiteralPath '${script("connect.ps1")}' | Invoke-Expression; Connect-Parallax --channel stable`;
      const { code, stdout, stderr } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], env, undefined, detached);
      assert.equal(code, 7, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
      // Quoted as cmd sees it, so only a plx that fails at end of input runs.
      assert.equal(readFileSync(recorded, "utf8").trim(), '-y "plx-cli@0.7.0 - 99" connect --channel nightly --channel stable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
