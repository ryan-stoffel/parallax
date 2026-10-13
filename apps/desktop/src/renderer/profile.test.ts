import { expect, test } from "vite-plus/test";

import type { AgentRun } from "../protocol/generated/protocol";
import { activityOf, dayKey, initials, rhythmOf } from "./profile";

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

test("hours count agents by local hour, and the busiest hour names the rhythm", () => {
  const at = (h: number) =>
    ({ backend: "claude", createdAt: new Date(2026, 9, 2, h, 30).toISOString() }) as AgentRun;
  const { hours } = activityOf([at(23), at(23), at(0), at(9)], 0);
  expect(hours).toHaveLength(24);
  expect([hours[0], hours[9], hours[23]]).toEqual([1, 1, 2]);
  expect([4, 5, 11, 12, 17, 18, 21, 22].map(rhythmOf)).toEqual([
    "Night owl",
    "Early bird",
    "Early bird",
    "Afternoon builder",
    "Afternoon builder",
    "Evening builder",
    "Evening builder",
    "Night owl",
  ]);
});
