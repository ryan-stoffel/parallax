import claudeFree from "./assets/plans/claude-free.svg";
import claudeMax from "./assets/plans/claude-max.svg";
import claudePro from "./assets/plans/claude-pro.svg";
import claudeUltra from "./assets/plans/claude-ultra.svg";
import gem from "./assets/plans/chatgpt-gem.svg";
import sparkle from "./assets/plans/chatgpt-sparkle.svg";
import { maskLogo } from "./logos";

/** A plan's mark, in the provider's own artwork from its pricing page, drawn in the text's color. */
type Mark = "claude-free" | "claude-pro" | "claude-max" | "claude-ultra" | "sparkle" | "gem";

interface Plan {
  label: string;
  mark?: Mark;
}

// The plans each provider reports: Anthropic's plan display name, or for an older account its
// `organization_type`, and Codex's `planType`. ChatGPT sells one Pro, with three usage tiers.
const plans: Record<string, Record<string, Plan>> = {
  claude: {
    free: { label: "Free", mark: "claude-free" },
    pro: { label: "Pro", mark: "claude-pro" },
    max: { label: "Max", mark: "claude-max" },
    ultra: { label: "Ultra", mark: "claude-ultra" },
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

const marks: Record<Mark, string> = {
  "claude-free": claudeFree,
  "claude-pro": claudePro,
  "claude-max": claudeMax,
  "claude-ultra": claudeUltra,
  sparkle,
  gem,
};

/** A subscription's plan: its provider's mark, in the text's color, and its plain name. */
export function PlanLabel({ kind, plan }: { kind: string; plan: string }) {
  const { label, mark } = planOf(kind, plan);
  const Mark = mark && maskLogo(marks[mark]);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
      {Mark && <Mark className="size-5 shrink-0" />}
      {label}
    </span>
  );
}
