import { useId, type ReactNode } from "react";

import type { ProjectAutonomy, ProjectPermission } from "../protocol/generated/protocol";

type Option<T> = { value: T; name: string; detail: string };

const modes: Option<ProjectPermission>[] = [
  {
    value: "auto",
    name: "Auto",
    detail:
      "A safety check reviews each action first and asks you about any it won't decide. Claude Code and Codex offer it.",
  },
  {
    value: "bypass",
    name: "Bypass",
    detail:
      "Every action runs with no second check. Cursor, Grok Build, Hermes Agent, and the Ollama Cloud, OpenRouter, and local model providers need it.",
  },
];

const levels: Option<ProjectAutonomy>[] = [
  {
    value: "ask",
    name: "Ask me",
    detail: "The coordinator answers nothing. Every question waits for you in Needs you.",
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

/**
 * A Project's permission mode and the disclaimer that goes with it (0042): why its agents run
 * without asking, what that lets them do, and the choice of Auto or Bypass. Create Project and
 * a Project's Permissions… dialog both show it, so they say the same thing.
 */
export function ProjectPermissionChoice(props: {
  value: ProjectPermission;
  onChange: (value: ProjectPermission) => void;
}) {
  return (
    <Choice legend="Permissions" options={modes} {...props}>
      A Project's agents run without asking. In any other mode an agent stops at its first command
      until someone answers, so the Project couldn't keep working while you're away. They can edit
      files, run commands, use the network, and push with your credentials.
    </Choice>
  );
}

/** A Project's autonomy (0043), in its Autonomy… dialog. */
export function AutonomyChoice(props: {
  value: ProjectAutonomy;
  onChange: (value: ProjectAutonomy) => void;
}) {
  return (
    <Choice legend="Autonomy" options={levels} {...props}>
      A child never waits on a question: it goes on with what it assumed. This decides who answers
      it. Every answer shows in the inbox, and you can change it.
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
