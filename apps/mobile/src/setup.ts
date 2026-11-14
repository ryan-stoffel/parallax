// What the phone keeps about its computers (machines.json), and how a setup from an older version
// moves to the account (0091). Pure, so it's tested without React Native.

import { t } from "i18next";

import type { RouteChoices } from "../../desktop/src/preload/routeList";
import { asLists } from "./access";
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
  /** An account's computer: its host id, the routes it last reported, and the user's choices. */
  account?: RouteChoices & { hostId: string };
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
 * `known` less the computers that left the account (`removed`), with the account's computers the
 * relay `listed` that it lacks, unless removed from this phone (`hidden`). A known one keeps the
 * name it reports itself. One the relay doesn't list and doesn't mark stays, as an offline one
 * does, since that list may come from a relay that lost its data (0091).
 */
export function withListed(
  known: Machine[],
  listed: Listed[],
  hidden: string[] = [],
  removed: string[] = [],
): Machine[] {
  const kept = known.filter((m) => !removed.some((hostId) => m.id === accountId(hostId)));
  const added = listed
    .filter((l) => !hidden.includes(accountId(l.hostId)) && !kept.some((m) => m.id === accountId(l.hostId)))
    .map((l) => ({ id: accountId(l.hostId), name: l.name || "Computer", account: { hostId: l.hostId, routes: [] } }));
  return added.length || kept.length < known.length ? [...kept, ...added] : known;
}

/**
 * Computer `connection`'s answer to `access/get`, as `AccountHosts.absorb` takes it: none when it's
 * malformed, and LAN-paired only if the phone's own record of that connection says so.
 */
export function keeper(machines: Machine[], connection: string, result: unknown) {
  const lists = asLists(result);
  if (!lists) return [];
  const paired = !!machines.find((m) => m.id === connection)?.paired;
  return [{ id: connection.replace(/^account:/, ""), connection, paired, lists }];
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
  if (row.ready) return t("Ready");
  if (!row.online) return t("Offline");
  if (row.code) return t("Waiting for you to allow · {{code}}", { code: row.code });
  if (row.usesAny) return t("Not connected yet");
  return row.stopped ? t("Not connected") : t("Connects once allowed");
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
