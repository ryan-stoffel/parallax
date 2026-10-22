import { expect, test } from "vite-plus/test";

import { dayLabel, plainTitle, standing } from "./ProjectHome";

const now = Date.parse("2026-10-22T15:00:00");
const row = (group: "waiting" | "working" | "ready" | "resolved", daysAgo = 0) =>
  ({ group, run: { updatedAt: new Date(now - daysAgo * 86_400_000).toISOString() } }) as never;

test("the head says who works and waits, else All quiet, then what finished this week", () => {
  expect(standing([], now)).toBe("All quiet.");
  expect(standing([row("resolved", 2), row("ready"), row("resolved", 9)], now)).toBe(
    "All quiet. 2 done this week.",
  );
  expect(standing([row("working"), row("working"), row("waiting")], now)).toBe(
    "2 agents working, 1 needs you.",
  );
  expect(standing([row("working"), row("ready")], now)).toBe("1 agent working. 1 done this week.");
});

test("a log day is Today, Yesterday, or its date", () => {
  expect(dayLabel(Date.parse("2026-10-22T08:00:00"), now)).toBe("Today");
  expect(dayLabel(Date.parse("2026-10-21T23:59:00"), now)).toBe("Yesterday");
  expect(dayLabel(Date.parse("2026-10-20T12:00:00"), now)).toMatch(/Oct 20/);
});

test("a title loses its Conventional Commit prefix, and keeps anything else", () => {
  expect(plainTitle("fix(GH-27): replace the reward")).toBe("replace the reward");
  expect(plainTitle("feat!: drop v1")).toBe("drop v1");
  expect(plainTitle("Scheduler: spill to devbox")).toBe("Scheduler: spill to devbox");
});
