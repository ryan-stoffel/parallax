import { useCallback, useEffect, useState } from "react";

import type { AgentSendParams } from "../protocol/generated/protocol";
import { applyEvents, emptyTranscript, type Transcript } from "./transcript";
import { uuidv7 } from "./uuidv7";

export interface AgentRunView {
  transcript: Transcript;
  /** Why the transcript couldn't load, for people. */
  error?: string;
  /** Texts this window sent, by turn id, since the log holds only the id (RYA-92). */
  sent: ReadonlyMap<string, string>;
  /**
   * Sends a message as the run's next turn, with a new model, effort, or access for the run if given.
   * Resolves to an error message, or undefined.
   */
  send: (text: string, options?: SendOptions) => Promise<string | undefined>;
  /** Stops the run. Resolves to an error message, or undefined. */
  cancel: () => Promise<string | undefined>;
}

/** A new model, effort, or access for a run, sent only to a wispd that advertises `sendModel`. */
export type SendOptions = Pick<AgentSendParams, "model" | "effort" | "permission">;

/**
 * One run's transcript, kept live: pages through `agent/events`, then subscribes
 * to its scope's events from a fresh snapshot `seq`, and starts over on `resync`.
 * Loads only while `connected`; a reconnect loads again. Key the caller by host
 * and run, so another run starts from an empty transcript.
 */
export function useAgentRun(hostId: string, runId: string, connected: boolean): AgentRunView {
  const [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let unsubscribe = () => {};

    async function load() {
      let t = emptyTranscript;
      // The scope's seq from `agent/list`, taken before the last page is read. The run's
      // own last seq can be too old for wispd to replay the scope from, which would
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
          const list = await window.wisp.request(hostId, "agent/list", {
            project: t.run.project,
          });
          if (stopped) return;
          if ("error" in list) return setError(list.error.message);
          snapshot = list.result.seq;
        }
        const page = await window.wisp.request(hostId, "agent/events", { runId, after: t.seq });
        if (stopped) return;
        if ("error" in page) return setError(page.error.message);
        logId ??= page.logId;
        t = applyEvents(t, page.result.events, runId);
        more = page.result.more;
        if (!more && !t.run) return setError("This agent run hasn't started.");
      }
      // The loop only ends with both, but the types can't tell.
      if (!t.run || snapshot === undefined || logId === undefined) return;
      setTranscript(t);
      setError(undefined);
      unsubscribe = window.wisp.subscribe(
        hostId,
        { after: Math.max(t.seq, snapshot), project: t.run.project, logId },
        (message) => {
          if (stopped) return;
          if (message.type === "event")
            setTranscript((prev) => applyEvents(prev, [message.event], runId));
          else if (message.type === "resync") void load();
          else setError(message.error.message);
        },
      );
    }

    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, runId, connected]);

  const send = useCallback(
    async (text: string, options?: SendOptions) => {
      const turnId = uuidv7();
      setSent((prev) => new Map(prev).set(turnId, text));
      const answer = await window.wisp.request(hostId, "agent/send", {
        runId,
        turnId,
        text,
        ...options,
      });
      if (!("error" in answer)) return undefined;
      setSent((prev) => {
        const next = new Map(prev);
        next.delete(turnId);
        return next;
      });
      return answer.error.message;
    },
    [hostId, runId],
  );

  const cancel = useCallback(async () => {
    const answer = await window.wisp.request(hostId, "agent/cancel", { runId });
    return "error" in answer ? answer.error.message : undefined;
  }, [hostId, runId]);

  return { transcript, error, sent, send, cancel };
}
