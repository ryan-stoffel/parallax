import { expect, test } from "vite-plus/test";

import { fill, isQuestion, questionsOf } from "./questions";
import type { ApprovalRequest } from "./transcript";

type Asked = Pick<ApprovalRequest, "toolName" | "input">;

const claude: Asked = {
  toolName: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "SQLite (Recommended)", description: "One writer" },
          { label: "Postgres", description: "A server" },
        ],
      },
      {
        question: "Which platforms?",
        multiSelect: true,
        options: [{ label: "macOS" }, { label: "Linux" }],
      },
    ],
  },
};
const codex: Asked = {
  toolName: "request_user_input",
  input: {
    questions: [
      {
        id: "pick",
        question: "Pick one",
        isOther: false,
        isSecret: false,
        options: [{ label: "A" }],
      },
      { id: "token", question: "Your token", isOther: false, isSecret: true, options: null },
    ],
  },
};

test("reads each tool's questions, and marks and trims a recommended option", () => {
  const [first, second] = questionsOf(claude);
  expect(first).toMatchObject({ id: "Which database?", multiple: false, custom: true });
  expect(first?.options[0]).toEqual({
    value: "SQLite (Recommended)",
    label: "SQLite",
    description: "One writer",
    recommended: true,
  });
  expect(second).toMatchObject({ multiple: true, custom: true });
  const [pick, token] = questionsOf(codex);
  expect(pick).toMatchObject({ id: "pick", custom: false, secret: false });
  expect(token).toMatchObject({ id: "token", custom: true, secret: true, options: [] });
});

test("anything that doesn't hold questions is an ordinary request", () => {
  expect(isQuestion({ toolName: "Bash", input: { questions: [{ question: "?" }] } })).toBe(false);
  expect(isQuestion({ toolName: "AskUserQuestion", input: { truncated: true, bytes: 9 } })).toBe(
    false,
  );
  expect(isQuestion({ toolName: "request_user_input", input: { questions: [] } })).toBe(false);
});

test("Claude Code's answers go by question text in its own input, several joined by commas", () => {
  const filled = fill(claude, questionsOf(claude), [
    { picked: ["SQLite (Recommended)"], typed: "" },
    { picked: ["macOS", "Linux"], typed: " BSD " },
  ]);
  expect(filled.input).toEqual({
    ...(claude.input as object),
    answers: { "Which database?": "SQLite (Recommended)", "Which platforms?": "macOS, Linux, BSD" },
  });
  expect(filled.answers).toEqual(["SQLite (Recommended)", "macOS, Linux, BSD"]);
});

test("Codex's answers go by id, and a secret stays out of the transcript's answers", () => {
  const filled = fill(codex, questionsOf(codex), [
    { picked: ["A"], typed: "" },
    { picked: [], typed: "s3cret" },
  ]);
  expect(filled.input).toEqual({
    answers: { pick: { answers: ["A"] }, token: { answers: ["s3cret"] } },
  });
  expect(filled.answers).toEqual(["A", "Hidden"]);
  expect(JSON.stringify(filled.answers)).not.toContain("s3cret");
});
