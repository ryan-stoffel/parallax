import { expect, test } from "vitest";

import { threadStatus } from "./threadStatus";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

const computer = (over: { connectedNow?: boolean; loading?: boolean } = {}) =>
  ({
    connectedNow: over.connectedNow ?? true,
    machine: { id: "account:one" },
    view: {
      loading: over.loading ?? false,
      state: {
        threads: [
          { id: "live", createdAt: hoursAgo(50), lastPromptAt: hoursAgo(40) },
          { id: "asks", createdAt: hoursAgo(3) },
          { id: "ended", createdAt: hoursAgo(3) },
          { id: "old", createdAt: hoursAgo(90) },
          { id: "gone", createdAt: hoursAgo(1), archived: true },
          { id: "never", createdAt: hoursAgo(1) },
        ],
        titles: { live: "Fix the build", ended: "Ship it" },
        runs: {
          live: { status: "running", updatedAt: hoursAgo(0) },
          asks: { status: "running", updatedAt: hoursAgo(1) },
          ended: { status: "failed", updatedAt: hoursAgo(2) },
          old: { status: "completed", updatedAt: hoursAgo(30) },
          gone: { status: "running", updatedAt: hoursAgo(1) },
        },
        approvals: { asks: { items: [{ kind: "approval", resolved: false }] } },
        waiting: {},
      },
    },
  }) as unknown as Parameters<typeof threadStatus>[0][number];

test("it keeps live threads however old and recently ended ones, with a time a busy thread doesn't change", () => {
  const { seen, connected } = threadStatus([computer()], NOW);
  expect(connected).toEqual(["account:one"]);
  expect(seen.map((e) => [e.run, e.state])).toEqual([
    ["live", "working"],
    ["asks", "needsYou"],
    ["ended", "failed"],
  ]);
  expect(seen[0]).toMatchObject({
    title: "Fix the build",
    at: NOW - 40 * 3_600_000,
    link: "parallax://thread/account%3Aone/live",
  });
  expect(seen[1]!.title).toBe("A thread");
  expect(seen[2]!.at).toBe(NOW - 2 * 3_600_000);
});

test("a computer not known now says nothing, so what's kept for it stays", () => {
  expect(threadStatus([computer({ connectedNow: false })], NOW)).toEqual({ seen: [], connected: [] });
  expect(threadStatus([computer({ loading: true })], NOW)).toEqual({ seen: [], connected: [] });
});
