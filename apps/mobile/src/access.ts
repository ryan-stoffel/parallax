// The phone's side of approving devices and computers for account sign-in (0091 "Access"), as
// `plxd dial` keeps it in daemon/src/remote.rs. A fake host the relay lists sets no limits of its
// own, so the phone keeps them: one random value and commitment per host while its request can
// wait, a different request or commitment from that host is a failed request, a new request only
// when the user asks and at most 5 an hour per host, and one SPAKE2 run per typed setup code, at
// most 5 an hour per host. Pure, so it's tested without React Native.

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { t } from "i18next";

import type { KeyStanding } from "../../desktop/src/preload/bridge";
import { base64url, fromBase64url } from "./pairing";
import { WrongHost } from "./routes";

/** How long a new device's request waits for approval before it lapses. */
export const REQUEST_LIFETIME_MS = 10 * 60_000;
/** At most this many new requests, and this many setup-code runs, per host an hour. */
export const MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
/** How many random bytes each side of a request contributes to its code. */
export const VALUE_BYTES = 32;

/** The value this phone sent for a request, kept while the request can wait. */
export interface Kept {
  request: string;
  commitment: string;
  /** base64url. */
  value: string;
  until: number;
}

/** What the phone keeps about one host's requests and setup runs. */
export interface HostBook {
  kept?: Kept;
  /** When new requests started, in the last hour. */
  requests: number[];
  /** When setup-code runs started, in the last hour. */
  setupRuns: number[];
}

export const emptyBook = (): HostBook => ({ requests: [], setupRuns: [] });

/** A limit the phone keeps, reached: a message for people. */
export class Limited extends Error {}

const withinHour = (times: number[], now: number) => times.filter((t) => now - t < HOUR_MS);

/**
 * The value this phone already sent for `request` at this host, if it kept one that can still
 * wait. Throws `WrongHost` when it kept one for another request id or commitment: a host that
 * answers each reconnect with a new request gets no new value to try.
 */
export function keptValue(
  book: HostBook,
  request: string,
  commitment: string,
  now: number,
): Uint8Array | undefined {
  const kept = book.kept && book.kept.until > now ? book.kept : undefined;
  if (!kept) return undefined;
  if (kept.request !== request || kept.commitment !== commitment) throw new WrongHost();
  return fromBase64url(kept.value);
}

/**
 * A new request's value, which the caller sends once the user asked, and the book that keeps it.
 * Throws `Limited` past `MAX_PER_HOUR` an hour.
 */
export function newRequest(
  book: HostBook,
  request: string,
  commitment: string,
  now: number,
  random: (count: number) => Uint8Array,
): { book: HostBook; value: Uint8Array } {
  const requests = withinHour(book.requests, now);
  if (requests.length >= MAX_PER_HOUR)
    throw new Limited(t("This phone asked that computer 5 times this hour. Try again later."));
  const value = random(VALUE_BYTES);
  const kept = { request, commitment, value: base64url(value), until: now + REQUEST_LIFETIME_MS };
  return { book: { ...book, kept, requests: [...requests, now] }, value };
}

/** `book` after a request ended: approved, denied, or lapsed. */
export const forgetRequest = ({ kept, ...book }: HostBook): HostBook => book;

/** `book` with one more setup-code run counted. Throws `Limited` past `MAX_PER_HOUR` an hour. */
export function setupRun(book: HostBook, now: number): HostBook {
  const runs = withinHour(book.setupRuns, now);
  if (runs.length >= MAX_PER_HOUR)
    throw new Limited(t("That computer's code was tried 5 times this hour. Try again later."));
  return { ...book, setupRuns: [...runs, now] };
}

/** The host's commitment to its value, which it reveals only after the phone sent its own. */
export const commitment = (hostValue: Uint8Array) =>
  base64url(sha256(concatBytes(utf8ToBytes("parallax-approval-commit\0"), hostValue)));

/**
 * The 6 digits both ends of a request show: a hash of both values, the host id, and the phone's
 * DPoP key thumbprint, its first 8 bytes read big-endian, modulo a million.
 */
export function approvalCode(
  hostValue: Uint8Array,
  clientValue: Uint8Array,
  hostId: string,
  thumbprint: string,
): string {
  const hash = sha256(
    concatBytes(
      utf8ToBytes("parallax-approval-code\0"),
      hostValue,
      clientValue,
      utf8ToBytes(hostId),
      utf8ToBytes("\0"),
      utf8ToBytes(thumbprint),
    ),
  );
  const first = hash.slice(0, 8).reduce((n, byte) => n * 256n + BigInt(byte), 0n);
  return String(first % 1_000_000n).padStart(6, "0");
}

/** Who may sign in to a host with the account, as `access/get` and `access/merge` carry it. */
export interface Lists {
  approvedClients: string[];
  removedClients: string[];
  approvedHosts: string[];
  /** Hosts added with Allow alone, which clients use and take no lists from. */
  allowedHosts?: string[];
  /** The read-only keys. A plxd from before read-only devices leaves them out. */
  readOnlyClients?: string[];
}

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * `result`, a computer's answer to `access/get`, as lists, or undefined when it's malformed, as a
 * fake computer's can be. An older plxd leaves out `allowedHosts` and `readOnlyClients`.
 */
export function asLists(result: unknown): Lists | undefined {
  const lists = (result ?? {}) as Record<keyof Lists, unknown>;
  const whole =
    strings(lists.approvedClients) &&
    strings(lists.removedClients) &&
    strings(lists.approvedHosts) &&
    (lists.allowedHosts === undefined || strings(lists.allowedHosts)) &&
    (lists.readOnlyClients === undefined || strings(lists.readOnlyClients));
  return whole ? (lists as unknown as Lists) : undefined;
}

/**
 * A connected computer's lists, under the id its connection pins. `paired` says the connection is a
 * LAN pairing, by the phone's own record of it: the relay picks a listed computer's id, so no id
 * can show that.
 */
export interface Known {
  id: string;
  lists: Lists;
  paired?: boolean;
}

/**
 * Which of `known` may add to `target`'s lists (0091): `target` itself, the computers its own list
 * vouches for, following their lists, and those this phone proved: `proved`, with a typed code, and
 * those `paired` on the LAN with one. A phone can't tell a fake computer that signed it in with no
 * tap from a real one approved on another device, so each computer's list decides what it accepts:
 * nothing real lists a fake one, so a fake's keys, removals, and host ids reach only fakes. A
 * computer marked by one of these, or in `allowed` (the marks this phone keeps), takes lists and
 * adds none, as it may be a fake one the user clicked through.
 */
export function sourcesFor<T extends Known>(
  target: T,
  known: T[],
  proved: string[],
  allowed: string[],
): T[] {
  const marked = new Set(allowed);
  // Each new mark starts the walk again, as a marked computer may have vouched for another.
  for (;;) {
    const vouched = new Set([target.id, ...proved]);
    const adds = (each: T) =>
      each === target || ((each.paired || vouched.has(each.id)) && !marked.has(each.id));
    for (let size = -1; size !== vouched.size; ) {
      size = vouched.size;
      for (const each of known.filter(adds)) for (const id of each.lists.approvedHosts) vouched.add(id);
    }
    const sources = known.filter(adds);
    const before = marked.size;
    for (const each of sources) for (const id of each.lists.allowedHosts ?? []) marked.add(id);
    if (marked.size === before) return sources;
  }
}

/**
 * The computers this phone's own record proves (0091), by `sourcesFor`'s rule with no target: those
 * `proved` with a typed code, those `paired` on the LAN, and what they approve, by pinned id, less
 * any marked. `sources` are those of `known` among them, whose word about this phone's key counts.
 * A computer that only signed this phone in, or that another computer's list names, isn't proved.
 */
export function provedAmong<T extends Known>(known: T[], proved: string[], allowed: string[]) {
  const nobody = { id: "", lists: { approvedClients: [], removedClients: [], approvedHosts: [] } } as unknown as T;
  const sources = sourcesFor(nobody, known, proved, allowed);
  const marked = new Set([...allowed, ...sources.flatMap((each) => each.lists.allowedHosts ?? [])]);
  const ids = [...proved, ...sources.flatMap((each) => [each.id, ...each.lists.approvedHosts])];
  return { sources, marked, ids: [...new Set(ids)].filter((id) => !marked.has(id)) };
}

/**
 * Every host's lists in one, with `hosts` (the ones this phone proved) approved too, and `allowed`
 * (the marks it keeps) marked. A key removed anywhere ends up removed and not approved, so the
 * lists merge with no clock. A key read-only anywhere ends up read-only. A marked computer stays out
 * of `approvedHosts`, the only list an older client or plxd reads, so neither takes it for one the
 * user verified.
 */
export function merged(all: Lists[], hosts: string[], allowed: string[] = []): Lists {
  const removed = new Set(all.flatMap((l) => l.removedClients));
  const sorted = (items: Iterable<string>) => [...new Set(items)].sort();
  const marks = sorted([...all.flatMap((l) => l.allowedHosts ?? []), ...allowed]);
  const readOnly = all.flatMap((l) => l.readOnlyClients ?? []);
  return {
    approvedClients: sorted(all.flatMap((l) => l.approvedClients).filter((k) => !removed.has(k))),
    removedClients: sorted(removed),
    approvedHosts: sorted([...all.flatMap((l) => l.approvedHosts), ...hosts].filter((id) => !marks.includes(id))),
    ...(marks.length > 0 && { allowedHosts: marks }),
    ...(readOnly.length > 0 && { readOnlyClients: sorted(readOnly) }),
  };
}

/** What `lists` say of `key`, this phone's own, if they say it needs replacing. */
export function keyStandingIn(key: string, lists: Lists): KeyStanding | undefined {
  if (lists.removedClients.includes(key)) return "removed";
  return lists.readOnlyClients?.includes(key) ? "readOnly" : undefined;
}

/** Whether `lists` lacks anything in `union`, so the host needs an `access/merge`. */
export const lacks = (lists: Lists, union: Lists) =>
  (["approvedClients", "removedClients", "approvedHosts", "allowedHosts", "readOnlyClients"] as const).some((name) =>
    (union[name] ?? []).some((item) => !(lists[name] ?? []).includes(item)),
  );
