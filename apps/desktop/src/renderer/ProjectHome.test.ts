import { expect, test } from "vite-plus/test";

import { dayLabel } from "./locale";
import { openLine, plainTitle } from "./ProjectHome";

const now = Date.parse("2026-10-22T15:00:00");
const row = (group: "waiting" | "working" | "ready" | "resolved", daysAgo = 0) =>
  ({ group, run: { updatedAt: new Date(now - daysAgo * 86_400_000).toISOString() } }) as never;

test("the head counts open threads, then what finished this week", () => {
  expect(openLine([], now)).toBe("No open threads");
  expect(openLine([row("resolved", 2), row("ready"), row("resolved", 9)], now)).toBe(
    "1 open thread · 2 done this week",
  );
  expect(openLine([row("working"), row("waiting"), row("resolved", 9)], now)).toBe(
    "2 open threads",
  );
});

test("a log day is Today, Yesterday, or its date", () => {
  expect(dayLabel(Date.parse("2026-10-22T08:00:00"), now)).toBe("Today");
  expect(dayLabel(Date.parse("2026-10-21T23:59:00"), now)).toBe("Yesterday");
  expect(dayLabel(Date.parse("2026-10-20T12:00:00"), now)).toMatch(/Oct 20/);
  // A daylight-saving day's 25 hours still make one Yesterday, whatever the zone.
  const sunday = Date.parse("2026-11-02T10:00:00");
  expect(dayLabel(Date.parse("2026-11-01T00:30:00"), sunday)).toBe("Yesterday");
  expect(dayLabel(Date.parse("2026-10-31T23:30:00"), sunday)).toMatch(/Oct 31/);
});

test("a title loses its Conventional Commit prefix, and keeps anything else", () => {
  expect(plainTitle("fix(GH-27): replace the reward")).toBe("replace the reward");
  expect(plainTitle("feat!: drop v1")).toBe("drop v1");
  expect(plainTitle("Scheduler: spill to devbox")).toBe("Scheduler: spill to devbox");
});
