import { expect, test, vi } from "vitest";

import type { LoggedEvent } from "../../desktop/src/protocol/generated/protocol";
import { alertFor, HOLD_MS, holdAlerts, lastReplyIn, phaseOf, replyText } from "./alerts";

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

/** Fake timers and a `holdAlerts` for host `h`, run `r`, with what it fired. */
function held() {
  vi.useFakeTimers();
  const fired: string[] = [];
  const alerts = holdAlerts((hostId, runId, alert) => fired.push(`${hostId}/${runId}/${alert}`));
  return { fired, alerts, see: (phase: Parameters<typeof alerts.see>[2]) => alerts.see("h", "r", phase) };
}

test("a thread that stays done notifies once when the hold ends, however often it renders", () => {
  const { fired, see } = held();
  see("working");
  see("done");
  vi.advanceTimersByTime(HOLD_MS - 1);
  see("done");
  expect(fired).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(fired).toEqual(["h/r/done"]);
  see("done");
  vi.advanceTimersByTime(HOLD_MS);
  expect(fired).toEqual(["h/r/done"]);
});

test("a thread that goes on within the hold doesn't notify, and a new hold starts over", () => {
  const { fired, see } = held();
  see("working");
  see("failed");
  vi.advanceTimersByTime(HOLD_MS - 1);
  see("working");
  vi.advanceTimersByTime(HOLD_MS);
  expect(fired).toEqual([]);
  see("done");
  vi.advanceTimersByTime(HOLD_MS - 1);
  expect(fired).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(fired).toEqual(["h/r/done"]);
});

test("an approval request notifies at once and ends the hold", () => {
  const { fired, see } = held();
  see("working");
  see("done");
  see("needsYou");
  expect(fired).toEqual(["h/r/needsYou"]);
  vi.advanceTimersByTime(HOLD_MS);
  expect(fired).toEqual(["h/r/needsYou"]);
});

test("clear drops every hold", () => {
  const { fired, alerts, see } = held();
  see("working");
  see("done");
  alerts.clear();
  vi.advanceTimersByTime(HOLD_MS);
  expect(fired).toEqual([]);
});

test("a reply reads as plain text on one line, cut to about 140 characters", () => {
  expect(
    replyText("## Done\n\n- **Fixed** the `foo_bar` bug in [the parser](https://x.dev/a)\n- *Added* a test\n```ts\nlet a;\n```"),
  ).toBe("Done Fixed the foo_bar bug in the parser Added a test let a;");
  expect(replyText(" \n ```\n```")).toBeUndefined();
  const cut = replyText("word ".repeat(100))!;
  expect(cut.endsWith("word…")).toBe(true);
  expect(cut.length).toBeLessThanOrEqual(141);
  expect(replyText("a".repeat(139) + "😀" + "b").endsWith("a…")).toBe(true);
});

test("the last reply is the newest assistant text, if there is one", () => {
  const output = (seq: number, items: object[]) =>
    ({ seq, time: "2026-01-01T00:00:00Z", event: { kind: "agent.output", runId: "r", items } }) as LoggedEvent;
  const events = [
    output(1, [{ kind: "text", messageId: "m1", text: "First" }]),
    output(2, [{ kind: "toolCall", callId: "c", name: "Bash", input: {} }]),
    output(3, [{ kind: "text", messageId: "m2", text: "**All** done" }]),
    output(4, [{ kind: "toolResult", callId: "c", status: "completed" }]),
  ];
  expect(lastReplyIn(events, "r")).toBe("All done");
  expect(lastReplyIn(events.slice(1, 2), "r")).toBeUndefined();
});
