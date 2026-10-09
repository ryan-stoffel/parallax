// One agent run's transcript, rebuilt from its logged events. Pure, so it is
// tested without React; useAgentRun feeds it a snapshot's events, older pages
// of `orchestration/threadHistory`, and live events alike.
import type {
  AgentFailureKind,
  AgentOutcome,
  AgentOutputItem,
  AgentRun,
  AgentStatus,
  AgentSubagentStatus,
  AgentTodoItem,
  AgentToolStatus,
  ImageId,
  JsonValue,
  LoggedEvent,
  ParallaxEvent,
  RunId,
} from "../protocol/generated/protocol";

/** One row of the transcript. `key` is stable across re-renders; `at` is when it began. */
export type Item = ItemBody & { at?: string };

type ItemBody =
  /**
   * `text` is null for a follow-up logged by a plxd from before it recorded the text. `wake` marks
   * a turn plxd sent a coordinator itself, when runs it started finished (0025). `from` is the run
   * id of the thread that sent it with its Parallax tools, not the user (0041). `images` are the
   * ids of the images sent with it, for `agent/image` (PLX-193), and `threads` the run ids of the
   * threads attached to it as context (PLX-378).
   */
  | {
      kind: "user";
      key: string;
      text: string | null;
      turnId?: string;
      wake?: boolean;
      from?: string;
      images?: ImageId[];
      threads?: RunId[];
    }
  /** `partial` while it is still arriving as `textDelta`s. */
  | { kind: "assistant"; key: string; text: string; messageId?: string; partial?: boolean }
  | { kind: "reasoning"; key: string; text: string }
  /**
   * `status` is absent until its result arrives; `name` is null for a result with no call.
   * `subagent` is the first line of the prompt of the subagent a coordinator's plxd tool names.
   * `images` are the ids of the images the tool returned, such as a device screenshot, for
   * `agent/image` (PLX-640).
   */
  | {
      kind: "tool";
      key: string;
      callId: string;
      name: string | null;
      input?: JsonValue;
      status?: AgentToolStatus;
      output?: string;
      images?: ImageId[];
      subagent?: string;
    }
  /** `active` is the step under way as the agent words it, from Claude Code's task tools. */
  | { kind: "todo"; key: string; items: AgentTodoItem[]; active?: string }
  /**
   * `turnId` marks a follow-up that never reached the agent. `from` is the run id of the thread
   * that stopped the run (0041).
   */
  | {
      kind: "notice";
      key: string;
      tone: "info" | "warning";
      text: string;
      turnId?: string;
      from?: string;
    }
  /**
   * A permission request (PLX-196, 0031): what the agent asks to do, and how it ended, which is
   * absent while it waits.
   */
  | { kind: "approval"; key: string; request: ApprovalRequest; resolved?: ApprovalResolution }
  /** How one CLI process of the run ended. */
  | { kind: "end"; key: string; outcome: AgentOutcome }
  /**
   * Where a CLI process started or resumed its session, by the vendor's id, and its model when the
   * CLI says. Never shown: `withTaskLists` takes it out, and starts a new task list when the id
   * changes (PLX-250).
   */
  | { kind: "session"; key: string; sessionId: string; model?: string }
  /** A session on another model than the last one that named its own (PLX-495). */
  | { kind: "modelSwitch"; key: string; from: string; to: string }
  /** The agent compacting its context: under way, then `done` (PLX-584). */
  | { kind: "compaction"; key: string; done: boolean }
  /** A page the agent showed with html_render (PLX-639), kept with run `runId`'s images. */
  | ({ kind: "htmlRender"; key: string; runId: string } & HtmlRenderRef)
  /** A browser recording the agent stopped with preview_recording_stop (PLX-639). */
  | { kind: "recording"; key: string; runId: string; attachmentId: string };

/** What an html_render result names: the page, its title, and the frame height the agent asked for. */
export interface HtmlRenderRef {
  attachmentId: string;
  title: string;
  height: number;
}

/** The recording a preview_recording_stop output names, by its attachment id. */
function recordingId(output?: string): string | undefined {
  try {
    const { id, mimeType } = JSON.parse(output ?? "") as { id?: unknown; mimeType?: unknown };
    return typeof id === "string" && mimeType === "video/webm" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The page an html_render tool's output names, or undefined for anything else. */
export function htmlRenderRef(output?: string): HtmlRenderRef | undefined {
  try {
    const { attachmentId, title, height } =
      (JSON.parse(output ?? "") as { htmlRender?: Partial<HtmlRenderRef> }).htmlRender ?? {};
    if (typeof attachmentId === "string" && typeof title === "string" && typeof height === "number")
      return { attachmentId, title, height };
  } catch {
    // Not JSON, or cut short.
  }
  return undefined;
}

/** A permission request as `approvalRequested` carries it. */
export type ApprovalRequest = Omit<Extract<AgentOutputItem, { kind: "approvalRequested" }>, "kind">;

/**
 * How a permission request ended, as `approvalResolved` or `agent/approve` says, and when. `gone`
 * is this app's own: `agent/approve` found no such request, so it ended without saying how here.
 */
export type ApprovalResolution = Omit<
  Extract<AgentOutputItem, { kind: "approvalResolved" }>,
  "kind" | "approvalId"
> & { at?: string; gone?: boolean };

export type Approval = Extract<Item, { kind: "approval" }>;

export interface Transcript {
  /** Absent until `agent.started` is in. */
  run?: AgentRun;
  items: Item[];
  /** The agent's own subagents, by the call that started each, kept out of `items` (PLX-382). */
  subagents?: Readonly<Record<string, Subagent>>;
  /** The last `seq` applied. Anything at or below it is a repeat. */
  seq: number;
  /** Events applied so far, after the compacted-row rule, so a later rewrite can replace them. */
  events?: LoggedEvent[];
  /**
   * Whether every turn the agent started has finished, with no work since, so a run still
   * `running` is only winding down (PLX-584).
   */
  turnDone?: boolean;
  /**
   * The turns the live CLI started and hasn't finished, as a follow-up sent mid-turn starts before
   * the turn it follows finishes.
   */
  openTurns?: number;
}

/**
 * One of the agent's own subagents (PLX-382, 0041), such as Claude Code's Agent tool: read-only,
 * with no run of its own. Its task, type, and model come from the call that started it, and the
 * model then from what it wrote.
 */
export interface Subagent {
  callId: string;
  /** The subagent whose transcript has the call that started this one, for a nested one. */
  parent?: string;
  description?: string;
  prompt?: string;
  agentType?: string;
  model?: string;
  items: Item[];
  /** How its call ended. A subagent started in the background has its call end at once. */
  call?: AgentToolStatus;
  finished?: { status: AgentSubagentStatus; summary?: string };
  /** When its call was made. */
  at?: string;
}

/** The tools that start one of Claude Code's own subagents: `Agent`, once `Task`. */
export const isSubagentTool = (name: string | null) => name === "Agent" || name === "Task";

export type SubagentState = "running" | "completed" | "failed" | "stopped";

/**
 * Where a subagent stands. Only its finish says it's done: a status this app doesn't know reads as
 * stopped. Without one, a call that failed failed it, and otherwise it works while its run is
 * `live` and was stopped with the run once it isn't, since a background subagent's call succeeds
 * as soon as it launches.
 */
export function subagentState(s: Subagent, live: boolean): SubagentState {
  const status = s.finished?.status;
  if (status === "completed" || status === "failed") return status;
  if (status) return "stopped";
  if (s.call === "error" || s.call === "denied") return "failed";
  return live ? "running" : "stopped";
}

export const subagentLabels: Record<SubagentState, string> = {
  running: "Working",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** A subagent for people: its task, else its prompt's first line, else its type. */
export const nativeTitle = (s: Subagent) =>
  s.description?.trim() || s.prompt?.trim().split("\n")[0] || s.agentType || "Subagent";

/**
 * A subagent's transcript: its prompt, what it did, and its final report when its transcript
 * doesn't end on it already, as Claude Code doesn't stream a subagent's last reply.
 */
export function subagentRows(s: Subagent): Item[] {
  const rows: Item[] = [];
  if (s.prompt) rows.push({ kind: "user", key: `${s.callId}:prompt`, text: s.prompt, at: s.at });
  rows.push(...s.items);
  const said = s.items.findLast((x) => x.kind === "assistant")?.text.trim();
  const summary = s.finished?.summary?.trim();
  if (summary && summary !== said)
    rows.push({ kind: "assistant", key: `${s.callId}:summary`, text: summary });
  return rows;
}

export const emptyTranscript: Transcript = { items: [], seq: 0 };

/** The first `seq` of a compacted turn, when `event` is that rewritten row (0052). */
export function compactedFrom(event: ParallaxEvent): number | undefined {
  return event.kind === "agent.output" ? event.compacted?.from : undefined;
}

/**
 * A reader that meets a compacted row first drops any `agent.output` of that run with `seq` in
 * [`from`, the row's `seq`), then takes the row, replacing any held event at that `seq` (0052).
 */
export function applyCompacted(events: LoggedEvent[]): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  const taken = new Map<string, { from: number; seq: number }[]>();
  for (const event of events) {
    const from = compactedFrom(event.event);
    if (from !== undefined && event.event.kind === "agent.output") {
      const runId = event.event.runId;
      const ranges = taken.get(runId) ?? [];
      ranges.push({ from, seq: event.seq });
      taken.set(runId, ranges);
      for (let i = out.length - 1; i >= 0; i--) {
        const held = out[i]!;
        if (held.seq === event.seq) {
          out.splice(i, 1);
          continue;
        }
        if (
          held.event.kind === "agent.output" &&
          held.event.runId === runId &&
          held.seq >= from &&
          held.seq < event.seq
        )
          out.splice(i, 1);
      }
      out.push(event);
      continue;
    }
    if (event.event.kind === "agent.output") {
      const ranges = taken.get(event.event.runId) ?? [];
      if (ranges.some((range) => event.seq >= range.from && event.seq < range.seq)) continue;
      if (ranges.some((range) => event.seq === range.seq)) continue;
    }
    out.push(event);
  }
  return out;
}

const isText = (v?: JsonValue) => (typeof v === "string" ? v : undefined);

/**
 * Applies events, in `seq` order, for one run. Repeats and other runs' events are
 * skipped, and kinds this version doesn't know still count their `seq`.
 */
function mergeHeld(held: LoggedEvent[], incoming: LoggedEvent[]): LoggedEvent[] {
  // `held` is already merged, so newer events in order with no compacted row just append: the
  // live case, which then skips sorting the whole log again.
  let last = held.at(-1)?.seq ?? -Infinity;
  const appends = incoming.every((event) => {
    const newer = event.seq > last && compactedFrom(event.event) === undefined;
    last = event.seq;
    return newer;
  });
  if (appends) return held.concat(incoming);
  const all = applyCompacted([...held, ...incoming]);
  const bySeq = new Map<number, LoggedEvent>();
  for (const event of all) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function applyEvents(t: Transcript, events: LoggedEvent[], runId: string): Transcript {
  const incoming = applyCompacted(events);
  const all = mergeHeld(t.events ?? [], incoming);
  const replacing = incoming.some((event) => {
    const from = compactedFrom(event.event);
    return (
      from !== undefined &&
      event.event.kind === "agent.output" &&
      event.event.runId === runId &&
      from <= t.seq
    );
  });
  if (replacing) {
    const built = applyEventsInner({ ...emptyTranscript, run: t.run }, all, runId);
    return { ...built, run: t.run ?? built.run, events: all };
  }
  return { ...applyEventsInner(t, incoming, runId), events: all };
}

function applyEventsInner(t: Transcript, events: LoggedEvent[], runId: string): Transcript {
  let { run, seq, turnDone, openTurns = 0 } = t;
  const items = [...t.items];
  const subagents = { ...t.subagents };
  const push = (item: Item) => items.push(item);

  for (const { seq: at, time, event } of events) {
    if (at <= seq) continue;
    seq = at;
    if (!("runId" in event) || event.runId !== runId) continue;
    const key = (i: number | string = 0) => `${at}:${i}`;
    const before = items.length;

    run = updateRun(run, event);
    switch (event.kind) {
      case "agent.started":
        turnDone = false;
        if (event.run) push({ kind: "user", key: key(), text: event.run.prompt });
        break;
      case "agent.accountFallback":
        // The failed attempt's CLI ended, with its turns, without an agent.finished.
        openTurns = 0;
        push({
          kind: "notice",
          key: key(),
          tone: "info",
          text: `Switched from ${accountLabel(event.fromAccount)} to ${accountLabel(event.toAccount)}: ${failureText(event.reason)}.`,
        });
        break;
      case "agent.finished":
        // Every turn of the CLI ends with it, including a stopped one that logged no turnFinished.
        openTurns = 0;
        // A request still waiting ends with the run, as when plxd stopped without resolving it.
        items.forEach((item, i) => {
          if (item.kind === "approval" && !item.resolved)
            items[i] = { ...item, resolved: { decision: "withdrawn", by: "stop", at: time } };
        });
        push({ kind: "end", key: key(), outcome: event.outcome });
        break;
      case "agent.wakeupsPaused":
        push({
          kind: "notice",
          key: key(),
          tone: "info",
          text: "Wake-ups are paused: finished subagents won't wake the coordinator. Your next message resumes them.",
        });
        break;
      case "agent.output":
        event.items.forEach((item, i) => {
          if (item.kind === "turnStarted") openTurns++;
          // A dropped follow-up never had a turnStarted, so it doesn't count.
          if (item.kind === "turnFinished") {
            // A page that starts mid-run may hold a turn's end without its start.
            openTurns = Math.max(0, openTurns - 1);
            turnDone = openTurns === 0;
          } else if (activityKinds.has(item.kind)) turnDone = false;
          applyOutput(items, item, key(i), time, subagents, runId);
        });
        break;
    }
    // A row moved down by one put in before it keeps its own time.
    for (let i = before; i < items.length; i++)
      if (items[i]!.at === undefined) items[i] = { ...items[i]!, at: time };
  }
  // Unchanged subagents keep their object, so what reads them doesn't render again.
  const had = t.subagents ?? {};
  const changed =
    Object.keys(subagents).length !== Object.keys(had).length ||
    Object.entries(subagents).some(([callId, sub]) => had[callId] !== sub);
  return {
    run,
    items,
    subagents: changed ? subagents : t.subagents,
    seq,
    ...(turnDone !== undefined && { turnDone, openTurns }),
  };
}

/** The output items that mean the agent is at work on a turn. */
const activityKinds = new Set<string>([
  "turnStarted",
  "textDelta",
  "text",
  "reasoning",
  "toolCall",
  "toolResult",
  "todoList",
  "subagent",
  "approvalRequested",
  "contextCompaction",
]);

/**
 * `t` built again from `events`, every event of its run loaded so far, oldest first, as when a
 * transcript that opened at its end gets an older page in front (PLX-490). A page that starts
 * inside a turn reads on its own as a message's tail, or a tool result with no call; built again
 * with the page before, it reads as a full load does. The run stays as `t` has it, since older
 * events never change it.
 */
export function rebuild(t: Transcript, events: LoggedEvent[], runId: string): Transcript {
  const all = mergeHeld([], events);
  const built = applyEventsInner({ ...emptyTranscript, run: t.run }, all, runId);
  return { ...built, run: t.run, seq: Math.max(t.seq, built.seq), events: all };
}

/** A run as `event` leaves it: `agent.started` sets it, and `agent.updated` and fallbacks change it. */
export function updateRun(run: AgentRun | undefined, event: ParallaxEvent): AgentRun | undefined {
  switch (event.kind) {
    case "agent.started":
      return event.run;
    case "agent.updated":
      // `error`, `resumeAt`, and `autoResume` are absent once cleared; the rest only ever arrives.
      return (
        run && {
          ...run,
          ...event.state,
          error: event.state.error,
          resumeAt: event.state.resumeAt,
          autoResume: event.state.autoResume,
        }
      );
    case "agent.accountFallback":
      return run && { ...run, accountId: event.toAccount };
    default:
      return run;
  }
}

// ponytail: copies the item list per event and scans back for matches; fine for
// thousands of items, since plxd coalesces output every 50 ms.
/**
 * Applies one output item to `items`, the agent's or, under `owner`, a subagent's. A subagent's
 * own items go to its entry in `subagents`, out of the agent's flow (PLX-382).
 */
function applyOutput(
  items: Item[],
  item: AgentOutputItem,
  key: string,
  time: string,
  subagents: Record<string, Subagent>,
  runId: string,
  owner?: string,
) {
  const last = items.at(-1);
  // The assistant message a text item continues: same vendor id, or the partial one just before.
  const target = (messageId?: string) => {
    const i = messageId
      ? items.findLastIndex((x) => x.kind === "assistant" && x.messageId === messageId)
      : last?.kind === "assistant" && last.partial
        ? items.length - 1
        : -1;
    return i < 0 ? undefined : { i, item: items[i] as Extract<Item, { kind: "assistant" }> };
  };

  switch (item.kind) {
    case "sessionStarted": {
      const from = items.findLast((x) => x.kind === "session" && x.model);
      const to = item.model;
      // The same model with another context window, as Claude Code's `[1m]`, isn't a switch.
      const bare = (model: string) => model.replace(/\[.*\]$/, "");
      if (from?.kind === "session" && from.model && to && bare(from.model) !== bare(to)) {
        // Above the message sent with the new model, which Claude Code reports before its session.
        const at = last?.kind === "user" && last.turnId ? items.length - 1 : items.length;
        items.splice(at, 0, {
          kind: "modelSwitch",
          key: `${key}:switch`,
          from: from.model,
          to,
          at: time,
        });
      }
      items.push({ kind: "session", key, sessionId: item.sessionId, ...(to && { model: to }) });
      break;
    }
    case "turnStarted": {
      const attached = {
        ...(!!item.images?.length && { images: item.images }),
        ...(!!item.threads?.length && { threads: item.threads }),
      };
      if (item.turnId)
        items.push({
          kind: "user",
          key,
          text: item.text ?? null,
          turnId: item.turnId,
          ...(item.wake && { wake: true }),
          ...(item.from && { from: item.from }),
          ...attached,
        });
      else {
        // The run's first turn has no id; its prompt came with agent.started, and gets its images
        // and threads.
        const i = items.findIndex((x) => x.kind === "user" && !x.turnId);
        const prompt = items[i];
        if (prompt?.kind === "user" && (attached.images || attached.threads))
          items[i] = { ...prompt, ...attached };
      }
      break;
    }
    case "textDelta": {
      const found = target(item.messageId);
      if (found) items[found.i] = { ...found.item, text: found.item.text + item.text };
      else
        items.push({
          kind: "assistant",
          key,
          text: item.text,
          messageId: item.messageId,
          partial: true,
        });
      break;
    }
    case "text": {
      const found = target(item.messageId);
      const message = { kind: "assistant", text: item.text, messageId: item.messageId } as const;
      if (found) items[found.i] = { ...message, key: found.item.key, at: found.item.at };
      else items.push({ ...message, key });
      break;
    }
    case "reasoning":
      items.push({ kind: "reasoning", key, text: item.text });
      break;
    case "subagent": {
      const sub = subagents[item.callId] ?? { callId: item.callId, items: [] };
      const inner = [...sub.items];
      const before = inner.length;
      applyOutput(inner, item.item, key, time, subagents, runId, item.callId);
      for (let i = before; i < inner.length; i++) inner[i] = { ...inner[i]!, at: time };
      subagents[item.callId] = {
        ...(subagents[item.callId] ?? sub),
        items: inner,
        agentType: item.agentType ?? sub.agentType,
        model: item.model ?? sub.model,
      };
      break;
    }
    case "subagentFinished": {
      const sub = subagents[item.callId] ?? { callId: item.callId, items: [] };
      subagents[item.callId] = { ...sub, finished: { status: item.status, summary: item.summary } };
      break;
    }
    case "toolCall": {
      const { callId, name, input } = item;
      if (isSubagentTool(name) && isObject(input)) {
        const sub = subagents[callId];
        subagents[callId] = {
          callId,
          items: [],
          ...sub,
          ...(owner && { parent: owner }),
          description: isText(input["description"]),
          prompt: isText(input["prompt"]),
          agentType: sub?.agentType ?? isText(input["subagent_type"]),
          // The model asked for, such as `haiku`, until it writes something.
          model: sub?.model ?? isText(input["model"]),
          at: time,
        };
      }
      const runId = name?.startsWith(plxdTools)
        ? (input as { runId?: unknown } | null | undefined)?.runId
        : undefined;
      const subagent = typeof runId === "string" ? subagentTitle(items, runId) : undefined;
      items.push({ kind: "tool", key, callId, name, input, ...(subagent && { subagent }) });
      break;
    }
    case "toolResult": {
      const sub = subagents[item.callId];
      if (sub) subagents[item.callId] = { ...sub, call: item.status };
      const i = items.findLastIndex((x) => x.kind === "tool" && x.callId === item.callId);
      const result = {
        status: item.status,
        output: item.output,
        ...(!!item.images?.length && { images: item.images }),
      };
      if (i >= 0) items[i] = { ...(items[i] as Extract<Item, { kind: "tool" }>), ...result };
      else items.push({ kind: "tool", key, callId: item.callId, name: null, ...result });
      const page =
        i >= 0 && (items[i] as { name: string | null }).name === `${plxdTools}html_render`
          ? item.status === "ok" && htmlRenderRef(item.output)
          : undefined;
      if (page) items.push({ kind: "htmlRender", key: `${key}:page`, runId, ...page });
      const recorded =
        i >= 0 &&
        item.status === "ok" &&
        (items[i] as { name: string | null }).name === `${plxdTools}preview_recording_stop`
          ? recordingId(item.output)
          : undefined;
      if (recorded)
        items.push({ kind: "recording", key: `${key}:video`, runId, attachmentId: recorded });
      break;
    }
    case "todoList":
      items.push({ kind: "todo", key, items: item.items });
      break;
    case "notice":
      items.push({ kind: "notice", key, tone: "info", text: item.detail });
      break;
    case "contextCompaction": {
      // Its end takes the place of its start.
      const i = items.findLastIndex((x) => x.kind === "compaction");
      const started = items[i];
      if (item.done && started?.kind === "compaction" && !started.done)
        items[i] = { ...started, done: true, at: time };
      else items.push({ kind: "compaction", key, done: item.done });
      break;
    }
    case "warning":
      items.push({ kind: "notice", key, tone: "warning", text: item.detail });
      break;
    case "followUpDropped":
      items.push({
        kind: "notice",
        key,
        tone: "warning",
        text: "A message wasn't sent to the agent.",
        turnId: item.turnId,
      });
      break;
    case "interrupted":
      items.push({
        kind: "notice",
        key,
        tone: "info",
        text: "Stopped by another thread.",
        from: item.from,
      });
      break;
    case "turnFinished": {
      // The turn's final text, when it isn't already the last thing the agent said.
      const said = items.findLast((x) => x.kind === "assistant")?.text.trim();
      if (item.result?.trim() && item.result.trim() !== said)
        items.push({ kind: "assistant", key, text: item.result });
      break;
    }
    case "approvalRequested": {
      const { kind: _, ...request } = item;
      items.push({ kind: "approval", key, request });
      // Claude Code fills ExitPlanMode's request from the plan file the model wrote, and the call
      // itself may carry no plan. The call takes the request's, so its plan card shows it (0031).
      const plan = isObject(item.input) ? item.input["plan"] : undefined;
      const i = items.findLastIndex((x) => x.kind === "tool" && x.callId === item.callId);
      const call = items[i];
      if (
        item.toolName === "ExitPlanMode" &&
        typeof plan === "string" &&
        call?.kind === "tool" &&
        call.name === "ExitPlanMode" &&
        (call.input === undefined || isObject(call.input)) &&
        typeof call.input?.["plan"] !== "string"
      )
        items[i] = { ...call, input: { ...call.input, plan } };
      break;
    }
    case "approvalResolved": {
      const { kind: _, approvalId, ...resolution } = item;
      const i = items.findLastIndex(
        (x) => x.kind === "approval" && x.request.approvalId === approvalId,
      );
      const asked = items[i];
      if (asked?.kind === "approval")
        items[i] = { ...asked, resolved: { ...resolution, at: time } };
      break;
    }
    // usage isn't shown.
  }
}

/** Whether a JSON value is an object, not an array or null. */
export const isObject = (v?: JsonValue): v is Record<string, JsonValue> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** `input`'s `name` field, when it's a string. */
export const field = (input: JsonValue | undefined, name: string) => {
  const value = isObject(input) ? input[name] : undefined;
  return typeof value === "string" ? value : undefined;
};

/** The permission requests still waiting, oldest first. */
export const waitingApprovals = (items: readonly Item[]): Approval[] =>
  items.filter((i): i is Approval => i.kind === "approval" && !i.resolved);

/** By run id: a run's permission requests, kept while they wait (`trackApprovals`). */
export type ApprovalsByRun = Readonly<Record<string, Transcript>>;

/**
 * Applies a Project's events to each run's waiting permission requests: a request joins, and its
 * resolution or its run's next `agent.finished` takes it out, as `applyEvents` reads them. Repeats
 * are skipped by each run's `seq`, so pages of a run's log and the Project's subscription can
 * overlap.
 */
export function trackApprovals(
  byRun: ApprovalsByRun,
  events: readonly LoggedEvent[],
): ApprovalsByRun {
  let next = byRun;
  for (const logged of events) {
    const { event } = logged;
    let kept: Extract<ParallaxEvent, { kind: "agent.output" | "agent.finished" }>;
    if (event.kind === "agent.output") {
      const items = event.items.filter(
        (i) => i.kind === "approvalRequested" || i.kind === "approvalResolved",
      );
      if (items.length === 0) continue;
      kept = { ...event, items };
    } else if (event.kind === "agent.finished") kept = event;
    else continue;
    const t = applyEvents(
      next[kept.runId] ?? emptyTranscript,
      [{ ...logged, event: kept }],
      kept.runId,
    );
    next = { ...next, [kept.runId]: { seq: t.seq, items: waitingApprovals(t.items) } };
  }
  return next;
}

/** The prefix of a thread's plxd tools as Claude Code names them (0041), `mcp__plxd__thread_launch`. */
export const plxdTools = "mcp__plxd__";

/**
 * The first line of thread `runId`'s prompt, from the newest earlier plxd tool answer that
 * lists it: thread_launch's run, thread_wait's `thread`, or thread_list's `threads`, and in older
 * transcripts the 0019 tools' run, `run`, or `runs`.
 */
function subagentTitle(items: Item[], runId: string): string | undefined {
  type Summary = { runId?: unknown; prompt?: unknown };
  for (const x of items.toReversed()) {
    if (x.kind !== "tool" || !x.name?.startsWith(plxdTools) || !x.output?.includes(runId)) continue;
    try {
      type Answer = Summary & { run?: Summary; runs?: Summary[]; thread?: Summary };
      const answer = JSON.parse(x.output) as Answer & { threads?: Summary[] };
      const run = [
        answer,
        answer.run,
        answer.thread,
        ...(answer.runs ?? []),
        ...(answer.threads ?? []),
      ].find((r) => r?.runId === runId);
      if (typeof run?.prompt === "string") return run.prompt.trim().split("\n")[0];
    } catch {
      // Not JSON, or cut short: an older answer may still have it.
    }
  }
  return undefined;
}

/** A run of agent activity between its messages, collapsed to one row: thinking, tool calls, and checklists. */
export interface Work {
  kind: "work";
  key: string;
  items: Item[];
  /** Whether an `end` closed its turn, so it folds under "Worked for …" (PLX-326). */
  done?: boolean;
  /** When the work began, and when what followed it (the answer, or the end) did. */
  startedAt?: string;
  endedAt?: string;
}

/**
 * The rows of each turn an `end` row closes that fold into its work, as T3 Code shows a finished
 * turn (PLX-326): its messages before the last, its answered permission requests, and its context
 * compactions; and every row of those turns, `ended`. One CLI
 * process can run several turns, as follow-ups arrive, so its `end` closes them all. A turn still
 * going has no `end`, so its messages stream in place and its requests stay in view.
 */
function finishedTurnRows(rows: readonly { kind: string }[]): {
  folds: Set<number>;
  ended: Set<number>;
} {
  const folds = new Set<number>();
  // Every row of a turn an `end` closed.
  const ended = new Set<number>();
  let since = 0;
  // The current turn's messages and answered requests, and the earlier turns' that would fold.
  let turn: number[] = [];
  let closed: number[] = [];
  const close = () => {
    const answer = turn.findLast((j) => rows[j]!.kind === "assistant");
    closed.push(...turn.filter((j) => j !== answer));
    turn = [];
  };
  rows.forEach((row, i) => {
    if (row.kind === "user" || row.kind === "pending") close();
    else if (
      row.kind === "assistant" ||
      (row.kind === "approval" && (row as Approval).resolved) ||
      (row.kind === "compaction" && (row as Extract<Item, { kind: "compaction" }>).done)
    )
      turn.push(i);
    else if (row.kind === "end") {
      close();
      for (const j of closed) folds.add(j);
      closed = [];
      for (let j = since; j < i; j++) ended.add(j);
      since = i + 1;
    }
  });
  return { folds, ended };
}

/**
 * Folds each run of thinking, tool calls, and checklists into one `Work` row. While a turn goes,
 * the agent's messages split runs and pass through, so they stay in order and stream in place;
 * once it ends, all but its last fold too (`finishedTurnRows`). A dropped follow-up's notice,
 * another thread's stop, and other rows (user, end, and whatever the caller adds) pass through. Other notices fold, except
 * those after a run's last activity. A run in an ended turn is `done`.
 */
export function groupWork<R extends { kind: string; at?: string }>(
  rows: readonly (Item | R)[],
): (Item | R | Work)[] {
  const { folds, ended } = finishedTurnRows(rows);
  const out: (Item | R | Work)[] = [];
  let run: Item[] = [];
  // Whether the run's first row is in a turn an `end` closed.
  let done = false;
  const flush = (next?: { kind: string; at?: string }) => {
    const last = run.findLastIndex((i) => i.kind !== "notice");
    if (last >= 0) {
      const items = run.slice(0, last + 1);
      out.push({
        kind: "work",
        key: `work:${items[0]!.key}`,
        items,
        ...(done && { done }),
        startedAt: items[0]!.at,
        // A later follow-up's time would count the wait between turns as work.
        endedAt:
          (run[last + 1] ?? (next?.kind === "assistant" || next?.kind === "end" ? next : undefined))
            ?.at ?? items[last]!.at,
      });
    }
    out.push(...run.slice(last + 1));
    run = [];
  };
  for (const [i, row] of rows.entries()) {
    if (
      folds.has(i) ||
      ["reasoning", "tool", "todo"].includes(row.kind) ||
      (row.kind === "notice" && !(row as Item & { turnId?: string }).turnId && !("from" in row))
    ) {
      if (run.length === 0) done = ended.has(i);
      run.push(row as Item);
    } else {
      flush(row);
      out.push(row);
    }
  }
  flush();
  return out;
}

/** "Worked for 1m 29s", or "Worked briefly" when the times are missing or under a second. */
export function workedFor(startedAt?: string, endedAt?: string): string {
  const s = Math.round((Date.parse(endedAt ?? "") - Date.parse(startedAt ?? "")) / 1000);
  if (!(s >= 1)) return "Worked briefly";
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  const parts = h ? [`${h}h`, `${m}m`] : m ? [`${m}m`, `${s % 60}s`] : [`${s}s`];
  return `Worked for ${parts.join(" ")}`;
}

/** An account for people: a subscription is named by its backend, a key account by its id. */
export function accountLabel(accountId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(accountId)) return "API key";
  return `${accountId.charAt(0).toUpperCase()}${accountId.slice(1)} subscription`;
}

const failures: Record<AgentFailureKind, string> = {
  notSignedIn: "not signed in",
  rateLimited: "rate limited",
  policyViolation: "stopped by Parallax's safety check",
  unexpectedApiKey: "found an unexpected API key",
  vendorError: "the provider returned an error",
  crashed: "the CLI crashed",
  spawnFailed: "the CLI didn't start",
  commitFailed: "Parallax couldn't commit its changes",
  internal: "something went wrong in plxd",
};

/** Why a run failed or moved accounts, for people. */
export const failureText = (kind: AgentFailureKind) =>
  (failures as Partial<Record<string, string>>)[kind] ?? "something went wrong";

const statuses: Record<AgentStatus, string> = {
  starting: "Starting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  waiting: "Waiting",
  accepted: "Accepted",
};

/** A run's status for people. A status newer than this app is "Unknown". */
export const statusLabel = (status: AgentStatus) =>
  (statuses as Partial<Record<string, string>>)[status] ?? "Unknown";

/** Whether the run's CLI is live, so Stop applies. */
export const isRunning = (status?: AgentStatus) => status === "starting" || status === "running";
