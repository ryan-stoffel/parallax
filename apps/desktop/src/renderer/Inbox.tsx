import { useCallback, useEffect, useState } from "react";

import type { InboxItem, Question } from "../protocol/generated/protocol";
import { describeError } from "./errors";

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
