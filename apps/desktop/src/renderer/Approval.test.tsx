// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, ParallaxBridge } from "../preload/bridge";
import type {
  AgentOutputItem,
  AgentRun,
  LoggedEvent,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import { AgentChat, describeTool } from "./AgentChat";
import { ApprovalQueue, queueOf, withAnswers, type AnswerState, type Asked } from "./Approval";
import { diffLines } from "./diffLines";
import type { Approval, ApprovalRequest, ApprovalResolution, Item } from "./transcript";
import { fakeWatch } from "./fakeWatch";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
// happy-dom lays nothing out: a tall transcript and short rows, so the virtualized list renders all.
// The list reads the transcript's height from clientHeight and each row's from offsetHeight.
Object.defineProperties(HTMLElement.prototype, {
  clientHeight: {
    get(this: HTMLElement) {
      return this.getAttribute("role") === "log" ? 10_000 : 0;
    },
  },
  offsetHeight: {
    get(this: HTMLElement) {
      return this.getAttribute("role") === "log" ? 10_000 : 20;
    },
  },
});

const runId = "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01";
const run: AgentRun = {
  id: runId,
  project: "r-parallax",
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
const append = (event: ParallaxEvent) => {
  const seq = (log.at(-1)?.seq ?? 0) + 1;
  const logged = { seq, time: `2026-10-01T12:00:${String(seq).padStart(2, "0")}Z`, event };
  log.push(logged);
  return logged;
};
const output = (...items: AgentOutputItem[]) => append({ kind: "agent.output", runId, items });
const emit = (...items: AgentOutputItem[]) =>
  act(async () => listener({ type: "event", event: { subscription: "s", ...output(...items) } }));

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
  window.parallax = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities: { approvals: {} },
    }),
    onConnectionState: () => () => {},
    request,
    watch: fakeWatch(() => window.parallax),
    subscribe: (_host, _params, l) => {
      listener = l;
      return () => {};
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
});

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
  render(
    <>
      <AgentChat hostId="local" runId={runId} />
      <Notifications />
    </>,
  );
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

test("Approve answers with agent/approve, shows the answer on its way, then collapses to a line", async () => {
  output(asked("a1"));
  let release: (answer: RpcResponse<unknown>) => void = () => {};
  approve = () => new Promise((resolve) => (release = resolve));
  await renderChat();
  await click(inCard("Approve"));
  expect(approveCalls()).toEqual([{ runId, approvalId: "a1", decision: "allow" }]);
  // No second answer while the first is on its way.
  expect(buttons().every((b) => b.disabled)).toBe(true);

  await act(async () => release({ result: { decision: "allowed", by: "user" } }));
  await settle();
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Approved Bash: pnpm test/)]);
  // plxd's resolution confirms it.
  await emit(resolved("a1", { decision: "allowed", by: "user" }));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Approved Bash: pnpm test/)]);
});

test("a request that ends while its answer is on the way leaves, and the answer's reply changes nothing", async () => {
  output(asked("a1"));
  let release: (answer: RpcResponse<unknown>) => void = () => {};
  approve = () => new Promise((resolve) => (release = resolve));
  await renderChat();
  await click(inCard("Approve"));
  // It timed out just before the answer reached plxd.
  await emit(resolved("a1", { decision: "expired", by: "timeout" }));
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Timed out Bash/)]);
  // plxd's reply is how it ended, as `agent/approve` is idempotent.
  await act(async () => release({ result: { decision: "expired", by: "timeout" } }));
  await settle();
  expect(pinned()).toBeNull();
  expect(lines()).toEqual([expect.stringMatching(/^Timed out Bash/)]);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test("Always allow shows only when the request offers rules, and sends always", async () => {
  output(asked("a1", { alwaysAllow: [] }));
  await renderChat();
  expect(inCard("Always allow")).toBeUndefined();
  await emit(asked("a2", { alwaysAllow: ["Bash(pnpm test:*)"] }));
  await click(inCard("Approve"));
  await click(inCard("Always allow"));
  expect(approveCalls()).toEqual([
    { runId, approvalId: "a1", decision: "allow" },
    { runId, approvalId: "a2", decision: "allow", always: true },
  ]);
  expect(lines()).toEqual([
    expect.stringMatching(/^Approved/),
    expect.stringMatching(/^Always allowed Bash: pnpm test/),
  ]);
});

// --- The card's previews ---

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

test("the card on screen stays first for as long as it waits: requests that come after it queue behind it, older or not", async () => {
  const older = { runId: "other", approval: approval("a1", "2026-10-01T12:00:00Z") };
  const shownNow = { runId, approval: approval("b1", "2026-10-01T12:00:05Z") };
  const newer = { runId, approval: approval("c1", "2026-10-01T12:00:09Z") };
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
  expect(pinned()!.querySelector("input")).toBe(note);
  expect(note.value).toBe("Not t");
  expect(document.activeElement).toBe(note);

  // Closing the note leaves it in place, and so does a newer request.
  await act(async () => inCard("Cancel")!.click());
  expect(card()!.textContent).toContain("pnpm test b1");
  rerender(queue([older, shownNow, newer]));
  expect(card()!.textContent).toContain("pnpm test b1");

  // As do its answer on the way, and one that fails.
  const all = [older, shownNow, newer];
  rerender(queue(all, new Map([["b1", { state: "answering", choice: "allow" }]])));
  expect(card()!.textContent).toContain("pnpm test b1");
  expect(buttons().every((b) => b.disabled)).toBe(true);
  rerender(queue(all, new Map([["b1", { state: "failed", choice: "allow", error: "busy" }]])));
  expect(card()!.textContent).toContain("pnpm test b1");
  expect(buttons().every((b) => !b.disabled)).toBe(true);

  // Once it's answered, the oldest of the rest takes its place.
  const answered = new Map<string, AnswerState>([
    ["b1", { state: "answered", resolved: { decision: "allowed", by: "user" } }],
  ]);
  rerender(queue([older, newer], answered));
  expect(card()!.textContent).toContain("pnpm test a1");
});

// --- A new card under a pointer ---

/** A queue whose answers go to `answered`, by approval id and choice. */
const answeringTo =
  (answered: (approvalId: string, choice: string) => void) =>
  (asked: Asked[], answers = new Map<string, AnswerState>()) => (
    <ApprovalQueue
      asked={asked}
      answers={answers}
      onAnswer={(a, choice) => answered(a.approval.request.approvalId, choice)}
      onDismiss={() => {}}
      describe={describeTool}
      markdown={(text) => <p>{text}</p>}
    />
  );
const done = (...ids: string[]) =>
  new Map<string, AnswerState>(
    ids.map((id) => [id, { state: "answered", resolved: { decision: "allowed", by: "user" } }]),
  );
/**
 * A pointer's click, which has a click count where a key's has none. It comes `at` on the clock of
 * `performance.now`, by default a second from now, well past the time a new card ignores clicks.
 */
const pointerClick = (el: Element, at = performance.now() + 1000) =>
  act(() => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    Object.defineProperty(click, "timeStamp", { value: at });
    el.dispatchEvent(click);
  });
/** A pointer event on the card's Approve: a mouse's with no button down, unless `init` says. */
const pointer = (type: string, init: PointerEventInit = {}) =>
  act(() => {
    inCard("Approve")!.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
  });

test("a new card ignores a pointer's click until the pointer hovers over it; a key's click goes at once", () => {
  const answered = vi.fn();
  const show = answeringTo(answered);
  const one = { runId, approval: approval("a1") };
  const two = { runId, approval: approval("a2", "2026-10-01T12:00:01Z") };
  const three = { runId, approval: approval("a3", "2026-10-01T12:00:02Z") };

  // The first card appears under a pointer that was already there.
  const rerender = render(show([one, two]));
  pointerClick(inCard("Approve")!);
  expect(answered).not.toHaveBeenCalled();
  // Nothing looks turned off meanwhile.
  expect(buttons().some((b) => b.disabled)).toBe(false);
  pointer("pointermove");
  pointerClick(inCard("Approve")!);
  expect(answered).toHaveBeenLastCalledWith("a1", "allow");

  // The next takes its place under the same pointer: a click meant for the first misses it.
  rerender(show([two, three], done("a1")));
  expect(card()!.textContent).toContain("pnpm test a2");
  pointerClick(inCard("Approve")!);
  pointerClick(inCard("Deny")!);
  expect(answered).toHaveBeenCalledOnce();
  expect(pinned()!.querySelector("input")).toBeNull();
  // So does one that drifts a pixel while pressed: the press began on the first.
  pointer("pointerdown", { buttons: 1 });
  pointer("pointermove", { buttons: 1 });
  pointerClick(inCard("Approve")!);
  expect(answered).toHaveBeenCalledOnce();
  // A key's click goes at once.
  act(() => inCard("Approve")!.click());
  expect(answered).toHaveBeenLastCalledWith("a2", "allow");
  expect(answered).toHaveBeenCalledTimes(2);
});

test("a new card ignores a pointer's click for 300 ms after it shows, even after a hover or a touch; a key's goes at once", () => {
  const answered = vi.fn();
  const show = answeringTo(answered);
  const one = { runId, approval: approval("a1") };
  const two = { runId, approval: approval("a2", "2026-10-01T12:00:01Z") };
  const three = { runId, approval: approval("a3", "2026-10-01T12:00:02Z") };
  // The clock a card notes when it shows, and that clicks are stamped on.
  const clock = vi.spyOn(performance, "now").mockReturnValue(5_000);
  try {
    const rerender = render(show([one, two, three]));
    pointer("pointermove");
    pointerClick(inCard("Approve")!, 5_299);
    expect(answered).not.toHaveBeenCalled();
    pointerClick(inCard("Approve")!, 5_300);
    expect(answered).toHaveBeenLastCalledWith("a1", "allow");

    // The next, shown at 9 s: a pointer already moving, or a finger, is still too soon for it.
    clock.mockReturnValue(9_000);
    rerender(show([two, three], done("a1")));
    pointer("pointermove");
    pointerClick(inCard("Approve")!, 9_120);
    pointer("pointerdown", { pointerType: "touch", buttons: 1 });
    pointerClick(inCard("Approve")!, 9_240);
    expect(answered).toHaveBeenCalledOnce();
    // A key's click goes at once.
    act(() => inCard("Approve")!.click());
    expect(answered).toHaveBeenLastCalledWith("a2", "allow");

    // And a touch goes once the time is up.
    rerender(show([three], done("a1", "a2")));
    pointer("pointerdown", { pointerType: "touch", buttons: 1 });
    pointerClick(inCard("Approve")!, 9_300);
    expect(answered).toHaveBeenLastCalledWith("a3", "allow");
  } finally {
    clock.mockRestore();
  }
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

test("ExitPlanMode: Approve plan allows it as asked, and the plan returns to the transcript", async () => {
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
  await click(inCard("Approve plan"));
  // As asked: no edited input, so its planFilePath never changes (0031).
  expect(approveCalls()).toEqual([{ runId, approvalId: "p1", decision: "allow" }]);
  expect(pinned()).toBeNull();
  expect(transcript().textContent).toContain("Keep the sidebar's list while a host reconnects");
});
