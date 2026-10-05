import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type {
  AgentDelivery,
  AgentSendParams,
  LoggedEvent,
  PromptImage,
  QueuedMessage,
} from "../protocol/generated/protocol";
import { applyEvents, emptyTranscript, isRunning, rebuild, type Transcript } from "./transcript";
import { uuidv7 } from "./uuidv7";

export interface AgentRunView {
  transcript: Transcript;
  /** Why the transcript couldn't load, for people. */
  error?: string;
  /** Messages this window sent, by turn id, since older logs hold only the id (PLX-92). */
  sent: ReadonlyMap<string, SentMessage>;
  queue: QueuedMessage[];
  queueError?: string;
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
 * A transcript that opened at its end: every event of its run loaded so far, oldest first, the
 * `seq` to load older ones before, absent once the first is in, and the log they came from.
 */
interface Pages {
  events: LoggedEvent[];
  before?: number;
  logId: string;
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

/**
 * One run's transcript, kept live: pages through `agent/events`, then subscribes
 * to its own events in its scope from a fresh snapshot `seq` (an older plxd, without
 * `eventFilters`, sends the whole scope's), and starts over on `resync`. Loads only
 * while `connected`; a reconnect loads again, from a new snapshot, so a quiet run's
 * old `seq` is never resubscribed from. Key the caller by host and run, so another
 * run starts from an empty transcript. With `paged`, for a plxd that advertises
 * `eventsBefore`, it reads only the newest page, and `loadOlder` reads the rest.
 */
export function useAgentRun(
  hostId: string,
  runId: string,
  connected: boolean,
  queueEnabled = false,
  paged = false,
): AgentRunView {
  const [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<ReadonlyMap<string, SentMessage>>(new Map());
  const pages = useRef<Pages>(undefined);
  const [older, setOlder] = useState(false);

  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [queueError, setQueueError] = useState<string>();

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let unsubscribe = () => {};

    // The queue as plxd has it. Messages sent from here keep plxd's text, edits included, so a
    // dropped one's Send again sends what the user last saw.
    function showQueue(messages: QueuedMessage[]) {
      setQueue(messages);
      setQueueError(undefined);
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

    async function load() {
      pages.current = undefined;
      setOlder(false);
      return paged ? loadNewest() : loadAll();
    }

    // The newest page, the run read after it, and the log's seq read before it, so a subscribe
    // after that seq misses nothing. Older pages follow while there's nothing to show, as when
    // the newest holds only the run's last updates.
    async function loadNewest() {
      let p: Pages | undefined;
      let t = emptyTranscript;
      let snapshot = 0;
      do {
        const page = await window.parallax.request(hostId, "agent/events", {
          runId,
          after: 0,
          before: p?.before ?? Number.MAX_SAFE_INTEGER,
        });
        if (stopped) return;
        if ("error" in page) return setError(page.error.message);
        const { events, more, run, seq = 0 } = page.result;
        if (!run) return setError("This agent run hasn't started.");
        if (!p) [t, snapshot] = [{ ...emptyTranscript, run }, seq];
        p = {
          events: [...events, ...(p?.events ?? [])],
          before: more ? events[0]?.seq : undefined,
          logId: p?.logId ?? page.logId,
        };
        t = rebuild(t, p.events, runId);
      } while (t.items.length === 0 && p.before !== undefined);
      pages.current = p;
      await live(t, snapshot, p.logId, p);
    }

    async function loadAll() {
      let t = emptyTranscript;
      // The scope's seq from `agent/list`, taken before the last page is read. The run's
      // own last seq can be too old for plxd to replay the scope from, which would
      // answer every subscribe with another resync. Subscribing after the snapshot is
      // gap-free, since at least one page was read after it.
      let snapshot: number | undefined;
      // The log the first page was read under. If it changes before the subscribe, main
      // answers it with a resync, so a mix of two logs' seqs is never used.
      let logId: string | undefined;
      for (let more = true; more || snapshot === undefined;) {
        // agent.started, the first event, carries the run's scope: its project, or its
        // thread's repo entry (0017).
        if (snapshot === undefined && t.run) {
          const list = await window.parallax.request(hostId, "agent/list", {
            project: t.run.project,
          });
          if (stopped) return;
          if ("error" in list) return setError(list.error.message);
          snapshot = list.result.seq;
        }
        const page = await window.parallax.request(hostId, "agent/events", { runId, after: t.seq });
        if (stopped) return;
        if ("error" in page) return setError(page.error.message);
        logId ??= page.logId;
        t = applyEvents(t, page.result.events, runId);
        more = page.result.more;
        if (!more && !t.run) return setError("This agent run hasn't started.");
      }
      // The loop only ends with both, but the types can't tell.
      if (!t.run || snapshot === undefined || logId === undefined) return;
      await live(t, snapshot, logId);
    }

    // Shows `t` and subscribes after `snapshot`, adding the run's events to `p` when paged.
    async function live(t: Transcript, snapshot: number, logId: string, p?: Pages) {
      if (!t.run) return;
      if (queueEnabled) {
        const listed = await window.parallax.request(hostId, "queue/list", { runId });
        if (stopped) return;
        if ("error" in listed) setQueueError(listed.error.message);
        else showQueue(listed.result.messages);
      }
      setTranscript(t);
      setOlder(p?.before !== undefined);
      setError(undefined);
      unsubscribe = window.parallax.subscribe(
        hostId,
        { after: Math.max(t.seq, snapshot), project: t.run.project, run: runId, logId },
        (message) => {
          if (stopped) return;
          if (message.type === "event") {
            const event = message.event.event;
            if (queueEnabled && event.kind === "queue.updated" && event.runId === runId)
              showQueue(event.messages);
            if (p && "runId" in event && event.runId === runId) p.events.push(message.event);
            setTranscript((prev) => applyEvents(prev, [message.event], runId));
          } else if (message.type === "resync") void load();
          else setError(message.error.message);
        },
      );
    }

    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, runId, connected, queueEnabled, paged]);

  const loadOlder = useCallback(() => {
    const p = pages.current;
    if (!p || p.before === undefined || p.loading) return;
    p.loading = true;
    void window.parallax
      .request(hostId, "agent/events", { runId, after: 0, before: p.before })
      .then((page) => {
        p.loading = false;
        // A resync or reconnect started over meanwhile.
        if (pages.current !== p) return;
        if ("error" in page) return setError(page.error.message);
        if (page.logId !== p.logId) return;
        const { events, more } = page.result;
        p.events = [...events, ...p.events];
        p.before = more ? events[0]?.seq : undefined;
        setOlder(p.before !== undefined);
        setTranscript((prev) => rebuild(prev, p.events, runId));
      });
  }, [hostId, runId]);

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

  return { transcript, error, sent, send, cancel, queue, queueError, older, loadOlder };
}
