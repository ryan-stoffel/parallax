import { ChevronDown, Zap } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";

import type { AgentEffort } from "../protocol/generated/protocol";
import { effortLevels as levels } from "./catalog";
import { menuButton, menuPanel, Picker } from "./ui";

const last = levels.length - 1;
// The thumb's center travels from one radius in to one radius short of the far end, as the
// range's own (invisible) thumb does, so pointer positions map to the same stops.
const thumb = "2.75rem";
const at = (i: number) => `calc(${thumb} / 2 + (100% - ${thumb}) * ${i / last})`;
// A little overshoot, so the thumb and fill spring into place together.
const spring = "duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]";

// Where the gauge's needle points at each level, in degrees clockwise from straight up. High is
// lucide's own Gauge, and Max is the end of the arc.
const needle: Record<AgentEffort, number> = {
  low: -80,
  medium: -20,
  high: 45,
  xhigh: 80,
  max: 120,
};

/**
 * lucide's Gauge, with its needle turned to the effort. The `lucide` class keeps its 1.5px lines.
 * The needle springs to each level, and turned up to Max it rattles against the end of the arc
 * before it settles (index.css). Opening a thread already at Max shows it settled.
 */
function EffortGauge({ value }: { value: AgentEffort }) {
  const [from] = useState(value);
  const [moved, setMoved] = useState(false);
  if (!moved && value !== from) setMoved(true);
  const lit = moved && value === "max";
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={lit ? "lucide effort-lit" : "lucide"}
      style={{ "--needle": `${needle[value]}deg` } as CSSProperties}
    >
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      <path d="M12 14V8.34" className={`effort-needle transition-[rotate] ${spring}`} />
    </svg>
  );
}

/** A context window's size, such as `200K` or `1M`. */
const tokens = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`);

// What each kind of instance with fast mode calls it, and its two settings. Cursor has none (0036).
const fastNames: Partial<Record<string, { label: string; on: string; off: string }>> = {
  claude: { label: "Fast mode", on: "On", off: "Off" },
  codex: { label: "Speed", on: "Fast", off: "Standard" },
};

/**
 * The reasoning picker: a button showing a gauge that points at the effort, the effort, and a bolt
 * in fast mode, that opens a slider with a stop for each level. A soft sheen sweeps through the
 * fill, faster the harder it thinks, and at Max the track breathes (index.css). Below it, the
 * context window is a choice when the model offers more than one, and fast mode when the model has
 * it (`fastMode`, by its instance kind's name for it).
 */
export function EffortMenu({
  value,
  onChange,
  contexts = [],
  context,
  onContext,
  fastMode,
  fast = false,
  onFast,
}: {
  value: AgentEffort;
  onChange: (value: AgentEffort) => void;
  /** The context windows the model offers, in tokens. */
  contexts?: number[];
  /** The chosen context window. Absent: none is shown. */
  context?: number;
  onContext?: (tokens: number) => void;
  /** The kind of the model's instance, when it has fast mode. */
  fastMode?: string;
  fast?: boolean;
  onFast?: (fast: boolean) => void;
}) {
  const id = useId();
  const level = levels.findIndex((l) => l.value === value);
  const { name, blurb, speed } = levels[level]!;
  const full = level === last;
  const names = fastMode && fastNames[fastMode];
  const row = "mt-4 flex items-center justify-between gap-2 text-body text-muted-foreground";
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-label={`Reasoning effort: ${name}${fast ? ", fast" : ""}`}
        className={menuButton}
      >
        <EffortGauge value={value} />
        <span className="composer-effort">{name}</span>
        {fast && <Zap aria-hidden className="fill-current text-orange-500" />}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        id={id}
        popover="auto"
        className={`${menuPanel()} w-80 p-4 ${full ? "effort-full" : ""}`}
      >
        <div className="mb-4 min-w-0">
          <div className="text-reading">
            Reasoning <span className="text-muted-foreground">{name}</span>
          </div>
          <div className="truncate text-meta text-faint-foreground">{blurb}</div>
        </div>
        <div
          className="relative"
          style={{ "--thumb": thumb, "--effort-speed": `${speed}s` } as CSSProperties}
        >
          <div className="effort-track relative h-9 rounded-full bg-selected shadow-[inset_0_0_0_1px_var(--border)]">
            {/* Square on the right, where the thumb covers it. */}
            <div
              aria-hidden
              className={`effort-fill absolute inset-y-0 left-0 rounded-l-full transition-[width] ${spring}`}
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
            onChange={(e) => onChange(levels[Number(e.target.value)]!.value)}
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
              className={`absolute -translate-x-1/2 text-meta transition-colors ${i === level ? "font-medium text-foreground" : "text-faint-foreground"}`}
              style={{ left: at(i) }}
            >
              {l.name}
            </span>
          ))}
        </div>
        {/* One context window is no choice, so there's nothing to show. */}
        {context !== undefined && contexts.length > 1 && (
          <div className={row}>
            Context window
            <Picker
              label="Context window"
              value={String(context)}
              onChange={(v) => onContext?.(Number(v))}
              options={contexts.map((n) => ({ value: String(n), label: tokens(n) }))}
              align="end"
              panelClassName="min-w-28"
            />
          </div>
        )}
        {names && (
          <div className={row}>
            {names.label}
            <Picker
              label={names.label}
              value={fast ? "on" : "off"}
              onChange={(v) => onFast?.(v === "on")}
              options={[
                { value: "on", label: names.on },
                { value: "off", label: names.off },
              ]}
              align="end"
              panelClassName="min-w-28"
            />
          </div>
        )}
      </div>
    </>
  );
}
