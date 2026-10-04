import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleDot,
  ChevronRight,
  CircleQuestionMark,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { InboxItem, InboxKind, Question } from "../protocol/generated/protocol";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";
import { age } from "./Sidebar";

/** The inbox's groups, in 0043's order. A kind a newer plxd adds isn't shown. */
export const inboxGroups: { kind: InboxKind; label: string }[] = [
  { kind: "needsYou", label: "Needs you" },
  { kind: "done", label: "Done" },
  { kind: "failed", label: "Failed or stuck" },
  { kind: "decided", label: "Decided for you" },
  { kind: "learned", label: "Learned" },
];

/**
 * The question a Needs you or Decided item is about. Items carry no question id, so it's the
 * question of the item's run that its text quotes, as plxd quotes it (JSON). The latest, if the
 * run asked the same one twice.
 */
export function questionOf(item: InboxItem, questions: readonly Question[]): Question | undefined {
  if (item.kind !== "needsYou" && item.kind !== "decided") return undefined;
  return questions.findLast(
    (q) => q.run === item.run && item.text.includes(JSON.stringify(q.question)),
  );
}

export interface InboxView {
  /** Every item, oldest first, read and unread. */
  items: InboxItem[];
  /** The Project's questions, which Needs you and Decided items are about. */
  questions: Question[];
  /** Marks items seen with `inbox/seen`. */
  seen: (ids: string[]) => Promise<void>;
  /** The user's answer to `question`, which then marks `item` seen. Resolves to an error message. */
  answer: (item: InboxItem, question: Question, text: string) => Promise<string | undefined>;
}

/**
 * A Project's inbox (0043), kept live: `inbox/list`, then the Project's events after its `seq`
 * for `inbox.added`, starting over on `resync`. With `answerable` (the `questions` capability),
 * also `question/list`, read again when a Needs you or Decided item arrives. Loads only while
 * `enabled`: connected to a plxd with `inbox`. Key its caller by host and Project.
 */
export function useInbox(
  hostId: string,
  project: string,
  enabled: boolean,
  answerable: boolean,
): InboxView {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let unsubscribe = () => {};
    const loadQuestions = async () => {
      if (!answerable) return;
      const answer = await window.parallax.request(hostId, "question/list", { project });
      if (!stopped && "result" in answer) setQuestions(answer.result.questions);
    };
    async function load() {
      unsubscribe();
      const list = await window.parallax.request(hostId, "inbox/list", { project });
      // ponytail: a failed list shows no inbox; the chat under it still works.
      if (stopped || "error" in list) return;
      setItems(list.result.items);
      void loadQuestions();
      const since = { after: list.result.seq, project, logId: list.logId };
      unsubscribe = window.parallax.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type !== "event") return;
        const { event } = message.event;
        if (event.kind !== "inbox.added") return;
        const { item } = event;
        setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]));
        if (item.kind === "needsYou" || item.kind === "decided") void loadQuestions();
      });
    }
    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, project, enabled, answerable]);

  const seen = useCallback(
    async (ids: string[]) => {
      const answer = await window.parallax.request(hostId, "inbox/seen", { project, items: ids });
      if ("error" in answer) return;
      const marked = new Map(answer.result.items.map((i) => [i.id, i]));
      setItems((prev) => prev.map((i) => marked.get(i.id) ?? i));
    },
    [hostId, project],
  );

  const answer = useCallback(
    async (item: InboxItem, question: Question, text: string) => {
      const answer = await window.parallax.request(hostId, "question/answer", {
        question: question.id,
        text,
      });
      if ("error" in answer) return describeError(answer.error);
      const next = answer.result.question;
      setQuestions((prev) => prev.map((q) => (q.id === next.id ? next : q)));
      await seen([item.id]);
      return undefined;
    },
    [hostId, seen],
  );

  return { items, questions, seen, answer };
}

/** Each kind's look in the inbox: the icon beside its rows, from the agents list's statuses. */
const kindLooks: Record<InboxKind, { Icon: LucideIcon; color: string }> = {
  needsYou: { Icon: CircleQuestionMark, color: "text-warning" },
  done: { Icon: CircleCheck, color: "text-emerald-500" },
  failed: { Icon: CircleAlert, color: "text-danger" },
  decided: { Icon: CircleDot, color: "text-muted-foreground" },
  learned: { Icon: BookOpen, color: "text-muted-foreground" },
};

/**
 * A Project's unread inbox items, at the top of its coordinator chat, grouped as 0043 orders them.
 * Needs you items are cards, always shown; the rest fold into one line of counts that opens to a
 * line each. Opening an item opens its child's chat and marks it seen, and Mark all read clears it. With `answerable`, an open question takes an
 * answer in place, or keeps what the child assumed, and a decided one can be changed: "went with X,
 * change it?". Shows nothing once every item is seen.
 */
export function Inbox({
  view,
  answerable,
  onOpen,
}: {
  view: InboxView;
  answerable: boolean;
  /** Opens a run's chat: a child's, or the coordinator's for its paused wake-ups. */
  onOpen: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const unread = view.items.filter((i) => !i.seenAt);
  if (unread.length === 0) return null;
  const groups = inboxGroups
    .map((g) => ({ ...g, items: unread.filter((i) => i.kind === g.kind) }))
    .filter((g) => g.items.length > 0);
  const needs = groups.find((g) => g.kind === "needsYou");
  const updates = groups.filter((g) => g.kind !== "needsYou");
  const count = updates.reduce((n, g) => n + g.items.length, 0);
  const rowsOf = (items: InboxItem[]) =>
    items.map((item) => {
      const open = () => {
        onOpen(item.run);
        void view.seen([item.id]);
      };
      const question = answerable ? questionOf(item, view.questions) : undefined;
      const onAnswer = (q: Question, text: string) => view.answer(item, q, text);
      const Row = item.kind === "needsYou" ? NeedsYouCard : InboxRow;
      return (
        <Row key={item.id} item={item} question={question} onOpen={open} onAnswer={onAnswer} />
      );
    });
  return (
    <section aria-label="Inbox" className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-4">
      <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-border bg-surface">
        {needs && (
          <section aria-label={needs.label} className="px-2 pt-2 pb-1">
            <h3 className="px-1.5 pb-1.5 text-[11.5px] font-medium text-faint-foreground">
              {needs.label} <span className="tabular-nums">{needs.items.length}</span>
            </h3>
            <ul className="flex flex-col gap-1.5">{rowsOf(needs.items)}</ul>
          </section>
        )}
        {/* Everything else is news, folded into one line until it's opened. */}
        <div
          className={`flex items-center gap-2 py-1 pr-1.5 pl-2 ${needs ? "border-t border-border/60" : ""}`}
        >
          <button
            type="button"
            aria-expanded={expanded}
            disabled={count === 0}
            onClick={() => setExpanded(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1.5 py-1 text-left text-[12.5px] text-muted-foreground enabled:hover:text-foreground"
          >
            <span className="flex items-center gap-1.5">
              {count > 0 && (
                <ChevronRight
                  aria-hidden
                  className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              )}
              {count === 0 ? "Nothing else new" : `${count} ${count === 1 ? "update" : "updates"}`}
            </span>
            {updates.map((g) => {
              const { Icon, color } = kindLooks[g.kind];
              return (
                <span
                  key={g.kind}
                  title={g.label}
                  className="flex items-center gap-1 tabular-nums [&_svg]:size-3.5"
                >
                  <span className={color}>
                    <Icon aria-hidden />
                  </span>
                  {g.items.length}
                </span>
              );
            })}
          </button>
          <button
            type="button"
            onClick={() => void view.seen(unread.map((i) => i.id))}
            className={quietButton}
          >
            Mark all read
          </button>
        </div>
        <div hidden={!expanded}>
          {updates.map((g) => (
            <section key={g.kind} aria-label={g.label} className="border-t border-border/60 py-1.5">
              <h3 className="px-3.5 pt-0.5 pb-1 text-[11.5px] font-medium text-faint-foreground">
                {g.label} <span className="tabular-nums">{g.items.length}</span>
              </h3>
              <ul>{rowsOf(g.items)}</ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * A Needs you item: what the child asks, what it went on assuming, and a way to answer. plxd's text
 * reads "<title>: asks ...", so with the question shown on its own the link keeps only the title.
 */
function NeedsYouCard({
  item,
  question,
  onOpen,
  onAnswer,
}: {
  item: InboxItem;
  question?: Question;
  onOpen: () => void;
  onAnswer: (question: Question, text: string) => Promise<string | undefined>;
}) {
  const waiting = question?.status === "open" || question?.status === "escalated";
  const asks = item.text.indexOf(": asks ");
  const title = question && waiting && asks > 0 ? item.text.slice(0, asks) : item.text;
  const { Icon, color } = kindLooks.needsYou;
  return (
    <li className="rounded-lg border border-border bg-background px-3 py-2.5">
      <button
        type="button"
        onClick={onOpen}
        title={item.text}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <span className={`shrink-0 [&_svg]:size-3.5 ${color}`}>
          <Icon aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-faint-foreground tabular-nums">{age(item.createdAt)}</span>
      </button>
      {question && waiting && (
        <>
          <p className="mt-1.5 text-[13.5px] text-foreground">{question.question}</p>
          {question.assumption && (
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Going with <span className="text-foreground/85">{question.assumption}</span> until you
              say otherwise.
            </p>
          )}
          <AnswerForm
            label="Answer"
            question={question.question}
            keep={question.assumption || undefined}
            onAnswer={(text) => onAnswer(question, text)}
          />
        </>
      )}
    </li>
  );
}

function InboxRow({
  item,
  question,
  onOpen,
  onAnswer,
}: {
  item: InboxItem;
  /** The question it's about, where the user can answer it. */
  question?: Question;
  onOpen: () => void;
  onAnswer: (question: Question, text: string) => Promise<string | undefined>;
}) {
  const [changing, setChanging] = useState(false);
  const { Icon, color } = kindLooks[item.kind];
  return (
    <li className="px-1.5">
      <div className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover">
        <span className={`shrink-0 [&_svg]:size-3.5 ${color}`}>
          <Icon aria-hidden />
        </span>
        <button
          type="button"
          onClick={onOpen}
          title={item.text}
          className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground/85 group-hover:text-foreground"
        >
          {item.text}
        </button>
        {item.kind === "decided" && question && !changing && (
          <button
            type="button"
            onClick={() => setChanging(true)}
            className="shrink-0 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Change it?
          </button>
        )}
        <span className="shrink-0 text-[12px] text-faint-foreground tabular-nums">
          {age(item.createdAt)}
        </span>
      </div>
      {question && changing && (
        <div className="pr-2 pb-1 pl-7.5">
          <AnswerForm
            label="Change"
            question={question.question}
            onAnswer={(text) => onAnswer(question, text)}
            onCancel={() => setChanging(false)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * An answer box and its button, named for its question so each box is told apart. It keeps the
 * text, and shows why, when the answer fails.
 */
function AnswerForm({
  label,
  question,
  keep,
  onAnswer,
  onCancel,
}: {
  label: string;
  question: string;
  /** What the child assumed, sent as the answer with one click. */
  keep?: string;
  onAnswer: (text: string) => Promise<string | undefined>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        const failed = await onAnswer(text.trim());
        setBusy(false);
        setError(failed);
      }}
      className="mt-2"
    >
      <div className="flex items-center gap-2">
        <input
          aria-label={`${label}: ${question}`}
          placeholder={keep ? "Or answer differently" : "Your answer"}
          value={text}
          disabled={busy}
          autoFocus={!!onCancel}
          onChange={(e) => setText(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12.5px] placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50"
        />
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel} className={quietButton}>
            Cancel
          </button>
        )}
        {keep && !text.trim() ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const failed = await onAnswer(keep);
              setBusy(false);
              setError(failed);
            }}
            className={outlineButton}
          >
            Keep it
          </button>
        ) : (
          <button type="submit" disabled={busy || !text.trim()} className={outlineButton}>
            {label}
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </form>
  );
}
