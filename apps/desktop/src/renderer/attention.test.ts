import { expect, test } from "vite-plus/test";

import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { activeAt, attentionOf, snoozed } from "./attention";

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
  // Its turn ended but it waits on a Monitor or a watched pull request (PLX-777).
  expect(attentionOf(thread(), run(), 0, "waiting")).toBe("waiting");
  expect(attentionOf(thread(), run(), 0, "monitoring")).toBe("monitoring");
  expect(attentionOf(thread(), run({ status: "running" }), 0, "waiting")).toBe("working");
  // Archiving clears every badge.
  const archived = thread({ archived: true });
  expect(attentionOf(archived, run(), 0)).toBe("settled");
  expect(attentionOf(archived, run({ status: "running" }), 1)).toBe("settled");
});

test("a snoozed thread hides until its time, or until it needs the user", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const later = thread({ snoozedUntil: "2026-10-01T13:00:00Z" });
  expect(snoozed(later, "done", now)).toBe(true);
  expect(snoozed(later, "needsYou", now)).toBe(false);
  expect(snoozed(thread({ snoozedUntil: "2026-10-01T11:00:00Z" }), "done", now)).toBe(false);
});

test("a thread is active as of its last prompt, or when its run stopped after it, so a finished one rises", () => {
  const prompted = thread({ lastPromptAt: "2026-10-01T10:30:00Z" });
  const stopped = "2026-10-01T11:00:00Z";
  expect(activeAt(prompted, run(), stopped)).toBe(stopped);
  // While it works, or waits out a usage limit, its row stays where its prompt put it.
  expect(activeAt(prompted, run({ status: "running" }), stopped)).toBe("2026-10-01T10:30:00Z");
  expect(activeAt(prompted, run({ status: "waiting" }), stopped)).toBe("2026-10-01T10:30:00Z");
  // A run that stopped before the newest prompt doesn't move it back.
  expect(activeAt(thread({ lastPromptAt: "2026-10-01T12:00:00Z" }), run(), stopped)).toBe(
    "2026-10-01T12:00:00Z",
  );
  expect(activeAt(thread(), undefined)).toBe("2026-10-01T10:00:00Z");
});
