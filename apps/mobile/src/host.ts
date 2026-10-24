// A computer paired on the LAN (0065), for one without Parallax Connect: pairing with its code,
// its credential in the Keychain, and the pinned socket to its plxd's remote listener, which
// machines.ts connects a WebHost over.

import * as SecureStore from "expo-secure-store";

import { PinnedSocket, request } from "../modules/pinned-tls";
import {
  base64url,
  confirmation,
  fromBase64url,
  newDpopSecret,
  proof,
  same,
  spake,
  thumbprint,
} from "./pairing";

const PORT = 7341;
const KEY = "host";

/** A paired computer: its name, certificate fingerprint, where it listens, and the session. */
export interface Saved {
  name: string;
  fingerprint: string;
  /** In the order they're tried: the one paired over first, then those plxd reported. */
  routes: string[];
  token: string;
  /** The DPoP key's secret, base64url. */
  key: string;
}

// Never restored to another phone from a backup, so the session stays bound to this one.
export const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export async function loadSaved(): Promise<Saved | null> {
  const raw = await SecureStore.getItemAsync(KEY, keychain);
  return raw ? (JSON.parse(raw) as Saved) : null;
}

/** Forgets the paired computer. */
export const forget = () => SecureStore.deleteItemAsync(KEY, keychain);

/** `route` with plxd's port when it has none: `10.0.0.2` is `10.0.0.2:7341`. */
export const withPort = (route: string) => (route.includes(":") ? route : `${route}:${PORT}`);
const url = (route: string, path: string) => `https://${withPort(route)}${path}`;

/** A POST to `path`, pinned to `pin`: its JSON answer, or a pairing error for people. */
async function post(route: string, pin: string, path: string, body: object, headers = {}) {
  const answer = await request(url(route, path), "POST", headers, body, pin);
  if (answer.status === 401)
    throw new Error("That code is wrong, used, or expired. Show a new one.");
  if (answer.status !== 200) throw new Error(`Parallax couldn't pair (${answer.status}).`);
  return JSON.parse(answer.body) as Record<string, unknown>;
}

/**
 * Pairs with the computer at `route` using the code it shows, as `plxd dial` does
 * (daemon/src/remote.rs): learns the certificate that answers, runs SPAKE2 keyed to its
 * fingerprint, and keeps the session only if the host confirms it knows the code too. Resolves to
 * the saved host, or rejects with an error for people.
 */
export async function pair(route: string, code: string, label: string): Promise<Saved> {
  const seen = await request(
    url(route, "/.well-known/parallax"),
    "GET",
    {},
    undefined,
    undefined,
  ).catch(() => {
    throw new Error(
      `Couldn't reach Parallax at ${withPort(route)}. ` +
        "Check the address and that Remote access is on.",
    );
  });
  const fp = seen.fingerprint;
  const exchange = spake(code, fp);
  const started = await post(route, fp, "/api/pair/start", { pake: base64url(exchange.message) });
  const shared = exchange.finish(fromBase64url(String(started["pake"])));
  const secret = newDpopSecret();
  const tp = thumbprint(secret);
  const finished = await post(
    route,
    fp,
    "/api/pair/finish",
    {
      pairing: started["pairing"],
      confirm: base64url(confirmation(shared, "client", fp, tp)),
      clientLabel: label,
    },
    { DPoP: proof(secret, "POST", url(route, "/api/pair/finish")) },
  );
  // Only a host that knows the code can vouch for the certificate this phone saw.
  if (!same(confirmation(shared, "host", fp, tp), fromBase64url(String(finished["confirm"]))))
    throw new Error("Another computer answered at that address. Pairing stopped.");
  const reported = (finished["routes"] as string[] | undefined) ?? [];
  const saved: Saved = {
    name: String(finished["name"] ?? route),
    fingerprint: fp,
    routes: [route, ...reported.filter((r) => withPort(r) !== withPort(route))],
    token: String(finished["accessToken"]),
    key: base64url(secret),
  };
  await SecureStore.setItemAsync(KEY, JSON.stringify(saved), keychain);
  return saved;
}

/**
 * Opens `/ws` on the first of the host's routes that answers with its certificate, with a 30 s
 * ticket for the session, as the web client's `openSocket` does.
 */
export async function pairedSocket(saved: Saved): Promise<WebSocket | { error: string }> {
  const secret = fromBase64url(saved.key);
  let error = `Couldn't reach ${saved.name}. Check that it's on and on this network.`;
  for (const route of saved.routes) {
    const ticketUrl = url(route, "/api/auth/websocket-ticket");
    const headers = {
      Authorization: `DPoP ${saved.token}`,
      DPoP: proof(secret, "POST", ticketUrl, saved.token),
    };
    const answer = await request(ticketUrl, "POST", headers, undefined, saved.fingerprint).catch(
      (e: { code?: string }) => {
        if (e.code === "ERR_WRONG_HOST") error = `Another computer answered at ${withPort(route)}.`;
      },
    );
    if (!answer) continue;
    const body = JSON.parse(answer.body || "{}") as { ticket?: string; error?: string };
    if (body.ticket) {
      const socket = new PinnedSocket(
        `wss://${withPort(route)}/ws?wsTicket=${body.ticket}`,
        saved.fingerprint,
      );
      return socket as unknown as WebSocket;
    }
    if (body.error === "invalid_token") return { error: "revoked" };
    return {
      error:
        answer.status === 401
          ? "Parallax refused this phone's proof. Check that its clock is right."
          : `Parallax couldn't connect (${answer.status}).`,
    };
  }
  return { error };
}
