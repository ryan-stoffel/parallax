/**
 * Maps Cursor SDK tool calls and failures into the lines plxd reads.
 * No SDK import: the tests run this file without loading the agent runtime.
 */

const TOOL_NAMES = {
  shell: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  delete: "Delete",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  semSearch: "Grep",
  mcp: "MCP",
  createPlan: "ExitPlanMode",
  updateTodos: "TodoWrite",
  task: "Task",
  generateImage: "GenerateImage",
  readLints: "ReadLints",
};

const TODO_STATUS = {
  pending: "pending",
  inProgress: "inProgress",
  completed: "completed",
  cancelled: "pending",
};

/** The longest tool output plxd is sent, in characters. */
export const MAX_OUTPUT = 32_000;

/**
 * @param {unknown} toolCall
 * @returns {{ name: string, input: unknown, plan?: string, todos?: { text: string, status: string }[] }}
 */
export function viewTool(toolCall) {
  const call = isRecord(toolCall) ? toolCall : {};
  const type = typeof call.type === "string" ? call.type : "tool";
  const args = isRecord(call.args) ? call.args : {};
  const name = TOOL_NAMES[type] ?? type;
  if (type === "createPlan") {
    const plan = typeof args.plan === "string" ? args.plan : "";
    return { name: "ExitPlanMode", input: { plan }, plan };
  }
  if (type === "shell") {
    return {
      name: "Bash",
      input: {
        command: typeof args.command === "string" ? args.command : "",
        ...(typeof args.workingDirectory === "string" ? { workingDirectory: args.workingDirectory } : {}),
      },
    };
  }
  if (type === "updateTodos" && Array.isArray(args.todos)) {
    return { name, input: args, todos: todosOf(args.todos) };
  }
  return { name, input: args };
}

/**
 * @param {unknown} toolCall
 * @returns {{ status: "ok" | "error", output?: string }}
 */
export function viewResult(toolCall) {
  const call = isRecord(toolCall) ? toolCall : {};
  const result = call.result;
  if (isRecord(result) && result.status === "error") {
    return { status: "error", output: clip(textOf(result.error ?? result)) };
  }
  if (result === undefined) return { status: "ok" };
  return { status: "ok", output: clip(textOf(result)) };
}

/**
 * @param {unknown} error
 * @returns {"notSignedIn" | "rateLimited" | "failed"}
 */
export function failureOf(error) {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  if (name === "AuthenticationError") return "notSignedIn";
  if (name === "RateLimitError") return "rateLimited";
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  if (/not signed in|unauthenticated|invalid api key|401/i.test(message)) return "notSignedIn";
  if (/rate limit|429/i.test(message)) return "rateLimited";
  return "failed";
}

/**
 * @param {string} text
 * @param {unknown[] | undefined} images
 */
export function userMessage(text, images) {
  const message = { text };
  const attached = (images ?? [])
    .filter(isRecord)
    .filter((image) => typeof image.data === "string" && typeof image.mediaType === "string")
    .map((image) => ({ data: image.data, mimeType: image.mediaType }));
  if (attached.length > 0) message.images = attached;
  return message;
}

/**
 * @param {unknown[]} todos
 */
function todosOf(todos) {
  return todos.filter(isRecord).map((todo) => ({
    text: typeof todo.content === "string" ? todo.content : "",
    status: TODO_STATUS[typeof todo.status === "string" ? todo.status : ""] ?? "pending",
  }));
}

function textOf(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(text) {
  if (text === undefined) return undefined;
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
