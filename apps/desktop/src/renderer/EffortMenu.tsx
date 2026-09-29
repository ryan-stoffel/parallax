import { Brain, ChevronDown, Feather, Flame, Sprout, Zap, type LucideIcon } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";

import { menuButton, menuPanel } from "./ui";

// Each level's icon, a line about it, and how long (in seconds) a stripe takes to cross the fill.
const levels: { name: string; Icon: LucideIcon; blurb: string; speed: number }[] = [
  { name: "Light", Icon: Feather, blurb: "Quick answers, barely a pause", speed: 3 },
  { name: "Low", Icon: Sprout, blurb: "A little thought first", speed: 2 },
  { name: "Medium", Icon: Brain, blurb: "Thinks it over", speed: 1.3 },
  { name: "High", Icon: Flame, blurb: "Digs in on the hard parts", speed: 0.8 },
  { name: "Max", Icon: Zap, blurb: "Everything it's got", speed: 0.4 },
];
const last = levels.length - 1;
// The thumb's center travels from one radius in to one radius short of the far end, as the
// range's own (invisible) thumb does, so pointer positions map to the same stops.
const thumb = "2.75rem";
const at = (i: number) => `calc(${thumb} / 2 + (100% - ${thumb}) * ${i / last})`;
// A little overshoot, so the thumb and fill spring into place together.
const spring = "duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]";

/**
 * The reasoning picker: a button showing the level that opens a slider with a stop for each
 * level. Stripes in the fill speed up with the level, and Max shimmers and glows (index.css).
 * A placeholder until wispd takes an effort per thread; nothing here is sent.
 */
export function EffortMenu() {
  const id = useId();
  const [level, setLevel] = useState(3);
  const { name, Icon, blurb, speed } = levels[level]!;
  const full = level === last;
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-label={`Reasoning effort: ${name}`}
        className={menuButton}
      >
        {name}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        id={id}
        popover="auto"
        className={`${menuPanel()} w-80 p-4 ${full ? "effort-full" : ""}`}
      >
        <div className="mb-4 flex items-center gap-3">
          <span
            key={level}
            aria-hidden
            className={`effort-icon grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-4.5 ${full ? "bg-amber-500/15 text-amber-500" : "bg-ring/15 text-ring"}`}
          >
            <Icon />
          </span>
          <div className="min-w-0">
            <div className="text-[14px]">
              Reasoning <span className="text-muted-foreground">{name}</span>
            </div>
            <div className="truncate text-[12px] text-faint-foreground">{blurb}</div>
          </div>
        </div>
        <div
          className="relative"
          style={{ "--thumb": thumb, "--effort-speed": `${speed}s` } as CSSProperties}
        >
          <div className="effort-track relative h-9 rounded-full bg-selected shadow-[inset_0_0_0_1px_var(--border)]">
            {/* Square on the right, where the thumb covers it. */}
            <div
              aria-hidden
              className={`effort-fill absolute inset-y-0 left-0 rounded-l-full bg-linear-to-r from-ring to-[color-mix(in_srgb,var(--ring)_65%,white)] transition-[width] ${spring}`}
              style={{ width: at(level) }}
            />
            {levels.map((l, i) => (
              <span
                key={l.name}
                aria-hidden
                className={`absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${i < level ? "bg-white/60" : "bg-foreground/35"}`}
                style={{ left: at(i) }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={last}
            step={1}
            value={level}
            aria-label="Reasoning effort"
            aria-valuetext={name}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="effort-slider peer absolute inset-x-0 top-1/2 m-0 h-(--thumb) w-full -translate-y-1/2"
          />
          <span
            aria-hidden
            className={`effort-thumb pointer-events-none absolute top-1/2 size-(--thumb) -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_8px_rgb(0_0_0/35%)] transition-[left,scale] peer-active:scale-90 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring ${spring}`}
            style={{ left: at(level) }}
          />
        </div>
        <div aria-hidden className="relative mt-2.5 h-4">
          {levels.map((l, i) => (
            <span
              key={l.name}
              className={`absolute -translate-x-1/2 text-[11.5px] transition-colors ${i === level ? "font-medium text-foreground" : "text-faint-foreground"}`}
              style={{ left: at(i) }}
            >
              {l.name}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
