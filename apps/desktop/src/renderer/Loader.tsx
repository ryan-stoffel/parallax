import { useState, type CSSProperties } from "react";

// Ported from Dani Asyrofi's loading indicators (https://loading.daniasyrofi.com), MIT License,
// Copyright (c) 2026 Dani Asyrofi. The license and the ported CSS are in index.css.

/** One way a loader moves: how long a cycle takes, and when each of its parts starts, in ms. */
interface Pattern {
  duration: number;
  delays: readonly number[];
}

// The source's patterns, only those in use. The number of delays is the number of parts.
const patterns = {
  orbit: {
    chase: { duration: 960, delays: [0, 120, 240, 360, 480, 600, 720, 840] },
    oppose: { duration: 1100, delays: [0, 120, 240, 360, 0, 120, 240, 360] },
  },
  beacon: {
    rise: { duration: 980, delays: [0, 90, 180, 270, 360] },
    balance: { duration: 1180, delays: [0, 180, 360, 180, 0] },
  },
  matrix: {
    ripple: { duration: 1160, delays: [240, 120, 240, 120, 0, 120, 240, 120, 240] },
    scan: { duration: 980, delays: [0, 0, 0, 180, 180, 180, 360, 360, 360] },
  },
  cells: {
    merge: { duration: 1120, delays: [0, 100, 200, 300] },
    spread: { duration: 1120, delays: [300, 200, 100, 0] },
  },
  register: {
    shift: { duration: 1040, delays: [0, 90, 180, 270, 360, 450] },
  },
  bands: {
    descend: { duration: 1060, delays: [0, 180, 360] },
  },
  lift: {
    rise: { duration: 1240, delays: [0, 120, 240, 360] },
    breathe: { duration: 1560, delays: [0, 100, 200, 300] },
  },
} as const satisfies Record<string, Record<string, Pattern>>;

type Patterns = typeof patterns;

/** A loader: its shape, and how it moves. */
export type LoaderStyle = {
  [K in keyof Patterns]: { kind: K; variant: keyof Patterns[K] };
}[keyof Patterns];

/**
 * A small animated mark for work in progress, in the working accent. Screen readers skip it, so
 * whatever it stands for says so in text. The loaders are drawn at 24 px and scaled to `size`.
 */
export function Loader({
  size = 16,
  className = "",
  ...loader
}: LoaderStyle & { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`loader text-working ${className}`}
      style={{ "--loader-scale": size / 24 } as CSSProperties}
    >
      {/* Keyed, so another loader starts on the wall clock too. */}
      <Stage key={`${loader.kind}/${loader.variant}`} {...loader} />
    </span>
  );
}

function Stage({ kind, variant }: LoaderStyle) {
  // Each part's cycle is set back by the wall clock as it mounts, so a loader drawn again (New
  // Thread handing off to the opened thread) carries on where the last one was.
  const [now] = useState(Date.now);
  const { duration, delays } = (patterns[kind] as Record<string, Pattern>)[variant]!;
  const index = (i: number) => ({ "--i": i }) as CSSProperties;
  let parts = delays.map((delay, i) => (
    <span
      key={i}
      className="loader-part"
      style={{
        ...index(i),
        animationDuration: `${duration}ms`,
        animationDelay: `${delay - (now % duration)}ms`,
      }}
    />
  ));
  // Orbit's dots each sit on a turned arm, and each band's runs along a rail.
  if (kind === "orbit" || kind === "bands")
    parts = parts.map((part, i) => (
      <span key={i} style={index(i)}>
        {part}
      </span>
    ));
  return (
    <span className="loader-stage" data-loader={kind} data-variant={variant}>
      {parts}
    </span>
  );
}
