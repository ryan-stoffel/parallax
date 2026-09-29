import { expect, test } from "vite-plus/test";

import { describeLimit, describeUsage, limitCard, limitName } from "./Usage";

const now = Date.parse("2026-09-28T12:00:00Z");
const period = (tokens: Partial<Record<string, number>>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...tokens,
});

test("usage counts every kind of token, with the cost only when the vendor reports one", () => {
  const spent = period({ inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 1_000_000 });
  expect(describeUsage({ ...spent, costUsdMicros: 3_404_000 }, "today")).toBe(
    "1.3M tokens today, about $3.40",
  );
  expect(describeUsage(spent, "week")).toBe("1.3M tokens this week");
  expect(describeUsage({ ...spent, costUsdMicros: 1200 }, "today")).toBe(
    "1.3M tokens today, under $0.01",
  );
  expect(describeUsage(period({}), "today")).toBe("No usage today");
  expect(describeUsage(undefined, "week")).toBe("No usage this week");
});

test("a limit says how much is used and when it resets, and stops once it has", () => {
  const limit = (usedPercent: number | undefined, resetsAt?: string) => ({
    window: "five_hour",
    ...(usedPercent !== undefined && { usedPercent }),
    ...(resetsAt && { resetsAt }),
    capturedAt: "2026-09-28T11:00:00Z",
  });
  expect(describeLimit(limit(12.7, "2026-09-28T14:14:00Z"), now)).toEqual({
    text: "5-hour limit · 12% used · resets in 2 h 14 min",
    used: 12.7,
  });
  expect(describeLimit(limit(100, "2026-09-28T12:00:30Z"), now)).toEqual({
    text: "5-hour limit reached · resets in 1 min",
    used: 100,
  });
  expect(describeLimit(limit(undefined, "2026-10-01T16:00:00Z"), now).text).toBe(
    "5-hour limit · resets in 3 d 4 h",
  );
  expect(describeLimit(limit(40), now)).toEqual({ text: "5-hour limit · 40% used", used: 40 });
  // The percent is from before the reset, so it's no longer true.
  expect(describeLimit(limit(95, "2026-09-28T11:59:00Z"), now)).toEqual({
    text: "5-hour limit has reset",
  });
});

test("vendor window names read as plain words", () => {
  expect(limitName("five_hour")).toBe("5-hour limit");
  expect(limitName("seven_day")).toBe("Weekly limit");
  expect(limitName("seven_day_opus")).toBe("Weekly Opus limit");
  expect(limitName("primary")).toBe("Primary limit");
});

test("a limit card says how much is left and when the rest comes back", () => {
  const limit = (window: string, usedPercent?: number, resetsAt?: string) => ({
    window,
    ...(usedPercent !== undefined && { usedPercent }),
    ...(resetsAt && { resetsAt }),
    capturedAt: "2026-09-28T11:00:00Z",
  });
  const inFourDays = "2026-10-02T17:00:00Z";
  expect(limitCard(limit("five_hour", 37.6, inFourDays), now)).toEqual({
    name: "Session",
    left: 63,
    line: "+37% in 4 d 5 h",
    badge: "4 d 5 h",
  });
  // Under 1% used: nothing to get back, just when it resets.
  expect(limitCard(limit("seven_day", 0.4, inFourDays), now).line).toBe("Resets in 4 d 5 h");
  expect(limitCard(limit("seven_day_opus", 140), now)).toEqual({
    name: "Weekly · Opus",
    left: 0,
    line: "Reset time unknown",
  });
  // Past its reset, the percent is stale and the whole window is back.
  expect(limitCard(limit("seven_day", 95, "2026-09-28T11:59:00Z"), now)).toEqual({
    name: "Weekly",
    left: 100,
    line: "Has reset",
    badge: "reset",
  });
  expect(limitCard(limit("primary"), now).name).toBe("Primary");
});
