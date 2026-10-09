/**
 * The sidecar against the real SDK, running the daemon's fake `claude` (fake-claude.sh) on a
 * fixture. Skipped until the SDK is installed here (`npm ci --omit=dev --omit=optional
 * --omit=peer`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../../../daemon/src/backend/claude/fixtures");
const installed = existsSync(path.join(here, "../node_modules/@anthropic-ai/claude-agent-sdk"));

test(
  "a query runs the CLI through the SDK with plxd's flags and answers its permission request",
  {
    skip: !installed && "the SDK isn't installed",
  },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-sidecar-"));
    copyFileSync(path.join(fixtures, "approval.jsonl"), path.join(dir, "fixture.jsonl"));
    const claude = path.join(dir, "claude");
    copyFileSync(path.join(fixtures, "fake-claude.sh"), claude);
    chmodSync(claude, 0o755);
    const sidecar = spawn(process.execPath, [path.join(here, "main.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const send = (value) => sidecar.stdin.write(`${JSON.stringify(value)}\n`);
    const flags = [
      "--permission-mode",
      "default",
      "--permission-prompt-tool",
      "stdio",
      "--restricted",
      "--settings",
      '{"env":{}}',
      "--add-dir",
      "/tmp/a",
    ];
    send({
      id: "q1",
      type: "open",
      executable: claude,
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        ...flags,
      ],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        FAKE_CLAUDE_DIR: dir,
        FAKE_CLAUDE_FIXTURE: path.join(dir, "fixture.jsonl"),
      },
    });
    const turn = "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01";
    send({
      id: "q1",
      stdin: {
        type: "user",
        message: { role: "user", content: "hi" },
        parent_tool_use_id: null,
        uuid: turn,
      },
    });

    const lines = [];
    for await (const line of readline.createInterface({ input: sidecar.stdout })) {
      lines.push(line);
      const [id, rest] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
      assert.equal(id, "q1");
      if (rest.includes('"can_use_tool"')) {
        const request = JSON.parse(rest);
        send({
          id: "q1",
          stdin: {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: request.request_id,
              response: { behavior: "allow", updatedInput: { command: "pnpm test" } },
            },
          },
        });
      }
      if (rest.includes('"type":"result"')) send({ id: "q1", type: "end" });
      if (rest.startsWith("exit ")) break;
    }
    sidecar.stdin.end();

    const types = lines
      .map((line) => line.slice(3))
      .map((rest) => (rest.startsWith("exit ") ? "exit" : JSON.parse(rest).type));
    assert.deepEqual(types, ["system", "assistant", "control_request", "user", "result", "exit"]);
    assert.deepEqual(JSON.parse(lines.at(-1).slice("q1 exit ".length)), {
      code: 0,
      signal: null,
      stderr: "",
    });
    // Every flag plxd gave reached the CLI, beside the SDK's own.
    const argv = readFileSync(path.join(dir, "argv"), "utf8").trim().split("\n");
    for (const flag of flags) assert.ok(argv.includes(flag), `${flag}: ${argv}`);
    // The SDK initialized the CLI, then sent plxd's prompt and its answer as plxd wrote them.
    const stdin = readFileSync(path.join(dir, "stdin"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(stdin[0].request.subtype, "initialize");
    assert.equal(stdin[1].uuid, turn);
    assert.equal(stdin[2].response.response.behavior, "allow");
  },
);
