import { expect, test } from "vitest";

import { alertFor, phaseOf } from "./alerts";

const run = (status: string) => ({ status }) as Parameters<typeof phaseOf>[0];

test("a run asking for approval needs you, and alerts come on a new ask or a turn ending only", () => {
  expect(phaseOf(run("running"), 1)).toBe("needsYou");
  expect(phaseOf(run("running"), 0)).toBe("working");
  expect(phaseOf(run("completed"), 0)).toBe("done");
  expect(phaseOf(run("failed"), 0)).toBe("failed");
  expect(phaseOf(run("cancelled"), 0)).toBe("idle");
  // Notifies on a new ask and on a turn ending, never on first sight.
  expect(alertFor(undefined, "done")).toBeUndefined();
  expect(alertFor("working", "needsYou")).toBe("needsYou");
  expect(alertFor("needsYou", "needsYou")).toBeUndefined();
  expect(alertFor("working", "done")).toBe("done");
  expect(alertFor("needsYou", "failed")).toBe("failed");
  // A run already finished that loads again isn't news.
  expect(alertFor("idle", "done")).toBeUndefined();
});

test("a turn that ends while the run still waits is not done until the waiting ends", () => {
  const waiting = phaseOf(run("completed"), 0, true);
  expect(waiting).toBe("working");
  expect(alertFor("working", waiting)).toBeUndefined();
  expect(alertFor(waiting, phaseOf(run("completed"), 0, false))).toBe("done");
  expect(phaseOf(run("failed"), 0, true)).toBe("failed");
});
