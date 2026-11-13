// The account's computers (0091): listed by Parallax Relay, reached over their LAN or relay routes
// (routes.ts), each pinned to its host id, and signed in to with the account. A signed-in phone
// whose key a computer approved gets a session there; a new phone is approved
// once, by typing a new computer's setup code or by matching a code on another device (access.ts).
//
// What the phone keeps, in the Keychain on this phone only: one DPoP key for every account host,
// as `plxd dial`'s `device_key`, each host's session, the hosts it trusts, and its request limits.

import * as SecureStore from "expo-secure-store";
import { t } from "i18next";

import { openRelay, PinnedSocket, randomBytes, request } from "../modules/pinned-tls";
import {
  approvalCode,
  commitment,
  emptyBook,
  forgetRequest,
  keptValue,
  keyStandingIn,
  merged,
  newRequest,
  provedAmong,
  REQUEST_LIFETIME_MS,
  setupRun,
  sourcesFor,
  type HostBook,
  type Known,
  type Lists,
} from "./access";
import { msg } from "../../desktop/src/i18n";
import type { KeyStanding } from "../../desktop/src/preload/bridge";
import type { RelayUsage } from "../../desktop/src/protocol/generated/protocol";
import { relayCapNotice } from "../../desktop/src/renderer/relayCap";
import { keychain, spakePair } from "./host";
import { base64url, fromBase64url, newDpopSecret, proof, thumbprint } from "./pairing";
import { RELAY_URL } from "./push";
import { inOrder, routesAhead, type RouteChoices } from "../../desktop/src/preload/routeList";
import { isRelay, ordered, race, usable, withPort, worthChecking, WrongHost } from "./routes";
import type { RelayEnd } from "../modules/pinned-tls";

const KEY = "account-hosts";

/** How long a request through the relay waits, seconds: its stream opens first. */
const RELAY_TIMEOUT_S = 30;

/** A host the relay lists for the account. */
export interface Listed {
  hostId: string;
  name: string;
  online: boolean;
  /** Its traffic against the relay's daily cap. An older relay leaves it out. */
  usage?: RelayUsage;
}

/** The relay's list: the account's hosts, and those marked as having left it. */
export interface HostList {
  hosts: Listed[];
  removed: string[];
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
  /** Those added with Allow alone, here or as a proved computer said, which add to no lists. */
  allowed?: string[];
  /**
   * Those set up with a code typed here, the only ones this phone itself knows are real. One that
   * signed it in with no tap may be a fake one the relay listed. A phone from before this field
   * has none, as it kept no record of how it came to trust a computer.
   */
  proved?: string[];
  /**
   * Those a computer in `proved` or paired on the LAN approves, by pinned id, kept so starting over
   * can tell them with nothing connected. Only these and `proved` count for it.
   */
  verified?: string[];
  books: Record<string, HostBook>;
  /** Why this phone stopped asking on its own, until the user asks again. */
  askingStopped?: string;
  /** Keys this phone started over from, which it copies to the removed lists, so they can't return. */
  retired?: string[];
}

/** Why a computer refuses a removed key's sign-in, as `DEVICE_REMOVED` in plxd says it. */
const DEVICE_REMOVED = "this device was removed";

/** What answers on a route: where requests go, the pin, and how to let it go. */
interface Endpoint {
  route: string;
  base: string;
  pin: string;
  close(): void;
  /** Why a request through it failed, for people, when the relay refused the stream. */
  problem(): string | undefined;
  /** How the relay last closed a stream through it, for the connection log. */
  relayEnd(): RelayEnd | undefined;
}

/** A host's descriptor (`/.well-known/parallax`), and the certificate's fingerprint. */
interface Described {
  name: string;
  routes: string[];
  fingerprint: string;
}

/** What to say about computer `name`'s traffic through Parallax Relay today, if anything. */
export const relayCap = (name: string, usage: RelayUsage | undefined) =>
  relayCapNotice(name, usage, (at) =>
    new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  );

/**
 * A message for people, for the relay's refusal of a stream. The relay answers 429 both for too
 * many streams this minute and for a spent day, and the bridge sees only the status, so `usage`, as
 * the account's list last said, tells them apart.
 */
export function relayProblem(status: number | undefined, usage?: RelayUsage): string | undefined {
  if (status === undefined) return undefined;
  if (status === 503) return t("That computer is offline or asleep.");
  if (status === 429) {
    const cap = relayCap(t("That computer"), usage);
    return cap?.reached ? cap.body : t("Too many connections to that computer this minute. Try again shortly.");
  }
  if (status === 401 || status === 403) return t("Parallax Connect didn't take this phone's sign-in.");
  if (status === 404) return t("Parallax Connect doesn't know that computer. Run npx plx-cli connect --channel nightly on it.");
  return t("Parallax Connect refused the connection ({{status}}).", { status });
}

/** What the account's list last said of each host's cap, for a refusal of its stream. */
const lastUsage = new Map<string, RelayUsage | undefined>();

/**
 * The account's list, from Parallax Relay with the account's token, or undefined when the read
 * failed. A relay from before `removed` marks nothing, and a host in both counts as removed.
 */
export async function listHosts(token: string): Promise<HostList | undefined> {
  const answer = await fetch(`${RELAY_URL}/v1/hosts`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  if (!answer?.ok) return undefined;
  const body = (await answer.json().catch(() => undefined)) as Partial<HostList> | undefined;
  if (!Array.isArray(body?.hosts)) return undefined;
  for (const host of body.hosts) lastUsage.set(host.hostId, host.usage);
  const removed = body.removed ?? [];
  return { hosts: body.hosts.filter((h) => !removed.includes(h.hostId)), removed };
}

export class AccountHosts {
  /**
   * Whether this phone's key needs replacing, as a verified computer said. Not saved: they say so
   * again, and it ends when the key does.
   */
  standing?: KeyStanding;
  /** The last sign-in to send a token, which the next waits for. */
  private turn: Promise<unknown> = Promise.resolve();

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

  /** The hosts added with Allow alone, here or as a proved computer said, kept for good. */
  get allowed() {
    return this.stored.allowed ?? [];
  }

  private get proved() {
    return this.stored.proved ?? [];
  }

  /** Whether this phone uses `hostId`: approved with its own code, or listed by a host it uses. */
  trusts(hostId: string) {
    return this.stored.trusted.includes(hostId);
  }

  /**
   * Whether this phone uses any account computer yet. A session counts, not trust alone, as a
   * computer paired on the LAN can list hosts this phone was never approved on.
   */
  get usesAny() {
    return this.sessions.length > 0;
  }

  /** Why asking on its own ended, as a denied or lapsed request did, until the user asks again. */
  get askingStopped() {
    return this.stored.askingStopped;
  }

  async stopAsking(why: string) {
    this.stored = { ...this.stored, askingStopped: why };
    await this.save();
  }

  /**
   * The user asked again: this phone may ask on its own again. A request that
   * ended was forgotten when it did, and one still waiting stays, as its host holds its value.
   */
  async resumeAsking() {
    const { askingStopped: _, ...rest } = this.stored;
    this.stored = rest;
    await this.save();
  }

  /** Whether this phone started a request at `hostId` that it hasn't heard the end of. */
  asked(hostId: string) {
    return !!this.book(hostId).kept;
  }

  /** Whether `hostId` can still be holding this phone's request, so it's worth waiting for. */
  waiting(hostId: string) {
    const { kept } = this.book(hostId);
    return !!kept && kept.until > Date.now();
  }

  /** Whether this phone started a request anywhere that it hasn't heard the end of. */
  private get askedAny() {
    return Object.values(this.stored.books).some((book) => book.kept);
  }

  /**
   * Takes in the lists of the computers this phone reaches: each one's `union` to copy back to it,
   * by `sourcesFor`, and it trusts the hosts any of them lists. That trust only lets this phone use
   * a host, and a fake one gains nothing on a real computer from it. A LAN pairing proves a computer
   * as a typed code does. A proved computer's restrictions are kept here with that trust, in one
   * write, as it may be offline next time. Another computer's aren't, as a fake one could then
   * restrict a real one, and those count only for the computer that holds them.
   */
  async absorb<T extends Known>(known: T[]): Promise<(T & { union: Lists })[]> {
    const marks = known
      .filter((each) => (each.paired || this.proved.includes(each.id)) && !this.allowed.includes(each.id))
      .flatMap((each) => each.lists.allowedHosts ?? []);
    const allowed = [...new Set([...this.allowed, ...marks])];
    // Only a computer this phone's own record proves may lead the user to start over, as any other
    // may be a fake one.
    const proved = provedAmong(known, [...this.proved, ...(this.stored.verified ?? [])], allowed);
    for (const { lists } of proved.sources) this.mark(keyStandingIn(this.thumbprint, lists));
    const verified = [...new Set([...(this.stored.verified ?? []), ...proved.ids])].filter(
      (id) => !proved.marked.has(id),
    );
    const listed = known
      .filter((each) => !allowed.includes(each.id))
      .flatMap((each) => [...each.lists.approvedHosts, ...(each.lists.allowedHosts ?? [])]);
    const trusted = [...new Set([...this.stored.trusted, ...listed])];
    if (
      trusted.length !== this.stored.trusted.length ||
      allowed.length !== this.allowed.length ||
      verified.join() !== (this.stored.verified ?? []).join()
    ) {
      this.stored = { ...this.stored, trusted, allowed, verified };
      await this.save();
    }
    const retired = { approvedClients: [], removedClients: this.stored.retired ?? [], approvedHosts: [] };
    return known.map((each) => ({
      ...each,
      union: merged(
        [...sourcesFor(each, known, this.proved, allowed).map((source) => source.lists), retired],
        this.proved,
        allowed,
      ),
    }));
  }

  /** Whether this phone's own record proves computer `hostId`: a typed or LAN code, or what those approve. */
  private isVerified(hostId: string) {
    const record = [...this.proved, ...(this.stored.verified ?? [])];
    return record.includes(hostId) && !this.allowed.includes(hostId);
  }

  /**
   * Which of `listed` this phone may ask on its own. After starting over, only those its own record
   * proves: the relay picks the list, and a fake computer mustn't catch a token while the user
   * expects a prompt.
   */
  askable<T extends { hostId: string }>(listed: T[]): T[] {
    if (!this.stored.retired?.length) return listed;
    return listed.filter((l) => this.trusts(l.hostId) && this.isVerified(l.hostId));
  }

  /**
   * Whether a connection may sign in to `hostId`, which sends it a fresh token: any computer this
   * phone trusts. While a new key still has no session, only what `askable` lets it ask, as another
   * computer's list can name a fake one while the user expects a prompt.
   */
  mayConnect(hostId: string) {
    return this.trusts(hostId) && !this.heldBack(hostId);
  }

  /** Whether `hostId` gets no fresh token now, as a new key has no session and it isn't verified. */
  private heldBack(hostId: string) {
    return !!this.stored.retired?.length && !this.usesAny && !this.isVerified(hostId);
  }

  /** Keeps what a computer said of this phone's key. A removal outranks read-only. */
  private mark(said: KeyStanding | undefined) {
    if (said === "removed" || (said && !this.standing)) this.standing = said;
  }

  /**
   * Replaces this phone's key, for one a verified computer says is removed or read-only (0091), and
   * drops its sessions and the values of its waiting requests. `absorb` then copies the old key to
   * the removed lists once the new one has a session. It keeps trusting only the computers its own
   * record proves, so it asks only them, and any other waits for a tap, so a fake one catches no
   * token while the user expects a prompt. The hour's counts stay, so this resets no limit. Nothing
   * approves the new key. It's saved first: a failed save leaves the old key in use. With no mark to
   * act on, as on a second tap, it does nothing, and answers false.
   */
  async startOver() {
    const standing = this.standing;
    if (!standing) return false;
    this.standing = undefined;
    const { askingStopped: _, ...rest } = this.stored;
    const next: Stored = {
      ...rest,
      key: base64url(newDpopSecret()),
      sessions: {},
      trusted: rest.trusted.filter((id) => this.isVerified(id)),
      books: Object.fromEntries(Object.entries(rest.books).map(([id, book]) => [id, forgetRequest(book)])),
      retired: [...(rest.retired ?? []), this.thumbprint],
    };
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify(next), keychain);
    } catch (e) {
      this.standing = standing;
      throw e;
    }
    this.stored = next;
    return true;
  }

  /** `run`, once any earlier one has ended, so each computer gets its fresh token alone. */
  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => {});
    return next;
  }

  /**
   * Lets go of `hostIds`, which left the account (0091): their sessions, trust, and waiting
   * requests. Their counts stay, since the relay names who left and shouldn't reset a limit.
   */
  async forget(hostIds: string[]) {
    const { sessions, trusted, books } = this.stored;
    const held = hostIds.filter((id) => sessions[id] || trusted.includes(id) || books[id]?.kept);
    if (!held.length) return;
    this.stored = {
      ...this.stored,
      sessions: Object.fromEntries(Object.entries(sessions).filter(([id]) => !held.includes(id))),
      trusted: trusted.filter((id) => !held.includes(id)),
      proved: this.proved.filter((id) => !held.includes(id)),
      verified: (this.stored.verified ?? []).filter((id) => !held.includes(id)),
      books: Object.fromEntries(
        Object.entries(books).map(([id, book]) => [id, held.includes(id) ? forgetRequest(book) : book]),
      ),
    };
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
      return {
        route,
        base,
        pin,
        close: () => {},
        problem: () => undefined,
        relayEnd: () => undefined,
      };
    }
    const token = await this.token();
    if (!token) throw new Error(t("Sign in to reach your computers through Parallax Connect."));
    const relay = RELAY_URL.replace(/^http/, "ws");
    const bridge = await openRelay(`${relay}/v1/hosts/${hostId}/connect`, token);
    return {
      route,
      base: `https://127.0.0.1:${bridge.port}`,
      pin,
      close: bridge.close,
      problem: () => relayProblem(bridge.refused(), lastUsage.get(hostId)),
      relayEnd: bridge.closedWith,
    };
  }

  /** One request to `path` at `at`, with its JSON answer. A relay stream can take seconds to open. */
  private async call(
    at: Endpoint,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: object,
    timeout = isRelay(at.route) ? RELAY_TIMEOUT_S : undefined,
  ) {
    const answer = await request(`${at.base}${path}`, method, headers, body, at.pin, timeout).catch(
      (e: { code?: string; message?: string }) => {
        if (e.code === "ERR_WRONG_HOST") throw new WrongHost(t("Another computer answered for that one."));
        throw new Error(at.problem() ?? t("Couldn't reach that computer."));
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
    if (status !== 200) throw new Error(t("That computer answered {{status}}.", { status }));
    const routes = Array.isArray(json["routes"]) ? (json["routes"] as string[]) : [];
    return { name: String(json["name"] ?? ""), routes, fingerprint };
  }

  /**
   * The first of `routes` to answer as `hostId`, as routes.ts races them, with its descriptor. Each
   * is pinned to `hostId`, and the descriptor sends no credential, so an address the user added
   * gets nothing unless it holds the host's key. Only the winner is kept; the caller closes it.
   */
  private async first(hostId: string, routes: string[], byOrder = false) {
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
      byOrder,
    );
    return value;
  }

  /**
   * Which route a connection on `route` should move to, if any: the first ahead of it to answer as
   * `hostId` now. Sends no credential.
   */
  async recheck(hostId: string, choices: RouteChoices, route: string, failedAt: Record<string, number>) {
    const ahead = routesAhead(ordered(hostId, choices), route, inOrder(choices));
    const routes = worthChecking(ahead, failedAt, Date.now());
    if (!routes.length) return undefined;
    const found = await this.first(hostId, routes, inOrder(choices)).catch(() => undefined);
    found?.at.close();
    return found?.at.route;
  }

  /**
   * Opens `/ws` on `hostId`'s first route to answer, with its session's proof on the upgrade, or
   * a new session from a fresh sign-in when it has none or plxd refused it. Resolves to the open
   * socket and its route, with the routes the host reports through `learn`; to a `Gate` when it
   * needs setting up or approving; or to an error for people. `only` is the route a re-check found,
   * for moving to it: a dial of it alone, so a slower route above a working one can't lose the race
   * and be moved to again at every re-check.
   */
  async open(
    hostId: string,
    choices: RouteChoices,
    failedAt: Record<string, number>,
    learn: (routes: string[], name: string) => void,
    only?: string,
  ): Promise<{ socket: PinnedSocket; route: string } | { gate: Gate } | { error: string }> {
    let found;
    try {
      const routes = only ? [only] : usable(ordered(hostId, choices), failedAt, Date.now());
      found = await this.first(hostId, routes, inOrder(choices));
    } catch (e) {
      return { error: (e as Error).message };
    }
    const { at, described } = found;
    learn(described.routes, described.name);
    const opened = (socket: PinnedSocket) => {
      socket.onEnd = () => {
        // Read first: closing the bridge forgets it.
        socket.relayEnd = at.relayEnd();
        at.close();
      };
      return { socket, route: at.route };
    };
    try {
      const saved = this.stored.sessions[hostId];
      if (saved) {
        const upgraded = await this.upgrade(at, saved);
        if ("socket" in upgraded) return opened(upgraded.socket);
        if (upgraded.status !== 401) throw new Error(at.problem() ?? t("Couldn't reach that computer."));
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
      throw new Error(at.problem() ?? t("That computer refused this phone's new session."));
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
   * one only when the user `ask`ed, and both ends then show its code. With `compare`, a host that
   * answers with a session at once showed no code to compare, so it's refused and nothing is kept.
   */
  private async signIn(
    at: Endpoint,
    hostId: string,
    ask: boolean,
    compare = false,
  ): Promise<{ session: string } | { gate: Gate; request?: string }> {
    const path = "/api/auth/account";
    const { status, json } = await this.inTurn(async () => {
      // The one place a sign-in gets a token, so it holds however the caller got here, as when a
      // computer held its descriptor's answer across starting over.
      if (this.heldBack(hostId)) throw new Refused(t(HELD_BACK));
      const key = this.stored.key;
      const token = await this.token(true);
      if (!token) throw new Error(t("Sign in to Parallax again."));
      // Starting over replaced the key meanwhile, and decides which computers get a token.
      if (this.stored.key !== key) throw new Error(t("This phone started over."));
      const answer = await this.call(
        at,
        "POST",
        path,
        { DPoP: proof(this.secret, "POST", `${at.base}${path}`, token) },
        { token, clientLabel: this.label },
      );
      // That answer is for the old key, and says nothing of the new one.
      if (this.stored.key !== key) throw new Error(t("This phone started over."));
      return answer;
    });
    // Already approved: trusted only if it already was, by a code or a host this phone uses, or if
    // this phone asked, and was allowed while it couldn't hear. That Allow may have come from any
    // of them, as it covers them all.
    if (status === 200 && compare) throw new Denied(t(NO_CODE));
    if (status === 200) return this.approved(hostId, json, this.askedAny);
    if (status === 401 || status === 403) {
      // Any computer this phone's own record doesn't prove may be a fake one.
      if (status === 403 && describeRefusal(json) === DEVICE_REMOVED && this.isVerified(hostId))
        this.mark("removed");
      throw new Refused(describeRefusal(json) ?? t("That computer refused this phone's sign-in."));
    }
    if (status !== 202) throw new Error(describeRefusal(json) ?? t("That computer answered {{status}}.", { status }));
    const requestId = String(json["request"]);
    const committed = String(json["commitment"]);
    const now = Date.now();
    let value: Uint8Array | undefined;
    try {
      value = keptValue(this.book(hostId), requestId, committed, now);
    } catch (e) {
      if (!ask || !(e instanceof WrongHost)) throw e;
      // A new request there means the one this phone kept ended, denied while it couldn't hear.
      throw new Denied(t("That request wasn't allowed."));
    }
    if (!value) {
      if (!ask) return { gate: { kind: "setup" } };
      // One this phone kept has lapsed, so it ended while the phone couldn't hear.
      if (this.asked(hostId)) throw new Denied(t(LAPSED));
      const started = newRequest(this.book(hostId), requestId, committed, now, randomBytes);
      await this.setBook(hostId, started.book);
      value = started.value;
    }
    const step = await this.approval(at, { request: requestId, value: base64url(value) });
    if ("session" in step) {
      if (compare) throw new Denied(t(NO_CODE));
      return this.approved(hostId, step.session, true);
    }
    // Only now does the host show its value, which must be the one it committed to.
    const hostValue = fromBase64url(String(step.pending["value"] ?? ""));
    if (commitment(hostValue) !== committed) throw new WrongHost(t("Another computer answered for that one."));
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
      wait ? 40 : RELAY_TIMEOUT_S,
    );
    if (status === 200) return { session: json };
    if (status === 202) return { pending: json };
    throw new Denied(describeRefusal(json) ?? t("That request wasn't allowed."));
  }

  /**
   * Keeps the session in `answer`, and trusts its host when the user approved it with a code on
   * this phone: typed it, or matched it on another device. That ends any other request and any
   * stop, since it covers every computer. `how` says what the user did here: `tapped` marks one
   * allowed with a tap on its code alone, which adds to no lists, and `typed` proves one set up with
   * its typed code. Without it, the phone can't tell who approved it, or if anyone did.
   */
  private async approved(
    hostId: string,
    answer: Record<string, unknown>,
    byCode: boolean,
    how?: "tapped" | "typed",
  ) {
    const session = String(answer["accessToken"] ?? "");
    if (!session) throw new Error(t("That computer sent no session."));
    const { trusted, books, allowed = [] } = this.stored;
    this.stored = {
      ...this.stored,
      sessions: { ...this.stored.sessions, [hostId]: session },
      ...(how === "tapped" && !allowed.includes(hostId) && { allowed: [...allowed, hostId] }),
      ...(how === "typed" && !this.proved.includes(hostId) && { proved: [...this.proved, hostId] }),
      ...(byCode && {
        trusted: trusted.includes(hostId) ? trusted : [...trusted, hostId],
        books: Object.fromEntries(Object.entries(books).map(([id, book]) => [id, forgetRequest(book)])),
        askingStopped: undefined,
      }),
    };
    await this.save();
    return { session };
  }

  /**
   * Asks to use `hostId` as a new device, because the user asked: signs in and starts a request,
   * or goes on with the one it kept. Resolves once approved, after `onCode` shows the code to
   * match on another device, or on that computer's own screen. It's given `allow`, for the user's
   * tap on that computer's code: the device its setup command named gets in on that alone, and any
   * other gets `onConfirm`, as that computer must confirm too. Rejects when it's denied or lapses,
   * with a message for people, which ends that request: the user may ask again, which starts a new
   * one, counted.
   */
  async ask(
    hostId: string,
    choices: RouteChoices,
    onCode: (code: string, allow: () => void) => void,
    onConfirm: () => void = () => {},
  ): Promise<void> {
    const { at } = await this.first(hostId, ordered(hostId, choices), inOrder(choices));
    try {
      const signed = await this.signIn(at, hostId, true);
      if ("session" in signed) {
        if (this.trusts(hostId)) return;
        // Asking again can't change this, and each try leaves a session there.
        throw new Denied(t("That computer already approved this phone. Run plx connect on it, and type the code it shows."));
      }
      if (signed.gate.kind !== "waiting" || !signed.request) throw new Error(t("That computer didn't start a request."));
      const request = signed.request;
      let tapped = false;
      let fromAllow: (session: Record<string, unknown>) => void = () => {};
      const allowedHere = new Promise<{ session: Record<string, unknown> }>((resolve) => {
        fromAllow = (session) => resolve({ session });
      });
      onCode(signed.gate.code, () => {
        tapped = true;
        // Either this call or the wait below gets the session, so losing here is no failure.
        this.approval(at, { request, allow: true }).then(
          (step) => {
            if ("session" in step) fromAllow(step.session);
            else if (step.pending["needsHost"]) onConfirm();
          },
          () => {},
        );
      });
      const giveUp = requestDeadline();
      for (;;) {
        if (Date.now() >= giveUp) throw new Denied(t(LAPSED));
        const step = await Promise.race([this.approval(at, { request }, true), allowedHere]);
        if ("session" in step) {
          await this.approved(hostId, step.session, true, tapped ? "tapped" : undefined);
          return;
        }
      }
    } catch (e) {
      if (e instanceof Denied) await this.setBook(hostId, forgetRequest(this.book(hostId)));
      throw e;
    } finally {
      at.close();
    }
  }

  /**
   * Compares codes with new computer `hostId`, which nothing vouches for, so it may be one the relay
   * made up. It takes no session until `decide` says the user allowed the code, and then marks the
   * computer `allowed`, so it adds to no lists. Without the Allow it asks nothing more
   * of the host, which withdraws the request. `onConfirm` says the computer must confirm too, as its
   * setup named no device. Rejects when it's denied or lapses, with a message for people.
   */
  async compare(
    hostId: string,
    choices: RouteChoices,
    decide: (code: string) => Promise<boolean>,
    onConfirm: () => void = () => {},
  ): Promise<void> {
    const { at } = await this.first(hostId, ordered(hostId, choices), inOrder(choices));
    try {
      const signed = await this.signIn(at, hostId, true, true);
      if (!("gate" in signed) || signed.gate.kind !== "waiting" || !signed.request)
        throw new Error(t("That computer didn't start a request."));
      const request = signed.request;
      if (!(await decide(signed.gate.code))) {
        await this.approval(at, { request, deny: true }).catch(() => {});
        throw new Denied(t("You didn't allow it."));
      }
      let step = await this.approval(at, { request, allow: true });
      if ("pending" in step) onConfirm();
      const giveUp = requestDeadline();
      while (!("session" in step)) {
        if (Date.now() >= giveUp) throw new Denied(t(LAPSED));
        step = await this.approval(at, { request }, true);
      }
      await this.approved(hostId, step.session, true, "tapped");
    } catch (e) {
      if (e instanceof Denied) await this.setBook(hostId, forgetRequest(this.book(hostId)));
      throw e;
    } finally {
      at.close();
    }
  }

  /**
   * Sets up `hostId` with the code `plx connect` shows on it: one SPAKE2 run, pinned to the host
   * id, which approves this phone's key there and this phone's trust in the host. The code is
   * used once whatever happens, and at most 5 runs an hour go to one host.
   */
  async setup(hostId: string, choices: RouteChoices, code: string): Promise<void> {
    const { at, described } = await this.first(hostId, ordered(hostId, choices), inOrder(choices));
    try {
      await this.setBook(hostId, setupRun(this.book(hostId), Date.now()));
      const at_ = (path: string) => `${at.base}${path}`;
      const timeout = isRelay(at.route) ? RELAY_TIMEOUT_S : undefined;
      const finished = await spakePair(at_, at.pin, described.fingerprint, code, this.secret, this.label, timeout).catch(
        (e: Error) => {
          throw new Error(at.problem() ?? e.message);
        },
      );
      await this.approved(hostId, finished, true, "typed");
    } finally {
      at.close();
    }
  }
}

// Shown with `t`.
const NO_CODE = msg("That computer showed no code to compare. Type the code it shows.");
const LAPSED = msg("That request wasn't allowed in time.");
const HELD_BACK = msg(
  "This phone's new key hasn't been allowed yet. Type the code that computer shows, or allow this phone first.",
);

/** When this phone stops waiting on a request: a real computer drops one by then, and a fake mustn't hold it. */
const requestDeadline = () => Date.now() + REQUEST_LIFETIME_MS + 10_000;

/** A sign-in or request the host refused: this phone needs setting up or approving again. */
class Refused extends Error {}

/** A new device's request that ended, denied or lapsed. Starting another is the user's to do. */
export class Denied extends Refused {}

const describeRefusal = (json: Record<string, unknown>) =>
  typeof json["error_description"] === "string" ? json["error_description"] : undefined;
