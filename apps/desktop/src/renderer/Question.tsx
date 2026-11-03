// An agent's questions for the user (PLX-245): a tab that leads the composer's top bar and opens
// the questions above it, or the same panel in place where a view has no bar. Question text is
// untrusted, so it renders only as text.
import { Check, ChevronUp, MessageCircleQuestion, Workflow } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type RefObject, type ToggleEvent } from "react";

import {
  approveButton,
  outlineButton,
  Pinned,
  quietButton,
  type AnswerState,
  type Asked,
  type Choice as AnswerChoice,
} from "./Approval";
import {
  fill,
  isAnswered,
  questionsOf,
  type Choice,
  type Filled,
  type Question,
} from "./questions";

/** What the agent reads when the user skips, since no answer may otherwise read as a denial. */
export const SKIPPED = "The user skipped this question. Continue without an answer.";

const unanswered: Choice = { picked: [], typed: "" };

/** `choice` with an option turned on or off: a single choice has one, and no typed answer. */
function toggled(choice: Choice, question: Question, value: string, on: boolean): Choice {
  if (!question.multiple) return { picked: on ? [value] : [], typed: "" };
  const others = choice.picked.filter((v) => v !== value);
  return { ...choice, picked: on ? [...others, value] : others };
}

/** `choice` with what the user typed: a single choice's typed answer takes the place of an option. */
const typedIn = (choice: Choice, question: Question, typed: string): Choice => ({
  picked: question.multiple ? choice.picked : [],
  typed,
});

/** Where the user is in a request's questions, and what they chose so far. */
function useForm(asked: Asked) {
  const [questions] = useState(() => questionsOf(asked.approval.request));
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<readonly Choice[]>(() => questions.map(() => unanswered));
  const choose = (next: Choice) => setChoices(choices.map((c, i) => (i === step ? next : c)));
  return { questions, step, setStep, choices, choose };
}

type Form = ReturnType<typeof useForm>;

/** One question: its text, its options as radios or checkboxes, and a typed answer if it takes one. */
function QuestionFields({
  question,
  choice,
  onChoose,
  onPicked,
}: {
  question: Question;
  choice: Choice;
  onChoose: (choice: Choice) => void;
  /** A pointer picked a single-choice option, which moves on to the next question. */
  onPicked: () => void;
}) {
  const name = useId();
  const { multiple, options, custom, secret } = question;
  return (
    <fieldset className="min-w-0">
      <legend className="text-body leading-relaxed font-medium break-words whitespace-pre-wrap">
        {question.text}
      </legend>
      {options.length > 0 && (
        <div className="mt-2 -mx-1.5 space-y-px">
          {options.map((option) => (
            <label
              key={option.value}
              className="flex items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-hover has-[:checked]:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
            >
              <input
                type={multiple ? "checkbox" : "radio"}
                name={name}
                checked={choice.picked.includes(option.value)}
                onChange={(e) =>
                  onChoose(toggled(choice, question, option.value, e.target.checked))
                }
                onClick={(e) => {
                  // A key's click (`detail` 0) only moves between options.
                  if (!multiple && e.detail > 0) onPicked();
                }}
                className="mt-1 size-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1 text-body leading-relaxed">
                <span className="break-words">{option.label}</span>
                {option.recommended && (
                  <span className="ml-2 text-meta text-faint-foreground">Recommended</span>
                )}
                {option.description && (
                  <span className="block text-meta break-words text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {custom && (
        <input
          type={secret ? "password" : "text"}
          autoComplete="off"
          aria-label={options.length > 0 ? "Your own answer" : question.text}
          placeholder={options.length > 0 ? "Something else" : "Your answer"}
          value={choice.typed}
          onChange={(e) => onChoose(typedIn(choice, question, e.target.value))}
          className="mt-2 h-7 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-body placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50"
        />
      )}
    </fieldset>
  );
}

interface AskProps {
  asked: Asked;
  /** How many requests with questions wait, this one first. */
  count: number;
  state?: AnswerState;
  onAnswer: (choice: AnswerChoice, message?: string, filled?: Filled) => void;
  onDismiss: () => void;
  /** Why answering is off right now, such as a lost connection. */
  disabledReason?: string;
  focusRef: RefObject<HTMLDivElement | null>;
}

/**
 * The questions as a form. Several step through their headers, each marked once answered. Enter or
 * Next moves on, the last sends them all, and Skip answers none.
 */
function QuestionPanel({
  form,
  asked,
  count,
  state,
  onAnswer,
  onDismiss,
  disabledReason,
  focusRef,
}: AskProps & { form: Form }) {
  const { questions, step, setStep, choices, choose } = form;
  const question = questions[step]!;
  const choice = choices[step] ?? unanswered;
  const last = step === questions.length - 1;
  const busy = state?.state === "answering";
  const gone = state?.state === "gone";
  const ready = last ? choices.every(isAnswered) : isAnswered(choice);
  const off = busy || gone || disabledReason !== undefined;
  const send = () => onAnswer("allow", undefined, fill(asked.approval.request, questions, choices));
  // The question that replaced the one in focus takes its place, so the next key or reader starts
  // there. Never on the first, which takes focus only from nothing (`QuestionQueue`).
  const shown = useRef(step);
  useLayoutEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    focusRef.current?.querySelector<HTMLInputElement>("fieldset input")?.focus();
  }, [step, focusRef]);
  return (
    <div
      ref={focusRef}
      role="group"
      tabIndex={-1}
      aria-label="Question from the agent"
      className="flex max-h-[min(60vh,32rem)] min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-surface px-4 py-3 focus-visible:outline-none"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (off || !ready) return;
          if (last) send();
          else setStep(step + 1);
        }}
        className="flex min-w-0 flex-col gap-2.5"
      >
        {asked.from && (
          <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            <Workflow aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{asked.from.label}</span>
            {asked.from.open && (
              <button
                type="button"
                onClick={asked.from.open}
                className="shrink-0 font-medium text-foreground underline underline-offset-2"
              >
                Open its chat
              </button>
            )}
          </p>
        )}
        {questions.length > 1 ? (
          <div className="-mx-1.5 flex flex-wrap items-center gap-1" aria-label="Questions">
            {questions.map((q, i) => (
              <button
                key={q.id}
                type="button"
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
                className={`flex h-6 max-w-40 items-center gap-1 rounded-md px-1.5 text-meta hover:bg-hover hover:text-foreground ${i === step ? "bg-hover text-foreground" : "text-muted-foreground"}`}
              >
                {isAnswered(choices[i] ?? unanswered) && (
                  <Check aria-label="Answered" className="size-3 shrink-0" />
                )}
                <span className="truncate">{q.header ?? `Question ${i + 1}`}</span>
              </button>
            ))}
          </div>
        ) : (
          question.header && <p className="text-meta text-faint-foreground">{question.header}</p>
        )}
        <QuestionFields
          key={question.id}
          question={question}
          choice={choice}
          onChoose={choose}
          onPicked={() => {
            if (!last) setStep(step + 1);
          }}
        />
        {gone ? (
          <div className="flex items-center justify-end gap-2">
            <p className="mr-auto min-w-0 text-meta text-muted-foreground">
              This question is no longer waiting.
            </p>
            <button type="button" onClick={onDismiss} className={outlineButton}>
              Dismiss
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            {count > 1 && (
              <span className="mr-auto text-meta text-faint-foreground tabular-nums">
                {count - 1} more waiting
              </span>
            )}
            <button
              type="button"
              disabled={off}
              title={disabledReason}
              onClick={() => onAnswer("deny", SKIPPED)}
              className={quietButton}
            >
              Skip
            </button>
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)} className={quietButton}>
                Back
              </button>
            )}
            <button
              type="submit"
              disabled={off || !ready}
              title={disabledReason}
              className={approveButton}
            >
              {busy ? "Sending…" : last ? "Send" : "Next"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * The questions' tab on the composer's top bar: the question and where it stands in the rest, which
 * opens the panel above the bar as it arrives. Like the bar's other popovers, a click elsewhere or
 * Esc closes it, with what the user chose kept for when the tab opens it again.
 */
function QuestionTab(props: AskProps & { form: Form }) {
  const { form, focusRef } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    panel.current?.showPopover();
  }, []);
  const question = form.questions[form.step]!;
  return (
    <section aria-label="Question" className="plan-strip">
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        title={open ? "Hide the question" : "Show the question"}
        className="flex w-full min-w-0 items-center gap-2.5 py-0.5 pr-3.5 pl-4 text-left text-body hover:bg-hover"
      >
        <MessageCircleQuestion aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{question.text}</span>
        {form.questions.length > 1 && (
          <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
            {form.step + 1} of {form.questions.length}
          </span>
        )}
        <ChevronUp
          aria-hidden
          className={`size-3.5 shrink-0 text-faint-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        onBeforeToggle={(e: ToggleEvent<HTMLDivElement>) => setOpen(e.newState === "open")}
        className="question-popover inset-auto m-0 mb-2 w-[anchor-size(width)] rounded-xl border-0 bg-transparent p-0 text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        <QuestionPanel {...props} focusRef={focusRef} />
      </div>
    </section>
  );
}

/**
 * The requests with questions, oldest first, one at a time. `inline` draws the panel in place, for
 * a view with no composer bar. The next request's panel takes focus only from nothing or from the
 * panel just answered, and once the last goes, focus that was in it returns by `returnFocus`.
 */
export function QuestionQueue({
  asked,
  answers,
  onAnswer,
  onDismiss,
  disabledReason,
  returnFocus,
  inline = false,
}: {
  asked: readonly Asked[];
  answers: ReadonlyMap<string, AnswerState>;
  onAnswer: (asked: Asked, choice: AnswerChoice, message?: string, filled?: Filled) => void;
  onDismiss: (asked: Asked) => void;
  disabledReason?: string;
  returnFocus?: () => void;
  inline?: boolean;
}) {
  const head = asked[0];
  const key = head?.approval.request.approvalId;
  const panel = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const [returning] = useState(() => returnFocus);
  const [leave] = useState(() => () => {
    hadFocus.current = true;
    // The next panel, if there is one, takes it straight back below.
    returning?.();
  });
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (panel.current && (hadFocus.current || !active || active === document.body))
      panel.current.focus({ preventScroll: true });
    hadFocus.current = false;
  }, [key]);
  if (!head || !key) return null;
  return (
    <Pinned key={key} onLeave={leave}>
      <Ask
        asked={head}
        count={asked.length}
        state={answers.get(key)}
        onAnswer={(choice, message, filled) => onAnswer(head, choice, message, filled)}
        onDismiss={() => onDismiss(head)}
        disabledReason={disabledReason}
        focusRef={panel}
        inline={inline}
      />
    </Pinned>
  );
}

function Ask({ inline, ...props }: AskProps & { inline: boolean }) {
  const form = useForm(props.asked);
  return inline ? <QuestionPanel {...props} form={form} /> : <QuestionTab {...props} form={form} />;
}
