import { useCallback, useEffect, useState } from "react";

import { applyEvents, emptyTranscript, type Transcript } from "./transcript";
import { uuidv7 } from "./uuidv7";

export interface AgentRunView {
  transcript: Transcript;
  /** Why the transcript couldn't load, for people. */
  error?: string;
  /** Texts this window sent, by turn id, since the log holds only the id (RYA-92). */
  sent: ReadonlyMap<string, string>;
  /** Sends a message as the run's next turn. Resolves to an error message, or undefined. */
  send: (text: string) => Promise<string | undefined>;
  cancel: () => void;
}

/**
 * One run's transcript, kept live: pages through `agent/events`, then subscribes
 * to its scope's events from the last `seq`, and starts over on `resync`.
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
      for (let more = true; more;) {
        const page = await window.wisp.request(hostId, "agent/events", { runId, after: t.seq });
        if (stopped) return;
        if ("error" in page) return setError(page.error.message);
        t = applyEvents(t, page.result.events, runId);
        more = page.result.more;
      }
      setTranscript(t);
      setError(undefined);
      // agent.started carries the run's scope: its project, or its thread's repo entry (0017).
      if (!t.run) return setError("This agent run hasn't started.");
      unsubscribe = window.wisp.subscribe(
        hostId,
        { after: t.seq, project: t.run.project },
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
    async (text: string) => {
      const turnId = uuidv7();
      setSent((prev) => new Map(prev).set(turnId, text));
      const answer = await window.wisp.request(hostId, "agent/send", { runId, turnId, text });
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

  const cancel = useCallback(
    () => void window.wisp.request(hostId, "agent/cancel", { runId }),
    [hostId, runId],
  );

  return { transcript, error, sent, send, cancel };
}
