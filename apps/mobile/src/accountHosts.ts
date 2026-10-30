// The account's computers (0091): listed by Parallax Relay, reached over their LAN, Tailscale, or
// relay routes (routes.ts), each pinned to its host id, and signed in to with the account. A
// signed-in phone whose key a computer approved gets a session there; a new phone is approved
// once, by typing a new computer's setup code or by matching a code on another device (access.ts).
//
// What the phone keeps, in the Keychain on this phone only: one DPoP key for every account host,
// as `plxd dial`'s `device_key`, each host's session, the hosts it trusts, and its request limits.

import * as SecureStore from "expo-secure-store";

import { openRelay, PinnedSocket, randomBytes, request } from "../modules/pinned-tls";
import {
  approvalCode,
  commitment,
  emptyBook,
  forgetRequest,
  keptValue,
  newRequest,
  setupRun,
  type HostBook,
} from "./access";
import { keychain, spakePair } from "./host";
import { base64url, fromBase64url, newDpopSecret, proof, thumbprint } from "./pairing";
import { RELAY_URL } from "./push";
import { isRelay, ordered, race, usable, withPort, WrongHost } from "./routes";

const KEY = "account-hosts";

/** A host the relay lists for the account. */
export interface Listed {
  hostId: string;
  name: string;
  online: boolean;
}

/**
 * Why an account host isn't connecting: it needs setting up, waits on another device that shows
 * `code`, or refused this phone's sign-in.
 */
export type Gate =
  | { kind: "setup" }
  | { kind: "waiting"; code: string }
  | { kind: "refused"; message: string };

interface Stored {
  /** The DPoP key's secret, base64url. */
  key: string;
  /** Each host's session token, by host id. */
  sessions: Record<string, string>;
  /** The hosts this phone uses: approved with its own code, or listed by one it uses. */
  trusted: string[];
  books: Record<string, HostBook>;
}

/** What answers on a route: where requests go, the pin, and how to let it go. */
interface Endpoint {
  route: string;
  base: string;
  pin: string;
  close(): void;
  /** Why a request through it failed, for people, when the relay refused the stream. */
  problem(): string | undefined;
}

/** A host's descriptor (`/.well-known/parallax`), and the certificate's fingerprint. */
interface Described {
  name: string;
  routes: string[];
  fingerprint: string;
}

/** A message for people, for the relay's refusal of a stream. */
function relayProblem(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status === 503) return "That computer is offline or asleep.";
  if (status === 429) return "Too many connections to that computer this minute. Try again shortly.";
  if (status === 401 || status === 403) return "Parallax Relay didn't take this phone's sign-in.";
  if (status === 404) return "Parallax Relay doesn't know that computer. Run plx connect on it.";
  return `Parallax Relay refused the connection (${status}).`;
}

/** The account's hosts, from Parallax Relay with the account's token, or undefined offline. */
export async function listHosts(token: string): Promise<Listed[] | undefined> {
  const answer = await fetch(`${RELAY_URL}/v1/hosts`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  if (!answer?.ok) return undefined;
  const { hosts } = (await answer.json()) as { hosts: Listed[] };
  return hosts;
}

export class AccountHosts {
  private constructor(
    private stored: Stored,
    /** A Clerk access token: a fresh one for a host, never sent twice, else the current one. */
    private readonly token: (fresh?: boolean) => Promise<string | undefined>,
    /** This phone's name, as hosts list it. */
    readonly label: string,
  ) {}

  static async load(token: (fresh?: boolean) => Promise<string | undefined>, label: string) {
    const raw = await SecureStore.getItemAsync(KEY, keychain).catch(() => null);
    const stored: Stored = raw
      ? (JSON.parse(raw) as Stored)
      : { key: base64url(newDpopSecret()), sessions: {}, trusted: [], books: {} };
    const hosts = new AccountHosts(stored, token, label);
    if (!raw) await hosts.save();
    return hosts;
  }

  private save() {
    return SecureStore.setItemAsync(KEY, JSON.stringify(this.stored), keychain);
  }

  private get secret() {
    return fromBase64url(this.stored.key);
  }

  /** This phone's DPoP key thumbprint, which hosts approve. */
  get thumbprint() {
    return thumbprint(this.secret);
  }

  /** The hosts this phone uses and has sessions with. */
  get sessions() {
    return Object.keys(this.stored.sessions).filter((id) => this.trusts(id));
  }

  /** Whether this phone uses `hostId`: approved with its own code, or listed by a host it uses. */
  trusts(hostId: string) {
    return this.stored.trusted.includes(hostId);
  }

  /** Trusts `hostIds` too, as a host this phone uses listed them, or a tailnet host vouched. */
  async trust(hostIds: string[]) {
    const added = hostIds.filter((id) => !this.stored.trusted.includes(id));
    if (!added.length) return;
    this.stored = { ...this.stored, trusted: [...this.stored.trusted, ...added] };
    await this.save();
  }

  private book(hostId: string) {
    return this.stored.books[hostId] ?? emptyBook();
  }

  private async setBook(hostId: string, book: HostBook) {
    this.stored = { ...this.stored, books: { ...this.stored.books, [hostId]: book } };
    await this.save();
  }

  private async setSession(hostId: string, token: string | undefined) {
    const sessions = { ...this.stored.sessions };
    if (token) sessions[hostId] = token;
    else delete sessions[hostId];
    this.stored = { ...this.stored, sessions };
    await this.save();
  }

  /** A way to `route`: directly, or through a relay bridge whose streams open with the account. */
  private async reach(route: string, hostId: string): Promise<Endpoint> {
    const pin = `key:${hostId}`;
    if (!isRelay(route)) {
      const base = `https://${withPort(route)}`;
      return { route, base, pin, close: () => {}, problem: () => undefined };
    }
    const token = await this.token();
    if (!token) throw new Error("Sign in to reach your computers through Parallax Relay.");
    const relay = RELAY_URL.replace(/^http/, "ws");
    const bridge = await openRelay(`${relay}/v1/hosts/${hostId}/connect`, token);
    return {
      route,
      base: `https://127.0.0.1:${bridge.port}`,
      pin,
      close: bridge.close,
      problem: () => relayProblem(bridge.refused()),
    };
  }

  /** One request to `path` at `at`, with its JSON answer. */
  private async call(
    at: Endpoint,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: object,
    timeout?: number,
  ) {
    const answer = await request(`${at.base}${path}`, method, headers, body, at.pin, timeout).catch(
      (e: { code?: string; message?: string }) => {
        if (e.code === "ERR_WRONG_HOST") throw new WrongHost("Another computer answered for that one.");
        throw new Error(at.problem() ?? "Couldn't reach that computer.");
      },
    );
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(answer.body || "{}") as Record<string, unknown>;
    } catch {}
    return { status: answer.status, json, fingerprint: answer.fingerprint };
  }

  /** The descriptor at `at`, which sends no credential: how a route proves it reaches the host. */
  private async describe(at: Endpoint): Promise<Described> {
    const { status, json, fingerprint } = await this.call(at, "GET", "/.well-known/parallax", {});
    if (status !== 200) throw new Error(`That computer answered ${status}.`);
    const routes = Array.isArray(json["routes"]) ? (json["routes"] as string[]) : [];
    return { name: String(json["name"] ?? ""), routes, fingerprint };
  }

  /**
   * The first of `routes` to answer as `hostId`, as routes.ts races them, with its descriptor.
   * Only the winner is kept; the caller closes it.
   */
  private async first(hostId: string, routes: string[]) {
    const { value } = await race(
      routes,
      async (route) => {
        const at = await this.reach(route, hostId);
        try {
          return { at, described: await this.describe(at) };
        } catch (e) {
          at.close();
          throw e;
        }
      },
      ({ at }) => at.close(),
    );
    return value;
  }

  /**
   * Which of `routes`' direct routes answers as `hostId` now, if any, for moving a connection off
   * the relay. Sends no credential.
   */
  async recheck(hostId: string, routes: string[], failedAt: Record<string, number>) {
    const direct = usable(ordered(hostId, routes), failedAt, Date.now()).filter((r) => !isRelay(r));
    if (!direct.length) return undefined;
    const found = await this.first(hostId, direct).catch(() => undefined);
    found?.at.close();
    return found?.at.route;
  }

  /**
   * Opens `/ws` on `hostId`'s first route to answer, with its session's proof on the upgrade, or
   * a new session from a fresh sign-in when it has none or plxd refused it. Resolves to the open
   * socket and its route, with the routes the host reports through `learn`; to a `Gate` when it
   * needs setting up or approving; or to an error for people.
   */
  async open(
    hostId: string,
    learned: string[],
    failedAt: Record<string, number>,
    learn: (routes: string[], name: string) => void,
  ): Promise<{ socket: PinnedSocket; route: string } | { gate: Gate } | { error: string }> {
    let found;
    try {
      found = await this.first(hostId, usable(ordered(hostId, learned), failedAt, Date.now()));
    } catch (e) {
      return { error: (e as Error).message };
    }
    const { at, described } = found;
    learn(described.routes, described.name);
    const opened = (socket: PinnedSocket) => {
      socket.onEnd = at.close;
      return { socket, route: at.route };
    };
    try {
      const saved = this.stored.sessions[hostId];
      if (saved) {
        const upgraded = await this.upgrade(at, saved);
        if ("socket" in upgraded) return opened(upgraded.socket);
        if (upgraded.status !== 401) throw new Error(at.problem() ?? "Couldn't reach that computer.");
        // plxd no longer knows the session, as after a restore: sign in again.
        await this.setSession(hostId, undefined);
      }
      const signed = await this.signIn(at, hostId, false);
      if ("gate" in signed) {
        at.close();
        return { gate: signed.gate };
      }
      const upgraded = await this.upgrade(at, signed.session);
      if ("socket" in upgraded) return opened(upgraded.socket);
      throw new Error(at.problem() ?? "That computer refused this phone's new session.");
    } catch (e) {
      at.close();
      // A refusal won't change by retrying, so it waits for the user.
      if (e instanceof Refused) return { gate: { kind: "refused", message: e.message } };
      // The route answered, then failed: it waits its cool-down before it's tried again.
      if (!isRelay(at.route)) failedAt[at.route] = Date.now();
      return { error: (e as Error).message };
    }
  }

  /** `/ws` at `at` with session `token`, once it opened, or the status that refused it. */
  private upgrade(at: Endpoint, token: string): Promise<{ socket: PinnedSocket } | { status?: number }> {
    const headers = {
      Authorization: `DPoP ${token}`,
      DPoP: proof(this.secret, "GET", `${at.base}/ws`, token),
    };
    const socket = new PinnedSocket(`${at.base.replace(/^https/, "wss")}/ws`, at.pin, headers);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.close();
        resolve({});
      }, 15_000);
      socket.onopen = () => {
        clearTimeout(timer);
        socket.onopen = socket.onclose = undefined;
        resolve({ socket });
      };
      socket.onclose = () => {
        clearTimeout(timer);
        resolve({ status: socket.refusedWith });
      };
    });
  }

  /**
   * Signs in at `at` with a fresh Clerk token. An approved key gets a session, kept. Otherwise the
   * host holds a request: with a value this phone kept for it, it goes on; with none, it starts
   * one only when the user `ask`ed, and both ends then show its code.
   */
  private async signIn(
    at: Endpoint,
    hostId: string,
    ask: boolean,
  ): Promise<{ session: string } | { gate: Gate; request?: string }> {
    const token = await this.token(true);
    if (!token) throw new Error("Sign in to Parallax again.");
    const path = "/api/auth/account";
    const { status, json } = await this.call(
      at,
      "POST",
      path,
      { DPoP: proof(this.secret, "POST", `${at.base}${path}`, token) },
      { token, clientLabel: this.label },
    );
    // Already approved: trusted only if it already was, by a code or a host this phone uses.
    if (status === 200) return this.approved(hostId, json, false);
    if (status === 401 || status === 403)
      throw new Refused(describeRefusal(json) ?? "That computer refused this phone's sign-in.");
    if (status !== 202) throw new Error(describeRefusal(json) ?? `That computer answered ${status}.`);
    const requestId = String(json["request"]);
    const committed = String(json["commitment"]);
    const now = Date.now();
    let value = keptValue(this.book(hostId), requestId, committed, now);
    if (!value) {
      if (!ask) return { gate: { kind: "setup" } };
      const started = newRequest(this.book(hostId), requestId, committed, now, randomBytes);
      await this.setBook(hostId, started.book);
      value = started.value;
    }
    const step = await this.approval(at, { request: requestId, value: base64url(value) });
    if ("session" in step) return this.approved(hostId, step.session, true);
    // Only now does the host show its value, which must be the one it committed to.
    const hostValue = fromBase64url(String(step.pending["value"] ?? ""));
    if (commitment(hostValue) !== committed) throw new WrongHost("Another computer answered for that one.");
    const code = approvalCode(hostValue, value, hostId, this.thumbprint);
    return { gate: { kind: "waiting", code }, request: requestId };
  }

  /** One `/api/auth/approval` call: the session once approved, else the waiting answer. */
  private async approval(
    at: Endpoint,
    body: object,
    wait = false,
  ): Promise<{ session: Record<string, unknown> } | { pending: Record<string, unknown> }> {
    const path = "/api/auth/approval";
    const { status, json } = await this.call(
      at,
      "POST",
      path,
      { DPoP: proof(this.secret, "POST", `${at.base}${path}`) },
      { ...body, wait },
      wait ? 40 : 10,
    );
    if (status === 200) return { session: json };
    if (status === 202) return { pending: json };
    throw new Refused(describeRefusal(json) ?? "That computer refused the request.");
  }

  /**
   * Keeps the session in `answer`, and trusts its host when the user approved it with a code on
   * this phone: typed it, or matched it on another device.
   */
  private async approved(hostId: string, answer: Record<string, unknown>, byCode: boolean) {
    const session = String(answer["accessToken"] ?? "");
    if (!session) throw new Error("That computer sent no session.");
    const { trusted } = this.stored;
    this.stored = {
      ...this.stored,
      sessions: { ...this.stored.sessions, [hostId]: session },
      trusted: byCode && !trusted.includes(hostId) ? [...trusted, hostId] : trusted,
      books: { ...this.stored.books, [hostId]: forgetRequest(this.book(hostId)) },
    };
    await this.save();
    return { session };
  }

  /**
   * Asks to use `hostId` as a new device, because the user asked: signs in and starts a request,
   * or goes on with the one it kept. Resolves once approved, after `onCode` shows the code to
   * match on another device. Rejects when it's denied or lapses, with a message for people.
   */
  async ask(hostId: string, learned: string[], onCode: (code: string) => void): Promise<void> {
    const { at } = await this.first(hostId, ordered(hostId, learned));
    try {
      const signed = await this.signIn(at, hostId, true);
      if ("session" in signed)
        throw new Error("That computer already approved this phone. Enter its setup code to use it.");
      if (signed.gate.kind !== "waiting" || !signed.request) throw new Error("That computer didn't start a request.");
      onCode(signed.gate.code);
      for (;;) {
        const step = await this.approval(at, { request: signed.request }, true).catch(async (e: unknown) => {
          // Denied or lapsed: the user may ask again, which starts a new request, counted.
          if (e instanceof Refused) await this.setBook(hostId, forgetRequest(this.book(hostId)));
          throw e;
        });
        if ("session" in step) {
          await this.approved(hostId, step.session, true);
          return;
        }
      }
    } finally {
      at.close();
    }
  }

  /**
   * Sets up `hostId` with the code `plx connect` shows on it: one SPAKE2 run, pinned to the host
   * id, which approves this phone's key there and this phone's trust in the host. The code is
   * used once whatever happens, and at most 5 runs an hour go to one host.
   */
  async setup(hostId: string, learned: string[], code: string): Promise<void> {
    const { at, described } = await this.first(hostId, ordered(hostId, learned));
    try {
      await this.setBook(hostId, setupRun(this.book(hostId), Date.now()));
      const at_ = (path: string) => `${at.base}${path}`;
      const finished = await spakePair(at_, at.pin, described.fingerprint, code, this.secret, this.label).catch(
        (e: Error) => {
          throw new Error(at.problem() ?? e.message);
        },
      );
      await this.approved(hostId, finished, true);
    } finally {
      at.close();
    }
  }
}

/** A sign-in or request the host refused: this phone needs setting up or approving again. */
class Refused extends Error {}

const describeRefusal = (json: Record<string, unknown>) =>
  typeof json["error_description"] === "string" ? json["error_description"] : undefined;
