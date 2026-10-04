import { useCallback, useEffect, useState } from "react";

import type { InboxItem, InboxKind, Question } from "../protocol/generated/protocol";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";

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

/**
 * A Project's unread inbox items, at the top of its coordinator chat, grouped as 0043 orders them.
 * Opening an item opens its child's chat and marks it seen. With `answerable`, an open question
 * in Needs you takes an answer in place, and a decided one can be changed: "went with X, change
 * it?". Shows nothing once every item is seen.
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
  const unread = view.items.filter((i) => !i.seenAt);
  if (unread.length === 0) return null;
  return (
    <section aria-label="Inbox" className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-4">
      <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-border bg-surface px-2 py-1.5">
        {inboxGroups.map(({ kind, label }) => {
          const group = unread.filter((i) => i.kind === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind} aria-label={label} className="py-1">
              <h3 className="px-2 pb-0.5 text-[11.5px] font-medium text-faint-foreground">
                {label} · {group.length}
              </h3>
              <ul>
                {group.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    question={answerable ? questionOf(item, view.questions) : undefined}
                    onOpen={() => {
                      onOpen(item.run);
                      void view.seen([item.id]);
                    }}
                    onAnswer={(question, text) => view.answer(item, question, text)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
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
  const waiting = question?.status === "open" || question?.status === "escalated";
  const asking = item.kind === "needsYou" ? waiting : changing;
  return (
    <li className="px-2 py-1">
      <button
        type="button"
        onClick={onOpen}
        title={item.text}
        className="line-clamp-2 w-full text-left text-[13px] text-foreground/85 hover:text-foreground"
      >
        {item.text}
      </button>
      {item.kind === "decided" && question && !changing && (
        <button
          type="button"
          onClick={() => setChanging(true)}
          className="mt-0.5 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Change it?
        </button>
      )}
      {question && asking && (
        <AnswerForm
          label={changing ? "Change" : "Answer"}
          onAnswer={(text) => onAnswer(question, text)}
          onCancel={changing ? () => setChanging(false) : undefined}
        />
      )}
    </li>
  );
}

/** An answer box and its button. It keeps the text, and shows why, when the answer fails. */
function AnswerForm({
  label,
  onAnswer,
  onCancel,
}: {
  label: string;
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
      className="mt-1"
    >
      <div className="flex items-center gap-2">
        <input
          aria-label={`${label} the question`}
          placeholder="Your answer"
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
        <button type="submit" disabled={busy || !text.trim()} className={outlineButton}>
          {label}
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </form>
  );
}
