import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type {
  AgentDelivery,
  AgentSendParams,
  LoggedEvent,
  PromptImage,
  QueuedMessage,
  ThreadRun,
} from "../protocol/generated/protocol";
import { applyEvents, emptyTranscript, isRunning, rebuild, type Transcript } from "./transcript";
import { useWatchKey } from "./useWatchKey";
import { uuidv7 } from "./uuidv7";

export interface AgentRunView {
  transcript: Transcript;
  /** Why the transcript couldn't load, for people. */
  error?: string;
  /** Messages this window sent, by turn id, since older logs hold only the id (PLX-92). */
  sent: ReadonlyMap<string, SentMessage>;
  queue: QueuedMessage[];
  /**
   * Sends a message, its images, and the threads attached to it as the run's next turn, with a new
   * model, effort, or access for the run if given. Resolves to plxd's error, or why the run
   * couldn't take it, or undefined.
   */
  send: (
    text: string,
    options?: SendOptions,
    images?: PromptImage[],
    threads?: string[],
    delivery?: AgentDelivery,
  ) => Promise<RpcError | undefined>;
  /** Stops the run. Resolves to an error message, or undefined. */
  cancel: () => Promise<string | undefined>;
  /** Whether older events are left to load, for a transcript that opened at its end (PLX-490). */
  older: boolean;
  /** Loads the page of events before the oldest loaded, one page at a time. */
  loadOlder: () => void;
}

/**
 * A transcript's events loaded so far, oldest first, and the `seq` to load older ones before,
 * absent once the first is in.
 */
interface Pages {
  events: LoggedEvent[];
  before?: number;
  loading?: boolean;
}

/**
 * A message this window sent: its text, images, and attached threads' run ids, at hand until the
 * run's log has them.
 */
export interface SentMessage {
  text: string;
  images: PromptImage[];
  threads?: string[];
}

/**
 * A new model, effort, or access for a run, sent only to a plxd that advertises `sendModel`, and
 * a new account, perhaps another provider's, only to one that advertises `sendAccount`.
 */
export type SendOptions = Pick<
  AgentSendParams,
  "model" | "effort" | "permission" | "contextWindow" | "fast" | "account"
>;

/** The queued runs of `runs`, as the queue lists them, first to be sent first. */
const queuedOf = (runs: ThreadRun[]): QueuedMessage[] =>
  runs
    .filter((r) => r.status === "queued")
    .map((r) => ({
      id: r.id,
      text: r.text ?? "",
      images: r.images ?? 0,
      threads: r.threads ?? [],
    }));

/**
 * One run's transcript, kept live through `orchestration/subscribeThread` (0059): a snapshot of
 * the run, its queue, and its newest events, then its events as they come. Older events load a
 * page at a time with `loadOlder`, and while the newest show nothing, on their own. It opens once
 * the host connects and stays open across disconnects: a reconnect resumes after the last event,
 * and a fresh snapshot rebuilds the transcript only when the gap is too long to replay
 * (`useWatchKey`). Key the caller by host and run, so another run starts from an empty transcript.
 */
export function useAgentRun(hostId: string, runId: string, connected: boolean): AgentRunView {
  const [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<ReadonlyMap<string, SentMessage>>(new Map());
  const pages = useRef<Pages>(undefined);
  const [older, setOlder] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [watchKey, failed] = useWatchKey(`${hostId}\n${runId}`, connected);

  // Loads the page before `p`'s oldest event into it, one at a time: `false` while another is
  // on its way, or once a fresh snapshot replaced `p` or the page failed.
  const loadPage = useCallback(
    async (p: Pages) => {
      if (p.before === undefined || p.loading) return false;
      p.loading = true;
      const page = await window.parallax.request(hostId, "orchestration/threadHistory", {
        threadId: runId,
        before: p.before,
      });
      p.loading = false;
      if (pages.current !== p) return false;
      if ("error" in page) {
        setError(page.error.message);
        return false;
      }
      const { events, more } = page.result;
      p.events = [...events, ...p.events];
      p.before = more ? events[0]?.seq : undefined;
      setOlder(p.before !== undefined);
      setTranscript((prev) => rebuild(prev, p.events, runId));
      return true;
    },
    [hostId, runId],
  );

  useEffect(() => {
    if (!watchKey) return;
    let stopped = false;

    // The queue as plxd has it. Messages sent from here keep plxd's text, edits included, so a
    // dropped one's Send again sends what the user last saw.
    function showQueue(messages: QueuedMessage[]) {
      setQueue(messages);
      setSent((prev) => {
        if (!messages.some((m) => prev.has(m.id) && prev.get(m.id)!.text !== m.text)) return prev;
        const next = new Map(prev);
        for (const m of messages) {
          const mine = next.get(m.id);
          if (mine) next.set(m.id, { ...mine, text: m.text });
        }
        return next;
      });
    }

    // Older pages, while the ones in show nothing, as when the newest holds only the run's last
    // updates.
    async function fill(p: Pages, t: Transcript) {
      while (!stopped && t.items.length === 0 && (await loadPage(p)))
        t = rebuild(t, p.events, runId);
    }

    const stop = window.parallax.watch(hostId, { threadId: runId }, (message) => {
      if (stopped) return;
      if (message.type === "error") {
        failed();
        return setError(message.error.message);
      }
      if (message.type === "snapshot") {
        const s = message.snapshot;
        const p: Pages = { events: s.events, before: s.more ? s.events[0]?.seq : undefined };
        pages.current = p;
        const t = rebuild({ ...emptyTranscript, run: s.thread, seq: s.seq }, s.events, runId);
        setTranscript(t);
        setOlder(p.before !== undefined);
        showQueue(queuedOf(s.runs));
        setError(undefined);
        void fill(p, t);
        return;
      }
      const event = message.event.event;
      if (event.kind === "queue.updated" && event.runId === runId) showQueue(event.messages);
      pages.current?.events.push(message.event);
      setTranscript((prev) => applyEvents(prev, [message.event], runId));
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [hostId, runId, watchKey, failed, loadPage]);

  const loadOlder = useCallback(() => {
    if (pages.current) void loadPage(pages.current);
  }, [loadPage]);

  const send = useCallback(
    async (
      text: string,
      options?: SendOptions,
      images: PromptImage[] = [],
      threads: string[] = [],
      delivery?: AgentDelivery,
    ) => {
      const turnId = uuidv7();
      setSent((prev) => new Map(prev).set(turnId, { text, images, threads }));
      const answer = await window.parallax.request(hostId, "agent/send", {
        runId,
        turnId,
        text,
        ...options,
        ...(delivery && { delivery }),
        ...(images.length > 0 && { images }),
        ...(threads.length > 0 && { threads }),
      });
      if ("result" in answer && isRunning(answer.result.run.status)) return undefined;
      setSent((prev) => {
        const next = new Map(prev);
        next.delete(turnId);
        return next;
      });
      // A finished run whose CLI didn't start again answers with the failed run, and no turn
      // follows for the message.
      return "error" in answer
        ? answer.error
        : { code: -32000, message: answer.result.run.error ?? "The agent couldn't start." };
    },
    [hostId, runId],
  );

  const cancel = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "agent/cancel", { runId });
    return "error" in answer ? answer.error.message : undefined;
  }, [hostId, runId]);

  return { transcript, error, sent, send, cancel, queue, older, loadOlder };
}
