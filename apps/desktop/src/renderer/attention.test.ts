import { expect, test } from "vite-plus/test";

import type { AgentRun, Thread } from "../protocol/generated/protocol";
import {
  attentionOf,
  childOrder,
  initials,
  projectAttention,
  runAttention,
  snoozeChoices,
  snoozed,
} from "./attention";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t",
  repo: "r",
  createdAt: "2026-10-01T10:00:00Z",
  ...over,
});
const run = (over: Partial<AgentRun> = {}) =>
  ({ id: "t", status: "completed", updatedAt: "2026-10-01T11:00:00Z", ...over }) as AgentRun;

test("a thread's attention follows its run, its requests, and when it was seen", () => {
  expect(attentionOf(thread(), run({ status: "running" }), 0)).toBe("working");
  expect(attentionOf(thread(), run({ status: "running" }), 1)).toBe("needsYou");
  expect(attentionOf(thread(), run(), 0)).toBe("done");
  expect(attentionOf(thread(), run({ status: "failed" }), 0)).toBe("failed");
  expect(attentionOf(thread(), run({ status: "waiting" }), 0)).toBe("settled");
  expect(attentionOf(thread({ seenAt: "2026-10-01T12:00:00Z" }), run(), 0)).toBe("settled");
  // It stopped again after the user looked.
  expect(attentionOf(thread({ seenAt: "2026-10-01T10:30:00Z" }), run(), 0)).toBe("done");
  expect(attentionOf(thread(), undefined, 0)).toBe("settled");
});

test("a Project needs the user when any run does, and works while any run does", () => {
  const runs = [run({ id: "a" }), run({ id: "b", status: "running" })];
  expect(projectAttention(runs, () => 0)).toBe("working");
  expect(projectAttention(runs, (id) => (id === "a" ? 1 : 0))).toBe("needsYou");
  expect(projectAttention([run()], () => 0)).toBe("settled");
});

test("a Project's children sort Needs you, Working, Done, then Failed", () => {
  const order = (r: AgentRun, asks = 0) => childOrder.indexOf(runAttention(r, asks));
  const runs = [
    run({ id: "failed", status: "failed" }),
    run({ id: "done" }),
    run({ id: "cancelled", status: "cancelled" }),
    run({ id: "working", status: "running" }),
    run({ id: "asks", status: "running" }),
  ];
  const asks = (r: AgentRun) => (r.id === "asks" ? 1 : 0);
  expect(runs.toSorted((a, b) => order(a, asks(a)) - order(b, asks(b))).map((r) => r.id)).toEqual([
    "asks",
    "working",
    "done",
    "cancelled",
    "failed",
  ]);
});

test("a snoozed thread hides until its time, or until it needs the user", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const later = thread({ snoozedUntil: "2026-10-01T13:00:00Z" });
  expect(snoozed(later, "done", now)).toBe(true);
  expect(snoozed(later, "needsYou", now)).toBe(false);
  expect(snoozed(thread({ snoozedUntil: "2026-10-01T11:00:00Z" }), "done", now)).toBe(false);
});

test("a repo's initials", () => {
  expect(initials("capstone-engine")).toBe("CE");
  expect(initials("parallax")).toBe("PA");
  expect(initials(".dotfiles")).toBe("DO");
});

test("snooze choices land on the right days", () => {
  // A Wednesday afternoon.
  const now = new Date(2026, 8, 30, 15, 30);
  const [hour, three, tomorrow, week] = snoozeChoices(now).map((c) => c.until);
  expect(hour!.getTime() - now.getTime()).toBe(3_600_000);
  expect(three!.getHours()).toBe(18);
  expect([tomorrow!.getDate(), tomorrow!.getHours()]).toEqual([1, 9]);
  expect([week!.getDay(), week!.getDate(), week!.getHours()]).toEqual([1, 5, 9]);
});
