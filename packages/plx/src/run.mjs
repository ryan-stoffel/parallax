// @ts-check
// Running a script on the target: over the system ssh for `add`, or here for `setup`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { POWERSHELL_ARGS } from "./scripts.mjs";

/** @typedef {"sh" | "powershell"} Shell */
/** @typedef {{ code: number, stdout: string }} Result */

/**
 * @typedef {object} Runner
 * @property {(command: string) => Promise<Result>} command Runs `command` in the target's own
 *   shell, keeping stdout. Only SSH targets have one to run it in.
 * @property {(shell: Shell, script: string, capture: boolean) => Promise<Result>} script Runs
 *   `script` with `sh -s` or PowerShell, from stdin. With `capture`, keeps stdout; without, prints
 *   stdout and stderr indented as they arrive.
 * @property {() => void} close Ends what the runner keeps open.
 */

/**
 * ssh's arguments to run `command` on `destination`. Host keys are accepted the first time,
 * since the tailnet already authenticated the node (0056). With `controlDir`, the calls share
 * one connection, so a password is asked once. Not BatchMode: the app runs this in a terminal,
 * where ssh can ask for a password.
 * @param {string} destination `[user@]host`
 * @param {{ port?: string, controlDir?: string }} options
 * @param {string[]} command
 */
export function sshArgs(destination, options, command) {
  const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  if (options.controlDir) {
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${options.controlDir}/%C`, "-o", "ControlPersist=120");
  }
  if (options.port) args.push("-p", options.port);
  return [...args, "--", destination, ...command];
}

/** The remote command that reads a script of `shell` from stdin. @param {Shell} shell */
const remoteReader = (shell) => (shell === "sh" ? ["sh -s"] : [`powershell ${POWERSHELL_ARGS.join(" ")}`]);

/**
 * A runner for `destination` over ssh. Windows' OpenSSH client has no ControlMaster, so there
 * each call connects on its own. The control socket's folder is under /tmp, since the path of a
 * Unix socket is limited to about 104 bytes and macOS' tmpdir is long.
 * @param {string} destination
 * @param {{ port?: string }} options
 * @returns {Runner}
 */
export function sshRunner(destination, options) {
  const controlDir = process.platform === "win32" ? undefined : mkdtempSync(path.join("/tmp", "plxc-"));
  const ssh = process.platform === "win32" ? "ssh.exe" : "ssh";
  const args = (/** @type {string[]} */ command) => sshArgs(destination, { ...options, controlDir }, command);
  return {
    command: (command) => exec(ssh, args([command]), { capture: true }),
    script: (shell, script, capture) => exec(ssh, args(remoteReader(shell)), { input: script, capture }),
    close() {
      if (!controlDir) return;
      spawn(ssh, ["-O", "exit", ...args([])], { stdio: "ignore" }).once("close", () =>
        rmSync(controlDir, { recursive: true, force: true }),
      );
    },
  };
}

/** A runner for this computer. @returns {Runner} */
export function localRunner() {
  return {
    command: () => Promise.reject(new Error("no shell command runs locally")),
    script: (shell, script, capture) =>
      shell === "sh"
        ? exec("sh", ["-s"], { input: script, capture })
        : exec("powershell.exe", POWERSHELL_ARGS, { input: script, capture }),
    close() {},
  };
}

/**
 * Runs `file` and resolves to its exit code (255 when it couldn't start, as ssh reports a failed
 * connection) and, with `capture`, its stdout. stderr always reaches the terminal: the first ssh
 * call may become a background ControlMaster that keeps stderr open, so it is never piped then.
 * @param {string} file
 * @param {string[]} args
 * @param {{ input?: string, capture: boolean }} options
 * @returns {Promise<Result>}
 */
function exec(file, args, { input, capture }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", capture ? "inherit" : "pipe"],
    });
    let stdout = "";
    if (capture) child.stdout?.on("data", (chunk) => (stdout += chunk));
    else {
      indent(child.stdout);
      indent(child.stderr);
    }
    child.once("error", (error) => {
      console.log(`  ${file}: ${error.message}`);
      resolve({ code: 255, stdout });
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Prints what `stream` sends, a line at a time, indented under the step it belongs to. @param {import("node:stream").Readable | null} stream */
function indent(stream) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (/** @type {string} */ chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) console.log(`  ${line.replace(/\r$/, "")}`);
  });
  stream.on("end", () => {
    if (pending) console.log(`  ${pending.replace(/\r$/, "")}`);
  });
}
