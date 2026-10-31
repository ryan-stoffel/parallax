// Stream trace: while the agent works, the box's top edge is a trace of how fast its reply
// streams, newest on the right. Text pulls the edge down; a tool call is a tick where it goes
// flat, so streaming, thinking, and a stalled tool read at a glance without leaving the box,
// which stays free to type in.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { reducedMotion } from "../../src/renderer/motion";
import {
  type ConceptProps,
  fitCanvas,
  sleep,
  themeColor,
  useFrames,
  useHost,
  wobble,
} from "./morph";

/** What the agent does, in turn, for how many seconds: as plxd's deltas and tool events would say. */
const phases: { kind: "text" | "think" | "tool"; seconds: number }[] = [
  { kind: "think", seconds: 1.2 },
  { kind: "text", seconds: 2.4 },
  { kind: "tool", seconds: 1.6 },
  { kind: "text", seconds: 1.8 },
  { kind: "tool", seconds: 0.9 },
  { kind: "tool", seconds: 2.2 },
  { kind: "text", seconds: 2.6 },
];
const total = phases.reduce((sum, p) => sum + p.seconds, 0);

/** The output rate in [0, 1] at `t`, and whether a tool call starts on this sample. */
function rateAt(t: number) {
  let start = 0;
  for (const phase of phases) {
    if (t < start + phase.seconds) {
      const into = t - start;
      // A soft start and end, as a burst of deltas ramps.
      const ramp = Math.min(1, into / 0.25, (phase.seconds - into) / 0.25);
      if (phase.kind === "tool") return 0;
      if (phase.kind === "think") return ramp * (0.1 + 0.05 * wobble(t * 3, 2));
      return ramp * (0.55 + 0.3 * wobble(t * 2.1, 5) + 0.15 * wobble(t * 11, 9));
    }
    start += phase.seconds;
  }
  return 0;
}
/** The times tool calls start, for their ticks. */
const tools = phases.reduce<number[]>((at, p, i) => {
  const start = phases.slice(0, i).reduce((sum, q) => sum + q.seconds, 0);
  return p.kind === "tool" ? [...at, start] : at;
}, []);

/** A sample every 40ms, 2px apart: 50px a second. */
const every = 40;
const pitch = 2;
/** Seconds of the turn already on the edge as it appears. */
const lead = 5;
/** How far the trace pulls down at full rate. */
const depth = 7;

export function Stream({ box, signal, done }: ConceptProps) {
  // Over the box's straight top edge, between its corners, and over its border.
  const host = useHost(box, "pointer-events-none absolute inset-x-4 -top-px z-10 h-3");
  const canvas = useRef<HTMLCanvasElement>(null);
  // The turn was already under way: its last few seconds are on the edge from the start.
  const samples = useRef(
    Array.from({ length: (lead * 1000) / every }, (_, i) => {
      const to = ((i + 1) * every) / 1000;
      return { rate: rateAt(to), tick: tools.some((s) => s >= to - every / 1000 && s < to) };
    }),
  );
  const started = useRef(performance.now() - lead * 1000);
  const pushed = useRef(started.current + lead * 1000);

  useEffect(() => {
    sleep((total - lead + 1.5) * 1000, signal).then(done, () => {});
  }, [signal, done]);

  useFrames((now) => {
    if (!canvas.current) return;
    while (now - pushed.current >= every) {
      const from = (pushed.current - started.current) / 1000;
      pushed.current += every;
      const to = (pushed.current - started.current) / 1000;
      samples.current.push({ rate: rateAt(to), tick: tools.some((s) => s >= from && s < to) });
    }
    const { ctx, width } = fitCanvas(canvas.current);
    const slide = reducedMotion() ? 0 : ((now - pushed.current) / every) * pitch;
    const all = samples.current;
    const y = (rate: number) => 0.5 + rate * depth;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.strokeStyle = themeColor("muted-foreground");
    // Only where it leaves the border: flat stretches are the border itself.
    ctx.beginPath();
    let drawing = false;
    for (let i = all.length - 1, x = width - slide; i > 0 && x > 0; i--, x -= pitch) {
      const live = all[i]!.rate > 0.01 || all[i - 1]!.rate > 0.01;
      if (live && !drawing) ctx.moveTo(x, y(all[i]!.rate));
      if (live) ctx.lineTo(x - pitch, y(all[i - 1]!.rate));
      drawing = live;
    }
    ctx.stroke();
    // A tick down from the edge where each tool call started.
    ctx.fillStyle = themeColor("faint-foreground");
    for (let i = all.length - 1, x = width - slide; i >= 0 && x > 0; i--, x -= pitch)
      if (all[i]!.tick) ctx.fillRect(Math.round(x) - 0.5, 0, 1, 5);
  });

  return (
    host && createPortal(<canvas ref={canvas} aria-hidden className="block h-full w-full" />, host)
  );
}
