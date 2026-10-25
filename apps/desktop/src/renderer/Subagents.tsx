// An agent's own subagents (PLX-382, 0041), such as Claude Code's Agent tool: read-only children
// of their thread, with no run, composer, or Parallax tools. Their call's row in the transcript
// opens one, as their chips in the top bar do, and the calls a turn made together show as one card.
import { ChevronDown, ChevronRight } from "./icons";
import { createContext, useContext } from "react";

import { duration, useSeconds } from "./AttentionMark";
import { locale } from "./locale";
import { ClaudeLogo } from "./logos";
import { models } from "./models";
import { clockOptions } from "./prefs";
import { backendLogos } from "./Sidebar";
import { TraceCollapsible } from "./Trace";
import {
  subagentLabels,
  subagentState,
  nativeTitle,
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

/**
 * The open thread's subagents, whether its run is live, the calls of those still running in the
 * background, and how to open one.
 */
export interface Subagents {
  subagents: Readonly<Record<string, Subagent>>;
  live: boolean;
  background: ReadonlySet<string>;
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
  background?: ReadonlySet<string>,
): NativeSubagent[] {
  return Object.values(subagents ?? {})
    .filter((s) => s.at !== undefined)
    .map((s) => ({
      callId: s.callId,
      ...(s.parent && { parent: s.parent }),
      title: nativeTitle(s),
      state: subagentState(s, live, background),
      ...(s.model && { model: s.model }),
    }));
}

/** A subagent's logo: its model's provider's, else Claude's, whose Agent tool starts them. */
function subagentLogo(s: Subagent) {
  return backendLogos[(s.model && knownModel(s.model)?.provider) || "claude"] ?? ClaudeLogo;
}

/** The first line of a subagent's last word: its final report, else its last message. */
function lastWord(s: Subagent) {
  const text = s.finished?.summary ?? s.items.findLast((x) => x.kind === "assistant")?.text;
  return text?.trim().split("\n")[0];
}

// The dot on a subagent's logo, by where it stands.
const dots: Record<SubagentState, string> = {
  running: "bg-working animate-pulse motion-reduce:animate-none",
  completed: "bg-added",
  failed: "bg-danger",
  stopped: "bg-faint-foreground",
};

/** A subagent's logo in a ring, with a dot for where it stands when `state` is given. */
function Avatar({ sub, state }: { sub: Subagent; state?: SubagentState }) {
  const Logo = subagentLogo(sub);
  return (
    <span className="relative grid size-7 shrink-0 place-items-center rounded-full border border-border bg-background [&_svg]:size-3.5">
      <Logo aria-hidden />
      {state && (
        <span
          aria-hidden
          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background ${dots[state]}`}
        />
      )}
    </span>
  );
}

/**
 * One subagent, as T3 Code lists one (PLX-843): its logo and state, its task, its last word, and
 * when it started. It opens the subagent.
 */
export function SubagentRow({ sub }: { sub: Subagent }) {
  const context = useContext(SubagentsContext);
  if (!context) return undefined;
  const state = subagentState(sub, context.live, context.background);
  const title = nativeTitle(sub);
  const said = lastWord(sub);
  return (
    <button
      type="button"
      aria-label={`Open subagent: ${title}, ${subagentLabels[state]}`}
      onClick={() => context.open(sub.callId)}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Avatar sub={sub} state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body text-foreground">{title}</span>
          <span className="shrink-0 text-meta text-faint-foreground">{subagentLabels[state]}</span>
        </span>
        {said && <span className="truncate text-meta text-muted-foreground">{said}</span>}
      </span>
      {sub.at && (
        <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
          {new Date(sub.at).toLocaleTimeString(locale(), clockOptions())}
        </span>
      )}
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-faint-foreground group-hover:text-foreground"
      />
    </button>
  );
}

/**
 * The subagents a turn started together, as T3 Code shows them (PLX-843): their logos stacked, how
 * many, where they stand, and how long they've gone, opening to a row for each. One alone is its
 * row. `id` keeps its open state with the transcript's rows.
 */
export function SubagentCard({
  id,
  subs,
  open,
  onToggle,
}: {
  id: string;
  subs: readonly Subagent[];
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}) {
  const context = useContext(SubagentsContext);
  if (!context) return undefined;
  if (subs.length === 1) return <SubagentRow sub={subs[0]!} />;
  const states = subs.map((s) => subagentState(s, context.live, context.background));
  const counts = (["running", "completed", "failed", "stopped"] as const)
    .map((state) => ({ state, n: states.filter((s) => s === state).length }))
    .filter(({ n }) => n > 0);
  const since = subs.map((s) => s.at).find(Boolean);
  // Once none works, from the first call to the last thing any of them did.
  const last = Math.max(...subs.flatMap((s) => s.items.map((i) => Date.parse(i.at ?? ""))));
  return (
    <TraceCollapsible open={open} onOpenChange={(next) => onToggle(id, next)}>
      <summary className="group flex w-full min-w-0 list-none items-center gap-3 rounded-xl py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="flex shrink-0 -space-x-2">
          {subs.slice(0, 3).map((s) => (
            <Avatar key={s.callId} sub={s} />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-medium text-foreground">{subs.length} subagents</span>
          <span className="truncate text-meta text-faint-foreground">
            {counts.map(({ state, n }, i) => (
              <span key={state} className={state === "running" ? "text-working" : undefined}>
                {i > 0 && ", "}
                {n} {subagentLabels[state].toLowerCase()}
              </span>
            ))}
          </span>
        </span>
        {since && states.includes("running") ? (
          <Elapsed since={since} />
        ) : (
          since &&
          last > Date.parse(since) && (
            <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
              {duration(Math.round((last - Date.parse(since)) / 1000))}
            </span>
          )
        )}
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 text-faint-foreground transition-transform group-hover:text-foreground motion-reduce:transition-none [details[open]>summary>&]:rotate-180"
        />
      </summary>
      {open && (
        <div className="mt-1 flex flex-col gap-1 pl-1">
          {subs.map((s) => (
            <SubagentRow key={s.callId} sub={s} />
          ))}
        </div>
      )}
    </TraceCollapsible>
  );
}

/** How long the card's subagents have gone, ticking each second. */
function Elapsed({ since }: { since: string }) {
  return (
    <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
      {duration(useSeconds(since))}
    </span>
  );
}
