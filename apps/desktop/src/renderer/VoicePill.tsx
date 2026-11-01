import { Check, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { WorkingMark } from "./AttentionMark";
import { animate, duration, easing } from "./motion";
import type { VoicePhase } from "./voiceSession";

const statuses: Record<VoicePhase, string> = {
  idle: "",
  loading: "Preparing voice input",
  recording: "Listening",
  finishing: "Transcribing",
};

// The bars: 25 of them, 3px wide with a 2px gap, so 123px across, and a new level each 45ms.
const bars = 25;
const barWidth = 3;
const barStep = 5;
const stepMs = 45;

/** How loud one analyser frame is, from 0 to 1: its RMS over the noise floor, lifted for speech. */
export function voiceLevel(samples: Float32Array | undefined): number {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Math.max(0, (rms - 0.004) * 6) ** 0.7);
}

/** The microphone's level over the last moment, the newest at the center, spreading outward. */
function Waveform({ waveform }: { waveform: () => Float32Array | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const levels = Array.from({ length: Math.ceil(bars / 2) }, () => 0);
    let last = 0;
    let frame: number;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const element = canvas.current;
      const context = element?.getContext("2d");
      if (!element || !context || now - last < stepMs) return;
      last = now;
      levels.pop();
      levels.unshift(voiceLevel(waveform()));
      const ratio = window.devicePixelRatio || 1;
      const { clientWidth: width, clientHeight: height } = element;
      if (element.width !== width * ratio) element.width = width * ratio;
      if (element.height !== height * ratio) element.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(element).color;
      const center = Math.floor(bars / 2);
      for (let bar = 0; bar < bars; bar++) {
        const away = Math.abs(bar - center);
        const size = barWidth + levels[away]! * (height - barWidth);
        // Fades toward the ends, so the row trails off instead of stopping at a wall.
        context.globalAlpha = 1 - (away / center) * 0.6;
        context.beginPath();
        context.roundRect(bar * barStep, (height - size) / 2, barWidth, size, barWidth / 2);
        context.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [waveform]);
  return (
    <canvas
      ref={canvas}
      aria-hidden
      style={{ width: bars * barStep - (barStep - barWidth) }}
      className="h-6 shrink-0"
    />
  );
}

/**
 * The recording pill: the left check inserts what was said, the right stop discards it, and the
 * waveform between them follows the microphone. It grows out of `anchor`, the composer it stands
 * in for, and shrinks back into it, so the box itself seems to become the pill.
 */
export function VoicePill({
  phase,
  waveform,
  confirm,
  cancel,
  anchor,
}: {
  phase: VoicePhase;
  waveform: () => Float32Array | undefined;
  confirm: () => void;
  cancel: () => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const active = phase !== "idle";
  // Kept through its shrinking back, after the session has ended.
  const [present, setPresent] = useState(active);
  if (active && !present) setPresent(true);
  const pill = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = pill.current;
    const box = anchor.current?.getBoundingClientRect();
    if (!element) return;
    const size = element.getBoundingClientRect();
    const composer = box && {
      width: `${box.width}px`,
      height: `${box.height}px`,
      borderRadius: "var(--radius-prompt)",
    };
    const small = { width: `${size.width}px`, height: `${size.height}px`, borderRadius: "22px" };
    const options = { duration: duration.slow, easing: easing.out, fill: "both" as const };
    if (active) {
      const morph = composer && animate(element, [composer, small], options);
      const fade =
        contents.current &&
        animate(contents.current, [{ opacity: 0 }, { opacity: 1 }], {
          duration: duration.base,
          delay: duration.fast,
          fill: "backwards",
        });
      return () => {
        morph?.cancel();
        fade?.cancel();
      };
    }
    if (!present) return;
    const fade =
      contents.current &&
      animate(contents.current, [{ opacity: 1 }, { opacity: 0 }], {
        duration: duration.fast,
        fill: "both",
      });
    const morph =
      composer &&
      animate(
        element,
        [
          { ...small, opacity: 1 },
          { ...composer, opacity: 0 },
        ],
        options,
      );
    if (!morph) {
      setPresent(false);
      return;
    }
    morph.onfinish = () => setPresent(false);
    return () => {
      morph.cancel();
      fade?.cancel();
    };
  }, [active, present, anchor]);
  if (!present) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center">
      <div
        ref={pill}
        aria-label="Voice input"
        className="pointer-events-auto flex h-11 items-center justify-center overflow-hidden rounded-[22px] border border-border bg-surface text-foreground shadow-composer"
      >
        <div ref={contents} className="flex items-center gap-2.5 px-1.5">
          <button
            type="button"
            aria-label="Insert transcription"
            title="Insert transcription"
            disabled={phase !== "recording"}
            onClick={confirm}
            className="send-sky grid size-8 shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:bg-selected disabled:text-faint-foreground"
          >
            <Check className="size-4" />
          </button>
          {phase === "recording" ? (
            <Waveform waveform={waveform} />
          ) : (
            // Not listening yet, or any more: the app's working mark, where the bars go.
            <div
              style={{ width: bars * barStep - (barStep - barWidth) }}
              className="grid h-6 shrink-0 place-items-center [--mark-blue:currentColor] [&_svg]:size-5"
            >
              <WorkingMark />
            </div>
          )}
          <button
            type="button"
            aria-label="Cancel voice input"
            title="Discard recording (Escape)"
            onClick={cancel}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-danger text-danger-foreground transition-opacity hover:opacity-85"
          >
            <Square className="size-3 fill-current" />
          </button>
        </div>
        <span role="status" className="sr-only">
          {statuses[phase]}
        </span>
      </div>
    </div>
  );
}
