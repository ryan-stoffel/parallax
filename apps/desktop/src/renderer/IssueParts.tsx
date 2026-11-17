import type { LucideIcon } from "lucide-react";

import type {
  IssueConnection,
  IssueState,
  IssueStateCategory,
} from "../protocol/generated/protocol";
import { icons } from "./icons";
import { categoryOf, providerNames } from "./issues";
import { Badge } from "./ui";

/** How each kind of state looks: its icon, and that icon's color. */
const looks: Record<IssueStateCategory, { Icon: LucideIcon; color: string }> = {
  backlog: { Icon: icons.issueBacklog, color: "text-faint-foreground" },
  todo: { Icon: icons.issueTodo, color: "text-muted-foreground" },
  inProgress: { Icon: icons.issueStarted, color: "text-warning" },
  done: { Icon: icons.success, color: "text-added" },
  canceled: { Icon: icons.skipped, color: "text-faint-foreground" },
};

/**
 * A tracker's color for a state, when it's one a style can take, pulled a quarter of the way to
 * the text's color so a pale one still shows on a light page and a dark one on a dark page.
 */
const colorOf = (state: IssueState) =>
  state.color && /^#[0-9a-f]{6}$/i.test(state.color)
    ? `color-mix(in oklab, ${state.color} 75%, currentColor)`
    : undefined;

/** A state's icon, in the tracker's color for it, or its kind's. */
export function StateIcon({ state, className = "" }: { state: IssueState; className?: string }) {
  const { Icon, color } = looks[categoryOf(state.category)];
  const own = colorOf(state);
  return (
    <Icon
      aria-hidden
      style={own ? { color: own } : undefined}
      className={`${own ? "" : color} ${className}`}
    />
  );
}

/** An issue's state as a chip: its name, led by its icon in the state's color. */
export function StateChip({ state }: { state: IssueState }) {
  return (
    <Badge>
      <StateIcon state={state} />
      {state.name}
    </Badge>
  );
}

/** A connection by name: its tracker, and its site, or its account where it has none. */
export const connectionName = (c: IssueConnection) =>
  `${providerNames[c.provider]} · ${c.site ?? c.account}`;
