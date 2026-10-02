import { expect, test } from "vite-plus/test";

import type { AgentRun } from "../protocol/generated/protocol";
import { activityOf, dayKey, initials } from "./profile";

test("initials are the first and last names' first letters, or the email's", () => {
  expect(initials({ name: "Ryan Thomas Stoffel", email: "r@x.dev" })).toBe("RS");
  expect(initials({ name: "  ryan  ", email: "r@x.dev" })).toBe("R");
  expect(initials({ name: "", email: "ryan@x.dev" })).toBe("R");
  expect(initials({ name: "Émile Zola", email: "" })).toBe("ÉZ");
});

/** A run started at local `y-m-d` noon. */
const run = (y: number, m: number, d: number, more: Partial<AgentRun> = {}) =>
  ({
    backend: "claude",
    createdAt: new Date(y, m - 1, d, 12).toISOString(),
    ...more,
  }) as AgentRun;

test("streaks count local days with an agent, across a month's end", () => {
  const runs = [
    run(2026, 9, 1),
    run(2026, 9, 29),
    run(2026, 9, 30),
    run(2026, 9, 30),
    run(2026, 10, 1),
    run(2026, 10, 2),
  ];
  const today = new Date(2026, 9, 2, 18).getTime();
  const a = activityOf(runs, today);
  expect(a.agents).toBe(6);
  expect(a.longest).toBe(4);
  expect(a.current).toBe(4);
  expect(a.busiest).toEqual({ day: "2026-09-30", agents: 2 });
  expect(a.since).toBe(Date.parse(runs[0]!.createdAt));
  // A day with none yet keeps yesterday's streak; a missed day ends it.
  expect(activityOf(runs, new Date(2026, 9, 3, 9).getTime()).current).toBe(4);
  expect(activityOf(runs, new Date(2026, 9, 4, 9).getTime()).current).toBe(0);
});

test("models are counted per backend and model, most first, and pull requests summed", () => {
  const a = activityOf(
    [
      run(2026, 10, 1, { model: "gpt-6-sol", backend: "codex", pullRequests: ["a", "b"] }),
      run(2026, 10, 1),
      run(2026, 10, 2),
      run(2026, 10, 2, { pullRequests: ["c"] }),
    ],
    Date.now(),
  );
  expect(a.pullRequests).toBe(3);
  expect(a.models).toEqual([
    { backend: "claude", model: undefined, agents: 3 },
    { backend: "codex", model: "gpt-6-sol", agents: 1 },
  ]);
  expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
});

test("the peak is the most agents started within one hour", () => {
  const at = (h: number, m: number) =>
    ({ backend: "claude", createdAt: new Date(2026, 9, 2, h, m).toISOString() }) as AgentRun;
  const a = activityOf([at(9, 0), at(9, 40), at(9, 59), at(10, 0), at(10, 30), at(14, 0)], 0);
  // 9:00, 9:40, and 9:59 fit in an hour, and so do 9:40, 9:59, 10:00, and 10:30.
  expect(a.peak).toEqual({ agents: 4, at: Date.parse(at(9, 40).createdAt) });
  expect(activityOf([], 0).peak).toBeUndefined();
});
