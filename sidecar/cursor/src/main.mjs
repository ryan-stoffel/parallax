/**
 * Parallax's Cursor sidecar (0053). plxd starts it and speaks JSON lines on stdio.
 *
 * The SDK is imported after the shell-spawn guard: a static import would run first, and a
 * sandboxed shell that fails to spawn would otherwise kill the process.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { failureOf, userMessage, viewResult, viewTool } from "./protocol.mjs";

const require = createRequire(import.meta.url);
// The SDK's `exports` leave out package.json, so it is read beside the resolved entry,
// `dist/cjs/index.js`.
const SDK_VERSION = JSON.parse(
  readFileSync(path.join(path.dirname(require.resolve("@cursor/sdk")), "../../package.json"), "utf8"),
).version;

// plxd passes only the provider instance's own `CURSOR_API_KEY`; ambient `CURSOR_*` is scrubbed.
// That key wins over the browser login, as in T3 Code. Nothing else reaches the SDK.
const CONFIGURED_KEY = process.env.CURSOR_API_KEY?.trim() || undefined;
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CURSOR_")) delete process.env[name];
}

const SANDBOX_MARKERS = ["dump_zsh_state", "dump_bash_state", "__CURSOR_SANDBOX_ENV_RESTORE"];

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT" && SANDBOX_MARKERS.some((marker) => message.includes(marker))) return;
  fail(error);
});

const node = process.versions.node.split(".").map(Number);
if (node[0] < 22 || (node[0] === 22 && node[1] < 13)) {
  emit({
    type: "error",
    failure: "failed",
    message: `Node.js 22.13 or newer is required (this is ${process.versions.node})`,
  });
  process.exit(1);
}

const sdk = await import("@cursor/sdk");
const {
  Agent,
  Cursor,
  FileCredentialStore,
  InMemoryCredentialStore,
  JsonlLocalAgentStore,
  createAgentPlatform,
} = sdk;

/** Every Cursor settings layer the Cursor CLI loads, as T3 Code passes them. */
const SETTING_SOURCES = ["project", "user", "team", "mdm", "plugins"];

const { command, authPath, storeDir, name } = parseArgs(process.argv.slice(2));
const credentials = new FileCredentialStore(authPath);

try {
  if (command === "status") await status();
  else if (command === "login") await login();
  else if (command === "logout") await logout();
  else if (command === "models") await models();
  else if (command === "run") await run();
  else {
    emit({ type: "error", failure: "failed", message: `unknown command ${command}` });
    process.exit(1);
  }
} catch (error) {
  fail(error);
}

function parseArgs(argv) {
  const command = argv[0];
  let authPath;
  let storeDir;
  let name = "Cursor";
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === "--auth") authPath = argv[i + 1];
    if (argv[i] === "--store") storeDir = argv[i + 1];
    if (argv[i] === "--name") name = argv[i + 1];
  }
  if (!command || !authPath || !storeDir) {
    emit({
      type: "error",
      failure: "failed",
      message: "usage: status|login|logout|models|run --auth <file> --store <dir>",
    });
    process.exit(1);
  }
  return { command, authPath, storeDir, name };
}

/** The provider's `CURSOR_API_KEY`, else the stored login unless it has expired. */
async function readApiKey() {
  if (CONFIGURED_KEY) return CONFIGURED_KEY;
  const stored = await credentials.load();
  if (!stored?.apiKey) return undefined;
  if (stored.apiKeyExpiresAtMs !== undefined && stored.apiKeyExpiresAtMs <= Date.now()) {
    return undefined;
  }
  return stored.apiKey;
}

async function requireApiKey() {
  const apiKey = await readApiKey();
  if (!apiKey) {
    emit({
      type: "error",
      failure: "notSignedIn",
      message: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
    });
    process.exit(1);
  }
  return apiKey;
}

/** Signed in when `Cursor.me` accepts the key, as T3 Code's provider probe checks. */
async function status() {
  const usesApiKey = CONFIGURED_KEY !== undefined;
  const apiKey = await readApiKey();
  if (!apiKey) {
    emit({ signedIn: false, usesApiKey, version: SDK_VERSION });
    return;
  }
  try {
    const user = await Cursor.me({ apiKey });
    emit({ signedIn: true, usesApiKey, email: user.userEmail ?? null, version: SDK_VERSION });
  } catch (error) {
    if (failureOf(error) !== "notSignedIn") throw error;
    emit({
      signedIn: false,
      usesApiKey,
      version: SDK_VERSION,
      message: usesApiKey
        ? "Cursor SDK authentication failed. Check CURSOR_API_KEY."
        : "Cursor sign-in expired or was rejected. Sign in again in provider settings.",
    });
  }
}

/**
 * The SDK logs into memory first, so a cancelled or rejected login never reaches the file. The
 * key is saved, then checked with `Cursor.me`, and cleared again if Cursor rejects it. plxd
 * refuses sign-in and sign-out for an instance with its own `CURSOR_API_KEY`.
 */
async function login() {
  const pending = new InMemoryCredentialStore();
  await Cursor.auth.login({
    openBrowser: false,
    apiKeyName: `Parallax - ${name}`,
    store: pending,
    signal: AbortSignal.timeout(300_000),
    onLoginUrl(url) {
      emit({ type: "url", url });
    },
  });
  const signedIn = await pending.load();
  if (!signedIn) throw new Error("Cursor login did not return credentials");
  await credentials.save(signedIn);
  try {
    const user = await Cursor.me({ apiKey: signedIn.apiKey });
    emit({ type: "done", email: user.userEmail ?? null });
  } catch (error) {
    await credentials.clear();
    throw error;
  }
}

async function logout() {
  await credentials.clear();
}

async function models() {
  const apiKey = await requireApiKey();
  const listed = await Cursor.models.list({ apiKey });
  emit({
    models: listed.map((model) => ({ id: model.id, name: model.displayName || model.id })),
  });
}

async function run() {
  const apiKey = await requireApiKey();
  const store = new JsonlLocalAgentStore(storeDir);
  const lines = readLines();
  const start = await lines.next();
  if (!start || start.type !== "start") {
    emit({ type: "error", failure: "failed", message: "the run needs a start message" });
    process.exit(1);
  }

  const permission = start.permission || "edit";
  const agent = await openAgent(apiKey, store, start, permission);
  emit({
    type: "session",
    agentId: agent.agentId,
    model: agent.model?.id ?? start.model ?? "auto",
  });

  let current = null;
  let shuttingDown = false;
  let supersede = null;
  const arm = () => {
    lines.setImmediate((message) => {
      if (!message || message.type === "cancel") {
        shuttingDown = true;
        supersede = null;
        current?.cancel().catch(() => {});
        return true;
      }
      if (message.type === "send" && message.steer && current) {
        supersede = message;
        current.cancel().catch(() => {});
        return true;
      }
      return false;
    });
  };
  const disarm = () => lines.setImmediate(() => false);

  let next = { type: "send", text: start.prompt ?? "", images: start.images };
  while (next && !shuttingDown) {
    const message = next;
    next = null;
    arm();
    const outcome = await turn(agent, message, start, permission, (run) => {
      current = run;
    });
    current = null;
    disarm();
    if (shuttingDown) {
      emit({ type: "turnFinished", result: null });
      break;
    }
    if (supersede) {
      emit({ type: "turnFinished", result: outcome.result ?? null });
      next = supersede;
      supersede = null;
      continue;
    }
    // A plan ends the turn, as in T3 Code: the app shows it, and building it is the next message.
    emit({ type: "turnFinished", result: outcome.result ?? null });
    emit({ type: "idle" });
    const follow = await lines.next();
    if (!follow || follow.type === "cancel") break;
    if (follow.type === "send") next = follow;
  }

  await agent.close?.();
  process.exit(0);
}

/** The agent options T3 Code's `makeCursorAgentOptions` builds, for Parallax's modes. */
async function openAgent(apiKey, store, start, permission) {
  const sandboxed = permission !== "bypass";
  if (!sandboxed) await primeSandbox(apiKey, start.cwd);
  const options = {
    apiKey,
    model: { id: start.model || "auto" },
    name: `Parallax ${start.name ?? ""}`.trim(),
    mode: modeOf(permission),
    local: {
      cwd: start.cwd,
      store,
      // On while the mode still asks: Plan and Auto. Edit and Bypass never ask.
      autoReview: permission === "plan" || permission === "auto",
      settingSources: SETTING_SOURCES,
      sandboxOptions: { enabled: sandboxed },
      enableAgentRetries: true,
    },
    ...mcpOf(start),
  };
  if (start.agentId) return Agent.resume(start.agentId, options);
  return Agent.create(options);
}

function mcpOf(start) {
  return start.mcp && typeof start.mcp === "object" ? { mcpServers: start.mcp } : {};
}

/**
 * The SDK decides once per process whether sandboxing works. After an unsandboxed run it caches
 * "unsupported", so a bare sandboxed workspace is warmed first, as T3 Code does. Best effort.
 */
async function primeSandbox(apiKey, cwd) {
  try {
    const platform = await createAgentPlatform({ workspaceRef: cwd });
    const release = await platform.prewarmLocalWorkspace({
      apiKey,
      local: { cwd, settingSources: [], sandboxOptions: { enabled: true } },
    });
    await release();
  } catch {
    // A sandboxed run later in this process reports the SDK's own error.
  }
}

function modeOf(permission) {
  return permission === "plan" ? "plan" : "agent";
}

async function turn(agent, message, start, permission, setRun) {
  let thinking = "";
  emit({ type: "turnStarted" });
  const run = await agent.send(userMessage(message.text ?? "", message.images), {
    model: { id: start.model || "auto" },
    mode: modeOf(permission),
    ...mcpOf(start),
    onDelta({ update }) {
      if (!update || typeof update !== "object") return;
      if (update.type === "text-delta") emit({ type: "text", text: update.text });
      else if (update.type === "thinking-delta") thinking += update.text;
      else if (update.type === "thinking-completed") {
        if (thinking) emit({ type: "reasoning", text: thinking });
        thinking = "";
      } else if (update.type === "tool-call-started") {
        const view = viewTool(update.toolCall);
        emit({ type: "tool", callId: update.callId, name: view.name, input: view.input });
        if (view.todos) emit({ type: "todo", items: view.todos });
      } else if (update.type === "tool-call-completed") {
        const view = viewResult(update.toolCall);
        emit({
          type: "toolResult",
          callId: update.callId,
          status: view.status,
          output: view.output,
        });
      } else if (update.type === "turn-ended" && update.usage) {
        emit({ type: "usage", usage: update.usage });
      }
    },
  });
  setRun(run);
  const result = await run.wait();
  setRun(null);
  if (thinking) emit({ type: "reasoning", text: thinking });
  if (result.status === "error") {
    emit({
      type: "error",
      failure: failureOf(result.error ?? { message: result.result }),
      message: result.error?.message || result.result || "the Cursor run failed",
    });
  }
  return { result: result.result };
}

function readLines() {
  const pending = [];
  let wait;
  let immediate = () => false;
  const deliver = (message) => {
    if (immediate(message)) return;
    if (wait) {
      const resolve = wait;
      wait = undefined;
      resolve(message);
    } else pending.push(message);
  };
  const reader = readline.createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    try {
      deliver(JSON.parse(line));
    } catch {
      emit({ type: "error", failure: "failed", message: "a message was not JSON" });
    }
  });
  reader.on("close", () => deliver(null));
  return {
    next: () =>
      pending.length
        ? Promise.resolve(pending.shift())
        : new Promise((resolve) => {
            wait = resolve;
          }),
    setImmediate(handler) {
      immediate = handler;
    },
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "error", failure: failureOf(error), message });
  process.exit(1);
}
