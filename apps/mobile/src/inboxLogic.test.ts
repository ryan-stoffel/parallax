import { expect, test } from "vitest";

import type { InboxItem, Question } from "../../desktop/src/protocol/generated/protocol";
import { inboxSections, readByOpening } from "./inboxLogic";

const NOW = new Date(2026, 10, 4, 12).getTime();
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

const item = (id: string, kind: InboxItem["kind"], daysAgo = 0, seenAt?: string): InboxItem => ({
  id,
  kind,
  run: "child",
  text: `Task: asks ${JSON.stringify(`Question ${id}?`)}, went on assuming "Yes"`,
  createdAt: at(daysAgo),
  ...(seenAt && { seenAt }),
});

const question = (id: string, status: Question["status"]): Question => ({
  id,
  run: "child",
  question: `Question ${id}?`,
  assumption: "Yes",
  status,
  createdAt: at(0),
});

test("opening reads all but what waits on the user, even before its questions load", () => {
  const items = [
    item("done", "done"),
    item("read", "failed", 0, at(0)),
    item("waiting", "needsYou"),
    item("answered", "needsYou"),
  ];
  expect(readByOpening(items, [])).toEqual(["done"]);
  expect(readByOpening(items, [question("waiting", "escalated"), question("answered", "answered")])).toEqual([
    "done",
    "answered",
  ]);
});

test("what waits on the user leads, then each day, newest first", () => {
  const items = [item("old", "done", 1), item("asked", "needsYou", 1), item("first", "done"), item("second", "learned")];
  expect(inboxSections(items, [], NOW).map((s) => [s.title, s.items.map((i) => i.id)])).toEqual([
    ["Needs you", ["asked"]],
    ["Today", ["second", "first"]],
    ["Yesterday", ["old"]],
  ]);
});
