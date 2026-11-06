import { expect, test } from "vitest";

import { questionsOf } from "../../desktop/src/renderer/questions";
import type { Approval } from "../../desktop/src/renderer/transcript";
import { nextOpen, questionLine, toggled, typedIn } from "./questionLogic";

const request = {
  approvalId: "a1",
  toolName: "AskUserQuestion",
  input: {
    questions: [
      { question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
      { question: "Which platforms?", multiSelect: true, options: [{ label: "macOS" }, { label: "Linux" }] },
    ],
  },
} as Approval["request"];
const [single, multiple] = questionsOf(request);
const none = { picked: [], typed: "" };

test("a single choice holds one answer, and a multiple one holds several and what was typed", () => {
  const picked = toggled(none, single!, "SQLite", true);
  expect(toggled(picked, single!, "Postgres", true)).toEqual({ picked: ["Postgres"], typed: "" });
  expect(typedIn(picked, single!, "MySQL")).toEqual({ picked: [], typed: "MySQL" });
  expect(toggled({ picked: [], typed: "MySQL" }, single!, "SQLite", true)).toEqual({ picked: ["SQLite"], typed: "" });

  const both = toggled(toggled(none, multiple!, "macOS", true), multiple!, "Linux", true);
  expect(typedIn(both, multiple!, "BSD")).toEqual({ picked: ["macOS", "Linux"], typed: "BSD" });
  expect(toggled(both, multiple!, "macOS", false).picked).toEqual(["Linux"]);
});

test("the next open question goes round from this one, and none is left once the others are answered", () => {
  const done = { picked: ["x"], typed: "" };
  expect(nextOpen([none, none, none], 0)).toBe(1);
  expect(nextOpen([none, done, none], 2)).toBe(0);
  expect(nextOpen([none, done], 0)).toBeUndefined();
});

test("a question's line says how it came out, and any other request has none", () => {
  const one = { ...request, input: { questions: [{ question: "Which database?", options: [{ label: "SQLite" }] }] } };
  const approval = (resolved?: Approval["resolved"], asked = one): Approval => ({
    kind: "approval",
    key: "k",
    request: asked,
    ...(resolved && { resolved }),
  });
  expect(questionLine(approval())?.title).toBe("Waiting for your answer: Which database?");
  expect(questionLine(approval({ decision: "allowed", by: "user", answers: ["SQLite"] }))).toEqual({
    title: "Answered Which database?",
    answers: "SQLite",
  });
  expect(questionLine(approval({ decision: "denied", by: "user" }))?.title).toBe("Skipped Which database?");
  expect(questionLine(approval({ decision: "denied", by: "cancel" }))?.title).toBe("Question ended Which database?");
  expect(questionLine(approval({ decision: "allowed", by: "user", answers: ["A", "Hidden"] }, request))).toEqual({
    title: "Answered 2 questions",
    answers: "A · Hidden",
  });
  expect(questionLine(approval(undefined, { ...request, toolName: "Bash" }))).toBeUndefined();
});
