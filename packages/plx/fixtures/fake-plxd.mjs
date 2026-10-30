// @ts-check
// A fake `plxd attach` for the connect tests: JSON-RPC on stdio, with the relay behind it faked
// too. FAKE_PLXD is its starting state as JSON, and each request is appended to FAKE_PLXD_LOG as
// a JSON line. A token other than `good-token` is refused, as the relay refuses a bad one.
//
// State: `relay` and `remote` (settings), `registered`, `connects` (false keeps the relay
// unreachable), `pending` (a new device's request), `pairAfterCodes` (the setup code count after
// which a device pairs), and `expiresInMs` (each setup code's life).

import { appendFileSync } from "node:fs";

const HOST_ID = "tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE";
const state = {
  relay: false,
  remote: false,
  registered: false,
  connects: true,
  /** @type {object | undefined} */
  pending: undefined,
  pairAfterCodes: 1,
  expiresInMs: 600_000,
  ...JSON.parse(process.env["FAKE_PLXD"] ?? "{}"),
};
let version = 1;
let codes = 0;
/** @type {string | undefined} */
let setupApproved;
/** @type {(() => void)[]} */
let waiters = [];
const changed = () => {
  version++;
  for (const wake of waiters) wake();
  waiters = [];
};

const access = () => ({
  version,
  account: state.registered ? "user_2abc" : undefined,
  approvedClients: ["NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"],
  removedClients: [],
  approvedHosts: [],
  pending: state.pending,
  setupApproved,
});

/** @type {Record<string, (params: any) => unknown>} */
const methods = {
  initialize: () => ({ plxd: "0.0.0-test", protocol: 1 }),
  "relay/register": ({ token }) => {
    if (token !== "good-token") throw new Error("The relay refused the sign-in. Sign in again.");
    state.registered = true;
    return { sessions: [], listening: state.remote, pairing: false };
  },
  "host/settings/set": (params) => {
    if (params.relay !== undefined) state.relay = params.relay;
    if (params.remote !== undefined) state.remote = params.remote;
    return { autoResume: true, relay: state.relay, remote: state.remote };
  },
  "host/settings/get": () => ({ autoResume: true, relay: state.relay, remote: state.remote }),
  "remote/sessions": () => ({
    sessions: [],
    listening: state.remote,
    pairing: false,
    relay: state.relay
      ? state.connects && state.registered
        ? { connected: true }
        : { connected: false, problem: "Couldn't reach Parallax Relay." }
      : undefined,
  }),
  "relay/hosts": ({ token }) => {
    if (token !== "good-token") throw new Error("The relay refused the sign-in.");
    return { hosts: [{ hostId: HOST_ID, name: "studio", online: true, thisComputer: true }] };
  },
  "relay/id": () => ({ hostId: HOST_ID }),
  "relay/remove": ({ token }) => {
    if (token !== "good-token") throw new Error("The relay refused the sign-in.");
    state.registered = false;
    return { hosts: [] };
  },
  "access/setupCode": () => {
    if (!state.remote) throw new Error("Turn on Reach from anywhere first.");
    codes++;
    setupApproved = undefined;
    changed();
    if (codes === state.pairAfterCodes)
      setTimeout(() => {
        setupApproved = "MacBook Air";
        changed();
      }, 30);
    return { code: `48291${codes}`, expiresAt: new Date(Date.now() + state.expiresInMs).toISOString() };
  },
  "access/get": ({ after }) => {
    if (after === undefined || after !== version) return access();
    return new Promise((resolve) => waiters.push(() => resolve(access())));
  },
  "access/approve": () => {
    state.pending = undefined;
    changed();
    return access();
  },
  "access/deny": () => {
    state.pending = undefined;
    changed();
    return access();
  },
};

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (buffered + chunk).split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line);
    if (process.env["FAKE_PLXD_LOG"]) appendFileSync(process.env["FAKE_PLXD_LOG"], `${JSON.stringify({ method, params })}\n`);
    const handler = methods[method];
    const reply = (/** @type {object} */ body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
    if (!handler) {
      reply({ error: { code: -32601, message: `no method ${method}` } });
      continue;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => reply({ result }),
        (error) => reply({ error: { code: -32602, message: error.message } }),
      );
  }
});
process.stdin.on("end", () => process.exit(0));
