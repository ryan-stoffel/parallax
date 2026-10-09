/**
 * The Claude sidecar's pure parts: plxd's `claude` arguments as Agent SDK options, which CLI
 * lines plxd gets, and the answer to a permission request. No SDK import, so the tests run
 * without it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The flags the SDK passes itself, with how many values each takes. */
const SDK_OWN = {
  "-p": 0,
  "--print": 0,
  "--verbose": 0,
  "--output-format": 1,
  "--input-format": 1,
};

/** Flags with one value that map to an SDK option of their own. */
const VALUE_OPTIONS = {
  "--model": "model",
  "--effort": "effort",
  "--resume": "resume",
  "--resume-session-at": "resumeSessionAt",
  "--permission-mode": "permissionMode",
  "--settings": "settings",
};

/** Flags with a comma-separated list that map to an SDK option. */
const LIST_OPTIONS = {
  "--tools": "tools",
  "--allowedTools": "allowedTools",
  "--disallowedTools": "disallowedTools",
  "--setting-sources": "settingSources",
};

/**
 * The SDK options that make it run `claude` with `args`, the arguments plxd's
 * `claude::arguments` builds (0061), and whether plxd answers permission requests
 * (`--permission-prompt-tool stdio`, which the SDK adds itself for `canUseTool`). Permission
 * modes map as T3 Code maps them: Full access is `bypassPermissions` with
 * `allowDangerouslySkipPermissions`. Any other flag goes in `extraArgs`, which the SDK passes on.
 *
 * @param {string[]} args
 * @param {string} cwd
 */
export function optionsFromArgs(args, cwd = process.cwd()) {
  const options = {};
  const extraArgs = {};
  let asks = false;
  for (let i = 0; i < args.length; i++) {
    let flag = args[i];
    let value;
    const eq = flag.startsWith("--") ? flag.indexOf("=") : -1;
    if (eq > 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const take = () => value ?? args[++i];
    if (flag in SDK_OWN) {
      if (SDK_OWN[flag] && value === undefined) i++;
    } else if (flag === "--permission-prompt-tool") {
      asks = take() === "stdio";
    } else if (flag in VALUE_OPTIONS) {
      options[VALUE_OPTIONS[flag]] = take();
    } else if (flag in LIST_OPTIONS) {
      const list = take();
      options[LIST_OPTIONS[flag]] = list ? list.split(",") : [];
    } else if (flag === "--fork-session") {
      options.forkSession = true;
    } else if (flag === "--strict-mcp-config") {
      options.strictMcpConfig = true;
    } else if (flag === "--add-dir") {
      (options.additionalDirectories ??= []).push(take());
    } else if (flag === "--mcp-config") {
      const config = take();
      const json = config.trimStart().startsWith("{")
        ? config
        : readFileSync(resolve(cwd, config), "utf8");
      options.mcpServers = { ...options.mcpServers, ...JSON.parse(json).mcpServers };
    } else if (flag.startsWith("--")) {
      const next = args[i + 1];
      extraArgs[flag.slice(2)] =
        value ?? (next !== undefined && !next.startsWith("-") ? args[++i] : null);
    }
  }
  if (options.permissionMode === "bypassPermissions")
    options.allowDangerouslySkipPermissions = true;
  if (Object.keys(extraArgs).length > 0) options.extraArgs = extraArgs;
  return { options, asks };
}

/**
 * Whether a CLI stdout line goes on to plxd: everything but the control traffic the SDK answers
 * itself. A `can_use_tool` request and its `control_cancel_request` go on, since plxd answers
 * those.
 *
 * @param {string} line
 */
export function forwards(line) {
  const head = line.slice(0, 120);
  if (!head.includes('"control_') && !head.includes('"keep_alive"')) return true;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return true;
  }
  switch (message?.type) {
    case "keep_alive":
    case "control_response":
      return false;
    case "control_request":
      return message.request?.subtype === "can_use_tool";
    default:
      return true;
  }
}

/**
 * The `canUseTool` result for plxd's `control_response`, which it writes as it wrote it to the
 * CLI before: `{subtype, request_id, response | error}`.
 *
 * @param {any} response
 */
export function permissionResult(response) {
  if (response?.subtype !== "success") {
    return { behavior: "deny", message: String(response?.error ?? "plxd refused the request") };
  }
  const answer = response.response ?? {};
  if (answer.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: answer.updatedInput ?? {},
      ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
    };
  }
  return {
    behavior: "deny",
    message: String(answer.message ?? ""),
    ...(answer.interrupt ? { interrupt: true } : {}),
  };
}

/** The messages plxd sends a query, as the async iterable the SDK reads its prompt from. */
export class Prompt {
  #items = [];
  #waiting;
  #ended = false;

  /** Queues `message`. Returns false once the prompt has ended. */
  push(message) {
    if (this.#ended) return false;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: message, done: false });
    } else this.#items.push(message);
    return true;
  }

  /** Ends the prompt after what is queued, so the CLI exits after its last turn. */
  end() {
    this.#ended = true;
    if (this.#waiting && this.#items.length === 0) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
