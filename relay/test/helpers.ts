import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { base64url, type HostJwk, sha256, thumbprint } from "../src/crypto";
import { hostMessage, PROOF_HEADER, registerMessage } from "../src/host";
import type { Env } from "../src/index";

export const BASE = "https://relay.test";
export const testEnv = env as Env & { TEST_CLERK_KEY: string };

/** A Clerk session token for `user`, signed by the test JWKS's key. `claims` override. */
export async function session(user: string, claims: Record<string, unknown> = {}) {
  const jwk = JSON.parse(testEnv.TEST_CLERK_KEY) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "RS256", kid: jwk.kid, typ: "JWT" })}.${encode({
    sub: user,
    sid: `sess_${user}`,
    iss: "https://clerk.test",
    iat: now,
    nbf: now,
    exp: now + 60,
    ...claims,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(signature)}`;
}

/** A plxd's host key, as its relay identity. */
export type Host = { id: string; jwk: HostJwk; sign(message: string): Promise<string> };

export async function newHost(): Promise<Host> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const { x, y } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk: HostJwk = { kty: "EC", crv: "P-256", x: x!, y: y! };
  return {
    id: await thumbprint(jwk),
    jwk,
    async sign(message) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(message),
      );
      return base64url(signature);
    },
  };
}

export function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

/** Registers `host` under the user of `token`, as plxd does. */
export async function register(host: Host, token: string, signer: Host = host) {
  const signature = await signer.sign(registerMessage(host.id, await sha256(token)));
  return call("/v1/hosts", {
    method: "POST",
    token,
    body: JSON.stringify({ hostId: host.id, jwk: host.jwk, name: "Ryan's Mac", signature }),
  });
}

/** An accepted WebSocket with its messages in order. */
export type Socket = {
  ws: WebSocket;
  next(): Promise<string | ArrayBuffer>;
  closed: Promise<number>;
};

export async function socket(
  path: string,
  headers: Record<string, string> = {},
): Promise<Socket | Response> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    headers: { upgrade: "websocket", ...headers },
  });
  const ws = response.webSocket;
  if (!ws) return response;
  ws.binaryType = "arraybuffer";
  ws.accept();
  const queue: (string | ArrayBuffer)[] = [];
  const waiters: ((m: string | ArrayBuffer) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event.data);
    else queue.push(event.data);
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  return {
    ws,
    closed,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : Promise.race([
            new Promise<string | ArrayBuffer>((resolve) => waiters.push(resolve)),
            closed.then((code) => Promise.reject(new Error(`closed ${code}`))),
          ]),
  };
}

export function opened(value: Socket | Response): Socket {
  if (value instanceof Response) throw new Error(`not a WebSocket: ${value.status}`);
  return value;
}

let lastProof = 0;

/** plxd's proof for its control socket: a time in milliseconds, newer than any before, signed. */
export async function hostProof(host: Host, signer: Host = host, at?: number) {
  const time = at ?? (lastProof = Math.max(Date.now(), lastProof + 1));
  return `${time}.${await signer.sign(hostMessage(host.id, time))}`;
}

/** Opens plxd's control socket with `proof`: the socket, or the refusal. */
export function hostSocket(host: Host, proof: string) {
  return socket(`/v1/hosts/${host.id}/host`, { [PROOF_HEADER]: proof });
}

/** plxd's control socket, opened with a fresh proof. */
export async function connectHost(host: Host) {
  return { control: opened(await hostSocket(host, await hostProof(host))) };
}

/** A hook frame as plxd reads it: its head and raw body. */
export function hookFrame(frame: ArrayBuffer) {
  const length = new DataView(frame).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(frame.slice(4, 4 + length))) as {
    t: string;
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
  };
  return { head, body: new Uint8Array(frame.slice(4 + length)) };
}
