import { useId, type ReactNode } from "react";

import type { ProjectAutonomy } from "../protocol/generated/protocol";

type Option<T> = { value: T; name: string; detail: string };

/** Each autonomy level (0043), with a line on who answers. */
export const autonomyLevels: Option<ProjectAutonomy>[] = [
  {
    value: "ask",
    name: "Ask me",
    detail: "The coordinator answers nothing. Every question waits on you.",
  },
  {
    value: "routine",
    name: "Routine",
    detail:
      "The coordinator answers what memory or the code clearly settles, and asks you the rest.",
  },
  {
    value: "full",
    name: "Full",
    detail: "The coordinator answers everything it can justify.",
  },
];

/** A Project's autonomy (0043), in its Autonomy… dialog. */
export function AutonomyChoice(props: {
  value: ProjectAutonomy;
  onChange: (value: ProjectAutonomy) => void;
}) {
  return (
    <Choice legend="Autonomy" options={autonomyLevels} {...props}>
      A child never waits on a question: it goes on with what it assumed. This decides who answers
      it. Every answer shows on the Project tab.
    </Choice>
  );
}

/** A labeled set of radio cards, with a line of detail on each. */
function Choice<T extends string>({
  legend,
  options,
  value,
  onChange,
  children,
}: {
  legend: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium">{legend}</legend>
      <p className="text-[12.5px] text-muted-foreground">{children}</p>
      {options.map((m) => (
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
            <span className="block text-[13px] font-medium">{m.name}</span>
            <span className="block text-[12px] text-muted-foreground">{m.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
