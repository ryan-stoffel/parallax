import assert from "node:assert/strict";
import test from "node:test";

import { Prompt, forwards, optionsFromArgs, permissionResult } from "./protocol.mjs";

const BASE = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

test("a worker's arguments become SDK options, and the rest pass through as extraArgs", () => {
  const { options, asks } = optionsFromArgs([
    ...BASE,
    "--restricted",
    "--tools",
    "Read,Edit,Bash",
    "--strict-mcp-config",
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    "stdio",
    "--settings",
    '{"sandbox":{"enabled":true}}',
    "--add-dir",
    "/a",
    "--add-dir",
    "/b",
    "--model",
    "opus",
    "--effort",
    "high",
  ]);
  assert.equal(asks, true);
  assert.deepEqual(options, {
    extraArgs: { restricted: null },
    tools: ["Read", "Edit", "Bash"],
    strictMcpConfig: true,
    permissionMode: "default",
    settings: '{"sandbox":{"enabled":true}}',
    additionalDirectories: ["/a", "/b"],
    model: "opus",
    effort: "high",
  });
});

test("modes map as T3 Code's, and a thread's plxd server and sessions carry over", () => {
  const mcp = { mcpServers: { plxd: { type: "stdio", command: "/bin/plxd", args: ["mcp"] } } };
  const { options, asks } = optionsFromArgs([
    ...BASE,
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    JSON.stringify(mcp),
    "--allowedTools",
    "mcp__plxd__thread_list,TodoWrite",
    "--resume",
    "5b1e3c9a",
    "--fork-session",
    "--resume-session-at",
    "a0000000",
    "--setting-sources",
    "user",
  ]);
  assert.equal(asks, false);
  assert.deepEqual(options, {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers: mcp.mcpServers,
    allowedTools: ["mcp__plxd__thread_list", "TodoWrite"],
    resume: "5b1e3c9a",
    forkSession: true,
    resumeSessionAt: "a0000000",
    settingSources: ["user"],
  });
});

test("an instance's own arguments pass through, with or without a value", () => {
  const { options } = optionsFromArgs(["--debug", "--max-turns=3", "--add-dir=/c", "--foo", "bar"]);
  assert.deepEqual(options, {
    extraArgs: { debug: null, "max-turns": "3", foo: "bar" },
    additionalDirectories: ["/c"],
  });
});

test("only the control traffic the SDK answers stays in the sidecar", () => {
  const line = (value) => JSON.stringify(value);
  assert.equal(forwards(line({ type: "assistant", message: {} })), true);
  assert.equal(forwards(line({ type: "keep_alive" })), false);
  assert.equal(forwards(line({ type: "control_response", response: {} })), false);
  const ask = (subtype) => line({ type: "control_request", request_id: "r", request: { subtype } });
  assert.equal(forwards(ask("can_use_tool")), true);
  assert.equal(forwards(ask("hook_callback")), false);
  assert.equal(forwards(line({ type: "control_cancel_request", request_id: "r" })), true);
  assert.equal(forwards("not json"), true);
});

test("plxd's answers become canUseTool results", () => {
  const success = (response) => ({ subtype: "success", request_id: "r", response });
  assert.deepEqual(
    permissionResult(
      success({
        behavior: "allow",
        updatedInput: { command: "ls" },
        updatedPermissions: [{ type: "addRules" }],
        toolUseID: "t",
      }),
    ),
    {
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [{ type: "addRules" }],
    },
  );
  assert.deepEqual(
    permissionResult(success({ behavior: "deny", message: "no", interrupt: true })),
    {
      behavior: "deny",
      message: "no",
      interrupt: true,
    },
  );
  assert.deepEqual(permissionResult({ subtype: "error", request_id: "r", error: "nope" }), {
    behavior: "deny",
    message: "nope",
  });
});

test("the prompt yields what was pushed, in order, then ends", async () => {
  const prompt = new Prompt();
  prompt.push(1);
  const seen = [];
  const reading = (async () => {
    for await (const message of prompt) seen.push(message);
  })();
  prompt.push(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  prompt.end();
  assert.equal(prompt.push(3), false);
  await reading;
  assert.deepEqual(seen, [1, 2]);
});
