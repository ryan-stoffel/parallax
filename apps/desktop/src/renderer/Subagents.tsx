// An agent's own subagents (PLX-382, 0041), such as Claude Code's Agent tool: read-only children
// of their thread, with no run, composer, or Parallax tools. Their call's row in the transcript
// opens one, as their chips in the top bar do.
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./Trace";
import { ArrowUpRight, Bot } from "lucide-react";
import { createContext, useContext } from "react";

import { Loader } from "./Loader";
import { models } from "./models";
import {
  subagentLabels,
  subagentState,
  nativeTitle,
  type Item,
  type Subagent,
  type SubagentState,
} from "./transcript";

/** A subagent as the top bar shows it. `parent` is the subagent that started a nested one. */
export interface NativeSubagent {
  callId: string;
  parent?: string;
  title: string;
  state: SubagentState;
  model?: string;
}

/** The open thread's subagents, whether its run is live, and how to open one. */
export interface Subagents {
  subagents: Readonly<Record<string, Subagent>>;
  live: boolean;
  open: (callId: string) => void;
}

export const SubagentsContext = createContext<Subagents | undefined>(undefined);

/**
 * The built-in catalog's entry for a reported model, dated ids and a `[1m]` suffix included. An
 * exact id wins, so Cursor's `claude-opus-5-5-medium` isn't taken for Claude's `claude-opus-5-5`.
 */
export function knownModel(model: string) {
  const id = model.replace(/\[.*\]$/, "");
  return models.find((m) => id === m.id) ?? models.find((m) => id.startsWith(`${m.id}-`));
}

/** A model for people: its name when this app knows it, else as reported. */
export function modelName(model?: string) {
  if (!model) return undefined;
  return knownModel(model)?.name ?? model;
}

/** The subagents of a transcript as the top bar shows them, oldest first. */
export function nativeSubagents(
  subagents: Readonly<Record<string, Subagent>> | undefined,
  live: boolean,
): NativeSubagent[] {
  return Object.values(subagents ?? {})
    .filter((s) => s.at !== undefined)
    .map((s) => ({
      callId: s.callId,
      ...(s.parent && { parent: s.parent }),
      title: nativeTitle(s),
      state: subagentState(s, live),
      ...(s.model && { model: s.model }),
    }));
}

/**
 * The call that started a subagent, as one row: its task and where it stands. It opens the
 * subagent. Undefined when the transcript knows no subagent for the call.
 */
export function SubagentCall({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const context = useContext(SubagentsContext);
  const sub = context?.subagents[item.callId];
  if (!context || !sub) return undefined;
  const state = subagentState(sub, context.live);
  const title = nativeTitle(sub);
  return (
    <button
      type="button"
      aria-label={`Open subagent: ${title}, ${subagentLabels[state]}`}
      onClick={() => context.open(item.callId)}
      className="flex w-fit max-w-full min-w-0 cursor-default rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <TraceLine
        status={state === "running" ? "running" : state === "failed" ? "error" : undefined}
      >
        <TraceIcon>
          {state === "running" ? <Loader kind="orbit" variant="oppose" /> : <Bot />}
        </TraceIcon>
        <TraceTitle>Subagent: {title}</TraceTitle>
        <TraceDescription className={state === "failed" ? "text-danger" : ""}>
          {subagentLabels[state]}
        </TraceDescription>
        <TraceIcon>
          <ArrowUpRight className="size-3.5" />
        </TraceIcon>
      </TraceLine>
    </button>
  );
}
