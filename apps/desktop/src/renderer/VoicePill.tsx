import { Check, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import type { VoicePhase } from "./voiceSession";

export function VoicePill({
  phase,
  waveform,
  confirm,
  cancel,
}: {
  phase: VoicePhase;
  waveform: () => Float32Array | undefined;
  confirm: () => void;
  cancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let frame: number;
    const draw = () => {
      const element = canvas.current;
      const context = element?.getContext("2d");
      if (element && context) {
        const ratio = window.devicePixelRatio || 1;
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (element.width !== width * ratio || element.height !== height * ratio) {
          element.width = width * ratio;
          element.height = height * ratio;
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.strokeStyle = getComputedStyle(element).color;
        context.lineWidth = 2;
        context.lineCap = "round";
        const samples = waveform();
        const count = Math.max(1, Math.floor(width / 5));
        for (let bar = 0; bar < count; bar++) {
          let peak = 0;
          if (samples) {
            const from = Math.floor((bar * samples.length) / count);
            const to = Math.floor(((bar + 1) * samples.length) / count);
            for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]!));
          }
          const size = Math.min(height - 4, Math.max(2, peak * height * 2));
          const x = ((bar + 0.5) * width) / count;
          context.beginPath();
          context.moveTo(x, (height - size) / 2);
          context.lineTo(x, (height + size) / 2);
          context.stroke();
        }
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [waveform]);
  const label =
    phase === "loading"
      ? "Preparing voice input…"
      : phase === "finishing"
        ? "Transcribing…"
        : "Listening…";
  return (
    <div
      className="mx-auto flex w-full max-w-md items-center gap-4 rounded-full border border-neutral-700 bg-neutral-950 px-2.5 py-2.5 text-neutral-100 shadow-lg"
      aria-label="Voice input"
    >
      <button
        type="button"
        aria-label="Insert transcription"
        title="Insert transcription"
        disabled={phase !== "recording"}
        onClick={confirm}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 transition-opacity disabled:opacity-30"
      >
        <Check className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <canvas ref={canvas} className="h-8 w-full text-neutral-100" aria-hidden />
        <p role="status" className="text-center text-meta text-neutral-400">
          {label}
        </p>
      </div>
      <button
        type="button"
        aria-label="Cancel voice input"
        title="Discard recording (Escape)"
        onClick={cancel}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-800 text-neutral-100 transition-colors hover:bg-neutral-700"
      >
        <Square className="size-3.5 fill-current" />
      </button>
    </div>
  );
}
