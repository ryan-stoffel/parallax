import { expect, test } from "vite-plus/test";

import samples from "../../../../crates/wisp-protocol/samples/v1/agents.json";
import type { AgentOutputItem, LoggedEvent, WispEvent } from "../protocol/generated/protocol";
import { applyEvents, emptyTranscript, type Item } from "./transcript";
import { uuidv7 } from "./uuidv7";

const runId = "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01";
// agents.json's events, in log order: a run's whole life, then a fallback and three endings.
const logged = (samples as { method?: string; params?: unknown }[])
  .filter((m) => m.method === "events/event")
  .map((m) => m.params as LoggedEvent);
const upTo = (seq: number) => logged.filter((e) => e.seq <= seq);

let nextSeq = 100;
const at = (event: WispEvent): LoggedEvent => ({ seq: nextSeq++, time: "", event });
const output = (...items: AgentOutputItem[]) => at({ kind: "agent.output", runId, items });
const build = (...events: LoggedEvent[]) => applyEvents(emptyTranscript, events, runId);
const of = <K extends Item["kind"]>(items: Item[], kind: K) =>
  items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);

test("rebuilds the sample run's transcript, item by item", () => {
  const t = build(...upTo(8));
  expect(t.seq).toBe(8);
  expect(t.items.map((i) => i.kind)).toEqual([
    "user", // the prompt, from agent.started
    "assistant", // msg_1: its delta, then its full text
    "reasoning",
    "todo",
    "tool", // Write: ok
    "tool", // Bash: input too large, denied
    "tool", // a result with no call
    "notice",
    "notice", // the warning
    "assistant", // the turn's result, which it hadn't said yet
    "user", // the follow-up, by turn id only
    "assistant", // its result
    "notice", // the follow-up was dropped
    "end",
  ]);

  const [prompt, followUp] = of(t.items, "user");
  expect(prompt).toMatchObject({ text: "Add a README that explains how to build the app." });
  expect(followUp).toMatchObject({ text: null, turnId: "01a0d361-2b3c-7d4e-9f50-6a7b8c9d0e11" });
  expect(of(t.items, "assistant").map((i) => i.text)).toEqual([
    "I'll add a README and note the build steps in shared context.",
    "Added README.md.",
    "Mentioned the tests.",
  ]);
  expect(of(t.items, "tool")).toMatchObject([
    { name: "Write", status: "ok", output: "File created" },
    { name: "Bash", status: "denied", input: { truncated: true } },
    { name: null, callId: "toolu_3", status: "error" },
  ]);
  expect(of(t.items, "notice").map((i) => i.tone)).toEqual(["info", "warning", "warning"]);
  expect(of(t.items, "end")[0]!.outcome).toEqual({
    status: "completed",
    result: "Mentioned the tests.",
  });

  // agent.updated kept the run current; the branch came with agent.started.
  expect(t.run).toMatchObject({ status: "completed", sessionId: "session-7f3a" });
  expect(t.run!.diff).toMatchObject({ files: 2 });
});

test("a page and a live event with the same seq apply once, and other runs are skipped", () => {
  const once = build(...upTo(8));
  expect(applyEvents(once, upTo(8), runId)).toEqual(once);

  const other = { ...logged[0]!, seq: 50, event: { ...logged[0]!.event, runId: "someone-else" } };
  const after = applyEvents(once, [other as LoggedEvent], runId);
  expect(after.items).toEqual(once.items);
  expect(after.seq).toBe(50);
});

test("kinds this version doesn't know are skipped, but still count their seq", () => {
  const known = build(...upTo(1));
  const newer = [
    at({ kind: "agent.somethingNew", runId } as unknown as WispEvent),
    output({ kind: "somethingNew" } as unknown as AgentOutputItem),
  ];
  const t = applyEvents(known, newer, runId);
  expect(t.items).toEqual(known.items);
  expect(t.seq).toBe(newer[1]!.seq);
});

test("an account fallback moves the run and says why", () => {
  const t = build(...upTo(9));
  expect(t.run!.accountId).toBe("01a0d34b-3c4d-7e5f-a061-7b8c9d0e1f22");
  expect(t.items.at(-1)).toMatchObject({
    kind: "notice",
    text: "Switched from Claude subscription to API key: rate limited.",
  });
});

test("each way a run ends is an end item, and an update clears a stale error", () => {
  const t = build(...logged);
  expect(of(t.items, "end").map((i) => i.outcome.status)).toEqual([
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]);
  // seq 14 failed with an error; seq 15 no longer has one.
  expect(build(...upTo(14)).run!.error).toBe("the CLI exited with code 1");
  expect(t.run).toMatchObject({ status: "cancelled", error: undefined });
});

test("deltas without a message id stream into one message that the full text replaces", () => {
  const t = build(
    ...upTo(1),
    output({ kind: "textDelta", text: "Hel" }),
    output({ kind: "textDelta", text: "lo" }),
  );
  const streaming = t.items.at(-1)!;
  expect(streaming).toMatchObject({ kind: "assistant", text: "Hello", partial: true });

  const done = applyEvents(t, [output({ kind: "text", text: "Hello!" })], runId);
  expect(done.items).toHaveLength(2);
  expect(done.items.at(-1)).toEqual({ kind: "assistant", key: streaming.key, text: "Hello!" });
});

test("a turn's result that repeats its last message isn't shown twice", () => {
  const t = build(
    ...upTo(1),
    output({ kind: "text", text: "All done." }, { kind: "turnFinished", result: "All done." }),
  );
  expect(of(t.items, "assistant")).toHaveLength(1);
});

test("a follow-up shows the text its turnStarted logged", () => {
  const turnId = uuidv7();
  const t = build(...upTo(1), output({ kind: "turnStarted", turnId, text: "And the tests." }));
  expect(of(t.items, "user").at(-1)).toMatchObject({ text: "And the tests.", turnId });
});

test("uuidv7 puts the time first and sets the version and variant", () => {
  const id = uuidv7(0x0190_1234_5678);
  expect(id).toMatch(/^01901234-5678-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(uuidv7()).not.toBe(uuidv7());
});
