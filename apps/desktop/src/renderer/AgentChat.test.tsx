// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/wisp-protocol/samples/v1/agents.json";
import type { SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { AgentRunResult, LoggedEvent } from "../protocol/generated/protocol";
import { AgentChat, RowView, RunTab } from "./AgentChat";
import type { Item } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom lays nothing out. Give the transcript a tall viewport and each row a
// small height, so the virtualized list renders every row.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
  },
});

const runId = "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01";
const logged = (samples as { method?: string; params?: unknown }[])
  .filter((m) => m.method === "events/event")
  .map((m) => m.params as LoggedEvent);

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
}

const row = (item: Item) =>
  render(<RowView row={item} live={false} open={false} onToggle={() => {}} />);

test("a user message shows its text, or a neutral label when the log has none", () => {
  row({ kind: "user", key: "a", text: "Fix the build" });
  expect(document.body.textContent).toBe("Fix the build");
  act(() => unmount());
  row({ kind: "user", key: "b", text: null, turnId: "t" });
  expect(document.body.textContent).toBe("Follow-up message");
});

test("an assistant message renders Markdown, but never raw HTML or images", () => {
  row({
    kind: "assistant",
    key: "a",
    text: "Run **this**:\n\n```sh\ncargo test\n```\n\nSee [docs](https://example.com). <img src=x onerror=alert(1)> ![a diagram](file:///etc/passwd)",
  });
  expect(document.querySelector("strong")?.textContent).toBe("this");
  expect(document.querySelector("pre code")?.textContent).toBe("cargo test\n");
  expect(document.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  const link = document.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com");
  expect(link.target).toBe("_blank");
  // A Markdown image is a link with its alt text, which main opens only if it's https.
  expect(document.querySelector("img")).toBeNull();
  const links = [...document.querySelectorAll("a")];
  expect(links.map((a) => a.textContent)).toEqual(["docs", "a diagram"]);
  // Its file: source is unsafe, so it has no href at all rather than an empty one.
  expect(links[1]!.hasAttribute("href")).toBe(false);
});

test("a tool call collapses its input and output under its name", () => {
  const toggled = vi.fn();
  const tool: Item = {
    kind: "tool",
    key: "t",
    callId: "toolu_1",
    name: "Bash",
    input: { command: "cargo test\n--quiet" },
    status: "error",
    output: "1 failed",
  };
  render(<RowView row={tool} live={false} open={false} onToggle={toggled} />);
  const details = document.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(document.querySelector("summary")!.textContent).toBe("Bashcargo test");
  expect(document.querySelector('[aria-label="Failed"]')).not.toBeNull();

  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(toggled).toHaveBeenCalledWith("t", true);
  expect(details.textContent).toContain("1 failed");
});

test("a tool call with an oversized input says so", () => {
  row({
    kind: "tool",
    key: "t",
    callId: "toolu_2",
    name: "Bash",
    input: { truncated: true, bytes: 90210 },
    status: "denied",
  });
  expect(document.querySelector("details")!.textContent).toContain("Too large to show (89 KB)");
});

test("reasoning, checklists, and notices render quietly", () => {
  row({ kind: "reasoning", key: "r", text: "The build uses cargo." });
  expect(document.querySelector("summary")!.textContent).toBe("Thinking");
  act(() => unmount());

  row({
    kind: "todo",
    key: "c",
    items: [
      { text: "Write README.md", status: "inProgress" },
      { text: "Read the scripts", status: "completed" },
    ],
  });
  expect([...document.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Write README.md",
    "Read the scripts",
  ]);
  expect(document.querySelector('[aria-label="Done"]')).not.toBeNull();
  act(() => unmount());

  row({ kind: "notice", key: "n", tone: "warning", text: "skipped a malformed line" });
  expect(document.body.textContent).toBe("skipped a malformed line");
});

test("a failed run shows why; other endings are a divider", () => {
  row({
    kind: "end",
    key: "e",
    outcome: { status: "failed", failure: "commitFailed", message: "no git identity" },
  });
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(
    "Failed: wisp couldn't commit its changesno git identity",
  );
  act(() => unmount());
  row({ kind: "end", key: "e", outcome: { status: "cancelled" } });
  expect(document.body.textContent).toBe("Stopped");
});

/**
 * A bridge serving the sample's events up to `seq`, two per page, that records calls.
 * `agent/list` answers `listSeq`, and a subscribe from before it resyncs, as wispd does
 * when it can't replay that far back. The first `resyncs` subscribes resync anyway.
 */
function fakeBridge(seq: number, { listSeq = seq, resyncs = 0, cancelError = "" } = {}) {
  let listener: (m: SubscriptionMessage) => void = () => {};
  const request = vi.fn(async (_host: string, method: string, params: { after?: number }) => {
    if (method === "agent/list") return { result: { runs: [], seq: listSeq }, logId: "log-1" };
    if (method === "agent/cancel" && cancelError)
      return { error: { code: -32000, message: cancelError } };
    if (method !== "agent/events") return { result: {}, logId: "log-1" };
    const rest = logged.filter((e) => e.seq > params.after! && e.seq <= seq);
    return { result: { events: rest.slice(0, 2), more: rest.length > 2 }, logId: "log-1" };
  });
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_host: string, params: { after: number }, l: typeof listener) => {
    listener = l;
    if (params.after < listSeq || resyncs-- > 0) queueMicrotask(() => l({ type: "resync" }));
    return unsubscribe;
  });
  window.wisp = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      wispd: "0.1.0",
      protocol: 1,
      capabilities: {},
    }),
    onConnectionState: () => () => {},
    request,
    subscribe,
  } as Partial<WispBridge> as WispBridge;
  return {
    request,
    subscribe,
    unsubscribe,
    emit: (m: SubscriptionMessage) => act(() => listener(m)),
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => {});
};

async function renderChat() {
  render(<AgentChat hostId="local" runId={runId} />);
  await settle(); // the connection state and the pages
}

const transcriptText = () => document.querySelector('[role="log"]')?.textContent ?? "";

test("loads every page, subscribes after the last seq, and appends live events", async () => {
  const { request, subscribe, unsubscribe, emit } = fakeBridge(2);
  await renderChat();
  expect(request).toHaveBeenCalledWith("local", "agent/events", { runId, after: 0 });
  expect(subscribe).toHaveBeenCalledWith(
    "local",
    { after: 2, project: "01a0d349-6e00-7c9e-80e2-0426486a8cae", logId: "log-1" },
    expect.any(Function),
  );
  expect(transcriptText()).toContain("Add a README");
  expect(document.body.textContent).toContain("Worktree"); // the footer's tab

  emit({ type: "event", event: { subscription: "s", ...logged[2]! } });
  // The agent's work folds under one dropdown until it's opened.
  expect(transcriptText()).not.toContain("I'll add a README and note the build steps");
  const work = document.querySelector<HTMLButtonElement>('[role="log"] button[aria-expanded]')!;
  act(() => work.click());
  expect(transcriptText()).toContain("I'll add a README and note the build steps");

  // A resync reloads from the start.
  request.mockClear();
  emit({ type: "resync" });
  await settle();
  expect(request).toHaveBeenCalledWith("local", "agent/events", { runId, after: 0 });

  act(() => unmount());
  expect(unsubscribe).toHaveBeenCalled();
});

test("subscribes after the scope's snapshot seq, so repeated resyncs end", async () => {
  // The run's last event is seq 8, but its project's log is at 1000.
  const { subscribe } = fakeBridge(8, { listSeq: 1000, resyncs: 2 });
  await renderChat();
  await settle();
  expect(subscribe.mock.calls.map(([, params]) => params.after)).toEqual([1000, 1000, 1000]);
  expect(transcriptText()).toContain("Add a README");
});

test("the composer tab shows the worktree and its branch", () => {
  const started = samples.find((m) => "result" in m && m.id === 2)!;
  render(<RunTab run={(started as unknown as { result: AgentRunResult }).result.run} />);
  expect(document.body.textContent).toBe("Worktreewisp/1a2b3c4d");
});

test("Enter sends with a fresh v7 turn id, but not while an IME is composing", async () => {
  const { request } = fakeBridge(4);
  await renderChat();
  const box = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Also mention the tests.",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();

  const enter = (isComposing: boolean) =>
    act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing, bubbles: true }));
    });
  await enter(true);
  expect(request.mock.calls.some(([, method]) => method === "agent/send")).toBe(false);

  await enter(false);
  const send = request.mock.calls.find(([, method]) => method === "agent/send")!;
  expect(send[2]).toMatchObject({ runId, text: "Also mention the tests." });
  expect((send[2] as { turnId: string }).turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(box.value).toBe("");
  // Shown as pending until its turn starts.
  expect(transcriptText()).toContain("Also mention the tests.");
});

test("a dropped follow-up sent from here can be sent again, once", async () => {
  const { request, emit } = fakeBridge(4);
  await renderChat();
  const box = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Also mention the tests.",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const sends = () => request.mock.calls.filter(([, method]) => method === "agent/send");
  const { turnId } = sends()[0]![2] as { turnId: string };
  emit({
    type: "event",
    event: {
      subscription: "s",
      seq: 50,
      time: "",
      event: { kind: "agent.output", runId, items: [{ kind: "followUpDropped", turnId }] },
    },
  });

  const sendAgain = () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Send again");
  await act(async () => sendAgain()!.click());
  expect(sends()).toHaveLength(2);
  expect(sends()[1]![2]).toMatchObject({ text: "Also mention the tests." });
  expect(sendAgain()).toBeUndefined();
});

test("Stop cancels, and a failed cancel says why and allows another try", async () => {
  const { request } = fakeBridge(4, { cancelError: "wispd is gone" });
  await renderChat();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!.click(),
  );
  expect(request).toHaveBeenCalledWith("local", "agent/cancel", { runId });
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("wispd is gone");
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!.disabled).toBe(
    false,
  );
});

test("while disconnected, nothing loads and the composer says why", async () => {
  const { request } = fakeBridge(8);
  window.wisp.connectionState = async () => ({
    status: "failed",
    retrying: true,
    error: { reason: "exited", message: "wispd exited" },
  });
  await renderChat();
  expect(request).not.toHaveBeenCalled();
  expect(document.querySelector("textarea")!.placeholder).toBe("Disconnected from wispd");
  const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  expect(send.disabled).toBe(true);
});
