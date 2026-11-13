// What the phone's question card and transcript work out without drawing, as the desktop's
// Question.tsx and Approval.tsx do, which render DOM and can't be imported here.
import { t } from "i18next";

import { isAnswered, questionsOf, type Choice, type Question } from "../../desktop/src/renderer/questions";
import type { Approval } from "../../desktop/src/renderer/transcript";

/** `choice` with an option turned on or off: a single choice has one, and no typed answer. */
export function toggled(choice: Choice, question: Question, value: string, on: boolean): Choice {
  if (!question.multiple) return { picked: on ? [value] : [], typed: "" };
  const others = choice.picked.filter((v) => v !== value);
  return { ...choice, picked: on ? [...others, value] : others };
}

/** `choice` with what the user typed: a single choice's typed answer takes the place of an option. */
export const typedIn = (choice: Choice, question: Question, typed: string): Choice => ({
  picked: question.multiple ? choice.picked : [],
  typed,
});

/** The next question without an answer, going round from `step`, or undefined once none is left. */
export const nextOpen = (choices: readonly Choice[], step: number) =>
  choices
    .map((_, i) => (step + 1 + i) % choices.length)
    .find((i) => i !== step && !isAnswered(choices[i]!));

/** How a question came out, in the desktop's words, followed by what it asked. */
function titleOf({ resolved }: Approval, asked: string) {
  if (!resolved) return t("Waiting for your answer: {{asked}}", { asked });
  if (resolved.decision === "allowed") return t("Answered {{asked}}", { asked });
  return resolved.decision === "denied" && resolved.by === "user"
    ? t("Skipped {{asked}}", { asked })
    : t("Question ended {{asked}}", { asked });
}

/**
 * A question's line in the transcript: how it came out, what it asked, and the user's answers, one
 * per question. Undefined for any other request.
 */
export function questionLine(approval: Approval): { title: string; answers?: string } | undefined {
  const questions = questionsOf(approval.request);
  if (questions.length === 0) return undefined;
  const asked =
    questions.length === 1
      ? questions[0]!.text
      : t("{{count}} questions", { count: questions.length, defaultValue_one: "{{count}} question" });
  return { title: titleOf(approval, asked), answers: approval.resolved?.answers?.join(" · ") };
}
