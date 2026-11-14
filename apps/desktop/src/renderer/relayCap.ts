import { t } from "i18next";

import type { RelayUsage } from "../protocol/generated/protocol";

/** The share of its daily cap a computer has used when the apps start to warn (PLX-1357). */
const WARN_AT = 0.8;

export type RelayCapNotice = { reached: boolean; title: string; body: string };

/**
 * What to tell the user about computer `name`'s traffic through Parallax Relay today, for the
 * desktop app and the phone. Undefined below 80% of the cap, and from a relay too old to send
 * `usage`. `reached` matches the relay's own check: only past `limit` does it refuse. `clock` writes
 * a time in the user's format.
 */
export function relayCapNotice(
  name: string,
  usage: RelayUsage | undefined,
  clock: (at: number) => string,
): RelayCapNotice | undefined {
  if (!usage || usage.bytes < usage.limit * WARN_AT) return undefined;
  const resets = clock(usage.resetsAt);
  if (usage.bytes > usage.limit)
    return {
      reached: true,
      title: t("{{name}} reached its daily Parallax Connect limit", { name }),
      body: t(
        "Parallax Connect won't reach it until the limit resets at {{time}}. It still works over the LAN.",
        { time: resets },
      ),
    };
  const percent = Math.floor((usage.bytes / usage.limit) * 100);
  const gib = usage.limit / 1024 ** 3;
  return {
    reached: false,
    title: t("{{name}} is near its daily Parallax Connect limit", { name }),
    body: t(
      "It has used {{percent}}% of today's {{gib}} GiB. The limit resets at {{time}}. It still works over the LAN, which doesn't count.",
      { percent, gib, time: resets },
    ),
  };
}
