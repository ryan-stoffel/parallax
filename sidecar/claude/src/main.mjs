/**
 * Parallax's Claude Agent SDK sidecar (0061). plxd starts one and speaks lines with it on stdio.
 * It holds every Claude run's live `query()`, keyed by plxd's run id.
 *
 * In, one JSON object per line:
 *   {"id", "type": "open", "executable", "args", "cwd", "env"}  starts a query that runs
 *       `executable`, the user's `claude`, with `args` as SDK options (`optionsFromArgs`)
 *   {"id", "stdin": <message>}  what plxd wrote on the CLI's stdin before the SDK: a user message,
 *       which joins the query's prompt, or a `control_response` that answers `canUseTool`
 *   {"id", "type": "interrupt" | "end" | "kill"}  ends the turn, ends the prompt, or kills the CLI
 *
 * Out, one line each:
 *   `<id> <line>`  a line of the CLI's stdout, except the control traffic the SDK answers
 *   `<id> oversized <bytes>`  a line too long to pass on
 *   `<id> exit {"code", "signal", "stderr"}`  the query ended, last
 *
 * The SDK spawns the CLI through `spawnClaudeCodeProcess`, so the sidecar reads its stdout lines
 * as they are, its exit status, and its stderr. When plxd goes away, stdin closes, and every CLI
 * is killed with its process group.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import readline from "node:readline";

import { Prompt, forwards, optionsFromArgs, permissionResult } from "./protocol.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  process.stderr.write(`Node.js 22.16 or newer is required (this is ${process.versions.node})\n`);
  process.exit(1);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");

/** The longest CLI line passed on, as plxd's own limit for a CLI's line. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** How much of the end of a CLI's stderr is kept, as plxd keeps it. */
const STDERR_TAIL = 64 * 1024;

/** @type {Map<string, ReturnType<typeof open>>} */
const queries = new Map();

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const id = message?.id;
  if (typeof id !== "string") return;
  if (message.type === "open") {
    if (!queries.has(id)) queries.set(id, open(id, message));
    return;
  }
  const live = queries.get(id);
  if (!live) return;
  if (message.stdin) live.stdin(message.stdin);
  else if (message.type === "interrupt") live.interrupt();
  else if (message.type === "end") live.prompt.end();
  else if (message.type === "kill") live.kill();
});
input.on("close", () => {
  for (const live of queries.values()) live.kill();
  process.exit(0);
});

function write(line) {
  process.stdout.write(`${line}\n`);
}

function open(id, { executable, args, cwd, env }) {
  const prompt = new Prompt();
  const { options, asks } = optionsFromArgs(Array.isArray(args) ? args : []);
  /** Answers to `can_use_tool` requests by the CLI's request id: a waiting callback, or an answer that came first. */
  const answers = new Map();
  let child;
  let stderr = "";
  let closed;
  const done = new Promise((resolve) => {
    closed = resolve;
  });

  const run = query({
    prompt,
    options: {
      ...options,
      cwd,
      env,
      pathToClaudeCodeExecutable: executable,
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(asks
        ? {
            canUseTool: (_tool, _input, { signal, requestId }) => {
              const early = answers.get(requestId);
              answers.delete(requestId);
              if (early && typeof early !== "function") return Promise.resolve(early);
              return new Promise((resolve) => {
                answers.set(requestId, resolve);
                signal?.addEventListener("abort", () => {
                  answers.delete(requestId);
                  resolve({ behavior: "deny", message: "withdrawn" });
                });
              });
            },
          }
        : {}),
      spawnClaudeCodeProcess: ({ command, args: argv, cwd: dir, env: vars, signal }) => {
        child = spawn(command, argv, {
          cwd: dir,
          env: vars,
          signal,
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so a kill reaches what it started, as plxd's did.
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        child.on("error", (error) => {
          stderr += `${error.message}\n`;
          closed({ code: null, signal: null });
        });
        child.on("close", (code, signal) => closed({ code, signal }));
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (stderr.length > 2 * STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL);
        });
        // Read beside the SDK's own reader, before it, so plxd gets each line as the CLI wrote it.
        readline
          .createInterface({ input: child.stdout, crlfDelay: Infinity })
          .on("line", (line) => {
            if (line.length * 3 > MAX_LINE_BYTES && Buffer.byteLength(line) > MAX_LINE_BYTES) {
              write(`${id} oversized ${Buffer.byteLength(line)}`);
            } else if (forwards(line)) write(`${id} ${line}`);
          });
        return child;
      },
    },
  });

  const live = {
    prompt,
    stdin(message) {
      if (message.type === "user") prompt.push(message);
      else if (message.type === "control_response") {
        const requestId = message.response?.request_id;
        const result = permissionResult(message.response);
        const waiting = answers.get(requestId);
        if (typeof waiting === "function") {
          answers.delete(requestId);
          waiting(result);
        } else answers.set(requestId, result);
      }
    },
    interrupt() {
      run.interrupt().catch(() => {});
    },
    kill() {
      prompt.end();
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };

  (async () => {
    try {
      for await (const _ of run) {
        // plxd reads the CLI's own lines above; this only keeps the SDK reading.
      }
    } catch (error) {
      if (!child) stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      live.kill();
    }
    const status = child ? await done : { code: null, signal: null };
    queries.delete(id);
    write(
      `${id} exit ${JSON.stringify({
        code: status.code,
        signal: status.signal ? (constants.signals[status.signal] ?? null) : null,
        stderr: stderr.slice(-STDERR_TAIL).trim(),
      })}`,
    );
  })();

  return live;
}
