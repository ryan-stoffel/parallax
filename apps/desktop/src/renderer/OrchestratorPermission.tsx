import { useId } from "react";

import type { OrchestratorAutonomy } from "../protocol/generated/protocol";

/** Each autonomy level (0043), with a line on who answers. */
export const autonomyLevels: { value: OrchestratorAutonomy; name: string; detail: string }[] = [
  {
    value: "ask",
    name: "Ask me",
    detail: "The orchestrator answers nothing. Every question waits on you.",
  },
  {
    value: "routine",
    name: "Routine",
    detail:
      "The orchestrator answers what memory or the code clearly settles, and asks you the rest.",
  },
  {
    value: "full",
    name: "Full",
    detail: "The orchestrator answers everything it can justify.",
  },
];

/** An orchestrator's autonomy (0043), in its Autonomy… dialog: radio cards, with a line of detail on each. */
export function AutonomyChoice({
  value,
  onChange,
}: {
  value: OrchestratorAutonomy;
  onChange: (value: OrchestratorAutonomy) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-body font-medium">Autonomy</legend>
      <p className="text-body text-muted-foreground">
        A child never waits on a question: it goes on with what it assumed. This decides who answers
        it. Every answer shows on the orchestrator tab.
      </p>
      {autonomyLevels.map((m) => (
        <label
          key={m.value}
          className="flex gap-2.5 rounded-lg border border-border px-3 py-2 hover:bg-hover has-checked:border-ring has-focus-visible:outline-2 has-focus-visible:outline-ring"
        >
          <input
            type="radio"
            name={name}
            value={m.value}
            checked={value === m.value}
            onChange={() => onChange(m.value)}
            className="mt-0.5 accent-primary"
          />
          <span>
            <span className="block text-body font-medium">{m.name}</span>
            <span className="block text-meta text-muted-foreground">{m.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
