import { useId } from "react";

// A nightly build's stars, glow, and clouds in the sidebar's top row (index.css shows them only
// under .nightly, which main.tsx sets). Drawn 640 by 56 and cropped to the sidebar, so they never
// scale. The sky behind them is the sidebar's own background (.night-sky-host in index.css).

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
// Each layer's lit top and its body, nearer ones lighter.
// index.css sets them per mode: indigo at night in dark mode, white and lavender in light.
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
      <svg viewBox="0 0 640 56" preserveAspectRatio="xMinYMin slice">
        <defs>
          <radialGradient id={`${id}-glow`} cx="0.75" cy="0" r="0.5">
            <stop offset="0" stopColor="#7c3aed" stopOpacity="0.4" />
            <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
          </radialGradient>
          {/* The clouds thin out into the sky by the top row's bottom. */}
          <linearGradient
            id={`${id}-thin`}
            x1="0"
            y1="36"
            x2="0"
            y2="54"
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
          <circle
            key={i}
            cx={x}
            cy={y}
            r={r}
            fill="#fff"
            opacity={opacity}
            className={i % 4 === 0 ? "twinkle" : undefined}
            style={{ animationDelay: `${(i * 0.7) % 4}s` }}
          />
        ))}
        <g mask={`url(#${id}-clouds)`}>
          {([0, 1, 2] as const).map((layer) => (
            <g key={layer} className={layer === 0 ? "drift" : undefined}>
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
    </div>
  );
}
