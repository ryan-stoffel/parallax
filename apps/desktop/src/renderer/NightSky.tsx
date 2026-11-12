import { useId } from "react";

// A nightly build's stars, glow, and clouds in the sidebar's top row, or a dev build's blueprint
// grid and dimension lines (0103). index.css shows the box only under .stage and the build's own
// art in it, by .nightly or .dev, which main.tsx sets. Drawn 640 by 56 and cropped to the sidebar,
// so they never scale. The sky or paper behind them is the sidebar's own background
// (.night-sky-host in index.css).
// Nothing here animates: Chromium repaints an animated SVG on every frame, which cost an idle
// window about half a CPU core.

// Stars: x, y, radius, opacity, from a fixed seed so every window draws the same sky.
const stars = (() => {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: 34 }, () => [
    next() * 640,
    next() * 40,
    0.4 + next() * 0.8,
    0.4 + next() * 0.6,
  ]);
})();

// Clouds: x, y (the base's middle), scale, and layer, back (0) to front (2).
const clouds: [number, number, number, 0 | 1 | 2][] = [
  [60, 50, 1.1, 0],
  [250, 49, 1.2, 0],
  [470, 50, 1.1, 0],
  [-6, 56, 0.9, 1],
  [150, 55, 0.8, 1],
  [350, 56, 1, 1],
  [560, 55, 0.9, 1],
  [90, 61, 0.9, 2],
  [270, 61, 0.8, 2],
  [450, 62, 0.9, 2],
  [620, 61, 0.8, 2],
];
// Each layer's lit top and its body, nearer ones lighter. index.css sets them, and the stars' and
// glow's colors, per mode: indigo at night in dark mode, white and lavender at dawn in light.
const shades = [
  ["var(--cloud-far-lit)", "var(--cloud-far)"],
  ["var(--cloud-mid-lit)", "var(--cloud-mid)"],
  ["var(--cloud-near-lit)", "var(--cloud-near)"],
];

/** A cartoon cloud: puffs on a rounded base. */
function Cloud({ fill, dy = 0 }: { fill: string; dy?: number }) {
  return (
    <g style={{ fill }} transform={`translate(0 ${dy})`}>
      <circle cx="-12" cy="-2" r="7" />
      <circle cx="0" cy="-7" r="10" />
      <circle cx="14" cy="-9" r="12" />
      <circle cx="28" cy="-4" r="8" />
      <rect x="-20" y="-5" width="56" height="12" rx="6" />
    </g>
  );
}

export function NightSky() {
  const id = useId();
  return (
    <div aria-hidden className="night-sky">
      <svg className="sky-art" viewBox="0 0 640 56" preserveAspectRatio="xMinYMin slice">
        <defs>
          <radialGradient id={`${id}-glow`} cx="0.75" cy="0" r="0.5">
            <stop offset="0" style={{ stopColor: "var(--sky-glow)" }} stopOpacity="0.4" />
            <stop offset="1" style={{ stopColor: "var(--sky-glow)" }} stopOpacity="0" />
          </radialGradient>
          {/* The clouds thin out into the sky by the top row's bottom. */}
          <linearGradient
            id={`${id}-thin`}
            x1="0"
            y1="36"
            x2="0"
            y2="52"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={`${id}-clouds`} maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="56">
            <rect width="640" height="56" fill={`url(#${id}-thin)`} />
          </mask>
        </defs>
        <rect width="640" height="56" fill={`url(#${id}-glow)`} />
        {stars.map(([x, y, r, opacity], i) => (
          <circle key={i} cx={x} cy={y} r={r} opacity={opacity} style={{ fill: "var(--star)" }} />
        ))}
        <g mask={`url(#${id}-clouds)`}>
          {([0, 1, 2] as const).map((layer) => (
            <g key={layer}>
              {clouds
                .filter((c) => c[3] === layer)
                .map(([x, y, scale]) => (
                  <g key={x} transform={`translate(${x} ${y}) scale(${scale})`}>
                    <Cloud fill={shades[layer]![0]!} />
                    <Cloud fill={shades[layer]![1]!} dy={2.5} />
                  </g>
                ))}
            </g>
          ))}
        </g>
      </svg>
      <Blueprint />
    </div>
  );
}

// The blueprint's dimension lines, each from (x1, y1) to (x2, y2) with a tick across each end, and
// its marks: a plus or a cross at (x, y). index.css sets --blueprint-line.
const dimensions: [number, number, number, number][] = [
  [96, 44, 172, 44],
  [214, 14, 214, 40],
  [300, 26, 388, 26],
  [452, 30, 452, 50],
  [508, 46, 616, 46],
];
const marks: [number, number, "plus" | "cross"][] = [
  [30, 30, "cross"],
  [188, 20, "plus"],
  [262, 42, "plus"],
  [420, 12, "cross"],
  [560, 22, "plus"],
];

/** A dev build's blueprint paper: a grid, a ruler along the top, and drafting marks. */
function Blueprint() {
  const id = useId();
  const line = { stroke: "var(--blueprint-line)" };
  return (
    <svg className="blueprint-art" viewBox="0 0 640 56" preserveAspectRatio="xMinYMin slice">
      <defs>
        <pattern id={`${id}-minor`} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M8 0H0V8" fill="none" style={line} strokeOpacity="0.14" strokeWidth="0.5" />
        </pattern>
        <pattern id={`${id}-major`} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" style={line} strokeOpacity="0.26" strokeWidth="0.6" />
        </pattern>
        <pattern id={`${id}-ruler`} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            style={line}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <radialGradient id={`${id}-glow`} cx="0.75" cy="0" r="0.5">
          <stop offset="0" style={{ stopColor: "var(--blueprint-glow)" }} stopOpacity="0.4" />
          <stop offset="1" style={{ stopColor: "var(--blueprint-glow)" }} stopOpacity="0" />
        </radialGradient>
        {/* The paper's lines fade into the sidebar by the top row's bottom. */}
        <linearGradient
          id={`${id}-thin`}
          x1="0"
          y1="30"
          x2="0"
          y2="56"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-fade`} maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="56">
          <rect width="640" height="56" fill={`url(#${id}-thin)`} />
        </mask>
      </defs>
      <rect width="640" height="56" fill={`url(#${id}-glow)`} />
      <g mask={`url(#${id}-fade)`}>
        <rect width="640" height="56" fill={`url(#${id}-minor)`} />
        <rect width="640" height="56" fill={`url(#${id}-major)`} />
        <rect width="640" height="6" fill={`url(#${id}-ruler)`} />
        <g fill="none" style={line} strokeLinecap="round" strokeOpacity="0.55" strokeWidth="0.7">
          {dimensions.map(([x1, y1, x2, y2]) => {
            const across =
              y1 === y2
                ? `M${x1} ${y1 - 3}V${y1 + 3}M${x2} ${y2 - 3}V${y2 + 3}`
                : `M${x1 - 3} ${y1}H${x1 + 3}M${x2 - 3} ${y2}H${x2 + 3}`;
            return (
              <g key={`${x1} ${y1}`}>
                <path d={`M${x1} ${y1}L${x2} ${y2}`} strokeDasharray="4 3" />
                <path d={across} />
              </g>
            );
          })}
          {marks.map(([x, y, kind]) => (
            <path
              key={`${x} ${y}`}
              d={
                kind === "plus"
                  ? `M${x - 3} ${y}H${x + 3}M${x} ${y - 3}V${y + 3}`
                  : `M${x - 2.5} ${y - 2.5}L${x + 2.5} ${y + 2.5}M${x + 2.5} ${y - 2.5}L${x - 2.5} ${y + 2.5}`
              }
            />
          ))}
          <circle cx="352" cy="40" r="10" strokeDasharray="2.5 3.5" strokeOpacity="0.35" />
          <path d="M352 36V44M348 40H356" strokeOpacity="0.4" strokeWidth="0.5" />
        </g>
      </g>
    </svg>
  );
}
