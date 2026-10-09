/**
 * Parallax's Claude Agent SDK sidecar (0061). plxd starts one and speaks lines with it on stdio.
 * It holds every Claude run's live `query()`, keyed by plxd's run id.
 *
 * In, one JSON object per line:
 *   {"id", "type": "open", "executable", "args", "cwd", "env", "supervisor"}  starts a query that runs
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
 * `spawnClaudeCodeProcess` runs the CLI through `plxd sdk-process`, preserving Rust's cleanup
 * before reap (or Windows Job Objects), bounded drain, output limits and exact exit status.
 * When plxd goes away, stdin closes, and every CLI is killed with its process group.
 */
import readline from "node:readline";

import { Prompt, forwards, optionsFromArgs, permissionResult } from "./protocol.mjs";
import { spawnClaude } from "./process.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  process.stderr.write(`Node.js 22.16 or newer is required (this is ${process.versions.node})\n`);
  process.exit(1);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");

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

function open(id, { executable, args, cwd, env, supervisor }) {
  const prompt = new Prompt();
  /** Answers to `can_use_tool` requests by the CLI's request id: a waiting callback, or an answer that came first. */
  const answers = new Map();
  let child;
  let run;
  let stderr = "";
  let closed;
  const done = new Promise((resolve) => {
    closed = resolve;
  });

  const start = () => {
    const { options, asks } = optionsFromArgs(Array.isArray(args) ? args : [], cwd);
    return query({
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
        spawnClaudeCodeProcess: (options) => {
          child = spawnClaude(supervisor, options, (frame) => {
            if (frame.stdout !== undefined) {
              const line = Buffer.from(frame.stdout, "base64").toString("utf8");
              if (forwards(line)) write(`${id} ${line}`);
            } else if (frame.oversized !== undefined) write(`${id} oversized ${frame.oversized}`);
            else if (frame.exit) {
              stderr += frame.exit.stderr;
              prompt.end();
              closed(frame.exit);
            }
          });
          child.on("error", () => {}); // The bridge's exit frame carries the startup error.
          return child;
        },
      },
    });
  };

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
      run?.interrupt().catch(() => {});
    },
    kill() {
      prompt.end();
      child?.kill("SIGKILL");
    },
  };

  (async () => {
    // Register the live query before a synchronous SDK/argument error can finish it.
    await Promise.resolve();
    try {
      run = start();
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
        signal: status.signal,
        stderr: stderr.slice(-STDERR_TAIL).trim(),
      })}`,
    );
  })();

  return live;
}
