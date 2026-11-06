// An agent's questions for the user (PLX-245), read from a permission request's input. Claude Code
// asks with `AskUserQuestion` and Codex with `request_user_input`. Both name a question's text,
// short header, and options, and take their answers back in different shapes.
import type { JsonValue } from "../protocol/generated/protocol";
import { isObject, type ApprovalRequest } from "./transcript";

export interface QuestionOption {
  /** What the agent reads when it's picked, exactly as it asked. */
  value: string;
  /** What the user reads: the value without its "(Recommended)". */
  label: string;
  description?: string;
  recommended: boolean;
}

export interface Question {
  /** What the answer is filed under: Codex's id, or Claude Code's question text. */
  id: string;
  text: string;
  header?: string;
  multiple: boolean;
  /** Whether the user may type an answer of their own. */
  custom: boolean;
  /** Whether a typed answer is hidden, and left out of the transcript. */
  secret: boolean;
  options: QuestionOption[];
}

/** What the user chose for one question: the options' values, and what they typed. */
export interface Choice {
  picked: readonly string[];
  typed: string;
}

/** What `agent/approve` carries for answered questions. */
export interface Filled {
  /** The tool's input, with the answers the agent reads. */
  input: Record<string, JsonValue>;
  /** One line per question, for the transcript. A secret answer isn't among them. */
  answers: string[];
}

/** What the agent reads when the user skips, since no answer may otherwise read as a denial. */
export const SKIPPED = "The user skipped this question. Continue without an answer.";

const claude = "AskUserQuestion";
const codex = "request_user_input";
const recommended = /\s*\(recommended\)\s*$/i;

const text = (value: JsonValue | undefined) =>
  typeof value === "string" && value.trim() ? value : undefined;

function optionsOf(value: JsonValue | undefined): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option): QuestionOption[] => {
    const label = isObject(option) ? text(option["label"]) : undefined;
    if (!isObject(option) || !label) return [];
    const description = text(option["description"]);
    return [
      {
        value: label,
        label: label.replace(recommended, ""),
        ...(description && { description }),
        recommended: recommended.test(label),
      },
    ];
  });
}

/**
 * The questions a request asks, in order. None for any other tool, or for an input too large to
 * have arrived whole, which then shows as an ordinary request.
 */
export function questionsOf(request: Pick<ApprovalRequest, "toolName" | "input">): Question[] {
  const { toolName, input } = request;
  if ((toolName !== claude && toolName !== codex) || !isObject(input)) return [];
  const list = input["questions"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Question[] => {
    const question = isObject(item) ? text(item["question"]) : undefined;
    if (!isObject(item) || !question) return [];
    const options = optionsOf(item["options"]);
    const header = text(item["header"]);
    const fromCodex = toolName === codex;
    return [
      {
        id: (fromCodex && text(item["id"])) || question,
        text: question,
        ...(header && { header }),
        multiple: !fromCodex && item["multiSelect"] === true,
        // Claude Code always takes an answer of the user's own.
        custom: !fromCodex || item["isOther"] === true || options.length === 0,
        secret: fromCodex && item["isSecret"] === true,
        options,
      },
    ];
  });
}

/** Whether a request is an agent's question rather than a tool call to allow. */
export const isQuestion = (request: Pick<ApprovalRequest, "toolName" | "input">) =>
  questionsOf(request).length > 0;

/** A choice's answers: the options picked, then what the user typed. */
const partsOf = ({ picked, typed }: Choice) => {
  const own = typed.trim();
  return own ? [...picked, own] : [...picked];
};

/** Whether a choice answers its question. */
export const isAnswered = (choice: Choice) => partsOf(choice).length > 0;

/**
 * The answers to `questions` as their tool takes them: Claude Code reads its input back with each
 * answer by question text, several joined with commas, and Codex reads answers by question id.
 */
export function fill(
  request: Pick<ApprovalRequest, "toolName" | "input">,
  questions: readonly Question[],
  choices: readonly Choice[],
): Filled {
  const parts = choices.map(partsOf);
  const input: Record<string, JsonValue> =
    request.toolName === codex
      ? {
          answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: parts[i] ?? [] }])),
        }
      : {
          ...(isObject(request.input) ? request.input : {}),
          answers: Object.fromEntries(questions.map((q, i) => [q.id, (parts[i] ?? []).join(", ")])),
        };
  return {
    input,
    answers: questions.map((q, i) => (q.secret ? "Hidden" : (parts[i] ?? []).join(", "))),
  };
}
