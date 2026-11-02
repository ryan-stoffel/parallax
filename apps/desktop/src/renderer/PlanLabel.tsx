import type { ReactNode } from "react";

/** A plan's line-art mark: Claude's sprout grows with its plan, and ChatGPT's is a sparkle, then a gem. */
type Mark = "sprout" | "budding" | "bloom" | "sparkle" | "gem";

interface Plan {
  label: string;
  mark?: Mark;
}

// The plans each provider reports: Anthropic's plan display name, or for an older account its
// `organization_type`, and Codex's `planType`. ChatGPT sells one Pro, with three usage tiers.
const plans: Record<string, Record<string, Plan>> = {
  claude: {
    free: { label: "Free" },
    pro: { label: "Pro", mark: "sprout" },
    max: { label: "Max", mark: "budding" },
    ultra: { label: "Ultra", mark: "bloom" },
    team: { label: "Team" },
    enterprise: { label: "Enterprise" },
  },
  codex: {
    free: { label: "Free" },
    go: { label: "Go", mark: "sparkle" },
    plus: { label: "Plus", mark: "sparkle" },
    prolite: { label: "Pro", mark: "gem" },
    pro: { label: "Pro", mark: "gem" },
    promax: { label: "Pro", mark: "gem" },
    team: { label: "Team" },
    business: { label: "Business" },
    enterprise: { label: "Enterprise" },
    edu: { label: "Edu" },
  },
};

/** A plan id as `kind`'s plan, or for one this app doesn't know, its id in title case. */
export function planOf(kind: string, plan: string): Plan {
  const id = plan.toLowerCase().replace(/^(?:claude|chatgpt)_/, "");
  return (
    plans[kind]?.[id] ?? {
      label: id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    }
  );
}

/** A pair of buds on branches, from the stem at height `y` up and out by `reach`. */
const buds = (y: number, reach: number) => (
  <>
    <path d={`M8 ${y} ${8 - reach} ${y - 3}M8 ${y} ${8 + reach} ${y - 3}`} />
    <circle cx={8 - reach} cy={y - 3} r={0.9} />
    <circle cx={8 + reach} cy={y - 3} r={0.9} />
  </>
);

const marks: Record<Mark, ReactNode> = {
  sprout: (
    <>
      <path d="M8 15V6.25" />
      <circle cx={8} cy={4} r={2.25} />
      {buds(12, 3.25)}
    </>
  ),
  budding: (
    <>
      <path d="M8 15V6.25" />
      <circle cx={8} cy={4} r={2.25} />
      {buds(10.5, 3)}
      {buds(14.5, 4.5)}
    </>
  ),
  bloom: (
    <>
      <path d="M8 15V8.75" />
      <circle cx={8} cy={5} r={3.75} />
      <circle cx={8} cy={5} r={1.25} />
      <path d="M5.35 2.35l1.77 1.77M8.88 5.88l1.77 1.77M5.35 7.65l1.77-1.77M8.88 4.12l1.77-1.77" />
      {buds(14.5, 3.5)}
    </>
  ),
  sparkle: (
    <path d="M8 2c.5 3.5 2.5 5.5 6 6-3.5.5-5.5 2.5-6 6-.5-3.5-2.5-5.5-6-6 3.5-.5 5.5-2.5 6-6Z" />
  ),
  gem: (
    <path d="M4.5 2.75h7L14.5 6.5 8 13.5 1.5 6.5ZM1.5 6.5h13M5.75 6.5 8 13.5l2.25-7M4.5 2.75l1.25 3.75L8 2.75l2.25 3.75 1.25-3.75" />
  ),
};

/** A subscription's plan: a line-art mark in the text's color, and its plain name. */
export function PlanLabel({ kind, plan }: { kind: string; plan: string }) {
  const { label, mark } = planOf(kind, plan);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
      {mark && (
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
        >
          {marks[mark]}
        </svg>
      )}
      {label}
    </span>
  );
}
