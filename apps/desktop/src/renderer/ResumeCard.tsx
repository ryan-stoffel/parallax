import { AlarmClock } from "lucide-react";
import { useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { clockOptions } from "./prefs";

/**
 * When a waiting run resumes, in the user's locale: "3:40 PM", or "Oct 5, 3:40 PM" when it isn't
 * today.
 */
export function resumeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, clockOptions());
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * The end of a run's transcript while it waits for its usage limit to reset (decision 0049): when
 * plxd resumes it, with Resume now and Cancel. Shown only for a `waiting` run.
 */
export function ResumeCard({
  hostId,
  run,
  disabledReason,
}: {
  hostId: string;
  run: AgentRun;
  /** Why the buttons can't be used now, such as a lost connection. */
  disabledReason?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (run.status !== "waiting") return null;

  // The run's next agent.updated takes the card away, so only a failure needs handling here.
  const act = async (method: "agent/resumeNow" | "agent/cancel") => {
    setBusy(true);
    setError(undefined);
    const answer = await window.parallax.request(hostId, method, { runId: run.id });
    setBusy(false);
    if ("error" in answer) setError(answer.error.message);
  };
  const disabled = busy || !!disabledReason;
  const button =
    "rounded-md px-2.5 py-1 text-[12.5px] font-medium enabled:hover:bg-hover disabled:opacity-50";
  return (
    <section
      aria-label="Usage limit"
      className="flex items-center gap-3 rounded-lg border border-warning/30 px-3.5 py-2.5 text-[13px]"
    >
      <AlarmClock aria-hidden className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Usage limit reached.{" "}
          {run.resumeAt ? `Resumes at ${resumeTime(run.resumeAt)}` : "It resumes once it resets."}
        </p>
        {error && (
          <p role="alert" className="mt-0.5 text-danger">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={disabled}
        title={disabledReason}
        onClick={() => void act("agent/resumeNow")}
        className={`${button} border border-border`}
      >
        Resume now
      </button>
      <button
        type="button"
        disabled={disabled}
        title={disabledReason}
        onClick={() => void act("agent/cancel")}
        className={`${button} text-muted-foreground`}
      >
        Cancel
      </button>
    </section>
  );
}
