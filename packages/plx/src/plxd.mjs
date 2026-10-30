// @ts-check
// A JSON-RPC connection to the running plxd over `plxd attach`'s stdio, which is plxd's trusted
// local connection, as `doctor` and the app use it. Requests may overlap, so `access/get` can wait
// for a change while another request goes out.

import { readFileSync } from "node:fs";

/** plx's version, for `initialize`. */
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * @typedef {object} Plxd
 * @property {(method: string, params?: object) => Promise<any>} call Sends a request and resolves
 *   to its result, or rejects with plxd's error message.
 * @property {() => void} close Ends `plxd attach`.
 */

/**
 * Speaks JSON-RPC with `child`, a `plxd attach`, and sends `initialize` first. Resolves once plxd
 * answered it.
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<Plxd>}
 */
export async function attach(child) {
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  let next = 1;
  /** @type {Error | undefined} */
  let ended;
  const end = (/** @type {Error} */ error) => {
    ended ??= error;
    for (const { reject } of waiting.values()) reject(ended);
    waiting.clear();
  };
  child.once("error", (error) => end(new Error(`Couldn't start plxd: ${error.message}`)));
  child.once("exit", () => end(new Error("plxd stopped answering.")));
  child.stdin?.on("error", () => {});

  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (/** @type {string} */ chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      /** @type {{ id?: unknown, result?: unknown, error?: { message?: string } }} */
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const request = typeof message.id === "number" ? waiting.get(message.id) : undefined;
      if (!request) continue;
      waiting.delete(/** @type {number} */ (message.id));
      if (message.error) request.reject(new Error(message.error.message ?? "plxd refused the request."));
      else request.resolve(message.result);
    }
  });

  /** @type {Plxd["call"]} */
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ended) return reject(ended);
      const id = next++;
      waiting.set(id, { resolve, reject });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", { protocol: { min: 1, max: 1 }, client: { name: "plx", version: VERSION }, capabilities: {} });
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    call,
    close() {
      child.stdin?.end();
      child.kill();
    },
  };
}
