// What the phone keeps about its computers (machines.json), and how a setup from an older version
// moves to the account (0091). Pure, so it's tested without React Native.

import type { Listed } from "./accountHosts";
import type { Saved } from "./host";

/**
 * A computer the phone uses: an account's computer (`account:<hostId>`), or one paired on the LAN
 * with a code (0065, `paired-…`).
 */
export interface Machine {
  id: string;
  name: string;
  /** A LAN-paired computer's session, which it's reached with. */
  paired?: Saved;
  /** An account's computer: its host id, and the LAN routes it last reported. */
  account?: { hostId: string; routes: string[] };
}

/** What the phone keeps: its computers, the one new threads start on, and whether onboarding is done. */
export interface Setup {
  machines: Machine[];
  defaultId?: string;
  /** Onboarding finished, with or without a computer. */
  onboarded: boolean;
  /** The account's computers removed from this phone, which discovery leaves out. */
  hidden?: string[];
}

/** An account's computer's id. */
export const accountId = (hostId: string) => `account:${hostId}`;

/** A LAN-paired computer's id, from its certificate's fingerprint. */
export const pairedId = (saved: Saved) => `paired-${saved.fingerprint.slice(0, 16)}`;

/**
 * A setup as read from machines.json. Computers this phone reached over Tailscale, before the
 * account replaced it, are dropped: the account lists them again as `account:` computers. A phone
 * left with none goes through onboarding again, which lists them for setting up.
 */
export function upgraded(read: { machines: { id: string; name: string }[] } & Partial<Setup>): Setup {
  const kept = read.machines.filter((m) => m.id.startsWith("account:") || m.id.startsWith("paired-"));
  const machines = kept.map(({ id, name, account }: Machine) => ({ id, name, ...(account && { account }) }));
  const dropped = kept.length < read.machines.length;
  return {
    machines,
    defaultId: machines.some((m) => m.id === read.defaultId) ? read.defaultId : undefined,
    onboarded: dropped && !machines.length ? false : (read.onboarded ?? read.machines.length > 0),
    ...(read.hidden && { hidden: read.hidden }),
  };
}

/**
 * `known` with the account's computers the relay `listed` that it lacks, unless removed from this
 * phone. A known one keeps the name it reports itself, and one the relay no longer lists stays,
 * as an offline one does.
 */
export function withListed(known: Machine[], listed: Listed[], hidden: string[] = []): Machine[] {
  const added = listed
    .filter((l) => !hidden.includes(accountId(l.hostId)) && !known.some((m) => m.id === accountId(l.hostId)))
    .map((l) => ({ id: accountId(l.hostId), name: l.name || "Computer", account: { hostId: l.hostId, routes: [] } }));
  return added.length ? [...known, ...added] : known;
}

/**
 * The computers a new phone asks to use, on its own, once it's signed in (0091): those online, in
 * the relay's order, and none once it uses any, since those vouch for the rest.
 */
export const toAsk = (listed: Listed[], usesAny: boolean, hidden: string[] = []): Listed[] =>
  usesAny ? [] : listed.filter((l) => l.online && !hidden.includes(accountId(l.hostId)));

/**
 * What a computer's row says on the first-run screen, where the phone does the asking: it's ready,
 * offline, waiting on the Allow that shows `code`, connects once one is given, or isn't connected:
 * asking stopped, or this phone uses another computer (`usesAny`) that hasn't vouched for this one.
 */
export function computerStatus(row: {
  ready: boolean;
  online: boolean;
  code?: string;
  stopped: boolean;
  usesAny: boolean;
}) {
  if (row.ready) return "Ready";
  if (!row.online) return "Offline";
  if (row.code) return `Waiting for you to allow · ${row.code}`;
  if (row.usesAny) return "Not connected yet";
  return row.stopped ? "Not connected" : "Connects once allowed";
}

/** How asking ended: allowed, refused so it waits for the user, or no computer answered. */
export type Asked = "allowed" | "stopped" | "unreachable";

/**
 * Asks `hosts` in turn until one lets this phone in, as approving on one covers them all. One that
 * can't be reached is passed over. One that denies it, a limit, or one still holding its request
 * ends it (`stops`), since a new request is the user's to start.
 */
export async function askEach(
  hosts: Listed[],
  ask: (host: Listed) => Promise<void>,
  stops: (error: unknown, host: Listed) => boolean,
  stopped: (error: unknown) => void,
): Promise<Asked> {
  for (const host of hosts) {
    try {
      await ask(host);
      return "allowed";
    } catch (error) {
      if (!stops(error, host)) continue;
      stopped(error);
      return "stopped";
    }
  }
  return "unreachable";
}
