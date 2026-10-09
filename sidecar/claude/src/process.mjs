/** The SDK's SpawnedProcess interface backed by plxd's existing Rust process supervisor. */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import readline from "node:readline";
import { constants } from "node:os";

export function spawnClaude(supervisor, { command, args, cwd, env, signal }, onFrame) {
  const helper = spawn(supervisor, ["sdk-process", "--", command, ...args], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    // Survive the sidecar's group cleanup long enough to kill the CLI on stdin EOF.
    detached: process.platform !== "win32",
  });
  helper.stdin.on("error", () => {});
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  const send = (message, callback = () => {}) => {
    if (helper.stdin.destroyed) { callback(); return; }
    helper.stdin.write(`${JSON.stringify(message)}\n`, callback);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { send({ stdin: chunk.toString("base64") }, callback); },
    final(callback) { send({ end: true }, callback); },
  });
  child.stdin.on("error", () => {});
  child.kill = () => {
    if (finished) return false;
    child.killed = true;
    send({ kill: true });
    return true;
  };
  let finished = false;
  let stderr = "";
  const finish = (status) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    onFrame({ exit: status });
    child.exitCode = status.code;
    child.signalCode = Object.entries(constants.signals).find(([, value]) => value === status.signal)?.[0] ?? null;
    child.stdout.end();
    child.emit("exit", status.code, child.signalCode);
    helper.stdin.end();
  };
  helper.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
  helper.on("error", (error) => {
    child.emit("error", error);
    finish({ code: null, signal: null, stderr: error.message });
  });
  readline.createInterface({ input: helper.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); }
    catch (error) {
      child.kill();
      finish({ code: null, signal: null, stderr: `Invalid process supervisor frame: ${error.message}` });
      return;
    }
    if (finished) return;
    if (frame.exit) finish(frame.exit);
    else {
      onFrame(frame);
      if (frame.stdout !== undefined) child.stdout.write(Buffer.concat([Buffer.from(frame.stdout, "base64"), Buffer.from("\n")]));
    }
  });
  helper.once("close", () => finish({ code: null, signal: null, stderr: stderr || "Claude process supervisor exited without a status" }));
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return child;
}
