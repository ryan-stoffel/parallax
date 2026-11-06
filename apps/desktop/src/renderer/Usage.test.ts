import { expect, test } from "vite-plus/test";

import { limitMeter } from "./usageStats";

const now = Date.parse("2026-09-28T12:00:00Z");

test("a limit meter says how much is left, warns near the cap, and says when it resets", () => {
  const limit = (window: string, usedPercent?: number, resetsAt?: string) => ({
    window,
    ...(usedPercent !== undefined && { usedPercent }),
    ...(resetsAt && { resetsAt }),
    capturedAt: "2026-09-28T11:00:00Z",
  });
  const inFourDays = "2026-10-02T17:00:00Z";
  expect(limitMeter(limit("five_hour", 37.6, inFourDays), now)).toEqual({
    name: "Session",
    left: 63,
    tone: "normal",
    resetsIn: "4d 5h",
  });
  // Amber from 75% used and red from 90%, by the rounded-down percent used.
  const tone = (used: number) => limitMeter(limit("seven_day", used, inFourDays), now).tone;
  expect([74.9, 75, 89.9, 90, 100].map(tone)).toEqual([
    "normal",
    "warning",
    "warning",
    "danger",
    "danger",
  ]);
  expect(limitMeter(limit("seven_day_fable", 140), now)).toEqual({
    name: "Weekly · Fable",
    left: 0,
    tone: "danger",
  });
  // Past its reset, the percent is stale and all of the window is left.
  expect(limitMeter(limit("seven_day", 95, "2026-09-28T11:59:00Z"), now)).toEqual({
    name: "Weekly",
    left: 100,
    tone: "normal",
  });
  expect(limitMeter(limit("primary"), now)).toEqual({ name: "Primary", tone: "normal" });
});
