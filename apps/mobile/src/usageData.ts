// The Usage tab's answers from every computer, put together as the desktop's usage page does:
// Cost and Tokens sum each computer's `usage/daily`, and Limits shows each subscription once.
// Pure, for the test; Usage.tsx asks the computers.
import type { RpcError } from "../../desktop/src/preload/bridge";
import {
  ErrorCodes,
  type AccountLimits,
  type KeyAccount,
  type UsageDailyResult,
  type UsageDay,
  type UsageSessions,
} from "../../desktop/src/protocol/generated/protocol";
import { describeError } from "../../desktop/src/renderer/errors";
import { backendOf, type Backend } from "../../desktop/src/renderer/usageStats";

/** Each backend's name, as the desktop's Settings > Providers shows it. */
export const backendNames: Record<Backend, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** A failed usage request, for people. A plxd without the method is too old. */
export function usageError(error: RpcError): string {
  return error.code === ErrorCodes.MethodNotFound
    ? "Update plxd on this computer to see its usage here."
    : describeError(error);
}

/** One computer's `usage/daily` since a day, or why it has none. */
export type Daily = UsageDailyResult | { problem: string };

/**
 * Every answer for `since` among `ids`, together. `sessions` is undefined unless every computer
 * that answered counted them, since one that didn't would make the total look whole when it isn't.
 */
export function gather(
  ids: string[],
  answers: (id: string) => Daily | undefined,
): { days: UsageDay[]; sessions?: UsageSessions[]; answered: number } {
  const days: UsageDay[] = [];
  let sessions: UsageSessions[] | undefined = [];
  let answered = 0;
  for (const id of ids) {
    const answer = answers(id);
    if (!answer || "problem" in answer) continue;
    days.push(...answer.days);
    sessions = answer.sessions && sessions?.concat(answer.sessions);
    answered++;
  }
  return { days, sessions: answered ? sessions : undefined, answered };
}

/** An account's windows, with the backend and name Limits shows it under. */
export interface Account extends AccountLimits {
  backend?: Backend;
  name: string;
}

/**
 * A computer's accounts for Limits: those of the providers enabled in its Settings > Providers
 * (`enabled`, every account on a plxd without `providers`), named by their backend.
 */
export function accountsOf(
  limits: AccountLimits[],
  keys: KeyAccount[],
  enabled?: string[],
): Account[] {
  return limits
    .filter((a) => !enabled || enabled.includes(a.accountId))
    .map((a) => {
      const backend = backendOf(a.accountId, keys);
      return { ...a, backend, name: backend ? backendNames[backend] : a.accountId };
    });
}

/**
 * Every computer's accounts, each once, by name. A subscription's limits are its account's, not a
 * computer's, so each comes from the first computer that read its windows.
 */
export function mergeAccounts(perComputer: Account[][]): Account[] {
  const byId = new Map<string, Account>();
  for (const accounts of perComputer)
    for (const a of accounts) {
      const seen = byId.get(a.accountId);
      if (!seen || (seen.limits.length === 0 && a.limits.length > 0)) byId.set(a.accountId, a);
    }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
