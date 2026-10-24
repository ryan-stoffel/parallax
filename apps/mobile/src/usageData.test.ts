import { expect, test } from "vitest";

import type { AccountLimits, UsageDay } from "../../desktop/src/protocol/generated/protocol";
import { accountsOf, gather, mergeAccounts, usageError, type Daily } from "./usageData";

const day = (agent: string, tokens: number): UsageDay => ({
  date: "2026-10-20",
  agent: agent as UsageDay["agent"],
  model: "m",
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

test("days add up across computers, and sessions only when every one that answered counted them", () => {
  const answers: Record<string, Daily> = {
    mac: { days: [day("claude", 10)], problems: [], sessions: [{ date: "2026-10-20", agent: "claude", sessions: 2 }] },
    linux: { days: [day("codex", 5)], problems: [], sessions: [{ date: "2026-10-20", agent: "codex", sessions: 1 }] },
    old: { problem: "Update plxd on this computer to see its usage here." },
  };
  const all = gather(["mac", "linux", "old", "offline"], (id) => answers[id]);
  expect(all.answered).toBe(2);
  expect(all.days.map((d) => d.inputTokens)).toEqual([10, 5]);
  expect(all.sessions?.map((s) => s.sessions)).toEqual([2, 1]);

  answers.linux = { days: [day("codex", 5)], problems: [] };
  expect(gather(["mac", "linux"], (id) => answers[id]).sessions).toBeUndefined();
  expect(gather(["offline"], () => undefined)).toEqual({ days: [], sessions: undefined, answered: 0 });
});

test("a plxd without usage/daily is asked to update", () => {
  expect(usageError({ code: -32601, message: "Method not found" })).toBe(
    "Update plxd on this computer to see its usage here.",
  );
  expect(usageError({ code: -32603, message: "ccusage failed" })).toBe("ccusage failed");
});

test("limits show each enabled account once, from the first computer that read its windows", () => {
  const window = { window: "five_hour", usedPercent: 40, capturedAt: "2026-10-20T10:00:00Z" };
  const limits: AccountLimits[] = [
    { accountId: "claude", limits: [], problem: "signed out" },
    { accountId: "codex", limits: [window] },
    { accountId: "key-1", limits: [] },
  ];
  const keys = [{ id: "key-1", provider: "anthropic", label: "Work", createdAt: "" }] as const;
  const mac = accountsOf(limits, [...keys], ["claude", "codex"]);
  expect(mac.map((a) => [a.accountId, a.name])).toEqual([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ]);
  // An older plxd has no `providers`: every account shows, an API key's named by its provider.
  expect(accountsOf(limits, [...keys]).at(-1)).toMatchObject({ backend: "claude", name: "Claude Code" });

  const linux = accountsOf([{ accountId: "claude", limits: [window] }], [], undefined);
  const merged = mergeAccounts([mac, linux]);
  expect(merged.map((a) => [a.accountId, a.limits.length])).toEqual([
    ["claude", 1],
    ["codex", 1],
  ]);
});
