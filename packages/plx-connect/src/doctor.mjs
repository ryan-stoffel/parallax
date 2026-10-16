// @ts-check
// `plx-connect doctor`: checks Parallax on this computer, offers the fixes it knows, then opens
// Claude Code with the results and a playbook to look into the rest and help file an issue, as
// T3 Code's `t3 triage` does.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { fetchReleases, pickRelease } from "./releases.mjs";
import { linuxPackages } from "./scripts.mjs";

/**
 * @typedef {object} Fix A command that fixes a failed check.
 * @property {string} title What it does, asked as a question.
 * @property {string} file
 * @property {string[]} args
 * @property {string} input Its stdin.
 * @property {boolean} [quiet] Drop its stdout, such as `plxd attach`'s JSON-RPC.
 */

/**
 * @typedef {object} Result
 * @property {"ok" | "fail" | "skip"} state `skip`: the check couldn't tell.
 * @property {string} detail
 * @property {Fix} [fix]
 */

/** @typedef {{ name: string, run: () => Promise<Result> | Result }} Check */

const REPO = "https://github.com/ryan-stoffel/parallax";

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
  const isDir = (/** @type {string} */ dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  return !existsSync(fallback) && legacy && isDir(legacy) ? legacy : fallback;
}

/** `plxd service status`'s `key: value` lines, as a map. @param {string} output */
export function parseServiceStatus(output) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of output.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 2).trim();
  }
  return values;
}

/** Runs `file` and resolves to its exit code, stdout, and stderr. @param {string} file @param {string[]} args */
function capture(file, args) {
  const run = spawnSync(file, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
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
 * The checks, in order. Those that need plxd are skipped without it.
 * @param {string | undefined} plxd
 * @param {string} dataDir
 */
function checks(plxd, dataDir) {
  const needsPlxd = /** @type {Result} */ ({ state: "skip", detail: "needs plxd" });
  /** @type {Check[]} */
  const list = [
    {
      name: "plxd is installed",
      run: () =>
        plxd
          ? { state: "ok", detail: plxd }
          : { state: "fail", detail: `Install Parallax from ${REPO}/releases, or run npx plx-connect setup.` },
    },
    {
      name: "plxd is up to date",
      async run() {
        if (!plxd) return needsPlxd;
        const version = capture(plxd, ["--version"]).stdout.trim().split(/\s+/)[1];
        if (!version) return { state: "fail", detail: `${plxd} --version printed no version.` };
        const channel = version.endsWith("-nightly") ? "nightly" : "stable";
        try {
          const newest = pickRelease(await fetchReleases(), channel).tag_name.replace(/^v/, "");
          if (newest === version) return { state: "ok", detail: `${version}, the newest ${channel}` };
          return { state: "fail", detail: `${version}; the newest ${channel} is ${newest}. Update Parallax.` };
        } catch (error) {
          return { state: "skip", detail: `${version}; couldn't check for a newer one: ${message(error)}` };
        }
      },
    },
    {
      name: "plxd is running",
      async run() {
        if (!plxd) return needsPlxd;
        /** @type {Fix} */
        const fix = { title: "Start plxd", file: plxd, args: ["attach"], input: "", quiet: true };
        if (process.platform === "win32") {
          return (await probePipe(dataDir)) ? { state: "ok", detail: "answers on its pipe" } : { state: "fail", detail: "doesn't answer on its pipe", fix };
        }
        // `answers initialize` probes this data folder's socket, whatever runs plxd.
        const run = capture(plxd, ["service", "status"]);
        const status = parseServiceStatus(run.stdout);
        // It fails before probing where there's no systemd user manager, such as WSL or a container.
        if (run.code !== 0 || !status["answers initialize"]) {
          return { state: "skip", detail: `plxd service status failed: ${run.stderr.trim() || `exit ${run.code}`}` };
        }
        if (status["answers initialize"] === "true") return { state: "ok", detail: "answers on its socket" };
        return { state: "fail", detail: "doesn't answer on its socket", fix };
      },
    },
  ];
  if (process.platform === "linux") {
    list.push({
      name: "Claude Code's sandbox packages are installed",
      run() {
        // Nix profiles too, as the install script's `has` does: a non-login shell may not have them on PATH.
        const home = os.homedir();
        const has = (/** @type {string} */ command) =>
          findOnPath(command, process.env, "linux") ||
          [".nix-profile/bin", ".local/state/nix/profile/bin"].some((dir) => isFile(path.join(home, dir, command)));
        const missing = [["bwrap", "bubblewrap"], ["socat", "socat"]].filter(([command]) => !has(command ?? "")).map(([, pkg]) => pkg);
        if (missing.length === 0) return { state: "ok", detail: "bubblewrap and socat" };
        return { state: "fail", detail: `missing ${missing.join(" and ")}`, fix: { title: `Install ${missing.join(" and ")}`, file: "sh", args: ["-s"], input: linuxPackages } };
      },
    });
  }
  list.push({
    name: "An agent CLI is on PATH",
    run() {
      const found = ["claude", "codex"].flatMap((name) => {
        const file = findOnPath(name, process.env, process.platform);
        return file ? [`${name} (${file})`] : [];
      });
      if (found.length > 0) return { state: "ok", detail: found.join(", ") };
      return { state: "fail", detail: "Neither claude nor codex is on PATH. Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup" };
    },
  });
  return list;
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/** @param {string} name @param {Result} result */
const line = (name, result) => `${{ ok: "✓", fail: "✗", skip: "!" }[result.state]} ${name}: ${result.detail}`;

/** Runs `fix` in the terminal and resolves when it exits. @param {Fix} fix */
function runFix(fix) {
  return new Promise((resolve) => {
    // `exit`, not `close`: a `serve` that `attach` starts may hold its stdio open.
    const child = spawn(fix.file, fix.args, { stdio: ["pipe", fix.quiet ? "ignore" : "inherit", "inherit"] });
    child.once("error", (error) => (console.log(`  ${message(error)}`), resolve(undefined)));
    child.once("exit", () => resolve(undefined));
    child.stdin?.end(fix.input);
  });
}

/**
 * The context file for the Claude Code session: this computer's facts and the check results.
 * @param {{ version: string, plxd: string | undefined, dataDir: string, results: { name: string, result: Result }[] }} input
 */
export function buildContext({ version, plxd, dataDir, results }) {
  return `# Parallax doctor context

Written by \`plx-connect doctor\` ${version} at ${new Date().toISOString()}.

- OS: ${process.platform} ${process.arch} (${os.release()})
- Node: ${process.version}
- plxd: ${plxd ?? "not found"}
- Data folder: ${dataDir}
- plxd's log: ${path.join(dataDir, "logs", "plxd.log")}
- Project store (SQLite; never write to it): ${path.join(dataDir, "plxd.sqlite3")}
- Repo: ${REPO}

## Checks

${results.map(({ name, result }) => `- ${line(name, result)}`).join("\n")}
`;
}

/** Asks a yes-or-no question, with `fallback` for an empty answer. @param {import("node:readline/promises").Interface} prompt @param {string} question @param {boolean} fallback */
async function ask(prompt, question, fallback) {
  const answer = (await prompt.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

/**
 * `plx-connect doctor`. Prints each check; in a terminal, offers the fix for each failed one and
 * checks again, then offers to open Claude Code with the context file and playbook. Resolves to
 * Claude Code's exit code when it ran, else 1 when a check still fails.
 */
export async function doctor() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const home = os.homedir();
  const dataDir = resolveDataDir(process.platform, home, process.env);
  const plxd = plxdCandidates(process.platform, home, process.env).find(isFile) ?? findOnPath("plxd", process.env, process.platform);
  const prompt = process.stdin.isTTY && process.stdout.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  /** @type {{ name: string, result: Result }[]} */
  const results = [];
  for (const check of checks(plxd, dataDir)) {
    let result = await check.run();
    console.log(line(check.name, result));
    if (result.state === "fail" && result.fix && prompt && (await ask(prompt, `  ${result.fix.title}?`, true))) {
      await runFix(result.fix);
      result = await check.run();
      console.log(line(check.name, result));
    }
    results.push({ name: check.name, result });
  }
  const failed = results.some(({ result }) => result.state === "fail");

  // A folder of its own outside the data folder, which this must never create: a new
  // ~/.parallax would hide the legacy folder from plxd.
  const dir = mkdtempSync(path.join(os.tmpdir(), "plx-doctor-"));
  const contextFile = path.join(dir, "context.md");
  const promptFile = path.join(dir, "prompt.md");
  writeFileSync(contextFile, buildContext({ version: pkg.version, plxd, dataDir, results }));
  const playbook = readFileSync(new URL("./doctor-playbook.md", import.meta.url), "utf8");
  writeFileSync(
    promptFile,
    `A Parallax user started this session with \`plx-connect doctor\`. Its check results and this computer's facts are in:\n\n    ${contextFile}\n\nFollow the playbook below, starting by asking the user what went wrong.\n\n---\n\n${playbook}`,
  );
  const paths = `The doctor's prompt and context are in:\n  ${promptFile}\n  ${contextFile}\nPaste the prompt file into any coding agent to look into a problem and file an issue.`;

  const claude = findOnPath("claude", process.env, process.platform);
  const open = claude && prompt && (await ask(prompt, "\nOpen Claude Code to look into a problem and file an issue?", failed));
  prompt?.close();
  if (!claude || !open) {
    console.log(`\n${paths}`);
    return failed ? 1 : 0;
  }
  console.log("Starting Claude Code. It will ask what went wrong.\n");
  // One line pointing at the prompt file: cmd.exe, which runs an npm `.cmd` shim, can't carry
  // the multi-line playbook as an argument. It has no `"`, so quoting it for cmd.exe is safe.
  const launch = `Read ${promptFile} and follow its instructions: it is your Parallax doctor playbook, and it starts by asking the user what went wrong.`;
  const shell = /\.(cmd|bat)$/i.test(claude);
  return new Promise((resolve) => {
    const child = spawn(shell ? `"${claude}"` : claude, [shell ? `"${launch}"` : launch], { cwd: dir, stdio: "inherit", shell });
    child.once("error", (error) => (console.log(`✗ Couldn't start Claude Code: ${message(error)}\n${paths}`), resolve(1)));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
