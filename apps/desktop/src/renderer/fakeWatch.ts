// For tests only: a fake bridge's `watch`, served from its own `request` and `subscribe`, as plxd
// builds its snapshots from the same lists and logs (0059): `thread/list`, `agent/list`, and
// `project/list` for the shell, with the permission requests in running runs' logs, and a run's
// `agent/events` and `queue/list` for a thread. Then the fake's events follow.
import type {
  ParallaxBridge,
  RpcError,
  SubscriptionMessage,
  WatchMessage,
  WatchParams,
} from "../preload/bridge";
import type {
  AgentRun,
  LoggedEvent,
  QueuedMessage,
  ShellSnapshot,
  ThreadRun,
  ThreadSnapshot,
} from "../protocol/generated/protocol";
import { updateRun } from "./transcript";

type Fake = Pick<ParallaxBridge, "request" | "subscribe">;
// The fakes answer whatever they're asked loosely; this reads their answers as plxd's.
type Call = (
  host: string,
  method: string,
  params: object,
) => Promise<{ result?: unknown; error?: RpcError }>;

/** `watch` for the fake bridge `bridge` returns when it runs. */
export function fakeWatch(bridge: () => Fake) {
  return (host: string, params: WatchParams, listen: (message: never) => void) => {
    const listener = listen as (message: WatchMessage) => void;
    let stopped = false;
    let unsubscribe = () => {};
    void (async () => {
      const { request, subscribe } = bridge();
      const call = request as unknown as Call;
      const snapshot =
        "threadId" in params ? await thread(call, host, params.threadId) : await shell(call, host);
      if (stopped) return;
      if ("code" in snapshot) return listener({ type: "error", error: snapshot });
      listener({ type: "snapshot", snapshot });
      const follow = (message: SubscriptionMessage) => {
        if (!stopped && message.type !== "resync") listener(message);
      };
      unsubscribe = subscribe(host, { after: snapshot.seq, logId: "log-1" }, follow);
    })();
    return () => {
      stopped = true;
      unsubscribe();
    };
  };
}

async function shell(call: Call, host: string): Promise<ShellSnapshot | RpcError> {
  const answers = await Promise.all(
    ["thread/list", "agent/list", "project/list"].map((method) => call(host, method, {})),
  );
  const failed = answers.find((a) => a.error)?.error;
  if (failed) return failed;
  const [list, listed, projects] = answers.map((a) => a.result) as [
    Pick<ShellSnapshot, "repos" | "threads"> & { seq: number },
    { runs: AgentRun[]; seq: number },
    { projects: ShellSnapshot["projects"]; seq?: number },
  ];
  const requests: LoggedEvent[] = [];
  for (const run of listed.runs.filter((r) => r.approvals && isOpen(r.status))) {
    const logged = await events(call, host, run.id);
    if (Array.isArray(logged)) requests.push(...logged);
  }
  return {
    seq: Math.max(list.seq, listed.seq, projects.seq ?? 0),
    projects: projects.projects,
    repos: list.repos,
    threads: list.threads,
    runs: listed.runs,
    requests,
  };
}

async function thread(
  call: Call,
  host: string,
  threadId: string,
): Promise<ThreadSnapshot | RpcError> {
  const logged = await events(call, host, threadId);
  if (!Array.isArray(logged)) return logged;
  const listed = (await call(host, "agent/list", {})).result as
    | { runs?: AgentRun[]; seq?: number }
    | undefined;
  // The run as its row stands after its events, as plxd reads it for a snapshot.
  const run = logged.reduce<AgentRun | undefined>(
    (run, e) => updateRun(run, e.event),
    listed?.runs?.find((r) => r.id === threadId),
  );
  if (!run) return { code: -32000, message: "This agent run hasn't started." };
  const queued = (await call(host, "queue/list", { runId: threadId })).result as
    | { messages?: QueuedMessage[] }
    | undefined;
  const runs = (queued?.messages ?? []).map((m, position): ThreadRun => ({
    ...m,
    status: "queued",
    position,
  }));
  return {
    seq: Math.max(logged.at(-1)?.seq ?? 0, listed?.seq ?? 0),
    thread: run,
    runs,
    events: logged,
    more: false,
    requests: [],
  };
}

/** Every event of run `runId`'s log, page by page, or the error a page failed with. */
async function events(call: Call, host: string, runId: string): Promise<LoggedEvent[] | RpcError> {
  const all: LoggedEvent[] = [];
  for (let after = 0, more = true; more;) {
    const answer = await call(host, "agent/events", { runId, after });
    if (answer.error) return answer.error;
    const page = answer.result as { events?: LoggedEvent[]; more?: boolean } | undefined;
    if (!page?.events) break;
    all.push(...page.events);
    after = page.events.at(-1)?.seq ?? after;
    more = !!page.more && page.events.length > 0;
  }
  return all;
}

const isOpen = (status: string) => ["starting", "running", "waiting"].includes(status);
