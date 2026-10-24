import { expect, test } from "vitest";

import { alertFor, phaseOf } from "./alerts";

const run = (status: string) => ({ status }) as Parameters<typeof phaseOf>[0];

test("a run asking for approval needs you, whatever its status", () => {
  expect(phaseOf(run("running"), 1)).toBe("needsYou");
  expect(phaseOf(run("running"), 0)).toBe("working");
  expect(phaseOf(run("completed"), 0)).toBe("done");
  expect(phaseOf(run("failed"), 0)).toBe("failed");
  expect(phaseOf(run("cancelled"), 0)).toBe("idle");
});

test("notifies on a new ask and on a turn ending, never on first sight", () => {
  expect(alertFor(undefined, "done")).toBeUndefined();
  expect(alertFor("working", "needsYou")).toBe("needsYou");
  expect(alertFor("needsYou", "needsYou")).toBeUndefined();
  expect(alertFor("working", "done")).toBe("done");
  expect(alertFor("needsYou", "failed")).toBe("failed");
  // A run already finished that loads again isn't news.
  expect(alertFor("idle", "done")).toBeUndefined();
});
