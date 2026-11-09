import { CircleAlert, Eye, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { Attention } from "./attention";

// The working mark's ring: eight dots from the top, the first solid and each counterclockwise of
// it fainter, so as the ring turns clockwise they trail it.
const ring = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * 2 * Math.PI;
  return { x: 12 - 8 * Math.sin(angle), y: 12 - 8 * Math.cos(angle), opacity: 1 - i * 0.11 };
});

/**
 * A ring of dots in Parallax blue, turning while an agent works, its faintest dot trailing. Only
 * transform moves (index.css).
 */
export function WorkingMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="mark-working">
      {ring.map((dot, i) => (
        <circle key={i} cx={dot.x} cy={dot.y} r="2" opacity={dot.opacity} />
      ))}
    </svg>
  );
}

/**
 * A check in a disc. With `animate`, the logo's circles meet in the middle and become it, once;
 * otherwise it is drawn still, so a reload never replays it.
 */
export function DoneMark({ animate }: { animate: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`mark-done ${animate ? "mark-done-animate" : ""}`}
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

/**
 * An alarm clock ringing, for a snoozed thread's wake time. Lucide's AlarmClock, drawn smaller to
 * leave room for a sound arc on each side, since Lucide has no ringing one.
 */
export function RingingAlarmMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="13.5" r="6.5" />
      <path d="M12 10.5v3l1.5 1.5" />
      <path d="m7.5 3-2.5 2.5" />
      <path d="m16.5 3 2.5 2.5" />
      <path d="m7.5 19.5-1.5 2" />
      <path d="m16.5 19.5 1.5 2" />
      <path d="M2 10.5c-.7 2-.7 4 0 6" />
      <path d="M22 10.5c.7 2 .7 4 0 6" />
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

function Clock({ since }: { since: string }) {
  return <>{duration(useSeconds(since))}</>;
}

/**
 * A row's status, as its mark and a word: Working for how long since `since`, Monitoring or Waiting (PLX-777),
 * Needs you, Done, or Failed. Settled shows nothing. Done animates only when this row saw the thread finish,
 * and a status that changed rises into place. `iconOnly`, as a sidebar row's is (PLX-1496), draws
 * the mark and Working's clock alone: the word is its tooltip, and still there for a screen reader.
 */
export function AttentionBadge({
  attention,
  since,
  iconOnly = false,
}: {
  attention: Attention;
  /** When the user last sent the thread a message, for Working's clock (PLX-1012). */
  since?: string;
  iconOnly?: boolean;
}) {
  // Done animates only on a change from another state, never on the first render.
  const [shown, setShown] = useState(attention);
  const [animate, setAnimate] = useState(false);
  const [changed, setChanged] = useState(false);
  if (shown !== attention) {
    setShown(attention);
    setAnimate(attention === "done");
    setChanged(true);
  }

  const look = `flex items-center gap-1 text-meta font-medium [&_svg]:size-3.5 ${changed ? "rise-in" : ""}`;
  const badge = (color: string, mark: ReactNode, word: string, clock?: ReactNode) => (
    <span key={attention} title={iconOnly ? word : undefined} className={`${look} ${color}`}>
      {mark}
      <span className={iconOnly ? "sr-only" : undefined}>{word}</span>
      {clock && <> {clock}</>}
    </span>
  );
  switch (attention) {
    case "working":
      return badge("text-working", <WorkingMark />, "Working", since && <Clock since={since} />);
    case "monitoring":
    case "waiting":
      return badge(
        "text-working",
        <Eye aria-hidden />,
        attention === "monitoring" ? "Monitoring" : "Waiting",
      );
    case "needsYou":
      return badge("text-warning", <MessageCircleQuestion aria-hidden />, "Needs you");
    case "done":
      return badge("text-added", <DoneMark animate={animate} />, "Done");
    case "failed":
      return badge("text-danger", <CircleAlert aria-hidden />, "Failed");
    default:
      return null;
  }
}
