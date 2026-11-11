// An agent's questions for the user (PLX-245): a tab that leads the composer's top bar and opens
// the questions above it, or the same panel in place where a view has no bar. Question text is
// untrusted, so it renders only as text.
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MessageCircleQuestion,
  Pencil,
  Workflow,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type ToggleEvent,
} from "react";

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
  SKIPPED,
  type Choice,
  type Filled,
  type Question,
} from "./questions";
import { IconButton } from "./ui";

export { SKIPPED };

const unanswered: Choice = { picked: [], typed: "" };

/** A dialog or a popover the user has open. A notification is a manual popover, which isn't one. */
const overlayOpen = () =>
  !!document.querySelector('dialog[open], [popover]:not([popover="manual"]):popover-open');

/**
 * Whether `panel` may take focus: from nothing, or from its own composer with nothing in it. Another
 * pane's composer isn't free, since focus moving would change which thread the user is in.
 */
export function focusIsFree(panel: HTMLElement) {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (!(active instanceof HTMLElement) || !active.isContentEditable) return false;
  const composer = active.closest(".composer-shell");
  return (
    !!composer?.parentElement?.contains(panel) &&
    !composer.querySelector(".composer-attachments") &&
    !active.textContent?.trim()
  );
}

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

/** A row's mark, which stands for its radio or checkbox: its number or icon, or a check once on. */
function Mark({ on, multiple, children }: { on: boolean; multiple: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={`grid size-5 shrink-0 place-items-center text-meta tabular-nums transition-colors motion-reduce:transition-none ${multiple ? "rounded-md" : "rounded-full"} ${on ? "bg-accent text-accent-foreground" : "border border-border text-muted-foreground"}`}
    >
      {on ? <Check className="size-3" strokeWidth={3} /> : children}
    </span>
  );
}

/**
 * One question: its text, its options as numbered rows, and a box for a typed answer if it takes
 * one. Each row's radio or checkbox covers it, unseen, so the row takes its clicks and keys.
 */
function QuestionFields({
  question,
  choice,
  onChoose,
  onPicked,
}: {
  question: Question;
  choice: Choice;
  onChoose: (choice: Choice) => void;
  /** A pointer picked a single-choice option, which moves on. */
  onPicked: () => void;
}) {
  const name = useId();
  const { multiple, options, custom, secret } = question;
  return (
    <fieldset className="approval-in min-w-0">
      <legend className="text-body leading-relaxed font-medium break-words whitespace-pre-wrap">
        {question.text}
      </legend>
      {options.length > 0 && (
        <div className="-mx-2 mt-1.5 space-y-0.5">
          {options.map((option, i) => {
            const on = choice.picked.includes(option.value);
            return (
              <label
                key={option.value}
                className={`relative flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${on ? "bg-hover" : ""}`}
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={name}
                  checked={on}
                  onChange={(e) =>
                    onChoose(toggled(choice, question, option.value, e.target.checked))
                  }
                  onClick={(e) => {
                    // A key's click (`detail` 0) only turns it on.
                    if (!multiple && e.detail > 0) onPicked();
                  }}
                  className="absolute inset-0 m-0 size-full opacity-0"
                />
                <Mark on={on} multiple={multiple}>
                  {i < 9 ? i + 1 : ""}
                </Mark>
                <span className="min-w-0 flex-1 text-body leading-5">
                  <span className="break-words">{option.label}</span>
                  {option.recommended && (
                    <span className="ml-2 rounded bg-accent/10 px-1.5 py-px text-meta text-accent">
                      Recommended
                    </span>
                  )}
                  {option.description && (
                    <span className="mt-0.5 block text-meta break-words text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {custom && (
        <label className="-mx-2 mt-1.5 flex h-9 items-center gap-2.5 rounded-lg border border-border px-2 focus-within:border-ring">
          <Mark on={choice.typed.trim() !== ""} multiple={multiple}>
            <Pencil className="size-3" />
          </Mark>
          <input
            type={secret ? "password" : "text"}
            autoComplete="off"
            aria-label={options.length > 0 ? "Your own answer" : question.text}
            placeholder={options.length > 0 ? "Something else" : "Your answer"}
            value={choice.typed}
            onChange={(e) => onChoose(typedIn(choice, question, e.target.value))}
            className="h-full min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus:outline-none disabled:opacity-50"
          />
        </label>
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
 * The questions as a form, one at a time. The arrows step through them. Picking a single choice or
 * pressing Next goes to the next one not yet answered, and once none is left, Send sends them all.
 * Skip answers none. The controls sit at the panel's foot, which stays put as questions of other
 * heights take its place, so the arrows don't move out from under a pointer.
 *
 * With focus in the panel, ↑ and ↓ move between the rows, ← and → between the questions, a number
 * picks its option, and Enter picks the option in focus or moves on.
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
  const busy = state?.state === "answering";
  const gone = state?.state === "gone";
  const off = busy || gone || disabledReason !== undefined;
  // The next question without an answer, going round from this one.
  const open = questions
    .map((_, i) => (step + 1 + i) % questions.length)
    .find((i) => i !== step && !isAnswered(choices[i] ?? unanswered));
  const ready = isAnswered(choice);
  const send = () => onAnswer("allow", undefined, fill(asked.approval.request, questions, choices));
  const goOn = () => {
    if (open !== undefined) setStep(open);
  };
  const pick = (i: number) => {
    const option = question.options[i];
    if (!option) return;
    const on = question.multiple ? !choice.picked.includes(option.value) : true;
    choose(toggled(choice, question, option.value, on));
    if (!question.multiple) goOn();
  };
  const formRef = useRef<HTMLFormElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.matches('input[type="text"], input[type="password"]');
    // A held key answers nothing: its first press did, and the rest would answer what comes next.
    if (e.repeat && (e.key === "Enter" || (!typing && /^[1-9]$/.test(e.key)))) {
      e.preventDefault();
      return;
    }
    if (off || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLInputElement>("fieldset input")];
    const at = rows.indexOf(target as HTMLInputElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      rows[at < 0 ? 0 : Math.min(Math.max(at + by, 0), rows.length - 1)]?.focus();
    } else if (e.key === "Enter" && at >= 0 && !typing) {
      // An option already on lets the Enter through to the form, which moves on or sends.
      if ((target as HTMLInputElement).checked) return;
      e.preventDefault();
      pick(at);
    } else if (e.key === "Enter" && target === e.currentTarget) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    } else if (typing) {
      return;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const to = step + (e.key === "ArrowRight" ? 1 : -1);
      if (to >= 0 && to < questions.length) setStep(to);
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      pick(Number(e.key) - 1);
    }
  };
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
      onKeyDown={onKey}
      className="composer-card flex max-h-[min(60vh,32rem)] min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-surface px-4 py-3 focus-visible:outline-none"
    >
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (off || !ready) return;
          if (open === undefined) send();
          else goOn();
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
        {(question.header || question.multiple || count > 1) && (
          <p className="flex items-center gap-1.5 text-meta text-faint-foreground">
            {question.header && <span className="truncate">{question.header}</span>}
            {question.header && question.multiple && <span aria-hidden>·</span>}
            {question.multiple && <span className="shrink-0">Choose any</span>}
            {count > 1 && (
              <span className="ml-auto shrink-0 tabular-nums">{count - 1} more waiting</span>
            )}
          </p>
        )}
        <QuestionFields
          key={question.id}
          question={question}
          choice={choice}
          onChoose={choose}
          onPicked={goOn}
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
            {questions.length > 1 && (
              <div role="group" aria-label="Questions" className="mr-auto flex items-center gap-1">
                <IconButton
                  label="Previous question"
                  size="sm"
                  disabled={step === 0}
                  onClick={() => setStep(step - 1)}
                >
                  <ChevronLeft aria-hidden className="size-4" />
                </IconButton>
                <span className="text-meta text-muted-foreground tabular-nums">
                  {step + 1} of {questions.length}
                </span>
                <IconButton
                  label="Next question"
                  size="sm"
                  disabled={step === questions.length - 1}
                  onClick={() => setStep(step + 1)}
                >
                  <ChevronRight aria-hidden className="size-4" />
                </IconButton>
              </div>
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
            <button
              type="submit"
              disabled={off || !ready}
              title={disabledReason}
              className={`${approveButton} inline-flex items-center gap-1`}
            >
              {busy ? "Sending…" : open === undefined ? "Send" : "Next"}
              {!busy &&
                (open === undefined ? (
                  <ArrowUp aria-hidden className="size-3.5" />
                ) : (
                  <ArrowRight aria-hidden className="size-3.5" />
                ))}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * The questions' tab on the composer's top bar, which opens the panel above the bar as a question
 * arrives, unless the user has a dialog or another popover open, which it would close or sit inert
 * above. Closed, it names the question and where it stands in the rest. Open, the panel says those,
 * so the tab only says what the thread waits on. Like the bar's other popovers, a click elsewhere
 * or Esc closes it, with what the user chose kept for when the tab opens it again.
 */
function QuestionTab(props: AskProps & { form: Form }) {
  const { form, focusRef } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!overlayOpen()) panel.current?.showPopover();
  }, []);
  // Esc closes the panel before the page sees it: focus may still be in the composer, where Esc
  // stops the run. Under an expanded side panel, the panel is open but unseen, and Esc is the
  // side panel's.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || !panel.current?.checkVisibility()) return;
      e.preventDefault();
      e.stopPropagation();
      panel.current?.hidePopover();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
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
        <span className={`min-w-0 flex-1 truncate ${open ? "text-muted-foreground" : ""}`}>
          {open ? "Waiting for your answer" : question.text}
        </span>
        {!open && form.questions.length > 1 && (
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
 * a view with no composer bar. The next request's panel takes focus only from nothing, an empty
 * composer, or the panel just answered, so a question never takes keys from someone typing. Once
 * the last goes, focus that was in it returns by `returnFocus`.
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
    if (panel.current && (hadFocus.current || focusIsFree(panel.current)))
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
