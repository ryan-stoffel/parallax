// @ts-check
// Finds the T3 Connect tunnel of one `t3 serve`, for t3-compare.mjs (PLX-1452).
//
// T3 0.1.7 runs its relay client, cloudflared 2026.10.4, with `--metrics 127.0.0.1:0`, and reads the
// tunnel's hostname from that metrics server's /config, as this does. This finds the client by
// those answers, not by its name, parent, or pid, so a renamed binary or a restart doesn't lose it.
// Each loopback listener gets one GET /config, and only relay clients get asked again. A client
// counts only when its ingress sends a hostname to this server's port, so a real T3 running on the
// same computer isn't picked.
import { execFileSync } from "node:child_process";

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A local metrics answer, or null when there's none in time. @param {string} url @returns {Promise<any>} */
const getJson = (url) =>
  fetch(url, { signal: AbortSignal.timeout(2000) })
    .then((answer) => answer.json())
    .catch(() => null);

/** The TCP listeners on 127.0.0.1, from lsof, with their pids. */
export function loopbackListeners() {
  let listing;
  try {
    listing = execFileSync("lsof", ["-nP", "-iTCP@127.0.0.1", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" });
  } catch (error) {
    // lsof exits 1 when nothing listens.
    listing = /** @type {{ stdout?: string }} */ (error).stdout ?? "";
  }
  /** @type {{ pid: string, port: string }[]} */
  const found = [];
  let pid = "";
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    const port = /^n.*:(\d+)$/.exec(line)?.[1];
    if (port) found.push({ pid, port });
  }
  return found;
}

/**
 * What the tunnel's public address answers T3's own check: an HTTP status, or an error code such as
 * ENOTFOUND. Never the hostname, which an error's message would quote.
 * @param {string} hostname
 * @returns {Promise<number | string>}
 */
async function publicAnswer(hostname) {
  try {
    return (await fetch(`https://${hostname}/.well-known/t3/environment`, { signal: AbortSignal.timeout(10_000) })).status;
  } catch (error) {
    const failure = /** @type {{ name?: string, cause?: { code?: string } }} */ (error);
    return failure.cause?.code ?? failure.name ?? "an error";
  }
}

/** @param {unknown} service @param {number} port */
function sendsTo(service, port) {
  try {
    return new URL(String(service)).port === String(port);
  } catch {
    return false;
  }
}

const STEPS = [
  "no relay client was listening on 127.0.0.1",
  "a relay client was running, with no hostname yet",
  "no relay client had a hostname for this server's port",
  "this server's relay client had no connection to Cloudflare",
];

/**
 * Waits until the tunnel to `serverPort` answers 200, the way T3 checks it: once the client has a
 * hostname and a connection to Cloudflare, so no lookup goes out before the tunnel exists. Returns
 * the hostname. After `limit` ms it throws with the furthest step it saw, without the hostname.
 * @param {number} serverPort
 * @param {{ limit?: number, listeners?: typeof loopbackListeners, answers?: typeof publicAnswer }} [options]
 */
export async function tunnelHost(serverPort, { limit = 240_000, listeners = loopbackListeners, answers = publicAnswer } = {}) {
  const notClients = new Set();
  let step = 0;
  /** @type {number | string | undefined} */
  let lastAnswer;
  const deadline = Date.now() + limit;
  for (; Date.now() < deadline; await sleep(1000)) {
    for (const { pid, port } of listeners()) {
      const key = `${pid}:${port}`;
      if (notClients.has(key)) continue;
      const config = await getJson(`http://127.0.0.1:${port}/config`);
      /** @type {unknown} */
      const ingress = config?.config?.ingress;
      if (!Array.isArray(ingress)) {
        notClients.add(key);
        continue;
      }
      const named = ingress.filter((rule) => rule?.hostname);
      const hostname = named.find((rule) => sendsTo(rule.service, serverPort))?.hostname;
      step = Math.max(step, named.length ? 2 : 1);
      if (typeof hostname !== "string") continue;
      const ready = await getJson(`http://127.0.0.1:${port}/ready`);
      step = Math.max(step, 3);
      if (!(ready?.readyConnections > 0)) continue;
      lastAnswer = await answers(hostname);
      if (lastAnswer === 200) return hostname;
    }
  }
  const reached = lastAnswer === undefined ? STEPS[step] : `its public address last answered ${lastAnswer}`;
  throw new Error(`T3's tunnel didn't answer in ${Math.round(limit / 60_000)} minutes: ${reached}`);
}
