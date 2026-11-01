import { useId } from "react";

/** How a plan ranks among its provider's: each rank has its own mark, and 3 also has a sheen. */
type Tier = 1 | 2 | 3;

interface Plan {
  label: string;
  tier?: Tier;
}

// The plans each provider's CLI reports: Claude Code's `subscriptionType` and Anthropic's
// `organization_type`, and Codex's `planType`. `ultra` isn't reported yet.
const plans: Record<string, Record<string, Plan>> = {
  claude: {
    free: { label: "Free" },
    pro: { label: "Pro", tier: 1 },
    max: { label: "Max", tier: 2 },
    ultra: { label: "Ultra", tier: 3 },
    team: { label: "Team", tier: 2 },
    enterprise: { label: "Enterprise", tier: 3 },
  },
  codex: {
    free: { label: "Free" },
    go: { label: "Go" },
    plus: { label: "Plus", tier: 1 },
    prolite: { label: "Pro Lite", tier: 2 },
    pro: { label: "Pro", tier: 2 },
    promax: { label: "Pro Max", tier: 3 },
    team: { label: "Team", tier: 2 },
    business: { label: "Business", tier: 2 },
    enterprise: { label: "Enterprise", tier: 3 },
    edu: { label: "Edu", tier: 1 },
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

/** A plan's mark, one shape per tier: a diamond, a cut gem, then a crown. */
function TierMark({ tier }: { tier: Tier }) {
  const fill = useId().replace(/\W/g, "");
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--plan-b)" />
          <stop offset="1" stopColor="var(--plan-a)" />
        </linearGradient>
      </defs>
      {tier === 1 && (
        <path
          d="M8 1.75 14.25 8 8 14.25 1.75 8Z"
          fill={`url(#${fill})`}
          fillOpacity={0.3}
          stroke={`url(#${fill})`}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {tier === 2 && (
        <>
          <path d="M4.25 2.25h7.5L15.25 6.5 8 14.5.75 6.5Z" fill={`url(#${fill})`} />
          <path
            d="M.75 6.5h14.5M5.25 6.5 8 14.5l2.75-8M4.25 2.25l1 4.25L8 2.25l2.75 4.25 1-4.25"
            fill="none"
            stroke="white"
            strokeOpacity={0.5}
            strokeWidth={0.75}
            strokeLinejoin="round"
          />
        </>
      )}
      {tier === 3 && (
        <>
          <path
            d="M2.25 11.75 1 4.5l3.75 2.75L8 1.75l3.25 5.5L15 4.5l-1.25 7.25Z"
            fill={`url(#${fill})`}
            stroke={`url(#${fill})`}
            strokeWidth={0.5}
            strokeLinejoin="round"
          />
          <rect x="2.25" y="12.75" width="11.5" height="1.75" rx="0.75" fill={`url(#${fill})`} />
          <circle cx="8" cy="8.5" r="1.25" fill="white" fillOpacity={0.75} />
        </>
      )}
    </svg>
  );
}

/** A subscription's label, with its tier's mark in its provider's colors (index.css). */
export function PlanBadge({ kind, plan }: { kind: string; plan: string }) {
  const { label, tier } = planOf(kind, plan);
  return (
    <span
      data-kind={kind}
      data-tier={tier}
      className="plan-badge inline-flex shrink-0 items-center gap-1 rounded-full py-px pr-1.5 pl-1 text-caption leading-[1.125rem] font-medium"
    >
      {tier && <TierMark tier={tier} />}
      {label}
    </span>
  );
}
