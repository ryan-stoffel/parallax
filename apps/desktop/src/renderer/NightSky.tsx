import { useId } from "react";

// A nightly build's sky behind the sidebar's top row (index.css shows it only under .nightly,
// which main.tsx sets). Drawn 640 wide and cropped to the sidebar, so its height never changes.

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
const shades = [
  ["#3c3a8c", "#2c2a6e"],
  ["#5753b4", "#43409a"],
  ["#8a86e4", "#6e6ac8"],
];

/** A cartoon cloud: puffs on a rounded base. */
function Cloud({ fill, dy = 0 }: { fill: string; dy?: number }) {
  return (
    <g fill={fill} transform={`translate(0 ${dy})`}>
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
      <svg viewBox="0 0 640 60" preserveAspectRatio="xMinYMax slice">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#070923" />
            <stop offset="0.6" stopColor="#17184f" />
            <stop offset="1" stopColor="#2a2470" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx="0.75" cy="0" r="0.5">
            <stop offset="0" stopColor="#7c3aed" stopOpacity="0.4" />
            <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="640" height="60" fill={`url(#${id}-sky)`} />
        <rect width="640" height="60" fill={`url(#${id}-glow)`} />
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
      </svg>
    </div>
  );
}
