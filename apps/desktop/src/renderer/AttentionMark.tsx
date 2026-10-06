import { CircleAlert, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";

import type { Attention } from "./attention";

/**
 * Parallax's two circles, swapping places while an agent works: each slides through the other,
 * the blue one growing as it passes in front. Only transform moves (index.css).
 */
export function WorkingMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={`mark-working ${className}`}>
      <circle className="mark-coral" cx="14.5" cy="14.5" r="6.5" />
      <circle className="mark-blue" cx="9.5" cy="9.5" r="6.5" />
    </svg>
  );
}

/**
 * A check in a disc. With `animate`, the logo's circles meet in the middle and become it, once;
 * otherwise it is drawn still, so a reload never replays it.
 */
export function DoneMark({ animate, className = "" }: { animate: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`mark-done ${animate ? "mark-done-animate" : ""} ${className}`}
    >
      {animate && (
        <>
          <circle className="mark-coral" cx="14.5" cy="14.5" r="6.5" />
          <circle className="mark-blue" cx="9.5" cy="9.5" r="6.5" />
        </>
      )}
      <circle className="mark-disc" cx="12" cy="12" r="9" />
      <path className="mark-check" d="m8 12.4 2.7 2.6L16 9.6" />
    </svg>
  );
}

/** Whole seconds since `from`, ticking every second. */
export function useSeconds(from: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
}

/** "12s", "4m 05s", "1h 02m": how long a turn has gone. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function Working({ since }: { since: string }) {
  return <>Working {duration(useSeconds(since))}</>;
}

/**
 * A row's status, as its mark and a word: Working for how long since `since`, Needs you, Done, or
 * Failed. Settled shows nothing. Done animates only when this row saw the thread finish.
 */
export function AttentionBadge({
  attention,
  since,
  count,
}: {
  attention: Attention;
  /** When the current turn started, for Working's clock. */
  since?: string;
  /** For a Project: how many of its runs work. */
  count?: number;
}) {
  // Done animates only on a change from another state, never on the first render.
  const [shown, setShown] = useState(attention);
  const [animate, setAnimate] = useState(false);
  if (shown !== attention) {
    setShown(attention);
    setAnimate(attention === "done");
  }

  const look = "flex items-center gap-1 text-[11.5px] font-medium [&_svg]:size-3.5";
  switch (attention) {
    case "working":
      return (
        <span className={`${look} text-working`}>
          <WorkingMark />
          {since ? <Working since={since} /> : count && count > 1 ? `${count} working` : "Working"}
        </span>
      );
    case "needsYou":
      return (
        <span className={`${look} text-warning`}>
          <MessageCircleQuestion aria-hidden />
          Needs you
        </span>
      );
    case "done":
      return (
        <span className={`${look} text-added`}>
          <DoneMark animate={animate} />
          Done
        </span>
      );
    case "failed":
      return (
        <span className={`${look} text-danger`}>
          <CircleAlert aria-hidden />
          Failed
        </span>
      );
    default:
      return null;
  }
}
