// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/wisp-protocol/samples/v1/agents.json";
import type { SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { AgentRunResult, LoggedEvent } from "../protocol/generated/protocol";
import { AgentChat, RowView, RunFooter } from "./AgentChat";
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
  };
}

const row = (item: Item) =>
  render(<RowView row={item} live={false} open={false} onToggle={() => {}} />);

test("a user message shows its text, or says it came from elsewhere", () => {
  row({ kind: "user", key: "a", text: "Fix the build" });
  expect(document.body.textContent).toBe("Fix the build");
  act(() => unmount());
  row({ kind: "user", key: "b", text: null, turnId: "t" });
  expect(document.body.textContent).toBe("Sent from another window");
});

test("an assistant message renders Markdown, but never raw HTML", () => {
  row({
    kind: "assistant",
    key: "a",
    text: "Run **this**:\n\n```sh\ncargo test\n```\n\nSee [docs](https://example.com). <img src=x onerror=alert(1)>",
  });
  expect(document.querySelector("strong")?.textContent).toBe("this");
  expect(document.querySelector("pre code")?.textContent).toBe("cargo test\n");
  expect(document.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  const link = document.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com");
  expect(link.target).toBe("_blank");
  expect(document.querySelector("img")).toBeNull();
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

/** A bridge serving the sample's events up to `seq`, two per page, that records calls. */
function fakeBridge(seq: number) {
  let listener: (m: SubscriptionMessage) => void = () => {};
  const request = vi.fn(async (_host: string, method: string, params: { after?: number }) => {
    if (method !== "agent/events") return { result: {} };
    const rest = logged.filter((e) => e.seq > params.after! && e.seq <= seq);
    return { result: { events: rest.slice(0, 2), more: rest.length > 2 } };
  });
  const subscribe = vi.fn((_host: string, _params: unknown, l: typeof listener) => {
    listener = l;
    return () => {};
  });
  window.wisp = {
    platform: "darwin",
    connectionState: async () => ({ status: "connected", wispd: "0.1.0", protocol: 1 }),
    onConnectionState: () => () => {},
    request,
    subscribe,
  } as Partial<WispBridge> as WispBridge;
  return { request, subscribe, emit: (m: SubscriptionMessage) => act(() => listener(m)) };
}

async function renderChat() {
  render(<AgentChat hostId="local" runId={runId} />);
  // Let the connection state and the pages resolve.
  for (let i = 0; i < 10; i++) await act(async () => {});
}

const transcriptText = () => document.querySelector('[role="log"]')?.textContent ?? "";

test("loads every page, subscribes after the last seq, and appends live events", async () => {
  const { request, subscribe, emit } = fakeBridge(2);
  await renderChat();
  expect(request).toHaveBeenCalledWith("local", "agent/events", { runId, after: 0 });
  expect(subscribe).toHaveBeenCalledWith(
    "local",
    { after: 2, project: "01a0d349-6e00-7c9e-80e2-0426486a8cae" },
    expect.any(Function),
  );
  expect(transcriptText()).toContain("Add a README");
  expect(document.body.textContent).toContain("Working"); // the footer's status

  emit({ type: "event", event: { subscription: "s", ...logged[2]! } });
  expect(transcriptText()).toContain("I'll add a README and note the build steps");

  // A resync reloads from the start.
  request.mockClear();
  emit({ type: "resync" });
  for (let i = 0; i < 10; i++) await act(async () => {});
  expect(request).toHaveBeenCalledWith("local", "agent/events", { runId, after: 0 });
});

test("the footer shows status, account, and worktree branch", () => {
  const started = samples.find((m) => "result" in m && m.id === 2)!;
  render(<RunFooter run={(started as unknown as { result: AgentRunResult }).result.run} />);
  expect(document.body.textContent).toBe("WorkingClaude subscriptionwisp/1a2b3c4d");
});

test("Enter sends with a fresh v7 turn id; Stop cancels while running", async () => {
  const { request } = fakeBridge(4);
  await renderChat();
  const box = document.querySelector("textarea")!;
  expect(document.querySelector('button[aria-label="Stop"]')).not.toBeNull();

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Also mention the tests.",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const send = request.mock.calls.find(([, method]) => method === "agent/send")!;
  expect(send[2]).toMatchObject({ runId, text: "Also mention the tests." });
  expect((send[2] as { turnId: string }).turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(box.value).toBe("");
  // Shown as pending until its turn starts.
  expect(transcriptText()).toContain("Also mention the tests.");

  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!.click());
  expect(request).toHaveBeenCalledWith("local", "agent/cancel", { runId });
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
