// One agent run's transcript, rebuilt from its logged events. Pure, so it is
// tested without React; useAgentRun feeds it pages of `agent/events` and live
// events alike.
import type {
  AgentFailureKind,
  AgentOutcome,
  AgentOutputItem,
  AgentRun,
  AgentStatus,
  AgentTodoItem,
  AgentToolStatus,
  JsonValue,
  LoggedEvent,
} from "../protocol/generated/protocol";

/** One row of the transcript. `key` is stable across re-renders; `at` is when it began. */
export type Item = ItemBody & { at?: string };

type ItemBody =
  /** `text` is null for a follow-up logged by a wispd from before it recorded the text. */
  | { kind: "user"; key: string; text: string | null; turnId?: string }
  /** `partial` while it is still arriving as `textDelta`s. */
  | { kind: "assistant"; key: string; text: string; messageId?: string; partial?: boolean }
  | { kind: "reasoning"; key: string; text: string }
  /** `status` is absent until its result arrives; `name` is null for a result with no call. */
  | {
      kind: "tool";
      key: string;
      callId: string;
      name: string | null;
      input?: JsonValue;
      status?: AgentToolStatus;
      output?: string;
    }
  | { kind: "todo"; key: string; items: AgentTodoItem[] }
  /** `turnId` marks a follow-up that never reached the agent. */
  | { kind: "notice"; key: string; tone: "info" | "warning"; text: string; turnId?: string }
  /** How one CLI process of the run ended. */
  | { kind: "end"; key: string; outcome: AgentOutcome };

export interface Transcript {
  /** Absent until `agent.started` is in. */
  run?: AgentRun;
  items: Item[];
  /** The last `seq` applied. Anything at or below it is a repeat. */
  seq: number;
}

export const emptyTranscript: Transcript = { items: [], seq: 0 };

/**
 * Applies events, in `seq` order, for one run. Repeats and other runs' events are
 * skipped, and kinds this version doesn't know still count their `seq`.
 */
export function applyEvents(t: Transcript, events: LoggedEvent[], runId: string): Transcript {
  let { run, seq } = t;
  const items = [...t.items];
  const push = (item: Item) => items.push(item);

  for (const { seq: at, time, event } of events) {
    if (at <= seq) continue;
    seq = at;
    if (!("runId" in event) || event.runId !== runId) continue;
    const key = (i: number | string = 0) => `${at}:${i}`;
    const before = items.length;

    switch (event.kind) {
      case "agent.started":
        run = event.run;
        if (run) push({ kind: "user", key: key(), text: run.prompt });
        break;
      case "agent.updated":
        // `error` is absent once the run goes again; the rest only ever arrives.
        if (run) run = { ...run, ...event.state, error: event.state.error };
        break;
      case "agent.accountFallback":
        if (run) run = { ...run, accountId: event.toAccount };
        push({
          kind: "notice",
          key: key(),
          tone: "info",
          text: `Switched from ${accountLabel(event.fromAccount)} to ${accountLabel(event.toAccount)}: ${failureText(event.reason)}.`,
        });
        break;
      case "agent.finished":
        push({ kind: "end", key: key(), outcome: event.outcome });
        break;
      case "agent.output":
        event.items.forEach((item, i) => applyOutput(items, item, key(i)));
        break;
    }
    for (let i = before; i < items.length; i++) items[i] = { ...items[i]!, at: time };
  }
  return { run, items, seq };
}

// ponytail: copies the item list per event and scans back for matches; fine for
// thousands of items, since wispd coalesces output every 50 ms.
function applyOutput(items: Item[], item: AgentOutputItem, key: string) {
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
    case "turnStarted":
      // The run's first turn has no id; its prompt came with agent.started.
      if (item.turnId)
        items.push({ kind: "user", key, text: item.text ?? null, turnId: item.turnId });
      break;
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
    case "toolCall":
      items.push({ kind: "tool", key, callId: item.callId, name: item.name, input: item.input });
      break;
    case "toolResult": {
      const i = items.findLastIndex((x) => x.kind === "tool" && x.callId === item.callId);
      const result = { status: item.status, output: item.output };
      if (i >= 0) items[i] = { ...(items[i] as Extract<Item, { kind: "tool" }>), ...result };
      else items.push({ kind: "tool", key, callId: item.callId, name: null, ...result });
      break;
    }
    case "todoList":
      items.push({ kind: "todo", key, items: item.items });
      break;
    case "notice":
      items.push({ kind: "notice", key, tone: "info", text: item.detail });
      break;
    case "warning":
      items.push({ kind: "notice", key, tone: "warning", text: item.detail });
      break;
    case "followUpDropped":
      items.push({
        kind: "notice",
        key,
        tone: "warning",
        text: "A message didn't reach the agent because it stopped first.",
        turnId: item.turnId,
      });
      break;
    case "turnFinished": {
      // The turn's final text, when it isn't already the last thing the agent said.
      const said = items.findLast((x) => x.kind === "assistant")?.text.trim();
      if (item.result?.trim() && item.result.trim() !== said)
        items.push({ kind: "assistant", key, text: item.result });
      break;
    }
    // sessionStarted and usage aren't shown.
  }
}

/** A turn's agent activity, collapsed to one row: thinking, tool calls, checklists, and narration. */
export interface Work {
  kind: "work";
  key: string;
  items: Item[];
  /** When the work began, and when what followed it (the answer, or the end) did. */
  startedAt?: string;
  endedAt?: string;
}

/**
 * Folds each run of agent activity into one `Work` row. The agent's closing messages, after its
 * last tool call or thought, stay out as the turn's answer, and so do notices after it. A notice
 * for a dropped follow-up, and other rows (user, end, and whatever the caller adds), split runs
 * and pass through.
 */
export function groupWork<R extends { kind: string; at?: string }>(
  rows: readonly (Item | R)[],
): (Item | R | Work)[] {
  const out: (Item | R | Work)[] = [];
  let run: Item[] = [];
  const flush = (next?: { kind: string; at?: string }) => {
    const last = run.findLastIndex((i) => i.kind !== "assistant" && i.kind !== "notice");
    if (last >= 0) {
      const items = run.slice(0, last + 1);
      out.push({
        kind: "work",
        key: `work:${items[0]!.key}`,
        items,
        startedAt: items[0]!.at,
        // A later follow-up's time would count the wait between turns as work.
        endedAt:
          (run[last + 1] ?? (next?.kind === "end" ? next : undefined))?.at ?? items[last]!.at,
      });
    }
    out.push(...run.slice(last + 1));
    run = [];
  };
  for (const row of rows) {
    if (
      ["assistant", "reasoning", "tool", "todo"].includes(row.kind) ||
      (row.kind === "notice" && !(row as Item & { turnId?: string }).turnId)
    )
      run.push(row as Item);
    else {
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
  policyViolation: "blocked by its sandbox",
  unexpectedApiKey: "found an unexpected API key",
  vendorError: "the provider returned an error",
  crashed: "the CLI crashed",
  spawnFailed: "the CLI didn't start",
  commitFailed: "wisp couldn't commit its changes",
  internal: "something went wrong in wispd",
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
  accepted: "Accepted",
};

/** A run's status for people. A status newer than this app is "Unknown". */
export const statusLabel = (status: AgentStatus) =>
  (statuses as Partial<Record<string, string>>)[status] ?? "Unknown";

/** Whether the run's CLI is live, so Stop applies. */
export const isRunning = (status?: AgentStatus) => status === "starting" || status === "running";
