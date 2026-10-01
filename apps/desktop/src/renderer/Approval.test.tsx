// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, WispBridge } from "../preload/bridge";
import type {
  AgentOutputItem,
  AgentRun,
  LoggedEvent,
  WispEvent,
} from "../protocol/generated/protocol";
import { AgentChat, describeTool, RowView } from "./AgentChat";
import {
  ApprovalQueue,
  clock,
  diffLines,
  outcomeOf,
  queueOf,
  withAnswers,
  type AnswerState,
  type Asked,
} from "./Approval";
import type { Approval, ApprovalRequest, ApprovalResolution, Item } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom lays nothing out: a tall transcript and short rows, so the virtualized list renders all.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
  },
});

const runId = "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01";
const run: AgentRun = {
  id: runId,
  project: "r-wisp",
  prompt: "Fix the flaky test",
  policy: "workspaceWrite",
  status: "running",
  backend: "claude",
  accountId: "claude",
  permission: "manual",
  approvals: true,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
};

// --- A bridge serving one run's log, which `emit` adds to live. ---
let log: LoggedEvent[];
let approve: (
  params: Record<string, unknown>,
) => RpcResponse<unknown> | Promise<RpcResponse<unknown>>;
let listener: (message: SubscriptionMessage) => void;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const seq = log.at(-1)?.seq ?? 0;
  if (method === "agent/list") return { result: { runs: [], seq }, logId: "log-1" };
  if (method === "agent/events") {
    const events = log.filter((e) => e.seq > Number(params["after"]));
    return { result: { events, more: false }, logId: "log-1" };
  }
  if (method === "agent/approve") return { logId: "log-1", ...(await approve(params)) };
  return { result: {}, logId: "log-1" };
});
const append = (event: WispEvent) => {
  const seq = (log.at(-1)?.seq ?? 0) + 1;
  const logged = { seq, time: `2026-10-01T12:00:${String(seq).padStart(2, "0")}Z`, event };
  log.push(logged);
  return logged;
};
const output = (...items: AgentOutputItem[]) => append({ kind: "agent.output", runId, items });
const emit = (...items: AgentOutputItem[]) =>
  act(async () => listener({ type: "event", event: { subscription: "s", ...output(...items) } }));
const emitEvent = (event: WispEvent) =>
  act(async () => listener({ type: "event", event: { subscription: "s", ...append(event) } }));

const asked = (approvalId: string, more: Partial<ApprovalRequest> = {}): AgentOutputItem => ({
  kind: "approvalRequested",
  approvalId,
  toolName: "Bash",
  input: { command: "pnpm test", description: "Run the tests" },
  callId: `toolu_${approvalId}`,
  expiresAt: "2026-10-01T12:30:00Z",
  ...more,
});
const resolved = (
  approvalId: string,
  resolution: Omit<ApprovalResolution, "at">,
): AgentOutputItem => ({ kind: "approvalResolved", approvalId, ...resolution }) as AgentOutputItem;
const plan = "## Plan\n\n1. Keep the sidebar's list while a host reconnects\n2. Run the tests";

beforeEach(() => {
  request.mockClear();
  log = [];
  append({ kind: "agent.started", runId, run });
  approve = (p) => ({
    result:
      p["decision"] === "allow"
        ? { decision: "allowed", by: "user", ...(p["always"] ? { always: true } : {}) }
        : { decision: "denied", by: "user", ...(p["message"] ? { message: p["message"] } : {}) },
  });
  window.wisp = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      wispd: "0.1.0",
      protocol: 1,
      capabilities: { approvals: {} },
    }),
    onConnectionState: () => () => {},
    request,
    subscribe: (_host, _params, l) => {
      listener = l;
      return () => {};
    },
  } as Partial<WispBridge> as WispBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
    unmount = () => {};
  };
  return (next: ReactNode) => act(() => root.render(next));
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => {});
};
async function renderChat() {
  render(<AgentChat hostId="local" runId={runId} />);
  await settle();
}

const pinned = () => document.querySelector('section[aria-label="Approval requests"]');
const card = () => pinned()?.querySelector('[role="group"]');
const buttons = () => [...(pinned()?.querySelectorAll("button") ?? [])];
const inCard = (name: string) => buttons().find((b) => b.textContent === name);
const click = async (element: Element | undefined | null) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const transcript = () => document.querySelector('[role="log"]')!;
// The transcript's permission lines, as they show.
const lines = () =>
  [...transcript().querySelectorAll("summary")]
    .map((s) => s.textContent ?? "")
    .filter((t) => /approv|allowed|Denied|Timed out|Withdrawn|No longer|Kept planning/i.test(t));
const approveCalls = () =>
  request.mock.calls.filter(([, m]) => m === "agent/approve").map(([, , params]) => params);
const typeNote = (text: string) =>
  act(() => {
    const box = pinned()!.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submitNote = () => act(async () => pinned()!.querySelector("form")!.requestSubmit());

test("a waiting request is pinned over the composer, outside the transcript, with Approve in the accent", async () => {
  output(
    { kind: "toolCall", callId: "toolu_a1", name: "Bash", input: { command: "pnpm test" } },
    asked("a1", { alwaysAllow: ["Bash(pnpm test:*)"] }),
  );
  await renderChat();
  expect(pinned()).not.toBeNull();
  expect(transcript().contains(pinned())).toBe(false);
  // Before the composer, so it can't scroll away.
  const composer = document.querySelector('[role="textbox"][aria-label="Message"]')!;
  expect(
    pinned()!.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const title = document.getElementById(card()!.getAttribute("aria-labelledby")!)!;
  expect(title.textContent).toBe("BashRun the tests");
  expect(card()!.querySelector("svg.lucide-square-terminal")).not.toBeNull();
  expect(card()!.querySelector("pre")!.textContent).toBe("pnpm test");
  expect(pinned()!.textContent).toContain("Always allow adds Bash(pnpm test:*)");
  expect(document.getElementById(card()!.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Needs approval",
  );
  expect(buttons().map((b) => b.textContent)).toEqual(["Deny", "Always allow", "Approve"]);
  expect(inCard("Approve")!.className).toContain("bg-send");
  expect(inCard("Deny")!.className).not.toContain("bg-send");
  expect(inCard("Always allow")!.getAttribute("aria-describedby")).toBeTruthy();
  // Its place in the transcript, until it's answered.
  expect(lines()).toEqual([expect.stringMatching(/^Waiting for approvalBash: pnpm test/)]);
});

test("Approve answers with agent/approve, shows the answer on its way, then collapses to a line", async () => {
  output(asked("a1"));
  let release: (answer: RpcResponse<unknown>) => void = () => {};
  approve = () => new Promise((resolve) => (release = resolve));
  await renderChat();
  await click(inCard("Approve"));
  expect(approveCalls()).toEqual([{ runId, approvalId: "a1", decision: "allow" }]);
  expect(inCard("Approving…")).toBeDefined();
  expect(buttons().every((b) => b.disabled)).toBe(true);
  expect(document.getElementById(card()!.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Approving…",
  );

  await act(async () => release({ result: { decision: "allowed", by: "user" } }));
  await settle();
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^ApprovedBash: pnpm test/)]);
  // wispd's resolution confirms it.
  await emit(resolved("a1", { decision: "allowed", by: "user" }));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^ApprovedBash: pnpm test/)]);
  const time = transcript().querySelector("summary time")!;
  expect(time.getAttribute("dateTime")).toMatch(/^2026-10-01T12:00:03Z$/);
});

test("a request that ends while its answer is on the way leaves, and the answer's reply changes nothing", async () => {
  output(asked("a1"));
  let release: (answer: RpcResponse<unknown>) => void = () => {};
  approve = () => new Promise((resolve) => (release = resolve));
  await renderChat();
  await click(inCard("Approve"));
  expect(inCard("Approving…")).toBeDefined();
  // It timed out just before the answer reached wispd.
  await emit(resolved("a1", { decision: "expired", by: "timeout" }));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Timed outBash/)]);
  // wispd's reply is how it ended, as `agent/approve` is idempotent.
  await act(async () => release({ result: { decision: "expired", by: "timeout" } }));
  await settle();
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Timed outBash/)]);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test("Always allow shows only when the request offers rules, and sends always", async () => {
  output(asked("a1", { alwaysAllow: [] }));
  await renderChat();
  expect(buttons().map((b) => b.textContent)).toEqual(["Deny", "Approve"]);
  expect(pinned()!.textContent).not.toContain("Always allow adds");
  await emit(asked("a2", { alwaysAllow: ["Bash(pnpm test:*)"] }));
  await click(inCard("Approve"));
  expect(buttons().map((b) => b.textContent)).toEqual(["Deny", "Always allow", "Approve"]);
  await click(inCard("Always allow"));
  expect(approveCalls()).toEqual([
    { runId, approvalId: "a1", decision: "allow" },
    { runId, approvalId: "a2", decision: "allow", always: true },
  ]);
  expect(lines()).toEqual([
    expect.stringMatching(/^Approved/),
    expect.stringMatching(/^Always allowedBash: pnpm test/),
  ]);
});

test("Always allow names every rule it adds in full, however many or long", async () => {
  const long = `Bash(${"node scripts/check-every-package-and-workspace.mjs --all ".repeat(6).trim()}:*)`;
  const rules = ["Bash(pnpm test:*)", "Bash(pnpm lint:*)", long];
  output(asked("a1", { alwaysAllow: rules }));
  await renderChat();
  const named = document.getElementById(inCard("Always allow")!.getAttribute("aria-describedby")!)!;
  expect([...named.querySelectorAll("code")].map((c) => c.textContent)).toEqual(rules);
  expect(named.textContent).toBe(`Always allow adds ${rules.join(", ")}`);
  // Wrapped, never cut off.
  for (const el of [named, ...named.querySelectorAll("code")])
    expect(el.className).not.toMatch(/truncate|line-clamp|overflow-hidden/);
});

test("Deny asks for an optional note, which goes as the message; Escape goes back to Deny", async () => {
  output(asked("a1"), asked("a2"));
  await renderChat();
  await click(inCard("Deny"));
  const note = pinned()!.querySelector("input")!;
  expect(note.getAttribute("aria-label")).toBe("Note to the agent");
  expect(document.activeElement).toBe(note);
  expect(buttons().map((b) => b.textContent)).toEqual(["Cancel", "Deny"]);
  await act(async () => {
    note.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(pinned()!.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(inCard("Deny"));

  // With a note, then with none.
  await click(inCard("Deny"));
  typeNote("Use the CI logs instead.");
  await submitNote();
  await settle();
  await click(inCard("Deny"));
  await submitNote();
  await settle();
  expect(approveCalls()).toEqual([
    { runId, approvalId: "a1", decision: "deny", message: "Use the CI logs instead." },
    { runId, approvalId: "a2", decision: "deny" },
  ]);
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([
    expect.stringMatching(/^DeniedBash: pnpm test/),
    expect.stringMatching(/^DeniedBash: pnpm test/),
  ]);
  // Its line opens to who decided, and the note.
  const details = transcript().querySelector("details")!;
  expect(details.textContent).toContain("Denied by you at");
  expect(details.textContent).toContain("Your note: Use the CI logs instead.");
});

test("an answer that fails says why, and can be sent again", async () => {
  output(asked("a1"));
  approve = () => ({ error: { code: -32000, message: "wispd is busy" } });
  await renderChat();
  await click(inCard("Approve"));
  expect(pinned()!.querySelector('[role="alert"]')!.textContent).toBe(
    "Your answer didn't reach the agent: wispd is busy",
  );
  expect(buttons().every((b) => !b.disabled)).toBe(true);

  approve = () => ({ result: { decision: "allowed", by: "user" } });
  await click(inCard("Approve"));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Approved/)]);
});

test("approvalNotFound reads as no longer waiting, not as a failure, and Dismiss puts it away", async () => {
  output(asked("a1"));
  approve = () => ({
    error: { code: -32000, message: "no request a1", data: { kind: "approvalNotFound" } },
  });
  await renderChat();
  await click(inCard("Approve"));
  expect(pinned()!.querySelector('[role="alert"]')).toBeNull();
  expect(pinned()!.textContent).toContain(
    "This request is no longer waiting. It timed out or was withdrawn before your answer reached it.",
  );
  expect(document.getElementById(card()!.getAttribute("aria-describedby")!)!.textContent).toBe(
    "No longer waiting",
  );
  expect(buttons().map((b) => b.textContent)).toEqual(["Dismiss"]);
  await click(inCard("Dismiss"));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^No longer waitingBash: pnpm test/)]);
});

test("a request that times out, is withdrawn, is stopped, or outlives its run leaves the queue, and its line says so", async () => {
  output(asked("a1"), asked("a2"), asked("a3"), asked("a4"));
  await renderChat();
  expect(card()!.textContent).toContain("Needs approval · 1 of 4");
  await emit(resolved("a1", { decision: "expired", by: "timeout" }));
  await emit(resolved("a2", { decision: "withdrawn", by: "agent" }));
  await emit(resolved("a3", { decision: "denied", by: "cancel" }));
  expect(card()!.textContent).toContain("Needs approval");
  await emitEvent({ kind: "agent.finished", runId, outcome: { status: "interrupted" } });
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([
    expect.stringMatching(/^Timed outBash/),
    expect.stringMatching(/^WithdrawnBash/),
    expect.stringMatching(/^DeniedBash/),
    expect.stringMatching(/^WithdrawnBash/),
  ]);
  const details = [...transcript().querySelectorAll("details")].map((d) => d.textContent);
  expect(details[0]).toContain("Nobody answered in time, so wispd denied it");
  expect(details[2]).toContain("Denied when the run was stopped");
  expect(details[3]).toContain("The run ended before anyone answered");
});

test("several requests queue oldest first, and the next takes the card's place once it's answered", async () => {
  output(asked("a1"));
  output(asked("a2", { toolName: "WebFetch", input: { url: "https://example.com/docs" } }));
  await renderChat();
  expect(card()!.textContent).toContain("Bash");
  expect(card()!.textContent).toContain("Needs approval · 1 of 2");
  await click(inCard("Approve"));
  expect(card()!.textContent).toContain("WebFetch");
  expect(card()!.textContent).toContain("https://example.com/docs");
  expect(card()!.textContent).not.toContain("1 of");
});

test("ExitPlanMode in a thread: the proposed plan is pinned, Approve plan allows it as asked, and the plan returns to the transcript", async () => {
  output(
    { kind: "toolCall", callId: "toolu_p1", name: "ExitPlanMode", input: {} },
    asked("p1", {
      toolName: "ExitPlanMode",
      input: { plan, planFilePath: "/home/me/.claude/plans/reconnect.md" },
      callId: "toolu_p1",
      interactive: true,
    }),
  );
  await renderChat();
  expect(pinned()!.textContent).toContain("Proposed plan");
  expect(pinned()!.querySelector("h2")!.textContent).toBe("Plan");
  expect(pinned()!.textContent).toContain("Keep the sidebar's list while a host reconnects");
  expect(buttons().map((b) => b.textContent)).toEqual(["Keep planning", "Approve plan"]);
  // The transcript doesn't show it twice while it waits.
  expect(transcript().textContent).not.toContain("Proposed plan");
  expect(lines()).toEqual([expect.stringMatching(/^Plan waiting for approval/)]);

  await click(inCard("Approve plan"));
  // As asked: no edited input, so its planFilePath never changes (0031).
  expect(approveCalls()).toEqual([{ runId, approvalId: "p1", decision: "allow" }]);
  expect(pinned()).toBeNull();
  expect(transcript().textContent).toContain("Proposed plan");
  expect(transcript().textContent).toContain("Keep the sidebar's list while a host reconnects");
  expect(lines()).toEqual([expect.stringMatching(/^Approved the plan/)]);
});

test("Keep planning sends what should change, and the plan reads as not approved", async () => {
  output(
    { kind: "toolCall", callId: "toolu_p1", name: "ExitPlanMode", input: { plan } },
    asked("p1", {
      toolName: "ExitPlanMode",
      input: { plan },
      callId: "toolu_p1",
      interactive: true,
    }),
  );
  await renderChat();
  await click(inCard("Keep planning"));
  expect(pinned()!.querySelector("input")!.getAttribute("aria-label")).toBe("What should change");
  typeNote("Cover the backoff too.");
  await submitNote();
  await settle();
  expect(approveCalls()).toEqual([
    { runId, approvalId: "p1", decision: "deny", message: "Cover the backoff too." },
  ]);
  // However the call ended, the user sent it back.
  await emit({
    kind: "toolResult",
    callId: "toolu_p1",
    status: "error",
    output: "Cover the backoff too.",
  });
  expect(transcript().textContent).toContain("Proposed planNot approved");
  expect(lines()).toEqual([expect.stringMatching(/^Kept planning/)]);
});

test("an ExitPlanMode request without a plan says so, and is answered all the same", async () => {
  output(
    { kind: "toolCall", callId: "toolu_p1", name: "ExitPlanMode", input: {} },
    asked("p1", {
      toolName: "ExitPlanMode",
      input: { planFilePath: "/home/me/.claude/plans/reconnect.md" },
      callId: "toolu_p1",
      interactive: true,
    }),
  );
  await renderChat();
  expect(pinned()!.textContent).toContain(
    "The plan didn't come with the request. The agent's messages above may have it.",
  );
  await click(inCard("Approve plan"));
  expect(approveCalls()).toEqual([{ runId, approvalId: "p1", decision: "allow" }]);
  expect(lines()).toEqual([expect.stringMatching(/^Approved the plan/)]);
});

test("a request says why the CLI asks, the path that made it, and when the agent's own subagent asks", async () => {
  output(
    asked("a1", {
      toolName: "Write",
      input: { file_path: "/repo/.git/hooks/pre-commit", content: "#!/bin/sh\nexit 0" },
      reason: "Writes to a git hook",
      blockedPath: "/repo/.git/hooks/pre-commit",
      subagent: "agent-7",
    }),
  );
  await renderChat();
  const text = pinned()!.textContent;
  expect(text).toContain("Writes to a git hook");
  expect(text).toContain("Path: /repo/.git/hooks/pre-commit");
  expect(text).toContain("Asked by one of the agent's own subagents.");
});

test("after a reload, an answered request is a line, never a card", async () => {
  output(asked("a1"));
  output(resolved("a1", { decision: "allowed", by: "user", always: true }));
  await renderChat();
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Always allowedBash: pnpm test/)]);
});

test("while a request waits, no loader muses under it; once answered, the work goes on", async () => {
  output(asked("a1"));
  await renderChat();
  expect(transcript().querySelector(".loader")).toBeNull();
  await click(inCard("Approve"));
  expect(transcript().querySelector(".loader")).not.toBeNull();
});

test("an open chat's Manual says its requests are denied when its run started without approvals", async () => {
  const manual = () =>
    [
      ...document.querySelectorAll('[role="menu"][aria-label="Access"] [role="menuitemradio"]'),
    ].find((o) => o.textContent?.startsWith("Manual"))!.textContent;
  await renderChat();
  expect(manual()).toBe("ManualAsks you before edits and commands.");
  act(() => unmount());
  log = [];
  append({ kind: "agent.started", runId, run: { ...run, approvals: undefined } });
  await renderChat();
  expect(manual()).toBe(
    "ManualAsks before edits and commands. This chat started before wisp could show those requests, so they're denied.",
  );
});

test("a long preview scrolls inside its bound, with the header, a problem, and the buttons outside it", async () => {
  const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  output(asked("a1", { toolName: "Write", input: { file_path: "/repo/notes.txt", content } }));
  approve = () => ({ error: { code: -32000, message: "wispd is busy" } });
  await renderChat();
  const bounded = card()!.querySelector<HTMLElement>('[style*="max-height"]')!;
  expect(bounded.style.maxHeight).toBe("45vh");
  expect(bounded.className).toContain("overflow-y-auto");
  expect(bounded.querySelector('[aria-label^="Diff"]')).not.toBeNull();
  // Show all keeps the whole file inside it.
  await click(
    [...bounded.querySelectorAll("button")].find((b) => b.textContent === "Show all 300 lines"),
  );
  expect(bounded.querySelector('[aria-label^="Diff"]')!.children).toHaveLength(300);
  await click(inCard("Approve"));
  const title = document.getElementById(card()!.getAttribute("aria-labelledby")!)!;
  for (const outside of [title, pinned()!.querySelector('[role="alert"]')!, inCard("Approve")!])
    expect(bounded.contains(outside)).toBe(false);
});

test("a pinned plan opened in full scrolls inside the same bound", async () => {
  // happy-dom lays nothing out: the plan measures as long.
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 2000,
  });
  try {
    output(asked("p1", { toolName: "ExitPlanMode", input: { plan }, interactive: true }));
    await renderChat();
    const body = pinned()!.querySelector<HTMLElement>(".proposed-plan")!.parentElement!;
    expect(body.style.maxHeight).toBe("184px");
    await click(inCard("Show full plan"));
    expect(body.style.maxHeight).toBe("45vh");
    expect(body.style.overflowY).toBe("auto");
    expect(body.contains(inCard("Approve plan")!)).toBe(false);
  } finally {
    if (own) Object.defineProperty(HTMLElement.prototype, "scrollHeight", own);
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});

// --- The card's previews ---

const previewOf = (request: Partial<ApprovalRequest>) => {
  const approval: Approval = {
    kind: "approval",
    key: "k",
    at: "2026-10-01T12:00:00Z",
    request: { approvalId: "a1", toolName: "Bash", input: {}, expiresAt: "", ...request },
  };
  render(
    <ApprovalQueue
      asked={[{ runId, approval }]}
      answers={new Map()}
      onAnswer={() => {}}
      onDismiss={() => {}}
      describe={describeTool}
      markdown={(text) => <p>{text}</p>}
    />,
  );
  return card()!;
};

test("an Edit shows its file and a diff of the change, removed lines first", () => {
  const el = previewOf({
    toolName: "Edit",
    input: {
      file_path: "/repo/src/Sidebar.tsx",
      old_string: "useEffect(() => {\n  clear();\n});",
      new_string: "useEffect(() => {\n  // Keep it.\n  keep();\n});",
    },
  });
  expect(el.querySelector("bdi")!.textContent).toBe("/repo/src/Sidebar.tsx");
  const diff = el.querySelector('[role="group"][aria-label^="Diff"]')!;
  expect(diff.getAttribute("aria-label")).toBe("Diff: 2 lines added, 1 removed");
  expect([...diff.children].map((line) => line.textContent)).toEqual([
    " useEffect(() => {",
    "−Removed:   clear();",
    "+Added:   // Keep it.",
    "+Added:   keep();",
    " });",
  ]);
});

test("a Write shows its content as added; an MCP call its server, tool, and arguments", () => {
  let el = previewOf({
    toolName: "Write",
    input: { file_path: "/repo/a.txt", content: "one\ntwo" },
  });
  expect(el.querySelector('[aria-label^="Diff"]')!.getAttribute("aria-label")).toBe(
    "Diff: 2 lines added, 0 removed",
  );
  // It may replace a file that's there, so it says it writes all of it.
  expect(el.textContent).toContain("Writes the whole file.");
  act(() => unmount());

  el = previewOf({
    toolName: "mcp__linear__save_issue",
    input: { title: "Tune the backoff", labels: ["app", "Improvement"], priority: 2 },
  });
  expect(document.getElementById(el.getAttribute("aria-labelledby")!)!.textContent).toBe(
    "Linearsave issue",
  );
  expect(el.querySelector("svg.lucide-plug")).not.toBeNull();
  const fields = [...el.querySelectorAll("dt")].map((dt) => [
    dt.textContent,
    dt.nextElementSibling!.textContent,
  ]);
  expect(fields).toEqual([
    ["title", "Tune the backoff"],
    ["labels", '["app","Improvement"]'],
    ["priority", "2"],
  ]);
  // Text reads as text, anything else as JSON in monospace.
  expect(el.querySelector("dd")!.className).not.toContain("font-mono");
  expect(el.querySelectorAll("dd")[1]!.className).toContain("font-mono");
});

test("a long command is cut short with Show all; a URL and a fetch's prompt show; oversized input says so", async () => {
  const command = Array.from({ length: 12 }, (_, i) => `echo ${i + 1}`).join("\n");
  let el = previewOf({ input: { command } });
  expect(el.querySelector("pre")!.textContent).toBe(command.split("\n").slice(0, 8).join("\n"));
  const all = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "Show all 12 lines",
  )!;
  expect(all.getAttribute("aria-expanded")).toBe("false");
  await act(async () => all.click());
  expect(el.querySelector("pre")!.textContent).toBe(command);
  act(() => unmount());

  el = previewOf({
    toolName: "WebFetch",
    input: { url: "https://example.com/docs", prompt: "Find the retry settings" },
  });
  expect(el.querySelector("pre")!.textContent).toBe("https://example.com/docs");
  expect(el.textContent).toContain("Find the retry settings");
  act(() => unmount());

  el = previewOf({ input: { truncated: true, bytes: 300_000 } });
  expect(el.textContent).toContain(
    "Its input is too large to show (293 KB). Approving runs it as asked.",
  );
});

// --- Focus, and what a screen reader hears ---

const approval = (approvalId: string, at = "2026-10-01T12:00:00Z"): Approval => ({
  kind: "approval",
  key: approvalId,
  at,
  request: {
    approvalId,
    toolName: "Bash",
    input: { command: `pnpm test ${approvalId}` },
    expiresAt: "",
  },
});

function queue(asked: Asked[], answers = new Map<string, AnswerState>(), returnFocus = () => {}) {
  return (
    <>
      <input aria-label="Somewhere else" />
      <ApprovalQueue
        asked={asked}
        answers={answers}
        onAnswer={() => {}}
        onDismiss={() => {}}
        describe={describeTool}
        markdown={(text) => <p>{text}</p>}
        returnFocus={returnFocus}
      />
    </>
  );
}
const said = () => document.querySelector('[aria-live="polite"]')!.textContent;

test("a card takes focus only from nothing, and focus in it moves to the next card, then back", () => {
  const returned = vi.fn();
  const one = { runId, approval: approval("a1") };
  const two = { runId, approval: approval("a2", "2026-10-01T12:00:01Z") };
  const rerender = render(queue([one, two], new Map(), returned));
  expect(document.activeElement).toBe(card());
  expect(said()).toBe("Approval needed, 1 of 2: Bash: pnpm test a1.");

  const answered = (id: string) =>
    [id, { state: "answered", resolved: { decision: "allowed", by: "user" } }] as const;
  rerender(queue([two], new Map([answered("a1")]), returned));
  expect(document.activeElement).toBe(card());
  expect(card()!.textContent).toContain("pnpm test a2");
  expect(said()).toBe("Approved. Approval needed: Bash: pnpm test a2.");

  rerender(queue([], new Map([answered("a1"), answered("a2")]), returned));
  expect(pinned()).toBeNull();
  expect(returned).toHaveBeenCalledOnce();
  expect(said()).toBe("Approved.");
});

test("a card never takes focus from someone typing", () => {
  const rerender = render(queue([]));
  const other = document.querySelector<HTMLInputElement>('input[aria-label="Somewhere else"]')!;
  act(() => other.focus());
  rerender(queue([{ runId, approval: approval("a1") }]));
  expect(document.activeElement).toBe(other);
  expect(said()).toBe("Approval needed: Bash: pnpm test a1.");
});

test("the card stays while its Deny note is open or its answer is on the way, though an older request arrives", async () => {
  const older = { runId: "other", approval: approval("a1", "2026-10-01T12:00:00Z") };
  const shownNow = { runId, approval: approval("b1", "2026-10-01T12:00:05Z") };
  const rerender = render(queue([shownNow]));
  await act(async () => inCard("Deny")!.click());
  const note = pinned()!.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(note, "Not t");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // A Project's subagent request, older, loads late.
  rerender(queue([older, shownNow]));
  expect(card()!.textContent).toContain("pnpm test b1");
  expect(card()!.textContent).toContain("Needs approval · 1 of 2");
  expect(pinned()!.querySelector("input")).toBe(note);
  expect(note.value).toBe("Not t");
  expect(document.activeElement).toBe(note);

  // Closing the note lets the queue take its order again.
  await act(async () => inCard("Cancel")!.click());
  expect(card()!.textContent).toContain("pnpm test a1");

  // So does an answer on its way, until it's back.
  act(() => unmount());
  const answering = new Map<string, AnswerState>([["b1", { state: "answering", choice: "allow" }]]);
  const again = render(queue([shownNow], answering));
  again(queue([older, shownNow], answering));
  expect(card()!.textContent).toContain("pnpm test b1");
  expect(inCard("Approving…")).toBeDefined();
});

test("a request that queues behind the card is announced by how many wait", () => {
  const one = { runId, approval: approval("a1") };
  const two = { runId, approval: approval("a2", "2026-10-01T12:00:01Z") };
  const three = { runId, approval: approval("a3", "2026-10-01T12:00:02Z") };
  const rerender = render(queue([one]));
  expect(said()).toBe("Approval needed: Bash: pnpm test a1.");
  rerender(queue([one, two]));
  expect(said()).toBe("2 requests waiting.");
  expect(card()!.textContent).toContain("Needs approval · 1 of 2");
  rerender(queue([one, two, three]));
  expect(said()).toBe("3 requests waiting.");
  // Fewer waiting behind it says nothing new.
  rerender(queue([one, three]));
  expect(said()).toBe("3 requests waiting.");
});

test("another run's request names it, with a way to its chat", async () => {
  const open = vi.fn();
  render(
    queue([
      {
        runId: "other",
        approval: approval("b1"),
        from: { label: "Subagent: Write the docs", open },
      },
    ]),
  );
  expect(pinned()!.textContent).toContain("Subagent: Write the docs");
  expect(said()).toBe("Approval needed from Subagent: Write the docs: Bash: pnpm test b1.");
  await act(async () => inCard("Open its chat")!.click());
  expect(open).toHaveBeenCalledOnce();
});

test("while disconnected, the answers are off and say why", () => {
  render(
    <ApprovalQueue
      asked={[{ runId, approval: approval("a1") }]}
      answers={new Map()}
      onAnswer={() => {}}
      onDismiss={() => {}}
      describe={describeTool}
      markdown={(text) => <p>{text}</p>}
      disabledReason="Disconnected from wispd"
    />,
  );
  expect(buttons().every((b) => b.disabled && b.title === "Disconnected from wispd")).toBe(true);
});

// --- The pure parts ---

test("diffLines aligns by the longest common run, removed first, and folds far unchanged lines", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
  expect(diffLines(before, after)).toEqual([
    { op: "gap", count: 2 },
    { op: " ", text: "c" },
    { op: " ", text: "d" },
    { op: "-", text: "e" },
    { op: "+", text: "E" },
    { op: " ", text: "f" },
    { op: " ", text: "g" },
    { op: "gap", count: 1 },
  ]);
  expect(diffLines("", "new\nfile")).toEqual([
    { op: "+", text: "new" },
    { op: "+", text: "file" },
  ]);
  expect(diffLines("same", "same")).toEqual([{ op: "gap", count: 1 }]);
});

test("the queue is oldest first, less what this window answered; answered here reads as resolved at once", () => {
  const a = { runId, approval: approval("a1", "2026-10-01T12:00:02Z") };
  const b = { runId: "other", approval: approval("b1", "2026-10-01T12:00:01Z") };
  const c = { runId, approval: approval("c1", "2026-10-01T12:00:03Z") };
  const answers = new Map<string, AnswerState>([
    ["c1", { state: "answered", resolved: { decision: "denied", by: "user" } }],
    ["a1", { state: "answering", choice: "allow" }],
  ]);
  expect(queueOf([a, b, c], answers).map((x) => x.approval.request.approvalId)).toEqual([
    "b1",
    "a1",
  ]);
  const items: Item[] = [
    approval("a1"),
    approval("c1"),
    { ...approval("d1"), resolved: { decision: "expired", by: "timeout" } },
  ];
  expect(withAnswers(items, answers).map((i) => (i as Approval).resolved?.decision)).toEqual([
    undefined,
    "denied",
    "expired",
  ]);
});

test("each outcome has its words, a plan's its own, and a decision newer than the app reads as ended", () => {
  const with_ = (resolved: ApprovalResolution | undefined, toolName = "Bash") => {
    const a = approval("a1");
    return outcomeOf({ ...a, request: { ...a.request, toolName }, ...(resolved && { resolved }) })
      .verb;
  };
  expect(with_(undefined)).toBe("Waiting for approval");
  expect(with_({ decision: "allowed", by: "user" })).toBe("Approved");
  expect(with_({ decision: "allowed", by: "user", always: true })).toBe("Always allowed");
  expect(with_({ decision: "denied", by: "user" })).toBe("Denied");
  expect(with_({ decision: "expired", by: "timeout" })).toBe("Timed out");
  expect(with_({ decision: "withdrawn", by: "agent" })).toBe("Withdrawn");
  expect(with_({ decision: "withdrawn", by: "agent", gone: true })).toBe("No longer waiting");
  expect(with_({ decision: "someday" as "allowed", by: "user" })).toBe("Ended");
  expect(with_(undefined, "ExitPlanMode")).toBe("Plan waiting for approval");
  expect(with_({ decision: "allowed", by: "user" }, "ExitPlanMode")).toBe("Approved the plan");
  expect(with_({ decision: "denied", by: "user" }, "ExitPlanMode")).toBe("Kept planning");
  expect(with_({ decision: "denied", by: "stop" }, "ExitPlanMode")).toBe("Plan not approved");
  expect(with_({ decision: "expired", by: "timeout" }, "ExitPlanMode")).toBe("Plan timed out");
});

test("a line in the transcript is one quiet row: how it ended, the tool, and when", () => {
  const row: Approval = {
    ...approval("a1"),
    resolved: { decision: "allowed", by: "user", at: "2026-10-01T12:00:05Z" },
  };
  render(<RowView row={row} live={false} open={false} onToggle={() => {}} />);
  const summary = document.querySelector("summary")!;
  expect(summary.querySelector("time")!.getAttribute("dateTime")).toBe("2026-10-01T12:00:05Z");
  expect(summary.textContent).toBe(`ApprovedBash: pnpm test a1${clock("2026-10-01T12:00:05Z")}`);
  expect(document.querySelector("details")!.open).toBe(false);
  // No box around it.
  expect(summary.querySelector('[class*="border"]')).toBeNull();
  expect(document.querySelector("details")!.className).not.toContain("border");
});

test("a time reads as the clock today, with the date otherwise", () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime();
  expect(clock(new Date(2026, 9, 1, 14, 31).toISOString(), now)).toBe("2:31 PM");
  expect(clock(new Date(2026, 8, 30, 9, 5).toISOString(), now)).toBe("Sep 30, 9:05 AM");
});
