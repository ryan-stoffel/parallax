import { useId } from "react";

// A nightly build's marks (index.css shows them only under .nightly, which main.tsx sets).

const stars: [x: number, y: number, r: number, opacity: number][] = [
  [14, 9, 0.9, 0.9],
  [34, 31, 0.6, 0.6],
  [52, 14, 0.7, 0.8],
  [71, 4, 0.5, 0.5],
  [88, 22, 1, 1],
  [104, 8, 0.6, 0.7],
  [118, 30, 0.5, 0.5],
  [196, 7, 0.8, 0.9],
  [212, 27, 0.6, 0.6],
  [228, 12, 1.1, 1],
  [244, 33, 0.5, 0.6],
  [250, 5, 0.6, 0.7],
  [62, 38, 0.5, 0.4],
  [180, 36, 0.5, 0.4],
];

/**
 * A filter that turns its shape's opacity into clouds of `color`: fractal noise, thresholded so
 * the shape's opaque end is solid and its clear end is open sky.
 */
function clouds(id: string, seed: number, color: string) {
  return (
    <filter id={id} x="0" y="0" width="256" height="52" filterUnits="userSpaceOnUse">
      <feTurbulence type="fractalNoise" baseFrequency="0.03 0.16" numOctaves="3" seed={seed} />
      <feColorMatrix
        type="matrix"
        values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0"
        result="noise"
      />
      <feComposite
        in="SourceAlpha"
        in2="noise"
        operator="arithmetic"
        k2="1.7"
        k3="1.3"
        k4="-1.05"
        result="shape"
      />
      <feFlood style={{ floodColor: color }} />
      <feComposite in2="shape" operator="in" />
    </filter>
  );
}

/**
 * The night sky behind the sidebar's top row: stars, a glow behind the logo, and clouds. The
 * nearest bank of clouds is the sidebar's own color, so the sky ends in it rather than at a line.
 */
export function NightSky() {
  const id = useId();
  return (
    <div aria-hidden className="night-sky">
      <svg viewBox="0 0 256 52" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#04061a" />
            <stop offset="0.55" stopColor="#111844" />
            <stop offset="1" stopColor="#272a78" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx="0.62" cy="0.55" r="0.45">
            <stop offset="0" stopColor="#6366f1" stopOpacity="0.45" />
            <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}-soft`} x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <filter id={`${id}-softer`} x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
          <linearGradient id={`${id}-ramp`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.35" stopOpacity="0" />
            <stop offset="1" stopOpacity="1" />
          </linearGradient>
          {clouds(`${id}-bank`, 4, "var(--sidebar)")}
          {clouds(`${id}-lit`, 9, "#a5b4fc")}
        </defs>
        <rect width="256" height="52" fill={`url(#${id}-sky)`} />
        <rect width="256" height="52" fill={`url(#${id}-glow)`} />
        {stars.map(([x, y, r, opacity], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={r}
            fill="#fff"
            opacity={opacity}
            className={i % 3 === 0 ? "twinkle" : undefined}
            style={{ animationDelay: `${(i * 0.7) % 4}s` }}
          />
        ))}
        {/* Far clouds, lit indigo, drifting. */}
        <g className="drift" filter={`url(#${id}-soft)`} fill="#818cf8" opacity="0.35">
          <ellipse cx="30" cy="40" rx="34" ry="7" />
          <ellipse cx="120" cy="36" rx="40" ry="6" />
          <ellipse cx="215" cy="41" rx="38" ry="7" />
        </g>
        <g filter={`url(#${id}-softer)`} fill="#c7d2fe" opacity="0.28">
          <ellipse cx="70" cy="44" rx="30" ry="5" />
          <ellipse cx="170" cy="45" rx="34" ry="5" />
        </g>
        {/* Near clouds from noise, densest at the bottom: lit ones, then the sidebar's color. */}
        <rect
          y="-9"
          width="256"
          height="52"
          fill={`url(#${id}-ramp)`}
          filter={`url(#${id}-lit)`}
          opacity="0.5"
        />
        <rect width="256" height="52" fill={`url(#${id}-ramp)`} filter={`url(#${id}-bank)`} />
      </svg>
    </div>
  );
}

/** A small cloud resting on the logo's lower edge. */
export function NightCloud() {
  return (
    <svg aria-hidden viewBox="0 0 16 9" className="night-cloud">
      <path
        fill="#e0e7ff"
        d="M3.5 9A3.5 3.5 0 0 1 3 2.03 3.9 3.9 0 0 1 10.3 1.6 3.2 3.2 0 0 1 13 9Z"
      />
    </svg>
  );
}
