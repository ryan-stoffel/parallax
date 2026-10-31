// Voice: while the user dictates, the box becomes the recording. Its text gives way to what's
// been heard so far and a waveform of the mic's level, newest on the right, so silence, speech,
// and a mic that hears nothing all read at a glance. Done puts the words in the box as text.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { icons } from "../../src/renderer/icons";
import { reducedMotion } from "../../src/renderer/motion";
import {
  type ConceptProps,
  fitCanvas,
  insertText,
  sleep,
  themeColor,
  useCover,
  useFrames,
  wobble,
} from "./morph";

const said = "Make the 32 px glyph a little heavier, then export the tinted variant at every size.";

/** When each word of `said` starts and ends, in seconds, as a person might say it. */
const timeline = (() => {
  let t = 0.5;
  return said.split(" ").map((word) => {
    const start = t;
    t += 0.14 + word.length * 0.05;
    const end = t;
    t += word.endsWith(",") ? 0.55 : 0.06;
    return { word, start, end };
  });
})();
const spoken = timeline.at(-1)!.end;

/** A level in [0, 1] at `t` seconds, shaped like speech: syllables in words, a floor between. */
function syntheticLevel(t: number) {
  const word = timeline.find((w) => t >= w.start && t < w.end);
  const floor = 0.035 + 0.02 * wobble(t * 9, 3);
  if (!word) return floor;
  const syllables = Math.max(1, Math.round((word.end - word.start) / 0.16));
  const phase = ((t - word.start) / (word.end - word.start)) * syllables;
  const shape = Math.sin(Math.PI * (phase % 1)) ** 0.7;
  return Math.max(floor, shape * (0.5 + 0.35 * wobble(t * 2.3, 1) + 0.15 * wobble(t * 23, 7)));
}

interface Signal {
  kind: "microphone" | "synthetic";
  level(t: number): number;
  stop(): void;
}

/** The mic through Web Audio's analyser, or a synthetic signal where there's no mic to use. */
async function openSignal(): Promise<Signal> {
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer")), 1500)),
    ]);
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      kind: "microphone",
      level() {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
        return Math.min(1, Math.sqrt(rms) * 1.6);
      },
      stop() {
        for (const track of stream.getTracks()) track.stop();
        void audio.close();
      },
    };
  } catch {
    return { kind: "synthetic", level: syntheticLevel, stop() {} };
  }
}

/** Bars every 4px, 2px wide; a new one every 50ms. */
const pitch = 4;
const every = 50;

export function Voice({ box, signal, done }: ConceptProps) {
  const content = useRef<HTMLDivElement>(null);
  const cover = useCover(box, content);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<Signal>();
  const [elapsed, setElapsed] = useState(0);
  const levels = useRef<number[]>([]);
  const started = useRef(0);
  const pushed = useRef(0);

  useEffect(() => {
    let open: Signal | undefined;
    void openSignal().then((s) => {
      if (signal.aborted) return s.stop();
      open = s;
      started.current = performance.now();
      pushed.current = started.current;
      setSource(s);
      document.documentElement.dataset["labSignal"] = s.kind;
    });
    return () => open?.stop();
  }, [signal]);

  const t = elapsed;
  const words =
    source?.kind === "synthetic" ? timeline.filter((w) => t >= w.start).map((w) => w.word) : [];
  const heard = words.join(" ");

  // Puts what was heard in the box as text, then gives the box back.
  const finish = async () => {
    if (!cover) return;
    if (source?.kind === "synthetic") insertText(box, said);
    await cover.release();
    done();
  };

  // The synthetic script ends a moment after its last word.
  useEffect(() => {
    if (source?.kind !== "synthetic" || !cover) return;
    sleep((spoken + 0.9) * 1000, signal).then(finish, () => {});
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once per signal and cover.
  }, [source, cover]);

  useFrames((now) => {
    if (!source || !canvas.current) return;
    while (now - pushed.current >= every) {
      pushed.current += every;
      levels.current.push(source.level((pushed.current - started.current) / 1000));
      if (levels.current.length > 400) levels.current.shift();
    }
    setElapsed((now - started.current) / 1000);
    const { ctx, width, height } = fitCanvas(canvas.current);
    // The newest bar slides in from the right edge between pushes.
    const slide = reducedMotion() ? 0 : ((now - pushed.current) / every) * pitch;
    ctx.fillStyle = themeColor("foreground");
    const mid = height / 2;
    const all = levels.current;
    for (let i = all.length - 1, x = width - 2 - slide; i >= 0 && x > -2; i--, x -= pitch) {
      const h = Math.max(2, all[i]! * (height - 2));
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, 2, h, 1);
      ctx.fill();
    }
  });

  const minutes = Math.floor(t / 60);
  const seconds = Math.floor(t % 60);
  return (
    cover &&
    createPortal(
      <div ref={content} className="flex flex-col gap-1.5 px-5 pt-3.5 pb-2.5">
        <p className="min-h-[1.625em] text-reading leading-relaxed text-foreground">
          {heard || <span className="text-faint-foreground">Listening</span>}
        </p>
        <div className="-mr-2 flex items-center gap-3">
          <span className="w-8 text-meta text-muted-foreground tabular-nums">
            {minutes}:{String(seconds).padStart(2, "0")}
          </span>
          <canvas ref={canvas} aria-hidden className="h-8 min-w-0 flex-1" />
          <button
            type="button"
            aria-label="Cancel dictation"
            onClick={() => void cover.release().then(done)}
            className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <icons.close />
          </button>
          <button
            type="button"
            aria-label="Done"
            onClick={() => void finish()}
            className="grid size-9 place-items-center rounded-full bg-send text-send-foreground [&_svg]:size-4"
          >
            <icons.done />
          </button>
        </div>
      </div>,
      cover.layer,
    )
  );
}
