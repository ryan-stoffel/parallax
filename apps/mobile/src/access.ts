// The phone's side of approving devices and computers for account sign-in (0091 "Access"), as
// `plxd dial` keeps it in daemon/src/remote.rs. A fake host the relay lists sets no limits of its
// own, so the phone keeps them: one random value and commitment per host while its request can
// wait, a different request or commitment from that host is a failed request, a new request only
// when the user asks and at most 5 an hour per host, and one SPAKE2 run per typed setup code, at
// most 5 an hour per host. Pure, so it's tested without React Native.

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

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
    throw new Limited("This phone asked that computer 5 times this hour. Try again later.");
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
    throw new Limited("That computer's code was tried 5 times this hour. Try again later.");
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
}

/**
 * Every host's lists in one, with `hosts` (the ones this phone has sessions with) approved too.
 * A key removed anywhere ends up removed and not approved, so the lists merge with no clock.
 */
export function merged(all: Lists[], hosts: string[]): Lists {
  const removed = new Set(all.flatMap((l) => l.removedClients));
  const sorted = (items: Iterable<string>) => [...new Set(items)].sort();
  return {
    approvedClients: sorted(all.flatMap((l) => l.approvedClients).filter((k) => !removed.has(k))),
    removedClients: sorted(removed),
    approvedHosts: sorted([...all.flatMap((l) => l.approvedHosts), ...hosts]),
  };
}

/** Whether `lists` lacks anything in `union`, so the host needs an `access/merge`. */
export const lacks = (lists: Lists, union: Lists) =>
  (["approvedClients", "removedClients", "approvedHosts"] as const).some((name) =>
    union[name].some((item) => !lists[name].includes(item)),
  );
