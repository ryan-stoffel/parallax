import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";

import type { InboxItem, InboxKind, Question } from "../protocol/generated/protocol";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";
import { PixelStack } from "./Pixels";
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
export const kindLooks: Record<InboxKind, { Icon: LucideIcon; color: string }> = {
  needsYou: { Icon: CircleQuestionMark, color: "text-warning" },
  done: { Icon: CircleCheck, color: "text-emerald-500" },
  failed: { Icon: CircleAlert, color: "text-danger" },
  decided: { Icon: CircleDot, color: "text-muted-foreground" },
  learned: { Icon: BookOpen, color: "text-muted-foreground" },
};

/** A row's sender: the child (or coordinator) it came from, and its provider's logo. */
export interface Sender {
  name: string;
  Logo?: ComponentType<SVGProps<SVGSVGElement>>;
}

const kindNames: Record<InboxKind, string> = {
  needsYou: "Needs you",
  done: "Done",
  failed: "Failed",
  decided: "Decided",
  learned: "Learned",
};

// What interrupts: the rest is news, read when the user likes.
const urgent = (item: InboxItem) => item.kind === "needsYou" || item.kind === "failed";

/**
 * A Project's inbox (0043) as a mail list, newest first: each row its sender, what it's about, and
 * when, bold until read. Needs you, the default while anything waits, holds the unread questions
 * and failures; All holds everything. A row opens in place: a question takes an answer, or keeps
 * what the child assumed, a decided one can be changed, and Open chat goes to its child. Opening
 * marks news read; a question stays unread until it's answered. J and K move, Enter opens, and E
 * marks read, as in a mail app. `senders` names each run.
 */
export function InboxPanel({
  view,
  answerable,
  senders,
  onOpen,
}: {
  view: InboxView;
  answerable: boolean;
  senders: (runId: string) => Sender;
  /** Opens a run's chat: a child's, or the coordinator's for its paused wake-ups. */
  onOpen: (runId: string) => void;
}) {
  const unread = view.items.filter((i) => !i.seenAt);
  // Read here since the panel opened, which stay where they were rather than vanish once opened.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const waiting = view.items.filter((i) => urgent(i) && (!i.seenAt || kept.has(i.id)));
  const [picked, setPicked] = useState<"needs" | "all">();
  const filter = picked ?? (waiting.length > 0 ? "needs" : "all");
  const shown = (filter === "needs" ? waiting : view.items).toReversed();
  const [openId, setOpenId] = useState<string>();
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  const toggle = (item: InboxItem) => {
    const opening = openId !== item.id;
    setOpenId(opening ? item.id : undefined);
    if (opening) setKept((k) => new Set(k).add(item.id));
    if (opening && !item.seenAt && item.kind !== "needsYou") void view.seen([item.id]);
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target !== e.currentTarget) return;
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      rows.current[Math.max(0, Math.min(shown.length - 1, i + step))]?.focus();
    } else if (e.key === "e" && !shown[i]!.seenAt) {
      e.preventDefault();
      void view.seen([shown[i]!.id]);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-2">
        {(
          [
            ["needs", "Needs you", waiting.filter((i) => !i.seenAt).length],
            ["all", "All", unread.length],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setPicked(value)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground"
          >
            {label}
            {count > 0 && (
              <span
                className={`font-mono text-[11px] tabular-nums ${value === "needs" ? "text-warning" : "text-faint-foreground"}`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
        {unread.length > 0 && (
          <button
            type="button"
            onClick={() =>
              void view.seen(unread.filter((i) => i.kind !== "needsYou").map((i) => i.id))
            }
            className="ml-auto rounded-md px-2 py-1 font-mono text-[11px] text-faint-foreground hover:bg-hover hover:text-foreground"
          >
            Mark read
          </button>
        )}
      </div>
      {shown.length > 0 ? (
        <ul aria-label="Inbox" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((item, i) => (
            <MailRow
              key={item.id}
              item={item}
              sender={senders(item.run)}
              open={item.id === openId}
              question={answerable ? questionOf(item, view.questions) : undefined}
              rowRef={(el) => {
                rows.current[i] = el;
              }}
              onToggle={() => toggle(item)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onOpenChat={() => {
                onOpen(item.run);
                if (!item.seenAt && item.kind !== "needsYou") void view.seen([item.id]);
              }}
              onAnswer={(q, text) => view.answer(item, q, text)}
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-16 text-center">
          <PixelStack count={9} />
          <p className="text-[13px] font-medium">
            {filter === "needs" ? "Nothing needs you" : "No mail yet"}
          </p>
          <p className="max-w-60 text-[12.5px] text-muted-foreground">
            {filter === "needs"
              ? "Questions and failures land here. Everything else is under All."
              : "Agents report here as they finish, decide, and learn."}
          </p>
        </div>
      )}
    </div>
  );
}

function MailRow({
  item,
  sender,
  open,
  question,
  rowRef,
  onToggle,
  onKeyDown,
  onOpenChat,
  onAnswer,
}: {
  item: InboxItem;
  sender: Sender;
  open: boolean;
  question?: Question;
  rowRef: (el: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onOpenChat: () => void;
  onAnswer: (question: Question, text: string) => Promise<string | undefined>;
}) {
  const [changing, setChanging] = useState(false);
  const unread = !item.seenAt;
  // plxd's text reads "<title>: <what happened>", and the title is already the sender.
  const subject = item.text.startsWith(`${sender.name}: `)
    ? item.text.slice(sender.name.length + 2)
    : item.text;
  const waiting = question?.status === "open" || question?.status === "escalated";
  const { color } = kindLooks[item.kind];
  return (
    <li className={`rounded-xl ${open ? "bg-selected" : ""}`}>
      <button
        ref={rowRef}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        className={`group flex w-full min-w-0 gap-3 rounded-xl py-2.5 pr-2.5 pl-2 text-left focus-visible:outline-2 focus-visible:outline-ring ${open ? "" : "hover:bg-hover"}`}
      >
        <span className="flex w-1.5 shrink-0 justify-center pt-2">
          {unread && <span className="size-1.5 rounded-full bg-accent" />}
          {unread && <span className="sr-only">Unread: </span>}
        </span>
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-background [&_svg]:size-3.5">
          {sender.Logo && <sender.Logo aria-hidden />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${unread ? "font-semibold text-foreground" : "text-muted-foreground"}`}
            >
              {sender.name}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-faint-foreground tabular-nums">
              {age(item.createdAt)}
            </span>
          </span>
          <span
            className={`text-[12.5px] leading-snug ${open ? "" : "line-clamp-2"} ${unread ? "text-foreground/80" : "text-faint-foreground"}`}
          >
            <span className={`mr-1.5 font-mono text-[10.5px] tracking-wide uppercase ${color}`}>
              {kindNames[item.kind]}
            </span>
            {question && waiting ? question.question : subject}
          </span>
        </span>
      </button>
      {open && (
        <div className="pr-3 pb-3 pl-[3.75rem]">
          {question && waiting && (
            <>
              {question.assumption && (
                <p className="text-[12.5px] text-muted-foreground">
                  Going with <span className="text-foreground">{question.assumption}</span> until
                  you say otherwise.
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
          {item.kind === "decided" && question && changing && (
            <AnswerForm
              label="Change"
              question={question.question}
              onAnswer={(text) => onAnswer(question, text)}
              onCancel={() => setChanging(false)}
            />
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <button type="button" onClick={onOpenChat} className={outlineButton}>
              Open chat
            </button>
            {item.kind === "decided" && question && !changing && (
              <button type="button" onClick={() => setChanging(true)} className={quietButton}>
                Change it
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * An answer box and its button, named for its question so each box is told apart. It keeps the
 * text, and shows why, when the answer fails.
 */
export function AnswerForm({
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
