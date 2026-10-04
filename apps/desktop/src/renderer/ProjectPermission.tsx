import { useId } from "react";

import type { ProjectPermission } from "../protocol/generated/protocol";

const modes: { value: ProjectPermission; name: string; detail: string }[] = [
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

/**
 * A Project's permission mode and the disclaimer that goes with it (0042): why its agents run
 * without asking, what that lets them do, and the choice of Auto or Bypass. Create Project and
 * a Project's Permissions… dialog both show it, so they say the same thing.
 */
export function ProjectPermissionChoice({
  value,
  onChange,
}: {
  value: ProjectPermission;
  onChange: (value: ProjectPermission) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium">Permissions</legend>
      <p className="text-[12.5px] text-muted-foreground">
        A Project's agents run without asking. In any other mode an agent stops at its first command
        until someone answers, so the Project couldn't keep working while you're away. They can edit
        files, run commands, use the network, and push with your credentials.
      </p>
      {modes.map((m) => (
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
