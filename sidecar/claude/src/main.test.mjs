/**
 * The sidecar against the real SDK, running the daemon's fake `claude` (fake-claude.sh) on a
 * fixture. Skipped until the SDK is installed here (`npm ci --omit=dev --omit=optional
 * --omit=peer`).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "../../../daemon/src/backend/claude/fixtures");
const installed = existsSync(path.join(here, "../node_modules/@anthropic-ai/claude-agent-sdk"));
const supervisor = process.env.PLXD_CLAUDE_PROCESS ?? path.join(here, "../../../target/debug/plxd");

function scratchSidecar(t, entry = path.join(here, "main.mjs")) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-sidecar-"));
  copyFileSync(path.join(fixtures, "fake-claude.sh"), path.join(dir, "claude"));
  chmodSync(path.join(dir, "claude"), 0o755);
  const sidecar = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "inherit"],
    detached: process.platform !== "win32",
  });
  const lines = [];
  const cleanup = [];
  const output = readline.createInterface({ input: sidecar.stdout });
  output.on("line", (line) => lines.push(line));
  t.after(() => {
    sidecar.stdin.end();
    for (const fn of cleanup) fn();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (value) => sidecar.stdin.write(`${JSON.stringify(value)}\n`);
  const until = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate(lines)) {
      assert.equal(sidecar.exitCode, null, "shared sidecar exited");
      assert.ok(Date.now() < deadline, `timed out: ${lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const open = (id, args, overrides = {}) => send({
    id, type: "open", supervisor, executable: path.join(dir, "claude"), args, cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir, FAKE_CLAUDE_DIR: dir,
      FAKE_CLAUDE_FIXTURE: path.join(fixtures, "read-only.jsonl") },
    ...overrides,
  });
  const prompt = (id) => send({ id, stdin: { type: "user", message: { role: "user", content: "hi" },
    parent_tool_use_id: null, uuid: "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01" } });
  const exit = async (id) => {
    await until((lines) => lines.some((line) => line.startsWith(`${id} exit `)));
    return JSON.parse(lines.find((line) => line.startsWith(`${id} exit `)).slice(`${id} exit `.length));
  };
  return { dir, lines, cleanup, send, until, open, prompt, exit, sidecar };
}

test("packaged resources start a query through the real SDK and Rust supervisor",
  { skip: !installed, timeout: 10000 }, async (t) => {
    const resources = mkdtempSync(path.join(tmpdir(), "claude-package-"));
    t.after(() => rmSync(resources, { recursive: true, force: true }));
    const root = path.join(here, "../../..");
    // Execute the release script's actual copy list, so a missing import fails this test.
    const staging = readFileSync(path.join(root, "scripts/ci/package-app"), "utf8")
      .split("\n").filter((line) => /^(mkdir|cp) .*claude-agent-sdk\//.test(line))
      .join("\n").replaceAll("target/package-resources", '"$PLX_TEST_RESOURCES"');
    assert.ok(staging.includes("main.mjs"), "release staging commands found");
    execFileSync("sh", ["-eu", "-c", staging], {
      cwd: root, env: { ...process.env, PLX_TEST_RESOURCES: resources },
    });
    const staged = path.join(resources, "claude-agent-sdk");
    // The SDK is installed separately on first use, outside the shipped resources.
    symlinkSync(path.join(here, "../node_modules"), path.join(staged, "node_modules"), "dir");
    const { lines, open, prompt, until, send, exit } = scratchSidecar(t, path.join(staged, "src/main.mjs"));
    open("packaged", []);
    prompt("packaged");
    await until((lines) => lines.some((line) => line.startsWith("packaged ") && line.includes('"type":"result"')));
    send({ id: "packaged", type: "end" });
    assert.deepEqual(await exit("packaged"), { code: 0, signal: null, stderr: "" });
    assert.equal(lines.filter((line) => line.startsWith("packaged exit ")).length, 1);
  });

test("killing the shared sidecar group still cleans up a live CLI and its child",
  { skip: !installed || process.platform === "win32", timeout: 10000 }, async (t) => {
    const { dir, cleanup, open, prompt, until, sidecar } = scratchSidecar(t);
    const pidFile = path.join(dir, "pids");
    const cli = path.join(dir, "cli.mjs");
    writeFileSync(cli, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"]
});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
setTimeout(() => {}, 60000);
`);
    writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${cli}'\n`, { mode: 0o755 });
    cleanup.push(() => {
      if (existsSync(pidFile)) {
        for (const pid of JSON.parse(readFileSync(pidFile, "utf8"))) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    });
    open("q", []);
    prompt("q");
    await until(() => existsSync(pidFile));
    const pids = JSON.parse(readFileSync(pidFile, "utf8"));
    const exited = new Promise((resolve) => sidecar.once("close", resolve));
    process.kill(-sidecar.pid, "SIGKILL");
    await exited;
    for (const pid of pids) {
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(pid, 0); }
        catch (error) { assert.equal(error.code, "ESRCH"); break; }
        assert.ok(Date.now() < deadline, `process ${pid} survived sidecar group cleanup`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });

test("file MCP configs and startup failures leave a second live SDK query healthy",
  { skip: !installed, timeout: 15000 }, async (t) => {
    const { dir, lines, open, prompt, until, send, exit } = scratchSidecar(t);
    open("healthy", ["--permission-mode", "default", "--permission-prompt-tool", "stdio"], {
      env: { PATH: "/usr/bin:/bin", HOME: dir, FAKE_CLAUDE_DIR: dir,
        FAKE_CLAUDE_FIXTURE: path.join(fixtures, "approval.jsonl") },
    });
    prompt("healthy");
    await until((lines) => lines.some((line) => line.startsWith("healthy ") && line.includes('"can_use_tool"')));
    writeFileSync(path.join(dir, "mcp.json"), '{"mcpServers":{}}');
    open("configured", ["--mcp-config", "mcp.json"]);
    prompt("configured");
    await until((lines) => lines.some((line) => line.startsWith("configured ") && line.includes('"type":"result"')));
    send({ id: "configured", type: "end" });
    assert.equal((await exit("configured")).code, 0);
    for (const [id, config] of [["bad-json", "{broken"], ["missing-file", "missing.json"]]) {
      open(id, ["--mcp-config", config]);
      const status = await exit(id);
      assert.equal(status.code, null);
      assert.ok(status.stderr.length > 0);
    }
    open("sdk-error", [], { cwd: 42 });
    assert.ok((await exit("sdk-error")).stderr.length > 0);
    // The healthy query was awaiting approval throughout the failed startups.
    const request = JSON.parse(lines.find((line) => line.startsWith("healthy ") && line.includes('"can_use_tool"')).slice(8));
    send({ id: "healthy", stdin: { type: "control_response", response: { subtype: "success",
      request_id: request.request_id, response: { behavior: "allow", updatedInput: { command: "pnpm test" } } } } });
    await until((lines) => lines.some((line) => line.startsWith("healthy ") && line.includes('"type":"result"')));
    send({ id: "healthy", type: "end" });
    assert.equal((await exit("healthy")).code, 0);
  });

for (const escaped of [false, true]) {
  test(`CLI exit drains output once while a ${escaped ? "detached" : "same-group"} child holds stdout`,
    { skip: !installed, timeout: 10000 }, async (t) => {
      const { dir, lines, cleanup, open, prompt, send, exit } = scratchSidecar(t);
      const cli = path.join(dir, "cli.mjs");
      const stream = readFileSync(path.join(fixtures, "read-only.jsonl"), "utf8")
        .split("\n").filter((line) => line.startsWith("{"));
      writeFileSync(cli, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"], detached: ${escaped}
});
writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(child.pid));
process.stderr.write("captured stderr\\n");
process.stdout.write(${JSON.stringify(stream.join("\n") + "\n")}, () => process.exit(0));
`);
      cleanup.push(() => {
        if (existsSync(path.join(dir, "pid"))) {
          try { process.kill(Number(readFileSync(path.join(dir, "pid"), "utf8")), "SIGKILL"); } catch {}
        }
      });
      // The SDK adds its CLI flags, so use a shell that forwards only the test script.
      writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${cli}'\n`, { mode: 0o755 });
      open("q", [], { executable: path.join(dir, "claude") });
      prompt("q");
      const status = await exit("q");
      assert.deepEqual(status, { code: 0, signal: null, stderr: "captured stderr" });
      send({ id: "q", type: "end" });
      send({ id: "q", type: "kill" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(lines, [...stream.map((line) => `q ${line}`), `q exit ${JSON.stringify(status)}`]);
      const pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
      if (escaped) process.kill(pid, "SIGKILL");
      else assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    });
}

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
      supervisor,
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
