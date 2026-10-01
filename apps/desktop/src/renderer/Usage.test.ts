import { expect, test } from "vite-plus/test";

import { describeLimit, describeUsage, limitMeter, limitName } from "./Usage";

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

test("a limit meter says how much is used, warns near the cap, and says when it resets", () => {
  const limit = (window: string, usedPercent?: number, resetsAt?: string) => ({
    window,
    ...(usedPercent !== undefined && { usedPercent }),
    ...(resetsAt && { resetsAt }),
    capturedAt: "2026-09-28T11:00:00Z",
  });
  const inFourDays = "2026-10-02T17:00:00Z";
  expect(limitMeter(limit("five_hour", 37.6, inFourDays), now)).toEqual({
    name: "Session",
    used: 37,
    tone: "normal",
    resets: "Resets in 4 d 5 h",
  });
  // Amber from 75% used and red from 90%, by the rounded-down percent shown.
  const tone = (used: number) => limitMeter(limit("seven_day", used, inFourDays), now).tone;
  expect([74.9, 75, 89.9, 90, 100].map(tone)).toEqual([
    "normal",
    "warning",
    "warning",
    "danger",
    "danger",
  ]);
  expect(limitMeter(limit("seven_day_opus", 140), now)).toEqual({
    name: "Weekly · Opus",
    used: 100,
    tone: "danger",
    resets: "Reset time unknown",
  });
  // Past its reset, the percent is stale and none of the window is used.
  expect(limitMeter(limit("seven_day", 95, "2026-09-28T11:59:00Z"), now)).toEqual({
    name: "Weekly",
    used: 0,
    tone: "normal",
    resets: "Has reset",
  });
  expect(limitMeter(limit("primary"), now)).toEqual({
    name: "Primary",
    tone: "normal",
    resets: "Reset time unknown",
  });
});
